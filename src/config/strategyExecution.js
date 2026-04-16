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

module.exports = {
  STRATEGY_EXECUTION_DEFAULTS,
  getStrategyExecutionConfig,
};
