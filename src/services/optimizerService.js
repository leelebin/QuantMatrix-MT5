/**
 * Strategy Parameter Optimizer
 * Grid search over parameter ranges using the backtest engine
 * Finds optimal parameter combinations for each strategy
 */

const indicatorService = require('./indicatorService');
const { getInstrument } = require('../config/instruments');
const { backtestsDb } = require('../config/db');
const TrendFollowingStrategy = require('../strategies/TrendFollowingStrategy');
const MeanReversionStrategy = require('../strategies/MeanReversionStrategy');
const MultiTimeframeStrategy = require('../strategies/MultiTimeframeStrategy');
const MomentumStrategy = require('../strategies/MomentumStrategy');
const BreakoutStrategy = require('../strategies/BreakoutStrategy');

const STRATEGY_MAP = {
  TrendFollowing: TrendFollowingStrategy,
  MeanReversion: MeanReversionStrategy,
  MultiTimeframe: MultiTimeframeStrategy,
  Momentum: MomentumStrategy,
  Breakout: BreakoutStrategy,
};

/**
 * Default parameter ranges for each strategy
 */
const DEFAULT_PARAM_RANGES = {
  TrendFollowing: {
    ema_fast: { min: 10, max: 30, step: 5 },
    ema_slow: { min: 40, max: 80, step: 10 },
    rsi_period: { min: 10, max: 20, step: 2 },
    slMultiplier: { min: 1.0, max: 2.5, step: 0.5 },
    tpMultiplier: { min: 2.0, max: 5.0, step: 0.5 },
  },
  MeanReversion: {
    bb_period: { min: 15, max: 30, step: 5 },
    bb_stddev: { min: 1.5, max: 2.5, step: 0.5 },
    rsi_oversold: { min: 20, max: 35, step: 5 },
    rsi_overbought: { min: 65, max: 80, step: 5 },
    slMultiplier: { min: 1.0, max: 2.5, step: 0.5 },
    tpMultiplier: { min: 1.5, max: 4.0, step: 0.5 },
  },
  Momentum: {
    ema_period: { min: 30, max: 70, step: 10 },
    rsi_period: { min: 10, max: 20, step: 2 },
    slMultiplier: { min: 1.0, max: 2.5, step: 0.5 },
    tpMultiplier: { min: 2.0, max: 5.0, step: 0.5 },
  },
  Breakout: {
    lookback_period: { min: 15, max: 30, step: 5 },
    body_multiplier: { min: 1.0, max: 2.5, step: 0.5 },
    slMultiplier: { min: 1.5, max: 3.0, step: 0.5 },
    tpMultiplier: { min: 3.0, max: 6.0, step: 0.5 },
  },
  MultiTimeframe: {
    stoch_period: { min: 10, max: 20, step: 2 },
    stoch_signal: { min: 3, max: 5, step: 1 },
    slMultiplier: { min: 1.5, max: 3.0, step: 0.5 },
    tpMultiplier: { min: 3.0, max: 6.0, step: 0.5 },
  },
};

class OptimizerService {
  constructor() {
    this.running = false;
    this.progress = null; // { current, total, percent, currentParams }
    this.lastResult = null;
  }

  /**
   * Generate all parameter combinations from ranges
   * @param {object} paramRanges - { paramName: { min, max, step } }
   * @returns {object[]} Array of parameter objects
   */
  _generateCombinations(paramRanges) {
    const paramNames = Object.keys(paramRanges);
    const paramValues = paramNames.map((name) => {
      const { min, max, step } = paramRanges[name];
      const values = [];
      for (let v = min; v <= max + step * 0.01; v += step) {
        values.push(parseFloat(v.toFixed(4)));
      }
      return values;
    });

    // Cartesian product
    const combinations = [];
    const generate = (idx, current) => {
      if (idx === paramNames.length) {
        combinations.push({ ...current });
        return;
      }
      for (const val of paramValues[idx]) {
        current[paramNames[idx]] = val;
        generate(idx + 1, current);
      }
    };
    generate(0, {});
    return combinations;
  }

