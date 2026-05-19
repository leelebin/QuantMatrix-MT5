const Strategy = require('../models/Strategy');
const StrategyInstance = require('../models/StrategyInstance');
const RiskProfile = require('../models/RiskProfile');
const strategyEngine = require('../services/strategyEngine');
const breakevenService = require('../services/breakevenService');
const { getAllSymbols } = require('../config/instruments');
const { getStrategyParameterDefinitions } = require('../config/strategyParameters');

const LEGACY_ASSIGNMENT_DEPRECATED_MESSAGE = 'This endpoint is deprecated. Use strategy runtime matrix / strategy instances instead.';
const LEGACY_ASSIGNMENT_WRITE_WARNING = 'Legacy assignment write used. This may affect live and paper assignment universe.';

function isLegacyAssignmentWriteAllowed(req = {}) {
  return req.body?.confirmLegacyAssignmentUpdate === true
    || String(process.env.ALLOW_LEGACY_ASSIGNMENT_WRITE || '').toLowerCase() === 'true';
}

function guardLegacyAssignmentWrite(req, res) {
  if (!isLegacyAssignmentWriteAllowed(req)) {
    res.status(409).json({
      success: false,
      message: LEGACY_ASSIGNMENT_DEPRECATED_MESSAGE,
      deprecated: true,
    });
    return false;
  }

  console.warn(LEGACY_ASSIGNMENT_WRITE_WARNING);
  return true;
}

async function ensureStrategyInstancesForSymbols(strategyName, symbols = [], seedPatch = {}) {
  const uniqueSymbols = [...new Set(Array.isArray(symbols) ? symbols : [])];
  for (const symbol of uniqueSymbols) {
    const existing = typeof StrategyInstance.findByKey === 'function'
      ? await StrategyInstance.findByKey(strategyName, symbol)
      : null;
    await StrategyInstance.upsert(strategyName, symbol, existing ? {} : seedPatch);
  }
}

async function syncStrategyInstances(strategyName, symbols = [], patch = {}) {
  const targetSymbols = [...new Set(Array.isArray(symbols) ? symbols : [])];
  for (const symbol of targetSymbols) {
    await StrategyInstance.upsert(strategyName, symbol, patch);
  }
}

function buildAssignmentsPayload(strategies) {
  const symbols = getAllSymbols();
  const symbolSet = new Set(symbols);
  const assignmentsBySymbol = Object.fromEntries(symbols.map((symbol) => [symbol, []]));
  const assignmentsByStrategy = {};

  strategies.forEach((strategy) => {
    const strategySymbols = Array.isArray(strategy.symbols)
      ? [...new Set(strategy.symbols)].filter((symbol) => symbolSet.has(symbol))
      : [];

    assignmentsByStrategy[strategy.name] = strategySymbols;

    strategySymbols.forEach((symbol) => {
      assignmentsBySymbol[symbol].push(strategy.name);
    });
  });

  return {
    symbols,
    strategies: strategies.map((strategy) => ({
      id: strategy._id,
      name: strategy.name,
      displayName: strategy.displayName,
      enabled: strategy.enabled,
    })),
    assignmentsBySymbol,
    assignmentsByStrategy,
  };
}

function enrichStrategy(strategy, activeProfile = null) {
  return {
    ...strategy,
    parameterDefinitions: getStrategyParameterDefinitions(strategy.name),
    effectiveBreakeven: breakevenService.resolveEffectiveBreakeven(activeProfile, strategy),
    effectiveExitPlan: breakevenService.resolveEffectiveExitPlan(activeProfile, strategy, null),
  };
}

