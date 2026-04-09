/**
 * Technical Indicator Service
 * Wraps the technicalindicators library for strategy use
 */

const { EMA, RSI, MACD, BollingerBands, ATR, Stochastic } = require('technicalindicators');

const indicatorService = {
  /**
   * Calculate EMA (Exponential Moving Average)
   * @param {number[]} closes - Closing prices
   * @param {number} period - EMA period
   * @returns {number[]}
   */
  ema(closes, period) {
    return EMA.calculate({ values: closes, period });
  },

  /**
   * Calculate RSI (Relative Strength Index)
   * @param {number[]} closes - Closing prices
   * @param {number} period - RSI period (default 14)
   * @returns {number[]}
   */
  rsi(closes, period = 14) {
    return RSI.calculate({ values: closes, period });
  },

  /**
   * Calculate MACD
   * @param {number[]} closes - Closing prices
   * @param {number} fastPeriod - Fast EMA period (default 12)
   * @param {number} slowPeriod - Slow EMA period (default 26)
   * @param {number} signalPeriod - Signal period (default 9)
   * @returns {Array<{MACD: number, signal: number, histogram: number}>}
   */
  macd(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    return MACD.calculate({
      values: closes,
      fastPeriod,
      slowPeriod,
      signalPeriod,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
  },

  /**
   * Calculate Bollinger Bands
   * @param {number[]} closes - Closing prices
   * @param {number} period - BB period (default 20)
   * @param {number} stdDev - Standard deviation multiplier (default 2)
   * @returns {Array<{upper: number, middle: number, lower: number, pb: number}>}
   */
  bollingerBands(closes, period = 20, stdDev = 2) {
    return BollingerBands.calculate({
      values: closes,
      period,
      stdDev,
    });
  },

  /**
   * Calculate ATR (Average True Range)
   * @param {Array<{high: number, low: number, close: number}>} candles
   * @param {number} period - ATR period (default 14)
   * @returns {number[]}
   */
  atr(candles, period = 14) {
    return ATR.calculate({
      high: candles.map((c) => c.high),
      low: candles.map((c) => c.low),
      close: candles.map((c) => c.close),
      period,
    });
  },

  /**
   * Calculate Stochastic Oscillator
   * @param {Array<{high: number, low: number, close: number}>} candles
   * @param {number} period - %K period (default 14)
   * @param {number} signalPeriod - %D period (default 3)
   * @returns {Array<{k: number, d: number}>}
   */
  stochastic(candles, period = 14, signalPeriod = 3) {
    return Stochastic.calculate({
      high: candles.map((c) => c.high),
      low: candles.map((c) => c.low),
      close: candles.map((c) => c.close),
      period,
      signalPeriod,
    });
  },

  /**
   * Calculate all indicators needed for strategy analysis
   * @param {Array<{open: number, high: number, low: number, close: number, time: string}>} candles
   * @returns {object} All indicator values
   */
  calculateAll(candles) {
    const closes = candles.map((c) => c.close);

    return {
      ema20: this.ema(closes, 20),
      ema50: this.ema(closes, 50),
      ema200: this.ema(closes, 200),
      rsi: this.rsi(closes, 14),
      macd: this.macd(closes),
      bollingerBands: this.bollingerBands(closes),
      atr: this.atr(candles),
      stochastic: this.stochastic(candles),
    };
  },

  /**
   * Get the latest value from an indicator array
   * @param {Array} values - Indicator values array
   * @param {number} offset - Offset from end (0 = latest)
   */
  latest(values, offset = 0) {
    if (!values || values.length === 0) return null;
    const idx = values.length - 1 - offset;
    return idx >= 0 ? values[idx] : null;
  },

  /**
   * Check if a crossover occurred (fast crosses above slow)
   * @param {number[]} fast - Fast series
   * @param {number[]} slow - Slow series
   * @returns {boolean}
   */
  crossOver(fast, slow) {
    if (fast.length < 2 || slow.length < 2) return false;
    const fLen = fast.length;
    const sLen = slow.length;
    return fast[fLen - 2] <= slow[sLen - 2] && fast[fLen - 1] > slow[sLen - 1];
  },

  /**
   * Check if a crossunder occurred (fast crosses below slow)
   * @param {number[]} fast - Fast series
   * @param {number[]} slow - Slow series
   * @returns {boolean}
   */
  crossUnder(fast, slow) {
    if (fast.length < 2 || slow.length < 2) return false;
    const fLen = fast.length;
    const sLen = slow.length;
    return fast[fLen - 2] >= slow[sLen - 2] && fast[fLen - 1] < slow[sLen - 1];
  },
};

module.exports = indicatorService;
