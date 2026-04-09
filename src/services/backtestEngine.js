/**
 * Backtest Engine
 * Simulates strategy execution on historical data
 * Outputs machine-readable JSON for analysis and strategy tuning
 */

const indicatorService = require('./indicatorService');
const { instruments, getInstrument } = require('../config/instruments');
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

class BacktestEngine {
  /**
   * Run a backtest
   * @param {object} params
   * @param {string} params.symbol - Trading symbol
   * @param {string} params.strategyType - Strategy name
   * @param {string} params.timeframe - Candle timeframe
   * @param {Array} params.candles - Historical OHLC data
   * @param {Array} [params.higherTfCandles] - Higher TF candles for multi-timeframe
   * @param {number} [params.initialBalance=10000] - Starting balance
   * @param {number} [params.spreadPips=0] - Simulated spread in pips (0 = use instrument default)
   * @param {number} [params.slippagePips=0.5] - Simulated slippage in pips
   * @returns {object} Backtest result
   */
  async run(params) {
    const {
      symbol,
      strategyType,
      timeframe,
      candles,
      higherTfCandles = null,
      initialBalance = 10000,
      spreadPips = 0,
      slippagePips = 0.5,
    } = params;

    const instrument = getInstrument(symbol);
    if (!instrument) throw new Error(`Unknown symbol: ${symbol}`);

    const StrategyClass = STRATEGY_MAP[strategyType];
    if (!StrategyClass) throw new Error(`Unknown strategy: ${strategyType}`);

    const strategy = new StrategyClass();
    const spread = (spreadPips || instrument.spread) * instrument.pipSize;
    const slippage = slippagePips * instrument.pipSize;

    // Simulation state
    let balance = initialBalance;
    let equity = initialBalance;
    let peakBalance = initialBalance;
    const trades = [];
    const equityCurve = [{ time: candles[0]?.time || '', equity: initialBalance }];
    let openPosition = null;
    const warmupPeriod = 250; // Need enough data for indicators

    // Process candles sequentially
    for (let i = warmupPeriod; i < candles.length; i++) {
      const currentCandle = candles[i];
      const historicalCandles = candles.slice(Math.max(0, i - 250), i + 1);

      // Calculate indicators
      const ind = indicatorService.calculateAll(historicalCandles);

      // Handle higher TF for multi-timeframe strategy
      if (strategyType === 'MultiTimeframe' && higherTfCandles) {
        const htfCloses = higherTfCandles
          .filter((c) => new Date(c.time) <= new Date(currentCandle.time))
          .map((c) => c.close);
        const htfEma200 = indicatorService.ema(htfCloses, 200);
        if (htfEma200.length > 0) {
          const latestEma = htfEma200[htfEma200.length - 1];
          const latestPrice = htfCloses[htfCloses.length - 1];
          strategy.setHigherTimeframeTrend(
            latestPrice > latestEma ? 'BULLISH' : 'BEARISH',
            { ema200: latestEma, price: latestPrice }
          );
        }
      }

      // ─── Check existing position for SL/TP hit ───
      if (openPosition) {
        const hit = this._checkSlTp(openPosition, currentCandle);
        if (hit) {
          const trade = this._closeTrade(openPosition, hit.exitPrice, hit.reason, currentCandle.time, instrument);
          balance += trade.profitLoss;
          trades.push(trade);
          openPosition = null;

          if (balance > peakBalance) peakBalance = balance;
          equityCurve.push({ time: currentCandle.time, equity: balance });

          // Daily loss check (simplified)
          continue;
        }

        // Simulate trailing stop
        const trailingResult = this._simulateTrailingStop(openPosition, currentCandle, instrument);
        if (trailingResult.updated) {
          openPosition.currentSl = trailingResult.newSl;
        }
      }

      // ─── Generate new signal if no position ───
      if (!openPosition) {
        const result = strategy.analyze(historicalCandles, ind, instrument);

        if (result.signal !== 'NONE') {
          // Simulate entry with spread and slippage
          let entryPrice;
          if (result.signal === 'BUY') {
            entryPrice = currentCandle.close + spread / 2 + slippage;
          } else {
            entryPrice = currentCandle.close - spread / 2 - slippage;
          }

          // Calculate lot size (risk-based)
          const slDistance = Math.abs(entryPrice - result.sl);
          const slPips = slDistance / instrument.pipSize;
          const riskAmount = balance * instrument.riskParams.riskPercent;
          let lotSize = riskAmount / (slPips * instrument.pipValue);
          lotSize = Math.max(instrument.minLot, Math.floor(lotSize / instrument.lotStep) * instrument.lotStep);
          lotSize = Math.min(lotSize, 5.0);

          // Get current ATR for trailing stop
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
            indicatorsSnapshot: result.indicatorsSnapshot,
            reason: result.reason,
          };
        }
      }

      // Update equity curve periodically
      if (i % 10 === 0) {
        let currentEquity = balance;
        if (openPosition) {
          const priceDiff = openPosition.type === 'BUY'
            ? currentCandle.close - openPosition.entryPrice
            : openPosition.entryPrice - currentCandle.close;
          currentEquity += priceDiff * openPosition.lotSize * instrument.contractSize;
        }
        equity = currentEquity;
        equityCurve.push({ time: currentCandle.time, equity: currentEquity });
      }
    }