// @desc    Get all strategies
// @route   GET /api/strategies
exports.getStrategies = async (req, res) => {
  try {
    // Ensure defaults exist
    await Strategy.initDefaults(strategyEngine.getStrategiesInfo());
    const activeProfile = await RiskProfile.getActive();
    const strategies = await Strategy.findAll();
    res.json({ success: true, data: strategies.map((strategy) => enrichStrategy(strategy, activeProfile)) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get single strategy
// @route   GET /api/strategies/:id
exports.getStrategy = async (req, res) => {
  try {
    const activeProfile = await RiskProfile.getActive();
    const strategy = await Strategy.findById(req.params.id);
    if (!strategy) {
      return res.status(404).json({ success: false, message: 'Strategy not found' });
    }
    res.json({ success: true, data: enrichStrategy(strategy, activeProfile) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Update strategy parameters
// @route   PUT /api/strategies/:id
exports.updateStrategy = async (req, res) => {
  try {
    const strategy = await Strategy.findById(req.params.id);
    if (!strategy) {
      return res.status(404).json({ success: false, message: 'Strategy not found' });
    }

    const { symbols, enabled, parameters, tradeManagement } = req.body;
    if (enabled !== undefined || parameters !== undefined || tradeManagement !== undefined) {
      return res.status(409).json({
        success: false,
        message: 'Runtime strategy enabled, parameters, and tradeManagement must be edited via /api/strategy-instances/:strategyName/:symbol',
      });
    }

    const legacyAssignmentWriteUsed = symbols !== undefined;
    if (legacyAssignmentWriteUsed && !guardLegacyAssignmentWrite(req, res)) return;

    const updateFields = {};
    if (symbols !== undefined) updateFields.symbols = symbols;

    const updatedStrategy = await Strategy.update(req.params.id, updateFields);
    const shouldEnsureInstances = symbols !== undefined;
    if (shouldEnsureInstances) {
      await ensureStrategyInstancesForSymbols(updatedStrategy.name, updatedStrategy.symbols);
    }
    const activeProfile = await RiskProfile.getActive();
    res.json({
      success: true,
      ...(legacyAssignmentWriteUsed ? {
        deprecated: true,
        warning: LEGACY_ASSIGNMENT_WRITE_WARNING,
      } : {}),
      data: enrichStrategy(updatedStrategy, activeProfile),
    });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      message: err.message,
      errors: err.details || [],
    });
  }
};

// @desc    Get symbol-strategy assignments
// @route   GET /api/strategies/assignments
exports.getAssignments = async (req, res) => {
  try {
    await Strategy.initDefaults(strategyEngine.getStrategiesInfo());
    const strategies = await Strategy.findAll();
    res.json({ success: true, data: buildAssignmentsPayload(strategies) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Replace symbol-strategy assignments
// @route   PUT /api/strategies/assignments
exports.updateAssignments = async (req, res) => {
  try {
    if (!guardLegacyAssignmentWrite(req, res)) return;

    const { assignmentsBySymbol } = req.body || {};
    const assignmentScope = String(req.body?.scope || 'paper').toLowerCase() === 'live'
      ? 'live'
      : 'paper';
    if (!assignmentsBySymbol || typeof assignmentsBySymbol !== 'object' || Array.isArray(assignmentsBySymbol)) {
      return res.status(400).json({
        success: false,
        message: 'assignmentsBySymbol must be an object keyed by symbol',
      });
    }

    await Strategy.initDefaults(strategyEngine.getStrategiesInfo());
    const strategies = await Strategy.findAll();
    const validSymbols = getAllSymbols();
    const validSymbolSet = new Set(validSymbols);
    const validStrategySet = new Set(strategies.map((strategy) => strategy.name));
    const nextAssignmentsByStrategy = Object.fromEntries(
      strategies.map((strategy) => [strategy.name, []])
    );

    for (const [symbol, strategyNames] of Object.entries(assignmentsBySymbol)) {
      if (!validSymbolSet.has(symbol)) {
        return res.status(400).json({
          success: false,
          message: `Invalid symbol: ${symbol}`,
        });
      }

      if (!Array.isArray(strategyNames)) {
        return res.status(400).json({
          success: false,
          message: `Assignments for ${symbol} must be an array`,
        });
      }

      const uniqueStrategyNames = [...new Set(strategyNames)];
      for (const strategyName of uniqueStrategyNames) {
        if (!validStrategySet.has(strategyName)) {
          return res.status(400).json({
            success: false,
            message: `Invalid strategy: ${strategyName}`,
          });
        }

        nextAssignmentsByStrategy[strategyName].push(symbol);
      }
    }

    const symbolOrder = new Map(validSymbols.map((symbol, index) => [symbol, index]));
    await Promise.all(strategies.map((strategy) => {
      const nextSymbols = [...new Set(nextAssignmentsByStrategy[strategy.name])]
        .sort((left, right) => symbolOrder.get(left) - symbolOrder.get(right));

      return Strategy.update(strategy._id, { symbols: nextSymbols });
    }));

    const seedPatch = assignmentScope === 'live'
      ? { paperEnabled: false, liveEnabled: true }
      : {};

    for (const strategy of strategies) {
      await ensureStrategyInstancesForSymbols(strategy.name, nextAssignmentsByStrategy[strategy.name], seedPatch);
    }

    const updatedStrategies = await Strategy.findAll();
    res.json({
      success: true,
      deprecated: true,
      warning: LEGACY_ASSIGNMENT_WRITE_WARNING,
      data: buildAssignmentsPayload(updatedStrategies),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Toggle strategy enabled/disabled
// @route   PUT /api/strategies/:id/toggle
exports.toggleStrategy = async (req, res) => {
  try {
    const strategy = await Strategy.findById(req.params.id);
    if (!strategy) {
      return res.status(404).json({ success: false, message: 'Strategy not found' });
    }

    return res.status(409).json({
      success: false,
      message: 'Runtime strategy enabled state must be edited per assignment via /api/strategy-instances/:strategyName/:symbol',
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Reset all strategy symbol assignments to defaults
// @route   POST /api/strategies/assignments/reset
exports.resetAssignments = async (req, res) => {
  try {
    if (!guardLegacyAssignmentWrite(req, res)) return;

    await Strategy.initDefaults(strategyEngine.getStrategiesInfo());
    await Strategy.resetToDefaults();
    const strategies = await Strategy.findAll();
    for (const strategy of strategies) {
      await ensureStrategyInstancesForSymbols(strategy.name, strategy.symbols);
    }
    res.json({
      success: true,
      deprecated: true,
      warning: LEGACY_ASSIGNMENT_WRITE_WARNING,
      message: 'Strategy symbol assignments reset to defaults',
      data: buildAssignmentsPayload(strategies),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get recent signals for a strategy
// @route   GET /api/strategies/:id/signals
exports.getSignals = async (req, res) => {
  try {
    const strategy = await Strategy.findById(req.params.id);
    if (!strategy) {
      return res.status(404).json({ success: false, message: 'Strategy not found' });
    }

    const limit = parseInt(req.query.limit) || 50;
    // Filter signals by strategy symbols
    const allSignals = strategyEngine.getRecentSignals(null, 200);
    const signals = allSignals
      .filter((s) => s.strategy === strategy.name)
      .slice(0, limit);

    res.json({ success: true, data: signals, count: signals.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
