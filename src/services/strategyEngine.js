/**
 * Strategy Engine
 * Manages strategy lifecycle, fetches data, calculates indicators, runs strategies
 */

const indicatorService = require('./indicatorService');
const { instruments, getInstrumentsByStrategy, STRATEGY_TYPES } = require('../config/instruments');
const TrendFollowingStrategy = require('../strategies/TrendFollowingStrategy');
const MeanReversionStrategy = require('../strategies/MeanReversionStrategy');
const MultiTimeframeStrategy = require('../strategies/MultiTimeframeStrategy');
const MomentumStrategy = require('../strategies/MomentumStrategy');
const BreakoutStrategy = require('../strategies/BreakoutStrategy');

class StrategyEngine {
  constructor() {
    this.strategies = {};
    this.running = false;
    this.interval = null;
    this.signals = [];       // Recent signals log
    this.maxSignalHistory = 200;
    this._initStrategies();
  }

  _initStrategies() {
    this.strategies[STRATEGY_TYPES.TREND_FOLLOWING] = new TrendFollowingStrategy();
    this.strategies[STRATEGY_TYPES.MEAN_REVERSION] = new MeanReversionStrategy();
    this.strategies[STRATEGY_TYPES.MULTI_TIMEFRAME] = new MultiTimeframeStrategy();
    this.strategies[STRATEGY_TYPES.MOMENTUM] = new MomentumStrategy();
    this.strategies[STRATEGY_TYPES.BREAKOUT] = new BreakoutStrategy();
  }

  /**
   * Run analysis for a single symbol
   * @param {string} symbol - Trading symbol
   * @param {Array} candles - OHLC candle data
   * @param {Array} higherTfCandles - Higher TF candles (for multi-timeframe strategy)
   * @returns {{ signal, symbol, strategy, timestamp }}
   */
  analyzeSymbol(symbol, candles, higherTfCandles = null) {
    const instrument = instruments[symbol];
    if (!instrument) {
      return { signal: 'NONE', symbol, strategy: null, reason: 'Unknown symbol' };
    }

    const strategy = this.strategies[instrument.strategyType];
    if (!strategy) {
      return { signal: 'NONE', symbol, strategy: null, reason: 'No strategy assigned' };
    }

    // Calculate indicators
    const ind = indicatorService.calculateAll(candles);

    // For multi-timeframe strategy, set higher TF trend
    if (instrument.strategyType === STRATEGY_TYPES.MULTI_TIMEFRAME && higherTfCandles) {
      const htfCloses = higherTfCandles.map((c) => c.close);
      const htfEma200 = indicatorService.ema(htfCloses, 200);
      const latestHtfEma = htfEma200.length > 0 ? htfEma200[htfEma200.length - 1] : null;
      const latestHtfPrice = higherTfCandles[higherTfCandles.length - 1].close;

      if (latestHtfEma) {
        const trend = latestHtfPrice > latestHtfEma ? 'BULLISH' : 'BEARISH';
        strategy.setHigherTimeframeTrend(trend, { ema200: latestHtfEma, price: latestHtfPrice });
      }
    }

    const result = strategy.analyze(candles, ind, instrument);

    const signalRecord = {
      symbol,
      strategy: instrument.strategyType,
      signal: result.signal,
      confidence: result.confidence,
      sl: result.sl,
      tp: result.tp,
      reason: result.reason,
      indicatorsSnapshot: result.indicatorsSnapshot,
      timestamp: new Date().toISOString(),
    };

    // Store signal in history
    if (result.signal !== 'NONE') {
      this.signals.unshift(signalRecord);
      if (this.signals.length > this.maxSignalHistory) {
        this.signals = this.signals.slice(0, this.maxSignalHistory);
      }
    }

    return signalRecord;
  }

  /**
   * Run analysis for all enabled symbols
   * @param {Function} getCandlesFn - async (symbol, timeframe, count) => candles[]
   * @param {Function} onSignalFn - async (signalRecord) => void
   * @param {string[]} enabledSymbols - List of symbols to analyze
   */
  async analyzeAll(getCandlesFn, onSignalFn, enabledSymbols = null) {
    const symbolsToAnalyze = enabledSymbols || Object.keys(instruments);

    for (const symbol of symbolsToAnalyze) {
      try {
        const instrument = instruments[symbol];
        if (!instrument) continue;

        const candles = await getCandlesFn(symbol, instrument.timeframe, 250);
        if (!candles || candles.length < 50) {
          console.log(`[Engine] Insufficient data for ${symbol}: ${candles ? candles.length : 0} candles`);
          continue;
        }

        // Get higher TF candles for metals
        let higherTfCandles = null;
        if (instrument.higherTimeframe) {
          higherTfCandles = await getCandlesFn(symbol, instrument.higherTimeframe, 250);
        }

        const result = this.analyzeSymbol(symbol, candles, higherTfCandles);

        if (result.signal !== 'NONE' && onSignalFn) {
          await onSignalFn(result);
        }
      } catch (err) {
        console.error(`[Engine] Error analyzing ${symbol}:`, err.message);
      }
    }
  }

  /**
   * Get recent signals
   * @param {string} symbol - Optional filter by symbol
   * @param {number} limit - Max signals to return
   */
  getRecentSignals(symbol = null, limit = 50) {
    let filtered = this.signals;
    if (symbol) {
      filtered = filtered.filter((s) => s.symbol === symbol);
    }
    return filtered.slice(0, limit);
  }

  /**
   * Get strategy info
   */
  getStrategiesInfo() {
    return Object.entries(this.strategies).map(([type, strategy]) => ({
      type,
      name: strategy.name,
      description: strategy.description,
      symbols: getInstrumentsByStrategy(type).map((i) => i.symbol),
    }));
  }
}

// Singleton
const strategyEngine = new StrategyEngine();

module.exports = strategyEngine;
