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
  // ─── Additive: crypto basket ─────────────────────────────────────────────
  // Category for spot-style crypto CFDs (BTCUSD, ETHUSD, ...). Treated as
  // its own risk bucket so the category correlation limit in riskManager
  // does not mix crypto exposure with forex/metals. Existing categories are
  // unchanged.
  CRYPTO: 'crypto',
};

const STRATEGY_TYPES = {
  TREND_FOLLOWING: 'TrendFollowing',
  MEAN_REVERSION: 'MeanReversion',
  MULTI_TIMEFRAME: 'MultiTimeframe',
  MOMENTUM: 'Momentum',
  BREAKOUT: 'Breakout',
  // ─── Additive: volume / order-flow driven hybrid for metals + oil ───
  // Added as a separate strategy type so it can be toggled independently
  // of the existing strategies. Existing instrument strategyType mappings
  // are unchanged; the default symbols for this strategy are tracked via
  // VOLUME_FLOW_HYBRID_DEFAULT_SYMBOLS below.
  VOLUME_FLOW_HYBRID: 'VolumeFlowHybrid',
};

/**
 * Default symbol assignments for the additive VolumeFlowHybrid strategy.
 * These are the symbols the strategy is registered to cover at startup
 * (new enabled-by-default list). They are intentionally the metals + oil
 * basket the strategy is tuned for. Indices are optional and opt-in —
 * they can be enabled from the Strategies page.
 */
const VOLUME_FLOW_HYBRID_DEFAULT_SYMBOLS = ['XAUUSD', 'XAGUSD', 'XTIUSD', 'XBRUSD'];
const VOLUME_FLOW_HYBRID_OPTIONAL_SYMBOLS = ['US30', 'NAS100', 'SPX500'];

/**
 * Default symbols for the crypto basket. These appear in the Strategies
 * grid, backtest selectors, batch-backtest scope, and diagnostics filters
 * automatically (all symbol lists are derived from `instruments` below).
 *
 * Conservative strategy assignment — mean reversion is avoided for crypto.
 *   - BTCUSD / ETHUSD         → Breakout (strongest trending majors)
 *   - SOLUSD / XRPUSD / DOGEUSD → Breakout (event/momentum driven)
 *   - LTCUSD / BCHUSD / ADAUSD → Momentum (cleaner intraday swings)
 */
const CRYPTO_DEFAULT_SYMBOLS = [
  'BTCUSD', 'ETHUSD', 'LTCUSD', 'XRPUSD',
  'BCHUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD',
];

/**
 * Broker-symbol alias resolution map.
 *
 * Keys are canonical, stable-for-UI names used everywhere in the app and
 * database (strategies/positions/backtests). Values are ordered lists of
 * possible broker-side names to try at MT5 connect time. The first name
 * that MT5 returns a `symbol_info` for is cached as the resolved broker
 * name for that canonical key. If nothing matches the symbol is marked
 * unresolved and any live/paper call that would hit MT5 is blocked by the
 * symbol resolver rather than reaching the bridge (see symbolResolver).
 *
 * How to override for a specific broker (recommended — do not edit this
 * file): set environment variable QM_SYMBOL_ALIAS_BTCUSD to a comma-
 * separated list, e.g.
 *
 *   QM_SYMBOL_ALIAS_BTCUSD=BTCUSD.a,BTCUSDT,BTCUSD
 *
 * The resolver prepends env-override candidates to the built-in list.
 */
