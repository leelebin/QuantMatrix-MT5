/**
 * Base Strategy class
 * All strategies extend this class and implement the analyze() method
 *
 * Strategies may also:
 *   - Override buildExitPlan(instrument, signal, indicators, context) to define a
 *     default exitPlan snapshot embedded in every triggered signal.
 *   - Override evaluateExit(position, context) to return a runtime override
 *     (adaptive exit-plan) based on the current market state (volatility
 *     regime, indicator divergence, etc.). The position monitor merges the
 *     override on top of the position snapshot before executing BE/trail.
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
   * @returns {{ signal: 'BUY'|'SELL'|'NONE', confidence: number, sl: number, tp: number, reason: string, indicatorsSnapshot: object, exitPlan?: object }}
   */
  analyze(candles, indicators, instrument) {
    throw new Error('analyze() must be implemented by subclass');
  }

  /**
   * Build the default exitPlan snapshot for a triggered signal. Each strategy
   * should override this to supply parameters tuned to its TP profile.
   *
   * The returned object must match the shape normalized by
   * breakevenService.normalizeExitPlan().
   *
   * @returns {object|null}
   */
  // eslint-disable-next-line no-unused-vars
  buildExitPlan(instrument, signal, indicators, context = {}) {
    return null;
  }

  /**
   * Adaptive runtime hook invoked by the position monitor on every cycle.
   * Return a sparse exitPlan override (or null) to change BE/trail behaviour
   * based on current market state. Returning null leaves the snapshot intact.
   *
   * context may include:
   *   - candles: latest closed candles for the setup timeframe
   *   - indicators: indicator snapshot computed by indicatorService
   *   - instrument: the runtime instrument config
   *   - price: latest bid/ask used for PnL distance
   *
   * @returns {object|null}
   */
  // eslint-disable-next-line no-unused-vars
  evaluateExit(position, context = {}) {
    return null;
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
