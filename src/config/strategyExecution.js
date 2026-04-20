const { getInstrument, STRATEGY_TYPES } = require('./instruments');

const STRATEGY_EXECUTION_DEFAULTS = {
  [STRATEGY_TYPES.TREND_FOLLOWING]: {
    timeframe: '1h',
    higherTimeframe: null,
    entryTimeframe: '15m',
  },
  [STRATEGY_TYPES.MEAN_REVERSION]: {
    timeframe: '1h',
    higherTimeframe: null,
    entryTimeframe: null,
  },
  [STRATEGY_TYPES.MULTI_TIMEFRAME]: {
    timeframe: '1h',
    higherTimeframe: '4h',
    entryTimeframe: '15m',
  },
  [STRATEGY_TYPES.MOMENTUM]: {
    timeframe: '1h',
    higherTimeframe: null,
    entryTimeframe: null,
  },
  [STRATEGY_TYPES.BREAKOUT]: {
    timeframe: '1h',
    higherTimeframe: null,
    entryTimeframe: null,
  },
  // VolumeFlowHybrid runs intraday on the setup TF (5m) with a lower TF
  // trigger (1m). Higher TF is optional context (15m). These are additive
  // and don't affect other strategies' configs.
  [STRATEGY_TYPES.VOLUME_FLOW_HYBRID]: {
    timeframe: '5m',
    higherTimeframe: '15m',
    entryTimeframe: '1m',
  },
};

function getStrategyExecutionConfig(symbol, strategyType) {
  const baseInstrument = getInstrument(symbol);
  if (!baseInstrument) {
    return null;
  }

  const executionDefaults = STRATEGY_EXECUTION_DEFAULTS[strategyType] || {};
  return {
    ...baseInstrument,
    strategyType,
    timeframe: executionDefaults.timeframe || baseInstrument.timeframe || '1h',
    higherTimeframe: Object.prototype.hasOwnProperty.call(executionDefaults, 'higherTimeframe')
      ? executionDefaults.higherTimeframe
      : baseInstrument.higherTimeframe || null,
    entryTimeframe: Object.prototype.hasOwnProperty.call(executionDefaults, 'entryTimeframe')
      ? executionDefaults.entryTimeframe
      : baseInstrument.entryTimeframe || null,
  };
}

// Allowed forced timeframes for batch backtest. Anything outside this list
// is rejected up the stack before fetching candles.
const FORCED_TIMEFRAME_OPTIONS = ['1m', '5m', '15m', '1h', '4h'];

// When forcing a primary timeframe we derive sensible higher / entry TFs
// one step up / one step down. null means "cannot be derived" — the caller
// should drop that role rather than silently substituting the default.
const HIGHER_TIMEFRAME_DERIVATION = {
  '1m': '5m',
  '5m': '15m',
  '15m': '1h',
  '1h': '4h',
  '4h': null,
};

const ENTRY_TIMEFRAME_DERIVATION = {
  '1m': null,
  '5m': '1m',
  '15m': '5m',
  '1h': '15m',
  '4h': '1h',
};

function isValidForcedTimeframe(tf) {
  return FORCED_TIMEFRAME_OPTIONS.includes(tf);
}

// Returns a modified execution config with the primary timeframe forced.
// Higher / entry roles are preserved (i.e. we do not invent a higher TF
// for strategies that don't use one) but re-derived consistently so the
// engine receives cohesive candle streams. If a role cannot be derived
// (e.g. entry TF for forced=1m), it is explicitly disabled rather than
// silently falling back to the strategy default — this prevents mixing
// a forced primary TF with a default lower TF.
function getForcedTimeframeExecutionConfig(symbol, strategyType, forcedTimeframe) {
  const base = getStrategyExecutionConfig(symbol, strategyType);
  if (!base) return null;
  if (!forcedTimeframe) return base;
  if (!isValidForcedTimeframe(forcedTimeframe)) {
    throw new Error(`Invalid forced timeframe: ${forcedTimeframe}`);
  }

  const higherTimeframe = base.higherTimeframe ? HIGHER_TIMEFRAME_DERIVATION[forcedTimeframe] : null;
  const entryTimeframe = base.entryTimeframe ? ENTRY_TIMEFRAME_DERIVATION[forcedTimeframe] : null;

  return {
    ...base,
    timeframe: forcedTimeframe,
    higherTimeframe,
    entryTimeframe,
    forcedTimeframe,
    higherTimeframeDisabled: base.higherTimeframe && !higherTimeframe ? base.higherTimeframe : null,
    entryTimeframeDisabled: base.entryTimeframe && !entryTimeframe ? base.entryTimeframe : null,
  };
}

module.exports = {
  STRATEGY_EXECUTION_DEFAULTS,
  FORCED_TIMEFRAME_OPTIONS,
  HIGHER_TIMEFRAME_DERIVATION,
  ENTRY_TIMEFRAME_DERIVATION,
  isValidForcedTimeframe,
  getStrategyExecutionConfig,
  getForcedTimeframeExecutionConfig,
};