const CRYPTO_SYMBOL_ALIASES = {
  BTCUSD: ['BTCUSD', 'BTCUSDm', 'BTCUSD.a', 'BTCUSD.r', 'BTCUSDT', 'BTCUSD.', 'BTC/USD'],
  ETHUSD: ['ETHUSD', 'ETHUSDm', 'ETHUSD.a', 'ETHUSD.r', 'ETHUSDT', 'ETHUSD.', 'ETH/USD'],
  LTCUSD: ['LTCUSD', 'LTCUSDm', 'LTCUSD.a', 'LTCUSD.r', 'LTCUSDT', 'LTCUSD.', 'LTC/USD'],
  XRPUSD: ['XRPUSD', 'XRPUSDm', 'XRPUSD.a', 'XRPUSD.r', 'XRPUSDT', 'XRPUSD.', 'XRP/USD'],
  BCHUSD: ['BCHUSD', 'BCHUSDm', 'BCHUSD.a', 'BCHUSD.r', 'BCHUSDT', 'BCHUSD.', 'BCH/USD'],
  SOLUSD: ['SOLUSD', 'SOLUSDm', 'SOLUSD.a', 'SOLUSD.r', 'SOLUSDT', 'SOLUSD.', 'SOL/USD'],
  ADAUSD: ['ADAUSD', 'ADAUSDm', 'ADAUSD.a', 'ADAUSD.r', 'ADAUSDT', 'ADAUSD.', 'ADA/USD'],
  DOGEUSD: ['DOGEUSD', 'DOGEUSDm', 'DOGEUSD.a', 'DOGEUSD.r', 'DOGEUSDT', 'DOGEUSD.', 'DOGE/USD'],
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
    pipValue: 0.1,
    contractSize: 10,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 3.0,
    timeframe: '1h',
    riskParams: { riskPercent: 0.01, slMultiplier: 1.5, tpMultiplier: 3 },
  },
  SPX500: {
    symbol: 'SPX500',
    category: INSTRUMENT_CATEGORIES.INDICES,
    strategyType: STRATEGY_TYPES.MOMENTUM,
    pipSize: 0.01,
    pipValue: 0.1,
    contractSize: 10,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 0.8,
    timeframe: '1h',
    riskParams: { riskPercent: 0.01, slMultiplier: 1.5, tpMultiplier: 3 },
  },
  NAS100: {
    symbol: 'NAS100',
    category: INSTRUMENT_CATEGORIES.INDICES,
    strategyType: STRATEGY_TYPES.MOMENTUM,
    pipSize: 0.01,
    pipValue: 0.1,
    contractSize: 10,
    minLot: 0.01,
    lotStep: 0.01,
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

  // ─── Crypto (Breakout / Momentum) ──────────────────────────────────────
  //
  // Crypto sizing below is aligned to the current MT5 broker profile.
  // Live/paper lot sizing now also asks MT5 to calculate broker-side
  // P/L directly, so these defaults mainly keep backtests and diagnostics
  // close to the live contract spec.
  // Conservative defaults:
  //   - riskPercent 0.008 (slightly below the forex 0.01 default)
  //   - slMultiplier 2.5, tpMultiplier 4 (wider stops, asymmetric RR)
  //   - spread in pips = ceil(typical broker spread / pipSize)
  // timeframe 1h with a 15m entry trigger keeps crypto on the same cycle
  // as forex majors so existing indicator buffers and loop cadence work
  // unchanged. See src/config/strategyExecution.js for per-strategy TFs.
  BTCUSD: {
    symbol: 'BTCUSD',
    category: INSTRUMENT_CATEGORIES.CRYPTO,
    strategyType: STRATEGY_TYPES.BREAKOUT,
    pipSize: 0.01,
    pipValue: 0.01,     // $0.01 per 1-lot (1 BTC) per 1-pip (0.01 USD) move
    contractSize: 1,    // 1 lot = 1 BTC (verify with broker)
    minLot: 0.01,
    lotStep: 0.01,
    spread: 5000,       // ~$50 in pips of 0.01
    timeframe: '1h',
    entryTimeframe: '15m',
    riskParams: { riskPercent: 0.008, slMultiplier: 2.5, tpMultiplier: 4 },
  },
  ETHUSD: {
    symbol: 'ETHUSD',
    category: INSTRUMENT_CATEGORIES.CRYPTO,
    strategyType: STRATEGY_TYPES.BREAKOUT,
    pipSize: 0.01,
    pipValue: 0.1,
    contractSize: 10,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 300,        // ~$3
    timeframe: '1h',
    entryTimeframe: '15m',
    riskParams: { riskPercent: 0.008, slMultiplier: 2.5, tpMultiplier: 4 },
  },
  LTCUSD: {
    symbol: 'LTCUSD',
    category: INSTRUMENT_CATEGORIES.CRYPTO,
    strategyType: STRATEGY_TYPES.MOMENTUM,
    pipSize: 0.01,
    pipValue: 1,
    contractSize: 100,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 50,         // ~$0.50
    timeframe: '1h',
    riskParams: { riskPercent: 0.008, slMultiplier: 2.5, tpMultiplier: 4 },
  },
  XRPUSD: {
    symbol: 'XRPUSD',
    category: INSTRUMENT_CATEGORIES.CRYPTO,
    strategyType: STRATEGY_TYPES.BREAKOUT,
    pipSize: 0.00001,
    pipValue: 0.5,
    contractSize: 50000,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 300,        // ~$0.003
    timeframe: '1h',
    riskParams: { riskPercent: 0.008, slMultiplier: 2.5, tpMultiplier: 4 },
  },
  BCHUSD: {
    symbol: 'BCHUSD',
    category: INSTRUMENT_CATEGORIES.CRYPTO,
    strategyType: STRATEGY_TYPES.MOMENTUM,
    pipSize: 0.01,
    pipValue: 0.1,
    contractSize: 10,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 150,        // ~$1.50
    timeframe: '1h',
    riskParams: { riskPercent: 0.008, slMultiplier: 2.5, tpMultiplier: 4 },
  },
  SOLUSD: {
    symbol: 'SOLUSD',
    category: INSTRUMENT_CATEGORIES.CRYPTO,
    strategyType: STRATEGY_TYPES.BREAKOUT,
    pipSize: 0.01,
    pipValue: 1,
    contractSize: 100,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 30,         // ~$0.30
    timeframe: '1h',
    entryTimeframe: '15m',
    riskParams: { riskPercent: 0.008, slMultiplier: 2.5, tpMultiplier: 4 },
  },
  ADAUSD: {
    symbol: 'ADAUSD',
    category: INSTRUMENT_CATEGORIES.CRYPTO,
    strategyType: STRATEGY_TYPES.MOMENTUM,
    pipSize: 0.00001,
    pipValue: 0.1,
    contractSize: 10000,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 200,        // ~$0.002
    timeframe: '1h',
    riskParams: { riskPercent: 0.008, slMultiplier: 2.5, tpMultiplier: 4 },
  },
  DOGEUSD: {
    symbol: 'DOGEUSD',
    category: INSTRUMENT_CATEGORIES.CRYPTO,
    strategyType: STRATEGY_TYPES.BREAKOUT,
    pipSize: 0.00001,
    pipValue: 1,
    contractSize: 100000,
    minLot: 0.01,
    lotStep: 0.01,
    spread: 200,        // ~$0.002
    timeframe: '1h',
    riskParams: { riskPercent: 0.008, slMultiplier: 2.5, tpMultiplier: 4 },
  },
};

function getInstrumentsByCategory(category) {
  return Object.values(instruments).filter((i) => i.category === category);
}

function getInstrumentsByStrategy(strategyType) {
  // The VolumeFlowHybrid strategy is additive — it is not assigned via each
  // instrument's primary `strategyType` field, so resolve it against the
  // dedicated default list instead.
  if (strategyType === STRATEGY_TYPES.VOLUME_FLOW_HYBRID) {
    return VOLUME_FLOW_HYBRID_DEFAULT_SYMBOLS
      .map((symbol) => instruments[symbol])
      .filter(Boolean);
  }
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
  VOLUME_FLOW_HYBRID_DEFAULT_SYMBOLS,
  VOLUME_FLOW_HYBRID_OPTIONAL_SYMBOLS,
  CRYPTO_DEFAULT_SYMBOLS,
  CRYPTO_SYMBOL_ALIASES,
  getInstrumentsByCategory,
  getInstrumentsByStrategy,
  getInstrument,
  getAllSymbols,
};
