const SymbolCustom = require('../models/SymbolCustom');
const { getSymbolCustomLogic } = require('../symbolCustom/registry');

const SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1 = 'SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1';
const SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED = 'SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED';
const SYMBOL_CUSTOM_CONTEXT_INVALID = 'SYMBOL_CUSTOM_CONTEXT_INVALID';
const VALID_SCOPES = Object.freeze(['paper', 'backtest', 'live']);

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function buildError(message, statusCode, details = []) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function normalizeScope(scope) {
  const normalized = String(scope || 'paper').trim().toLowerCase();
  if (!VALID_SCOPES.includes(normalized)) {
    throw buildError('Invalid SymbolCustom analysis scope', 400, [
      { field: 'scope', message: `Must be one of: ${VALID_SCOPES.join(', ')}` },
    ]);
  }
  return normalized;
}

function getLogicName(symbolCustom = {}) {
  return String(
    symbolCustom.logicName
      || symbolCustom.registryLogicName
      || symbolCustom.symbolCustomName
      || ''
  ).trim();
}

function getTimeframes(symbolCustom = {}) {
  return symbolCustom.timeframes || {};
}

function buildSymbolCustomSignal(symbolCustom = {}, rawResult = {}, context = {}) {
  const timeframes = getTimeframes(symbolCustom);
  const timestamp = context.timestamp || new Date();

  return {
    scope: context.scope || 'paper',
    source: 'symbolCustom',
    symbol: symbolCustom.symbol,
    symbolCustomId: symbolCustom._id || null,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName: context.logicName || getLogicName(symbolCustom),
    signal: rawResult.signal || 'NONE',
    status: rawResult.status,
    reason: rawResult.reason || null,
    reasonCode: rawResult.reasonCode,
    setupTimeframe: timeframes.setupTimeframe || null,
    entryTimeframe: timeframes.entryTimeframe || null,
    higherTimeframe: timeframes.higherTimeframe || null,
    parameters: cloneValue(symbolCustom.parameters || {}),
    timestamp,
  };
}

async function resolveCandles(symbolCustom, getCandlesFn, options) {
  if (options.candles !== undefined) {
    return options.candles;
  }

  if (typeof getCandlesFn !== 'function') {
    return {};
  }

  return getCandlesFn({
    symbol: symbolCustom.symbol,
    timeframes: getTimeframes(symbolCustom),
    symbolCustom,
    scope: options.scope,
    options,
  });
}

async function analyzeSymbolCustom(symbolCustom, getCandlesFn, options = {}) {
  if (!symbolCustom) {
    throw buildError('SymbolCustom is required', 400, [
      { field: 'symbolCustom', message: 'Required' },
    ]);
  }

  const scope = normalizeScope(options.scope || 'paper');
  const logicName = getLogicName(symbolCustom);
  const timestamp = options.timestamp || new Date();

  if (scope === 'live') {
    return buildSymbolCustomSignal(
      symbolCustom,
      {
        signal: 'NONE',
        status: 'BLOCKED',
        reason: 'SymbolCustom live execution is not supported in Phase 1',
        reasonCode: SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1,
      },
      { scope, logicName, timestamp }
    );
  }

  const logic = getSymbolCustomLogic(logicName);
  if (!logic) {
    throw buildError(SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED, 400, [
      { field: 'logicName', message: `SymbolCustom logic is not registered: ${logicName || '(empty)'}` },
    ]);
  }

  const candles = await resolveCandles(symbolCustom, getCandlesFn, { ...options, scope });
  const context = {
    ...(options.context || {}),
    scope,
    symbol: symbolCustom.symbol,
    symbolCustomId: symbolCustom._id || null,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName,
    timeframes: getTimeframes(symbolCustom),
    parameters: cloneValue(symbolCustom.parameters || {}),
    candles,
  };

  if (typeof logic.validateContext === 'function') {
    const validation = logic.validateContext(context);
    if (validation && validation.valid === false) {
      throw buildError(SYMBOL_CUSTOM_CONTEXT_INVALID, 400, validation.errors || []);
    }
  }

  const rawResult = await logic.analyze(context);
  return buildSymbolCustomSignal(symbolCustom, rawResult || {}, { scope, logicName, timestamp });
}

async function analyzeAllPaperSymbolCustoms(getCandlesFn, options = {}) {
  const symbolCustoms = await SymbolCustom.findAll({ paperEnabled: true });
  const activePaperSymbolCustoms = symbolCustoms.filter((symbolCustom) => symbolCustom.paperEnabled === true);
  const signals = [];

  for (const symbolCustom of activePaperSymbolCustoms) {
    signals.push(await analyzeSymbolCustom(symbolCustom, getCandlesFn, {
      ...options,
      scope: 'paper',
    }));
  }

  return signals;
}

module.exports = {
  SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1,
  SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED,
  SYMBOL_CUSTOM_CONTEXT_INVALID,
  analyzeSymbolCustom,
  analyzeAllPaperSymbolCustoms,
  buildSymbolCustomSignal,
};
