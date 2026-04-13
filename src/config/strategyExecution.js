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
