const SymbolCustom = require('../models/SymbolCustom');
const { getSymbolCustomLogic } = require('../symbolCustom/registry');

const SYMBOL_CUSTOM_LIVE_ANALYSIS_DISABLED = 'SYMBOL_CUSTOM_LIVE_ANALYSIS_DISABLED';
const SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_2 = SYMBOL_CUSTOM_LIVE_ANALYSIS_DISABLED;
const SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1 = SYMBOL_CUSTOM_LIVE_ANALYSIS_DISABLED;
const SYMBOL_CUSTOM_LIVE_NOT_ENABLED = 'SYMBOL_CUSTOM_LIVE_NOT_ENABLED';
const SYMBOL_CUSTOM_LIVE_NOT_ALLOWED = 'SYMBOL_CUSTOM_LIVE_NOT_ALLOWED';
const SYMBOL_CUSTOM_LIVE_STATUS_NOT_READY = 'SYMBOL_CUSTOM_LIVE_STATUS_NOT_READY';
const SYMBOL_CUSTOM_LIVE_PARAMETERS_DISABLED = 'SYMBOL_CUSTOM_LIVE_PARAMETERS_DISABLED';
const SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED = 'SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED';
const SYMBOL_CUSTOM_CONTEXT_INVALID = 'SYMBOL_CUSTOM_CONTEXT_INVALID';
const VALID_SCOPES = Object.freeze(['paper', 'backtest', 'live']);
const LIVE_READY_STATUSES = Object.freeze(['validated', 'live_ready']);

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

function getConfigObject(symbolCustom = {}, field) {
  return cloneValue(symbolCustom[field] || {});
}

function evaluateSymbolCustomLiveReadiness(symbolCustom = {}) {
  if (symbolCustom.liveEnabled !== true) {
    return {
      allowed: false,
      reasonCode: SYMBOL_CUSTOM_LIVE_NOT_ENABLED,
      reason: 'SymbolCustom live analysis requires liveEnabled=true',
    };
  }

  if (symbolCustom.allowLive !== true) {
    return {
      allowed: false,
      reasonCode: SYMBOL_CUSTOM_LIVE_NOT_ALLOWED,
      reason: 'SymbolCustom live analysis requires allowLive=true',
    };
  }

  const status = String(symbolCustom.status || '').trim();
  if (!LIVE_READY_STATUSES.includes(status)) {
    return {
      allowed: false,
      reasonCode: SYMBOL_CUSTOM_LIVE_STATUS_NOT_READY,
      reason: `SymbolCustom live analysis requires status ${LIVE_READY_STATUSES.join(' or ')}`,
    };
  }

  if (symbolCustom.parameters && symbolCustom.parameters.enabled === false) {
    return {
      allowed: false,
      reasonCode: SYMBOL_CUSTOM_LIVE_PARAMETERS_DISABLED,
      reason: 'SymbolCustom live analysis requires parameters.enabled not false',
    };
  }

  return { allowed: true, reasonCode: null, reason: null };
}

