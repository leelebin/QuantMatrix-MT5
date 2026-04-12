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
    this.signals = [];
    this.maxSignalHistory = 200;
    this.lastEmittedSignals = new Map();
    this._initStrategies();
  }

  _initStrategies() {
    this.strategies[STRATEGY_TYPES.TREND_FOLLOWING] = new TrendFollowingStrategy();
    this.strategies[STRATEGY_TYPES.MEAN_REVERSION] = new MeanReversionStrategy();
    this.strategies[STRATEGY_TYPES.MULTI_TIMEFRAME] = new MultiTimeframeStrategy();
    this.strategies[STRATEGY_TYPES.MOMENTUM] = new MomentumStrategy();
    this.strategies[STRATEGY_TYPES.BREAKOUT] = new BreakoutStrategy();
  }

  analyzeSymbol(symbol, candles, higherTfCandles = null, entryCandles = null) {
    const instrument = instruments[symbol];
    if (!instrument) {
      return { signal: 'NONE', symbol, strategy: null, reason: 'Unknown symbol' };
    }

    const strategy = this.strategies[instrument.strategyType];
    if (!strategy) {
      return { signal: 'NONE', symbol, strategy: null, reason: 'No strategy assigned' };
    }

    const closedCandles = candles.length > 1 ? candles.slice(0, -1) : [];
    const closedHigherTfCandles = higherTfCandles && higherTfCandles.length > 1
      ? higherTfCandles.slice(0, -1)
      : [];
    const closedEntryCandles = entryCandles && entryCandles.length > 1
      ? entryCandles.slice(0, -1)
      : [];

    if (closedCandles.length < 50) {
      return { signal: 'NONE', symbol, strategy: instrument.strategyType, reason: 'Need more closed candles' };
    }

    if (instrument.entryTimeframe && closedEntryCandles.length < 50) {
      return {
        signal: 'NONE',
        symbol,
        strategy: instrument.strategyType,
        reason: `Need more closed ${instrument.entryTimeframe} candles`,
      };
    }

    const ind = indicatorService.calculateAll(closedCandles);
    const entryInd = closedEntryCandles.length > 0 ? indicatorService.calculateAll(closedEntryCandles) : null;

    if (instrument.strategyType === STRATEGY_TYPES.MULTI_TIMEFRAME && closedHigherTfCandles.length > 0) {
      const htfCloses = closedHigherTfCandles.map((c) => c.close);
      const htfEma200 = indicatorService.ema(htfCloses, 200);
      const latestHtfEma = htfEma200.length > 0 ? htfEma200[htfEma200.length - 1] : null;
      const latestHtfPrice = closedHigherTfCandles[closedHigherTfCandles.length - 1].close;

      if (latestHtfEma) {
        const trend = latestHtfPrice > latestHtfEma ? 'BULLISH' : 'BEARISH';
        strategy.setHigherTimeframeTrend(trend, { ema200: latestHtfEma, price: latestHtfPrice });
      }
    }

    const result = strategy.analyze(closedCandles, ind, instrument, {
      higherTfCandles: closedHigherTfCandles,
      entryCandles: closedEntryCandles,
      entryIndicators: entryInd,
    });

    const analyzedCandle = closedCandles[closedCandles.length - 1];
    const latestEntryCandle = closedEntryCandles[closedEntryCandles.length - 1] || null;
    const signalRecord = {
      symbol,
      strategy: instrument.strategyType,
      signal: result.signal,
      confidence: result.confidence,
      sl: result.sl,
      tp: result.tp,
      reason: result.reason,
      indicatorsSnapshot: result.indicatorsSnapshot,
      setupTimeframe: result.setupTimeframe || instrument.timeframe || null,
      entryTimeframe: result.entryTimeframe || instrument.entryTimeframe || null,
      triggerReason: result.triggerReason || '',
      setupActive: result.setupActive === true,
      setupDirection: result.setupDirection || null,
      status: result.status || (result.signal !== 'NONE' ? 'TRIGGERED' : 'NO_SETUP'),
      setupCandleTime: result.setupCandleTime || analyzedCandle.time,
      entryCandleTime: result.entryCandleTime || latestEntryCandle?.time || null,
      timestamp: result.entryCandleTime || latestEntryCandle?.time || analyzedCandle.time,
      candleTime: analyzedCandle.time,
    };

    if (result.signal !== 'NONE' || result.setupActive) {
      const signalKey = [
        instrument.strategyType,
        signalRecord.status,
        signalRecord.setupDirection || result.signal,
        signalRecord.setupCandleTime || analyzedCandle.time,
        signalRecord.entryCandleTime || signalRecord.candleTime,
      ].join(':');

      if (this.lastEmittedSignals.get(symbol) === signalKey) {
        return {
          ...signalRecord,
          signal: 'NONE',
          confidence: 0,
          sl: 0,
          tp: 0,
          reason: 'Signal already processed for the latest setup/entry candle',
          indicatorsSnapshot: {},
          setupActive: false,
          status: 'DUPLICATE',
        };
      }

      this.lastEmittedSignals.set(symbol, signalKey);
      this.signals.unshift(signalRecord);
      if (this.signals.length > this.maxSignalHistory) {
        this.signals = this.signals.slice(0, this.maxSignalHistory);
      }
    }

    return signalRecord;
  }

  async analyzeAll(getCandlesFn, onSignalFn, enabledSymbols = null) {
    const symbolsToAnalyze = enabledSymbols || Object.keys(instruments);

    for (const symbol of symbolsToAnalyze) {
      try {
        const instrument = instruments[symbol];
        if (!instrument) continue;

        const candles = await getCandlesFn(symbol, instrument.timeframe, 251);
        if (!candles || candles.length < 50) {
          console.log(`[Engine] Insufficient data for ${symbol}: ${candles ? candles.length : 0} candles`);
          continue;
        }

        let higherTfCandles = null;
        if (instrument.higherTimeframe) {
          higherTfCandles = await getCandlesFn(symbol, instrument.higherTimeframe, 251);
        }

        let entryCandles = null;
        if (instrument.entryTimeframe) {
          entryCandles = await getCandlesFn(symbol, instrument.entryTimeframe, 251);
        }

        const result = this.analyzeSymbol(symbol, candles, higherTfCandles, entryCandles);

        if (result.signal !== 'NONE' && onSignalFn) {
          await onSignalFn(result);
        }
      } catch (err) {
        console.error(`[Engine] Error analyzing ${symbol}:`, err.message);
      }
    }
  }

  getRecentSignals(symbol = null, limit = 50) {
    let filtered = this.signals;
    if (symbol) {
      filtered = filtered.filter((s) => s.symbol === symbol);
    }
    return filtered.slice(0, limit);
  }

  getStrategiesInfo() {
    return Object.entries(this.strategies).map(([type, strategy]) => ({
      type,
      name: strategy.name,
      description: strategy.description,
      symbols: getInstrumentsByStrategy(type).map((i) => i.symbol),
    }));
  }
}

const strategyEngine = new StrategyEngine();

module.exports = strategyEngine;