    // Close any remaining position at last candle
    if (openPosition) {
      const lastCandle = candles[candles.length - 1];
      const exitPrice = openPosition.type === 'BUY' ? lastCandle.close - spread / 2 : lastCandle.close + spread / 2;
      const trade = this._closeTrade(openPosition, exitPrice, 'END_OF_DATA', lastCandle.time, instrument);
      balance += trade.profitLoss;
      trades.push(trade);
    }

    // Generate summary
    const summary = this._generateSummary(trades, initialBalance, balance, peakBalance);
    const monthlyBreakdown = this._generateMonthlyBreakdown(trades);

    const result = {
      symbol,
      strategy: strategyType,
      timeframe,
      period: {
        start: candles[warmupPeriod]?.time || '',
        end: candles[candles.length - 1]?.time || '',
      },
      parameters: this._getStrategyParams(strategyType, instrument),
      summary,
      monthlyBreakdown,
      trades,
      equityCurve,
    };

    // Save to database
    const saved = await backtestsDb.insert({
      ...result,
      createdAt: new Date(),
    });
    result.backtestId = saved._id;

    return result;
  }

  /**
   * Check if SL or TP was hit during a candle
   */
  _checkSlTp(position, candle) {
    if (position.type === 'BUY') {
      // Check SL first (worst case)
      if (candle.low <= position.currentSl) {
        return { exitPrice: position.currentSl, reason: 'SL_HIT' };
      }
      if (candle.high >= position.tp) {
        return { exitPrice: position.tp, reason: 'TP_HIT' };
      }
    } else {
      if (candle.high >= position.currentSl) {
        return { exitPrice: position.currentSl, reason: 'SL_HIT' };
      }
      if (candle.low <= position.tp) {
        return { exitPrice: position.tp, reason: 'TP_HIT' };
      }
    }
    return null;
  }

  /**
   * Simulate trailing stop within backtest
   */
  _simulateTrailingStop(position, candle, instrument) {
    const atr = position.atrAtEntry;
    if (!atr || atr <= 0) return { updated: false };

    const currentPrice = position.type === 'BUY' ? candle.high : candle.low;
    const profitDistance = position.type === 'BUY'
      ? currentPrice - position.entryPrice
      : position.entryPrice - currentPrice;

    let newSl = position.currentSl;

    if (position.type === 'BUY') {
      if (profitDistance >= 1.5 * atr) {
        newSl = currentPrice - atr;
      } else if (profitDistance >= 1.0 * atr) {
        newSl = position.entryPrice + (instrument.spread * instrument.pipSize);
      }
      if (newSl > position.currentSl) {
        return { updated: true, newSl };
      }
    } else {
      if (profitDistance >= 1.5 * atr) {
        newSl = currentPrice + atr;
      } else if (profitDistance >= 1.0 * atr) {
        newSl = position.entryPrice - (instrument.spread * instrument.pipSize);
      }
      if (newSl < position.currentSl) {
        return { updated: true, newSl };
      }
    }

    return { updated: false };
  }

  /**
   * Close a trade and calculate P/L
   */
  _closeTrade(position, exitPrice, reason, exitTime, instrument) {
    const priceDiff = position.type === 'BUY'
      ? exitPrice - position.entryPrice
      : position.entryPrice - exitPrice;
    const profitPips = priceDiff / instrument.pipSize;
    const profitLoss = priceDiff * position.lotSize * instrument.contractSize;

    return {
      id: position.id,
      type: position.type,
      entryTime: position.entryTime,
      entryPrice: position.entryPrice,
      exitTime,
      exitPrice,
      sl: position.sl,
      tp: position.tp,
      finalSl: position.currentSl,
      lotSize: position.lotSize,
      profitPips: parseFloat(profitPips.toFixed(1)),
      profitLoss: parseFloat(profitLoss.toFixed(2)),
      exitReason: reason,
      reason: position.reason,
      indicatorsAtEntry: position.indicatorsSnapshot,
    };
  }

  /**
   * Generate summary statistics
   */
  _generateSummary(trades, initialBalance, finalBalance, peakBalance) {
    if (trades.length === 0) {
      return {
        totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0,
        profitFactor: 0, totalProfitPips: 0, totalLossPips: 0, netProfitPips: 0,
        netProfitMoney: 0, returnPercent: 0, averageWinPips: 0, averageLossPips: 0,
        maxConsecutiveWins: 0, maxConsecutiveLosses: 0, maxDrawdownPercent: 0,
        sharpeRatio: 0, averageHoldingPeriodHours: 0,
      };
    }

    const winners = trades.filter((t) => t.profitPips > 0);
    const losers = trades.filter((t) => t.profitPips <= 0);
    const totalProfitPips = winners.reduce((s, t) => s + t.profitPips, 0);
    const totalLossPips = losers.reduce((s, t) => s + t.profitPips, 0);
    const totalProfitMoney = winners.reduce((s, t) => s + t.profitLoss, 0);
    const totalLossMoney = losers.reduce((s, t) => s + Math.abs(t.profitLoss), 0);

    // Consecutive wins/losses
    let maxConsWins = 0, maxConsLosses = 0, consWins = 0, consLosses = 0;
    for (const t of trades) {
      if (t.profitPips > 0) { consWins++; consLosses = 0; }
      else { consLosses++; consWins = 0; }
      maxConsWins = Math.max(maxConsWins, consWins);
      maxConsLosses = Math.max(maxConsLosses, consLosses);
    }

    // Max drawdown
    let peak = initialBalance;
    let maxDD = 0;
    let runningBalance = initialBalance;
    for (const t of trades) {
      runningBalance += t.profitLoss;
      if (runningBalance > peak) peak = runningBalance;
      const dd = (peak - runningBalance) / peak;
      if (dd > maxDD) maxDD = dd;
    }

    // Sharpe ratio (annualized, using daily returns approximation)
    const returns = trades.map((t) => t.profitLoss / initialBalance);
    const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
    const stdReturn = Math.sqrt(
      returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / returns.length
    );
    const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

    // Average holding period
    let totalHours = 0;
    let holdingCount = 0;
    for (const t of trades) {
      if (t.entryTime && t.exitTime) {
        const diff = new Date(t.exitTime) - new Date(t.entryTime);
        totalHours += diff / (1000 * 60 * 60);
        holdingCount++;
      }
    }

    return {
      totalTrades: trades.length,
      winningTrades: winners.length,
      losingTrades: losers.length,
      winRate: parseFloat((winners.length / trades.length).toFixed(4)),
      profitFactor: totalLossMoney > 0 ? parseFloat((totalProfitMoney / totalLossMoney).toFixed(2)) : totalProfitMoney > 0 ? 999 : 0,
      totalProfitPips: parseFloat(totalProfitPips.toFixed(1)),
      totalLossPips: parseFloat(totalLossPips.toFixed(1)),
      netProfitPips: parseFloat((totalProfitPips + totalLossPips).toFixed(1)),
      netProfitMoney: parseFloat((finalBalance - initialBalance).toFixed(2)),
      returnPercent: parseFloat(((finalBalance - initialBalance) / initialBalance * 100).toFixed(2)),
      averageWinPips: winners.length > 0 ? parseFloat((totalProfitPips / winners.length).toFixed(1)) : 0,
      averageLossPips: losers.length > 0 ? parseFloat((totalLossPips / losers.length).toFixed(1)) : 0,
      maxConsecutiveWins: maxConsWins,
      maxConsecutiveLosses: maxConsLosses,
      maxDrawdownPercent: parseFloat((maxDD * 100).toFixed(2)),
      sharpeRatio: parseFloat(sharpe.toFixed(2)),
      averageHoldingPeriodHours: holdingCount > 0 ? parseFloat((totalHours / holdingCount).toFixed(1)) : 0,
    };
  }

  /**
   * Generate monthly performance breakdown
   */
  _generateMonthlyBreakdown(trades) {
    const months = {};

    for (const t of trades) {
      const month = t.exitTime ? t.exitTime.substring(0, 7) : t.entryTime.substring(0, 7);
      if (!months[month]) {
        months[month] = { month, trades: 0, wins: 0, netPips: 0, netMoney: 0, maxDD: 0 };
      }
      months[month].trades++;
      if (t.profitPips > 0) months[month].wins++;
      months[month].netPips += t.profitPips;
      months[month].netMoney += t.profitLoss;
    }

    return Object.values(months).map((m) => ({
      month: m.month,
      trades: m.trades,
      winRate: m.trades > 0 ? parseFloat((m.wins / m.trades).toFixed(2)) : 0,
      netPips: parseFloat(m.netPips.toFixed(1)),
      netMoney: parseFloat(m.netMoney.toFixed(2)),
    })).sort((a, b) => a.month.localeCompare(b.month));
  }

  /**
   * Get strategy parameters for the report
   */
  _getStrategyParams(strategyType, instrument) {
    const base = {
      riskPercent: instrument.riskParams.riskPercent,
      slMultiplier: instrument.riskParams.slMultiplier,
      tpMultiplier: instrument.riskParams.tpMultiplier,
    };

    switch (strategyType) {
      case 'TrendFollowing':
        return { ...base, ema_fast: 20, ema_slow: 50, rsi_period: 14, atr_period: 14, volatility_threshold: 0.7 };
      case 'MeanReversion':
        return { ...base, bb_period: 20, bb_stddev: 2, rsi_period: 14, rsi_oversold: 30, rsi_overbought: 70 };
      case 'MultiTimeframe':
        return { ...base, ema_trend: 200, macd_fast: 12, macd_slow: 26, macd_signal: 9, stoch_period: 14, stoch_signal: 3 };
      case 'Momentum':
        return { ...base, ema_period: 50, rsi_period: 14, macd_fast: 12, macd_slow: 26, macd_signal: 9, bullish_candle_threshold: 2 };
      case 'Breakout':
        return { ...base, lookback_period: 20, atr_period: 14, body_multiplier: 1.5, rsi_period: 14 };
      default:
        return base;
    }
  }

  /**
   * Get all backtest results from DB
   */
  async getResults(limit = 50) {
    const results = await backtestsDb.find({}).sort({ createdAt: -1 }).limit(limit);
    // Return summaries without full trade list for listing
    return results.map((r) => ({
      _id: r._id,
      symbol: r.symbol,
      strategy: r.strategy,
      timeframe: r.timeframe,
      period: r.period,
      summary: r.summary,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Get a single backtest result with full details
   */
  async getResult(id) {
    return await backtestsDb.findOne({ _id: id });
  }

  /**
   * Delete a backtest result
   */
  async deleteResult(id) {
    return await backtestsDb.remove({ _id: id });
  }
}

const backtestEngine = new BacktestEngine();

module.exports = backtestEngine;
