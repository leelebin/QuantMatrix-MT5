/**
 * Base Strategy class
 * All strategies extend this class and implement the analyze() method
 */

class BaseStrategy {
  constructor(name, description) {
    this.name = name;
    this.description = description;
  }

  /**
   * Analyze candles and indicators to produce a trading signal
   * @param {Array} candles - OHLC candle data
   * @param {object} indicators - Pre-calculated indicator values
   * @param {object} instrument - Instrument configuration
   * @returns {{ signal: 'BUY'|'SELL'|'NONE', confidence: number, sl: number, tp: number, reason: string, indicatorsSnapshot: object }}
   */
  analyze(candles, indicators, instrument) {
    throw new Error('analyze() must be implemented by subclass');
  }

  /**
   * Helper: get latest candle
   */
  latestCandle(candles) {
    return candles[candles.length - 1];
  }

  /**
   * Helper: get previous candle
   */
  prevCandle(candles) {
    return candles[candles.length - 2];
  }

  /**
   * Helper: get latest indicator value
   */
  latest(arr, offset = 0) {
    if (!arr || arr.length === 0) return null;
    const idx = arr.length - 1 - offset;
    return idx >= 0 ? arr[idx] : null;
  }

  /**
   * Helper: calculate average of last N values
   */
  average(arr, n) {
    if (!arr || arr.length < n) return null;
    const slice = arr.slice(-n);
    return slice.reduce((sum, v) => sum + v, 0) / n;
  }

  /**
   * Helper: get resolved strategy parameters from context
   */
  getStrategyParameters(context = {}) {
    return context.strategyParams || {};
  }

  /**
   * Helper: build a no-signal response
   */
  noSignal(extra = {}) {
    return {
      signal: 'NONE',
      confidence: 0,
      sl: 0,
      tp: 0,
      reason: '',
      indicatorsSnapshot: {},
      marketQualityScore: 0,
      marketQualityThreshold: 0,
      marketQualityDetails: {},
      filterReason: '',
      setupTimeframe: null,
      entryTimeframe: null,
      triggerReason: '',
      setupActive: false,
      setupDirection: null,
      status: 'NO_SETUP',
      ...extra,
    };
  }
}

module.exports = BaseStrategy;
