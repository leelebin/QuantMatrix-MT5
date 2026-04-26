const Strategy = require('../models/Strategy');
const StrategyInstance = require('../models/StrategyInstance');
const { getStrategyInstance } = require('../services/strategyInstanceService');
const { normalizeNewsBlackoutConfig } = require('../config/newsBlackout');
const { listAssignedStrategyRiskStatuses } = require('../services/strategyParametersLibraryService');
const RiskProfile = require('../models/RiskProfile');
const breakevenService = require('../services/breakevenService');
const { normalizeExecutionPolicy } = require('../services/executionPolicyService');

async function ensureStrategyExists(strategyName) {
  const strategy = await Strategy.findByName(strategyName);
  if (!strategy) {
    const error = new Error(`Strategy definition not found for ${strategyName}`);
    error.statusCode = 404;
    throw error;
  }

  return strategy;
}

exports.getStrategyInstances = async (req, res) => {
  try {
    const instances = await StrategyInstance.findAll();
    res.json({ success: true, data: instances });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

exports.getParametersLibrary = async (_req, res) => {
  try {
    res.json({
      success: true,
      data: await listAssignedStrategyRiskStatuses(),
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

exports.getStrategyInstancesByStrategyName = async (req, res) => {
  try {
    await ensureStrategyExists(req.params.strategyName);
    const instances = await StrategyInstance.findByStrategyName(req.params.strategyName);
    res.json({ success: true, data: instances });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

exports.getStrategyInstanceByKey = async (req, res) => {
  try {
    const { strategyName, symbol } = req.params;
    const effectiveInstance = await getStrategyInstance(symbol, strategyName);
    res.json({
      success: true,
      data: effectiveInstance,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

exports.upsertStrategyInstance = async (req, res) => {
  try {
    const { strategyName, symbol } = req.params;
    const patch = {};
    const activeProfile = await RiskProfile.getActive();

    if (req.body.parameters !== undefined) {
      patch.parameters = req.body.parameters;
    }
    if (req.body.enabled !== undefined) {
      patch.enabled = req.body.enabled;
    }
    if (req.body.newsBlackout !== undefined) {
      patch.newsBlackout = normalizeNewsBlackoutConfig(req.body.newsBlackout);
    }
    if (req.body.tradeManagement !== undefined) {
      const normalizedTradeManagement = breakevenService.normalizeStrategyTradeManagement(
        req.body.tradeManagement,
        { activeProfile }
      );
      patch.tradeManagement = normalizedTradeManagement === undefined ? null : normalizedTradeManagement;
    }
    if (req.body.executionPolicy !== undefined) {
      const normalizedExecutionPolicy = normalizeExecutionPolicy(req.body.executionPolicy, {
        partial: false,
      });
      patch.executionPolicy = normalizedExecutionPolicy;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Request must include parameters, enabled, newsBlackout, tradeManagement, or executionPolicy',
      });
    }

    await ensureStrategyExists(strategyName);
    await StrategyInstance.upsert(strategyName, symbol, patch);
    const effectiveInstance = await getStrategyInstance(symbol, strategyName, { activeProfile });
    res.json({ success: true, data: effectiveInstance });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};