function buildSymbolCustomSignal(symbolCustom = {}, rawResult = {}, context = {}) {
  const timeframes = getTimeframes(symbolCustom);
  const timestamp = context.timestamp || new Date();
  const signal = rawResult.signal || 'NONE';
  const stopLoss = rawResult.stopLoss ?? rawResult.sl ?? null;
  const takeProfit = rawResult.takeProfit ?? rawResult.tp ?? null;
  const rawMetadata = rawResult.metadata || {};
  const confidence = rawResult.confidence ?? rawMetadata.confidence;
  const rawConfidence = rawResult.rawConfidence ?? rawMetadata.rawConfidence ?? confidence;
  const marketQualityScore = rawResult.marketQualityScore ?? rawMetadata.marketQualityScore;
  const marketQualityThreshold = rawResult.marketQualityThreshold ?? rawMetadata.marketQualityThreshold;

  return {
    scope: context.scope || 'paper',
    source: 'symbolCustom',
    symbol: symbolCustom.symbol,
    symbolCustomId: symbolCustom._id || null,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName: context.logicName || getLogicName(symbolCustom),
    signal,
    status: rawResult.status || (signal === 'NONE' ? 'NO_SIGNAL' : 'SIGNAL'),
    reason: rawResult.reason || null,
    reasonCode: rawResult.reasonCode,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(rawConfidence !== undefined ? { rawConfidence } : {}),
    ...(marketQualityScore !== undefined ? { marketQualityScore } : {}),
    ...(marketQualityThreshold !== undefined ? { marketQualityThreshold } : {}),
    sl: rawResult.sl ?? rawResult.stopLoss ?? null,
    tp: rawResult.tp ?? rawResult.takeProfit ?? null,
    stopLoss,
    takeProfit,
    setupTimeframe: timeframes.setupTimeframe || null,
    entryTimeframe: timeframes.entryTimeframe || null,
    higherTimeframe: timeframes.higherTimeframe || null,
    parameters: cloneValue(symbolCustom.parameters || {}),
    riskConfig: getConfigObject(symbolCustom, 'riskConfig'),
    sessionFilter: getConfigObject(symbolCustom, 'sessionFilter'),
    newsFilter: getConfigObject(symbolCustom, 'newsFilter'),
    beConfig: getConfigObject(symbolCustom, 'beConfig'),
    entryConfig: getConfigObject(symbolCustom, 'entryConfig'),
    exitConfig: getConfigObject(symbolCustom, 'exitConfig'),
    metadata: cloneValue(rawMetadata),
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
    const liveReadiness = evaluateSymbolCustomLiveReadiness(symbolCustom);
    if (!liveReadiness.allowed) {
      return buildSymbolCustomSignal(
        symbolCustom,
        {
          signal: 'NONE',
          status: 'BLOCKED',
          reason: liveReadiness.reason,
          reasonCode: liveReadiness.reasonCode,
          metadata: {
            liveReadiness,
          },
        },
        { scope, logicName, timestamp }
      );
    }
  }

  if (scope === 'live' && options.liveAnalysisEnabled === false) {
    return buildSymbolCustomSignal(
      symbolCustom,
      {
        signal: 'NONE',
        status: 'BLOCKED',
        reason: 'SymbolCustom live analysis was explicitly disabled by caller',
        reasonCode: SYMBOL_CUSTOM_LIVE_ANALYSIS_DISABLED,
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
    riskConfig: getConfigObject(symbolCustom, 'riskConfig'),
    sessionFilter: getConfigObject(symbolCustom, 'sessionFilter'),
    newsFilter: getConfigObject(symbolCustom, 'newsFilter'),
    beConfig: getConfigObject(symbolCustom, 'beConfig'),
    entryConfig: getConfigObject(symbolCustom, 'entryConfig'),
    exitConfig: getConfigObject(symbolCustom, 'exitConfig'),
    candles,
    activeProfile: options.activeProfile,
    liveAnalysisAllowed: scope === 'live',
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
  const activePaperSymbolCustoms = Array.isArray(options.symbolCustoms)
    ? options.symbolCustoms.filter((symbolCustom) => symbolCustom.paperEnabled === true)
    : await listActivePaperSymbolCustoms();
  const signals = [];

  for (const symbolCustom of activePaperSymbolCustoms) {
    signals.push(await analyzeSymbolCustom(symbolCustom, getCandlesFn, {
      ...options,
      scope: 'paper',
    }));
  }

  return signals;
}

async function listActivePaperSymbolCustoms() {
  const symbolCustoms = await SymbolCustom.findAll({ paperEnabled: true });
  return symbolCustoms.filter((symbolCustom) => symbolCustom.paperEnabled === true);
}

module.exports = {
  SYMBOL_CUSTOM_LIVE_ANALYSIS_DISABLED,
  SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_2,
  SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1,
  SYMBOL_CUSTOM_LIVE_NOT_ENABLED,
  SYMBOL_CUSTOM_LIVE_NOT_ALLOWED,
  SYMBOL_CUSTOM_LIVE_STATUS_NOT_READY,
  SYMBOL_CUSTOM_LIVE_PARAMETERS_DISABLED,
  SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED,
  SYMBOL_CUSTOM_CONTEXT_INVALID,
  LIVE_READY_STATUSES,
  analyzeSymbolCustom,
  analyzeAllPaperSymbolCustoms,
  listActivePaperSymbolCustoms,
  buildSymbolCustomSignal,
  evaluateSymbolCustomLiveReadiness,
};