  /**
   * Run a single backtest with custom parameters
   */
  _runSingleBacktest(strategy, candles, instrument, params, higherTfCandles = null) {
    const spread = instrument.spread * instrument.pipSize;
    const slippage = 0.5 * instrument.pipSize;
    let balance = 10000;
    let peakBalance = 10000;
    const trades = [];
    let openPosition = null;
    const warmupPeriod = 250;

    for (let i = warmupPeriod; i < candles.length; i++) {
      const currentCandle = candles[i];
      const historicalCandles = candles.slice(Math.max(0, i - 250), i + 1);
      const closes = historicalCandles.map((c) => c.close);

      // Build custom indicators based on params
      const ind = this._calculateIndicatorsWithParams(historicalCandles, closes, params);

      // Handle higher TF
      if (higherTfCandles && strategy.setHigherTimeframeTrend) {
        const htfCloses = higherTfCandles
          .filter((c) => new Date(c.time) <= new Date(currentCandle.time))
          .map((c) => c.close);
        const ema200Period = params.ema_trend || 200;
        const htfEma = indicatorService.ema(htfCloses, ema200Period);
        if (htfEma.length > 0) {
          const latestEma = htfEma[htfEma.length - 1];
          const latestPrice = htfCloses[htfCloses.length - 1];
          strategy.setHigherTimeframeTrend(
            latestPrice > latestEma ? 'BULLISH' : 'BEARISH',
            { ema200: latestEma, price: latestPrice }
          );
        }
      }

      // Check SL/TP on open position
      if (openPosition) {
        const hit = this._checkSlTp(openPosition, currentCandle);
        if (hit) {
          const trade = this._closeTrade(openPosition, hit.exitPrice, hit.reason, currentCandle.time, instrument);
          balance += trade.profitLoss;
          trades.push(trade);
          openPosition = null;
          if (balance > peakBalance) peakBalance = balance;
          continue;
        }

        // Trailing stop
        const atr = openPosition.atrAtEntry;
        if (atr > 0) {
          const currentPrice = openPosition.type === 'BUY' ? currentCandle.high : currentCandle.low;
          const profitDistance = openPosition.type === 'BUY'
            ? currentPrice - openPosition.entryPrice
            : openPosition.entryPrice - currentPrice;

          let newSl = openPosition.currentSl;
          if (openPosition.type === 'BUY') {
            if (profitDistance >= 1.5 * atr) newSl = currentPrice - atr;
            else if (profitDistance >= 1.0 * atr) newSl = openPosition.entryPrice + (spread);
            if (newSl > openPosition.currentSl) openPosition.currentSl = newSl;
          } else {
            if (profitDistance >= 1.5 * atr) newSl = currentPrice + atr;
            else if (profitDistance >= 1.0 * atr) newSl = openPosition.entryPrice - (spread);
            if (newSl < openPosition.currentSl) openPosition.currentSl = newSl;
          }
        }
      }

      // Generate signal if no position
      if (!openPosition) {
        // Override instrument risk params with optimizer params
        const testInstrument = {
          ...instrument,
          riskParams: {
            ...instrument.riskParams,
            slMultiplier: params.slMultiplier || instrument.riskParams.slMultiplier,
            tpMultiplier: params.tpMultiplier || instrument.riskParams.tpMultiplier,
          },
        };

        const result = strategy.analyze(historicalCandles, ind, testInstrument);

        if (result.signal !== 'NONE') {
          let entryPrice;
          if (result.signal === 'BUY') {
            entryPrice = currentCandle.close + spread / 2 + slippage;
          } else {
            entryPrice = currentCandle.close - spread / 2 - slippage;
          }

          const slDistance = Math.abs(entryPrice - result.sl);
          const slPips = slDistance / instrument.pipSize;
          const riskAmount = balance * (testInstrument.riskParams.riskPercent || 0.01);
          let lotSize = riskAmount / (slPips * instrument.pipValue);
          lotSize = Math.max(instrument.minLot, Math.floor(lotSize / instrument.lotStep) * instrument.lotStep);
          lotSize = Math.min(lotSize, 5.0);

          const currentAtr = ind.atr && ind.atr.length > 0 ? ind.atr[ind.atr.length - 1] : 0;

          openPosition = {
            id: trades.length + 1,
            type: result.signal,
            entryPrice,
            entryTime: currentCandle.time,
            sl: result.sl,
            tp: result.tp,
            currentSl: result.sl,
            lotSize,
            atrAtEntry: currentAtr,
            reason: result.reason,
          };
        }
      }
    }

    // Close remaining position
    if (openPosition) {
      const lastCandle = candles[candles.length - 1];
      const exitPrice = openPosition.type === 'BUY' ? lastCandle.close - spread / 2 : lastCandle.close + spread / 2;
      const trade = this._closeTrade(openPosition, exitPrice, 'END_OF_DATA', lastCandle.time, instrument);
      balance += trade.profitLoss;
      trades.push(trade);
    }

    return this._generateSummary(trades, 10000, balance, peakBalance);
  }

