/**
 * Trading instruments configuration
 * Defines all supported symbols, their properties, and assigned strategies
 */

const INSTRUMENT_CATEGORIES = {
  FOREX_MAJOR: 'forex_major',
  FOREX_CROSS: 'forex_cross',
  METALS: 'metals',
  INDICES: 'indices',
  ENERGY: 'energy',
};

const STRATEGY_TYPES = {
  TREND_FOLLOWING: 'TrendFollowing',
  MEAN_REVERSION: 'MeanReversion',
  MULTI_TIMEFRAME: 'MultiTimeframe',
  MOMENTUM: 'Momentum',
  BREAKOUT: 'Breakout',
};

const instruments = {
  // ─── Forex Majors (Trend Following) ───
  EURUSD: {
    symbol: 'EURUSD',
    category: INSTRUMENT_CATEGORIES.FOREX_MAJOR,
    strategyType: STRATEGY_TYPES.TREND_FOLLOWING,
    pipSize: 0.0001,
    pipValue: 10,       // per standard lot
    contractSize: 100000,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 1.2,        // average spread in pips
    timeframe: '1h',
    entryTimeframe: '15m',
    riskParams: { riskPercent: 0.01, slMultiplier: 1.5, tpMultiplier: 3 },
  },
  GBPUSD: {
    symbol: 'GBPUSD',
    category: INSTRUMENT_CATEGORIES.FOREX_MAJOR,
    strategyType: STRATEGY_TYPES.TREND_FOLLOWING,
    pipSize: 0.0001,
    pipValue: 10,
    contractSize: 100000,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 1.5,
    timeframe: '1h',
    entryTimeframe: '15m',
    riskParams: { riskPercent: 0.01, slMultiplier: 1.5, tpMultiplier: 3 },
  },
  USDJPY: {
    symbol: 'USDJPY',
    category: INSTRUMENT_CATEGORIES.FOREX_MAJOR,
    strategyType: STRATEGY_TYPES.TREND_FOLLOWING,
    pipSize: 0.01,
    pipValue: 6.7,      // approximate, varies with exchange rate
    contractSize: 100000,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 1.3,
    timeframe: '1h',
    entryTimeframe: '15m',
    riskParams: { riskPercent: 0.01, slMultiplier: 1.5, tpMultiplier: 3 },
  },
  AUDUSD: {
    symbol: 'AUDUSD',
    category: INSTRUMENT_CATEGORIES.FOREX_MAJOR,
    strategyType: STRATEGY_TYPES.TREND_FOLLOWING,
    pipSize: 0.0001,
    pipValue: 10,
    contractSize: 100000,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 1.4,
    timeframe: '1h',
    entryTimeframe: '15m',
    riskParams: { riskPercent: 0.01, slMultiplier: 1.5, tpMultiplier: 3 },
  },
  USDCHF: {
    symbol: 'USDCHF',
    category: INSTRUMENT_CATEGORIES.FOREX_MAJOR,
    strategyType: STRATEGY_TYPES.TREND_FOLLOWING,
    pipSize: 0.0001,
    pipValue: 10,
    contractSize: 100000,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 1.5,
    timeframe: '1h',
    entryTimeframe: '15m',
    riskParams: { riskPercent: 0.01, slMultiplier: 1.5, tpMultiplier: 3 },
  },
  USDCAD: {
    symbol: 'USDCAD',
    category: INSTRUMENT_CATEGORIES.FOREX_MAJOR,
    strategyType: STRATEGY_TYPES.TREND_FOLLOWING,
    pipSize: 0.0001,
    pipValue: 7.4,
    contractSize: 100000,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 1.6,
    timeframe: '1h',
    entryTimeframe: '15m',
    riskParams: { riskPercent: 0.01, slMultiplier: 1.5, tpMultiplier: 3 },
  },
  NZDUSD: {
    symbol: 'NZDUSD',
    category: INSTRUMENT_CATEGORIES.FOREX_MAJOR,
    strategyType: STRATEGY_TYPES.TREND_FOLLOWING,
    pipSize: 0.0001,
    pipValue: 10,
    contractSize: 100000,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 1.8,
    timeframe: '1h',
    entryTimeframe: '15m',
    riskParams: { riskPercent: 0.01, slMultiplier: 1.5, tpMultiplier: 3 },
  },

  // ─── Forex Crosses (Mean Reversion) ───
  EURJPY: {
    symbol: 'EURJPY',
    category: INSTRUMENT_CATEGORIES.FOREX_CROSS,
    strategyType: STRATEGY_TYPES.MEAN_REVERSION,
    pipSize: 0.01,
    pipValue: 6.7,
    contractSize: 100000,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 2.0,
    timeframe: '1h',
    riskParams: { riskPercent: 0.01, slMultiplier: 1.5, tpMultiplier: 2 },
  },
  GBPJPY: {
    symbol: 'GBPJPY',
    category: INSTRUMENT_CATEGORIES.FOREX_CROSS,
    strategyType: STRATEGY_TYPES.MEAN_REVERSION,
    pipSize: 0.01,
    pipValue: 6.7,
    contractSize: 100000,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 2.5,
    timeframe: '1h',
    riskParams: { riskPercent: 0.01, slMultiplier: 1.5, tpMultiplier: 2 },
  },
  EURGBP: {
    symbol: 'EURGBP',
    category: INSTRUMENT_CATEGORIES.FOREX_CROSS,
    strategyType: STRATEGY_TYPES.MEAN_REVERSION,
    pipSize: 0.0001,
    pipValue: 13,
    contractSize: 100000,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 1.8,
    timeframe: '1h',
    riskParams: { riskPercent: 0.01, slMultiplier: 1.5, tpMultiplier: 2 },
  },
  AUDNZD: {
    symbol: 'AUDNZD',
    category: INSTRUMENT_CATEGORIES.FOREX_CROSS,
    strategyType: STRATEGY_TYPES.MEAN_REVERSION,
    pipSize: 0.0001,
    pipValue: 6.5,
    contractSize: 100000,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 2.5,
    timeframe: '1h',
    riskParams: { riskPercent: 0.01, slMultiplier: 1.5, tpMultiplier: 2 },
  },

  // ─── Metals (Multi-Timeframe) ───
  XAUUSD: {
    symbol: 'XAUUSD',
    category: INSTRUMENT_CATEGORIES.METALS,
    strategyType: STRATEGY_TYPES.MULTI_TIMEFRAME,
    pipSize: 0.01,
    pipValue: 1,        // per 1 oz
    contractSize: 100,  // 100 oz per lot
    minLot: 0.01,
    lotStep: 0.01,
    spread: 25,         // in pips (0.25 USD)
    timeframe: '1h',
    higherTimeframe: '4h',
    entryTimeframe: '15m',
    riskParams: { riskPercent: 0.015, slMultiplier: 2, tpMultiplier: 5 },
  },
  XAGUSD: {
    symbol: 'XAGUSD',
    category: INSTRUMENT_CATEGORIES.METALS,
    strategyType: STRATEGY_TYPES.MULTI_TIMEFRAME,
    pipSize: 0.001,
    pipValue: 5,        // per 5000 oz lot
    contractSize: 5000,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 30,
    timeframe: '1h',
    higherTimeframe: '4h',
    entryTimeframe: '15m',
    riskParams: { riskPercent: 0.015, slMultiplier: 2.5, tpMultiplier: 5 },
  },

  // ─── Indices (Momentum) ───
  US30: {
    symbol: 'US30',
    category: INSTRUMENT_CATEGORIES.INDICES,
    strategyType: STRATEGY_TYPES.MOMENTUM,
    pipSize: 0.01,
    pipValue: 1,
    contractSize: 1,
    minLot: 0.1,
    lotStep: 0.1,
    spread: 3.0,
    timeframe: '1h',
    riskParams: { riskPercent: 0.01, slMultiplier: 1.5, tpMultiplier: 3 },
  },
  SPX500: {
    symbol: 'SPX500',
    category: INSTRUMENT_CATEGORIES.INDICES,
    strategyType: STRATEGY_TYPES.MOMENTUM,
    pipSize: 0.01,
    pipValue: 1,
    contractSize: 1,
    minLot: 0.1,
    lotStep: 0.1,
    spread: 0.8,
    timeframe: '1h',
    riskParams: { riskPercent: 0.01, slMultiplier: 1.5, tpMultiplier: 3 },
  },
  NAS100: {
    symbol: 'NAS100',
    category: INSTRUMENT_CATEGORIES.INDICES,
    strategyType: STRATEGY_TYPES.MOMENTUM,
    pipSize: 0.01,
    pipValue: 1,
    contractSize: 1,
    minLot: 0.1,
    lotStep: 0.1,
    spread: 1.5,
    timeframe: '1h',
    riskParams: { riskPercent: 0.01, slMultiplier: 1.5, tpMultiplier: 3 },
  },

  // ─── Energy (Breakout) ───
  XTIUSD: {
    symbol: 'XTIUSD',
    category: INSTRUMENT_CATEGORIES.ENERGY,
    strategyType: STRATEGY_TYPES.BREAKOUT,
    pipSize: 0.01,
    pipValue: 10,
    contractSize: 1000,  // barrels
    minLot: 0.01,
    lotStep: 0.01,
    spread: 4.0,
    timeframe: '1h',
    riskParams: { riskPercent: 0.01, slMultiplier: 2, tpMultiplier: 5 },
  },
  XBRUSD: {
    symbol: 'XBRUSD',
    category: INSTRUMENT_CATEGORIES.ENERGY,
    strategyType: STRATEGY_TYPES.BREAKOUT,
    pipSize: 0.01,
    pipValue: 10,
    contractSize: 1000,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 4.5,
    timeframe: '1h',
    riskParams: { riskPercent: 0.01, slMultiplier: 2, tpMultiplier: 5 },
  },
};

function getInstrumentsByCategory(category) {
  return Object.values(instruments).filter((i) => i.category === category);
}

function getInstrumentsByStrategy(strategyType) {
  return Object.values(instruments).filter((i) => i.strategyType === strategyType);
}

function getInstrument(symbol) {
  return instruments[symbol] || null;
}

function getAllSymbols() {
  return Object.keys(instruments);
}

module.exports = {
  instruments,
  INSTRUMENT_CATEGORIES,
  STRATEGY_TYPES,
  getInstrumentsByCategory,
  getInstrumentsByStrategy,
  getInstrument,
  getAllSymbols,
};
