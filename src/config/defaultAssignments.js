/**
 * Central default strategy-symbol assignment map.
 *
 * Used in two places:
 *   1. First-time initialization (Strategy.initDefaults) – applied only when a
 *      strategy record does NOT yet exist in the database.
 *   2. Reset-to-default (Strategy.resetToDefaults) – applied only when the user
 *      explicitly triggers a reset via POST /api/strategies/assignments/reset.
 *
 * Existing database records are NEVER overwritten during normal startup.
 * Only the symbols array is affected by a reset; enabled flags, parameters, and
 * trade-management overrides are left untouched.
 *
 * Crypto assignments are additive — they appear alongside existing defaults
 * but do not displace any. Mean reversion is intentionally left without
 * crypto symbols because crypto ranges are unstable and whipsaw frequently.
 */

const DEFAULT_STRATEGY_SYMBOL_ASSIGNMENTS = {
  Breakout: [
    'GBPUSD', 'USDCHF', 'NZDUSD', 'XAUUSD', 'XAGUSD', 'NAS100', 'XTIUSD', 'XBRUSD',
    // Crypto: BTC/ETH/SOL/XRP/DOGE — strong intraday breakouts on news cycles
    'BTCUSD', 'ETHUSD', 'SOLUSD', 'XRPUSD', 'DOGEUSD',
  ],
  MeanReversion: ['SPX500', 'XTIUSD'],
  Momentum: [
    'GBPUSD', 'USDCHF', 'NZDUSD', 'XAUUSD', 'US30', 'NAS100',
    // Crypto: mid-caps that trend cleanly once direction is established
    'LTCUSD', 'BCHUSD', 'ADAUSD',
  ],
  MultiTimeframe: ['SPX500', 'NAS100', 'XTIUSD'],
  TrendFollowing: ['EURUSD', 'GBPUSD', 'USDCHF', 'NZDUSD'],
  VolumeFlowHybrid: ['XAUUSD', 'XAGUSD', 'XTIUSD', 'XBRUSD'],
};

module.exports = { DEFAULT_STRATEGY_SYMBOL_ASSIGNMENTS };