  /**
   * Calculate indicators with custom parameters
   */
  _calculateIndicatorsWithParams(candles, closes, params) {
    return {
      ema20: indicatorService.ema(closes, params.ema_fast || 20),
      ema50: indicatorService.ema(closes, params.ema_slow || 50),
      ema200: indicatorService.ema(closes, params.ema_trend || 200),
      rsi: indicatorService.rsi(closes, params.rsi_period || 14),
      macd: indicatorService.macd(closes, params.macd_fast || 12, params.macd_slow || 26, params.macd_signal || 9),
      bollingerBands: indicatorService.bollingerBands(closes, params.bb_period || 20, params.bb_stddev || 2),
      atr: indicatorService.atr(candles, params.atr_period || 14),
      stochastic: indicatorService.stochastic(candles, params.stoch_period || 14, params.stoch_signal || 3),
    };
  }

  _checkSlTp(position, candle) {
    if (position.type === 'BUY') {
      if (candle.low <= position.currentSl) return { exitPrice: position.currentSl, reason: 'SL_HIT' };
      if (candle.high >= position.tp) return { exitPrice: position.tp, reason: 'TP_HIT' };
    } else {
      if (candle.high >= position.currentSl) return { exitPrice: position.currentSl, reason: 'SL_HIT' };
      if (candle.low <= position.tp) return { exitPrice: position.tp, reason: 'TP_HIT' };
    }
    return null;
  }

  _closeTrade(position, exitPrice, reason, exitTime, instrument) {
    const priceDiff = position.type === 'BUY' ? exitPrice - position.entryPrice : position.entryPrice - exitPrice;
    const profitPips = priceDiff / instrument.pipSize;
    const profitLoss = priceDiff * position.lotSize * instrument.contractSize;
    return {
      id: position.id,
      type: position.type,
      entryPrice: position.entryPrice,
      exitPrice,
      profitPips: parseFloat(profitPips.toFixed(1)),
      profitLoss: parseFloat(profitLoss.toFixed(2)),
      exitReason: reason,
    };
  }

  _generateSummary(trades, initialBalance, finalBalance, peakBalance) {
    if (trades.length === 0) {
      return { totalTrades: 0, winRate: 0, profitFactor: 0, returnPercent: 0, sharpeRatio: 0, maxDrawdownPercent: 0 };
    }
    const winners = trades.filter((t) => t.profitPips > 0);
    const totalProfitMoney = winners.reduce((s, t) => s + t.profitLoss, 0);
    const losers = trades.filter((t) => t.profitPips <= 0);
    const totalLossMoney = losers.reduce((s, t) => s + Math.abs(t.profitLoss), 0);

    let peak = initialBalance, maxDD = 0, running = initialBalance;
    for (const t of trades) {
      running += t.profitLoss;
      if (running > peak) peak = running;
      const dd = (peak - running) / peak;
      if (dd > maxDD) maxDD = dd;
    }

    const returns = trades.map((t) => t.profitLoss / initialBalance);
    const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
    const stdReturn = Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / returns.length);
    const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

    return {
      totalTrades: trades.length,
      winningTrades: winners.length,
      losingTrades: losers.length,
      winRate: parseFloat((winners.length / trades.length).toFixed(4)),
      profitFactor: totalLossMoney > 0 ? parseFloat((totalProfitMoney / totalLossMoney).toFixed(2)) : totalProfitMoney > 0 ? 999 : 0,
      returnPercent: parseFloat(((finalBalance - initialBalance) / initialBalance * 100).toFixed(2)),
      netProfitMoney: parseFloat((finalBalance - initialBalance).toFixed(2)),
      maxDrawdownPercent: parseFloat((maxDD * 100).toFixed(2)),
      sharpeRatio: parseFloat(sharpe.toFixed(2)),
    };
  }

  /**
   * Run optimizer
   * @param {object} params
   * @param {string} params.symbol
   * @param {string} params.strategyType
   * @param {Array} params.candles - Historical candles
   * @param {Array} params.higherTfCandles - Higher TF candles (optional)
   * @param {object} params.paramRanges - Custom parameter ranges (optional)
   * @param {string} params.optimizeFor - Metric to optimize: 'profitFactor', 'sharpeRatio', 'returnPercent', 'winRate'
   * @param {Function} params.onProgress - Progress callback
   */
  async run(params) {
    const {
      symbol,
      strategyType,
      candles,
      higherTfCandles = null,
      paramRanges = null,
      optimizeFor = 'profitFactor',
    } = params;

    if (this.running) {
      throw new Error('Optimizer is already running');
    }

    const instrument = getInstrument(symbol);
    if (!instrument) throw new Error(`Unknown symbol: ${symbol}`);

    const StrategyClass = STRATEGY_MAP[strategyType];
    if (!StrategyClass) throw new Error(`Unknown strategy: ${strategyType}`);

    const ranges = paramRanges || DEFAULT_PARAM_RANGES[strategyType];
    if (!ranges) throw new Error(`No parameter ranges for strategy: ${strategyType}`);

    this.running = true;
    const combinations = this._generateCombinations(ranges);
    const totalCombinations = combinations.length;

    console.log(`[Optimizer] Starting grid search: ${symbol} ${strategyType} | ${totalCombinations} combinations`);

    const results = [];

    for (let i = 0; i < combinations.length; i++) {
      const combo = combinations[i];

      this.progress = {
        current: i + 1,
        total: totalCombinations,
        percent: parseFloat(((i + 1) / totalCombinations * 100).toFixed(1)),
        currentParams: combo,
      };

      try {
        const strategy = new StrategyClass();
        const summary = this._runSingleBacktest(strategy, candles, instrument, combo, higherTfCandles);

        if (summary.totalTrades >= 5) { // Need at least 5 trades to be meaningful
          results.push({
            parameters: combo,
            summary,
          });
        }
      } catch (err) {
        // Skip failed combinations
      }

      // Yield to event loop every 10 iterations
      if (i % 10 === 0) {
        await new Promise((r) => setImmediate(r));
      }
    }

    // Sort by optimization metric
    results.sort((a, b) => {
      const valA = a.summary[optimizeFor] || 0;
      const valB = b.summary[optimizeFor] || 0;
      return valB - valA;
    });

    const optimizerResult = {
      symbol,
      strategy: strategyType,
      totalCombinations,
      validResults: results.length,
      optimizeFor,
      bestResult: results[0] || null,
      top10: results.slice(0, 10),
      allResults: results,
      completedAt: new Date().toISOString(),
    };

    this.lastResult = optimizerResult;
    this.running = false;
    this.progress = null;

    console.log(
      `[Optimizer] Complete: ${results.length} valid results from ${totalCombinations} combinations`
      + (results[0] ? ` | Best ${optimizeFor}: ${results[0].summary[optimizeFor]}` : '')
    );

    return optimizerResult;
  }

  /**
   * Get current optimizer progress
   */
  getProgress() {
    return {
      running: this.running,
      progress: this.progress,
    };
  }

  /**
   * Get last optimizer result
   */
  getLastResult() {
    return this.lastResult;
  }

  /**
   * Get default parameter ranges for a strategy
   */
  getDefaultRanges(strategyType) {
    return DEFAULT_PARAM_RANGES[strategyType] || null;
  }
}

const optimizerService = new OptimizerService();

module.exports = optimizerService;
