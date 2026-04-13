/**
 * Backtest Engine
 * Simulates strategy execution on historical data
 * Outputs machine-readable JSON for analysis and strategy tuning
 */

const indicatorService = require('./indicatorService');
const breakevenService = require('./breakevenService');
const { getInstrument } = require('../config/instruments');
const { backtestsDb } = require('../config/db');
const {
  resolveStrategyParameters,
} = require('../config/strategyParameters');
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
  _createStrategy(strategyType) {
    const StrategyClass = STRATEGY_MAP[strategyType];
    if (!StrategyClass) throw new Error(`Unknown strategy: ${strategyType}`);
    return new StrategyClass();
  }

  _buildTradingInstrument(instrument, resolvedParams) {
    return {
      ...instrument,
      riskParams: {
        ...instrument.riskParams,
        riskPercent: Number(resolvedParams.riskPercent ?? instrument.riskParams.riskPercent),
        slMultiplier: Number(resolvedParams.slMultiplier ?? instrument.riskParams.slMultiplier),
        tpMultiplier: Number(resolvedParams.tpMultiplier ?? instrument.riskParams.tpMultiplier),
      },
    };
  }

  _buildIndicators(candles, resolvedParams) {
    return indicatorService.calculateAll(candles, resolvedParams);
  }

  _toTimeMs(value) {
    return value instanceof Date ? value.getTime() : new Date(value).getTime();
  }

  _sliceIndicatorWindow(fullIndicators, totalCandles, windowStart, windowEnd) {
    const sliced = {};
    for (const [key, values] of Object.entries(fullIndicators || {})) {
      if (!Array.isArray(values)) {
        sliced[key] = values;
        continue;
      }

      const offset = totalCandles - values.length;
      const sliceStart = Math.max(0, windowStart - offset);
      const sliceEnd = Math.max(0, windowEnd - offset);
      sliced[key] = sliceStart < sliceEnd ? values.slice(sliceStart, sliceEnd) : [];
    }
    return sliced;
  }

  _buildHigherTimeframeTrendSeries(higherTfCandles, resolvedParams) {
    if (!higherTfCandles || higherTfCandles.length === 0) {
      return null;
    }

    const trendPeriod = Number(resolvedParams.ema_trend) || 200;
    const closes = higherTfCandles.map((candle) => candle.close);
    const ema = indicatorService.ema(closes, trendPeriod);

    return {
      closes,
      ema,
      emaOffset: closes.length - ema.length,
    };
  }

  _applyHigherTimeframeTrend(strategy, higherTfCandles, trendSeries, cursor) {
    if (!higherTfCandles || !trendSeries || !strategy.setHigherTimeframeTrend || cursor < 0) {
      return;
    }

    const emaIndex = cursor - trendSeries.emaOffset;
    if (emaIndex < 0 || emaIndex >= trendSeries.ema.length) {
      return;
    }

    const latestEma = trendSeries.ema[emaIndex];
    const latestPrice = trendSeries.closes[cursor];
    strategy.setHigherTimeframeTrend(
      latestPrice > latestEma ? 'BULLISH' : 'BEARISH',
      { ema200: latestEma, price: latestPrice }
    );
  }

  async _runSimulation(params) {
    const {
      symbol,
      strategyType,
      timeframe,
      candles,
      higherTfCandles = null,
      lowerTfCandles = null,
      initialBalance = 10000,
      spreadPips = 0,
      slippagePips = 0.5,
      tradeStartTime = null,
      tradeEndTime = null,
      strategyParams = null,
      storedStrategyParameters = null,
      breakevenConfig = null,
    } = params;

    const instrument = getInstrument(symbol);
    if (!instrument) throw new Error(`Unknown symbol: ${symbol}`);

    const resolvedParams = resolveStrategyParameters({
      strategyType,
      instrument,
      storedParameters: storedStrategyParameters,
      overrides: strategyParams,
    });
    const effectiveBreakeven = breakevenConfig
      ? breakevenService.normalizeBreakevenConfig(breakevenConfig, {
          partial: false,
          defaults: breakevenService.DEFAULT_BREAKEVEN_CONFIG,
          baseConfig: breakevenService.DEFAULT_BREAKEVEN_CONFIG,
        })
      : breakevenService.getDefaultBreakevenConfig();
    const tradingInstrument = this._buildTradingInstrument(instrument, resolvedParams);
    const strategy = this._createStrategy(strategyType);
    const spread = (spreadPips || instrument.spread) * instrument.pipSize;
    const slippage = slippagePips * instrument.pipSize;

    let balance = initialBalance;
    let equity = initialBalance;
    let peakBalance = initialBalance;
    const trades = [];
    const equityCurve = [{ time: tradeStartTime || candles[0]?.time || '', equity: initialBalance }];
    let openPosition = null;
    const warmupPeriod = 250;
    const tradeStartMs = tradeStartTime ? new Date(tradeStartTime).getTime() : null;
    const candleTimes = candles.map((candle) => this._toTimeMs(candle.time));
    const fullIndicators = this._buildIndicators(candles, resolvedParams);
    const lowerTfTimes = lowerTfCandles ? lowerTfCandles.map((candle) => this._toTimeMs(candle.time)) : null;
    const fullLowerIndicators = lowerTfCandles && tradingInstrument.entryTimeframe
      ? this._buildIndicators(lowerTfCandles, resolvedParams)
      : null;
    const higherTfTimes = higherTfCandles ? higherTfCandles.map((candle) => this._toTimeMs(candle.time)) : null;
    const higherTrendSeries = this._buildHigherTimeframeTrendSeries(higherTfCandles, resolvedParams);
    let lowerCursor = -1;
    let higherCursor = -1;

    if (!candles || candles.length < warmupPeriod + 2) {
      throw new Error(`Need at least ${warmupPeriod + 2} candles including warmup, got ${candles ? candles.length : 0}`);
    }

    for (let i = warmupPeriod; i < candles.length; i++) {
      const currentCandle = candles[i];
      const currentTimeMs = candleTimes[i];
      const nextCandle = candles[i + 1] || null;
      const historyStart = Math.max(0, i - 250);
      const historyEnd = i + 1;
      const historicalCandles = candles.slice(historyStart, historyEnd);
      const ind = this._sliceIndicatorWindow(fullIndicators, candles.length, historyStart, historyEnd);
      let lowerHistoricalCandles = null;
      let lowerInd = null;
      let pendingEntry = null;

      if (lowerTfCandles && tradingInstrument.entryTimeframe) {
        while (lowerCursor + 1 < lowerTfTimes.length && lowerTfTimes[lowerCursor + 1] <= currentTimeMs) {
          lowerCursor += 1;
        }

        if (lowerCursor >= 0) {
          const lowerStart = Math.max(0, lowerCursor - 250);
          const lowerEnd = lowerCursor + 1;
          lowerHistoricalCandles = lowerTfCandles.slice(lowerStart, lowerEnd);
          lowerInd = this._sliceIndicatorWindow(fullLowerIndicators, lowerTfCandles.length, lowerStart, lowerEnd);
        }

        if (lowerHistoricalCandles && lowerHistoricalCandles.length > 1) {
          lowerInd = lowerInd || {};
        }
      }

      if (higherTfCandles && strategy.setHigherTimeframeTrend) {
        while (higherCursor + 1 < higherTfTimes.length && higherTfTimes[higherCursor + 1] <= currentTimeMs) {
          higherCursor += 1;
        }
        this._applyHigherTimeframeTrend(strategy, higherTfCandles, higherTrendSeries, higherCursor);
      }

      if (openPosition) {
        const hit = this._checkSlTp(openPosition, currentCandle);
        if (hit) {
          const trade = this._closeTrade(openPosition, hit.exitPrice, hit.reason, currentCandle.time, tradingInstrument);
          balance += trade.profitLoss;
          trades.push(trade);
          openPosition = null;

          if (balance > peakBalance) peakBalance = balance;
          equityCurve.push({ time: currentCandle.time, equity: balance });
          continue;
        }

        const trailingResult = this._simulateTrailingStop(openPosition, currentCandle, tradingInstrument);
        if (trailingResult.updated) {
          openPosition.currentSl = trailingResult.newSl;
        }
      }

      if (!openPosition && nextCandle && (tradeStartMs === null || currentTimeMs >= tradeStartMs)) {
        const result = strategy.analyze(historicalCandles, ind, tradingInstrument, {
          higherTfCandles,
          entryCandles: lowerHistoricalCandles,
          entryIndicators: lowerInd,
          strategyParams: resolvedParams,
        });

        if (result.signal !== 'NONE') {
          const entryPrice = result.signal === 'BUY'
            ? nextCandle.open + spread / 2 + slippage
            : nextCandle.open - spread / 2 - slippage;
          const slDistance = Math.abs(entryPrice - result.sl);
          const slPips = slDistance / tradingInstrument.pipSize;
          const riskAmount = balance * tradingInstrument.riskParams.riskPercent;
          let lotSize = riskAmount / (slPips * tradingInstrument.pipValue);
          lotSize = Math.max(tradingInstrument.minLot, Math.floor(lotSize / tradingInstrument.lotStep) * tradingInstrument.lotStep);
          lotSize = Math.min(lotSize, 5.0);

          const currentAtr = ind.atr && ind.atr.length > 0 ? ind.atr[ind.atr.length - 1] : 0;

          pendingEntry = {
            id: trades.length + 1,
            type: result.signal,
            entryPrice,
            entryTime: nextCandle.time,
            sl: result.sl,
            tp: result.tp,
            currentSl: result.sl,
            lotSize,
            atrAtEntry: currentAtr,
            breakevenConfig: effectiveBreakeven,
            indicatorsSnapshot: result.indicatorsSnapshot,
            reason: result.reason,
          };
        }
      }

      if ((i % 10 === 0 || i === candles.length - 1) && (tradeStartMs === null || currentTimeMs >= tradeStartMs)) {
        let currentEquity = balance;
        if (openPosition) {
          const priceDiff = openPosition.type === 'BUY'
            ? currentCandle.close - openPosition.entryPrice
            : openPosition.entryPrice - currentCandle.close;
          currentEquity += priceDiff * openPosition.lotSize * tradingInstrument.contractSize;
        }
        equity = currentEquity;
        equityCurve.push({ time: currentCandle.time, equity: currentEquity });
      }

      if (!openPosition && pendingEntry) {
        openPosition = pendingEntry;
      }
    }

    if (openPosition) {
      const lastCandle = candles[candles.length - 1];
      const exitPrice = openPosition.type === 'BUY'
        ? lastCandle.close - spread / 2
        : lastCandle.close + spread / 2;
      const trade = this._closeTrade(openPosition, exitPrice, 'END_OF_DATA', lastCandle.time, tradingInstrument);
      balance += trade.profitLoss;
      trades.push(trade);
    }

    const summary = this._generateSummary(trades, initialBalance, balance, peakBalance);
    const monthlyBreakdown = this._generateMonthlyBreakdown(trades);

    return {
      symbol,
      strategy: strategyType,
      timeframe,
      period: {
        start: tradeStartTime || candles[warmupPeriod]?.time || '',
        end: tradeEndTime || candles[candles.length - 1]?.time || '',
      },
      parameters: resolvedParams,
      parameterSource: {
        hasStoredParameters: Boolean(storedStrategyParameters && Object.keys(storedStrategyParameters).length > 0),
        hasRuntimeOverrides: Boolean(strategyParams && Object.keys(strategyParams).length > 0),
      },
      breakevenConfigUsed: effectiveBreakeven,
      summary,
      monthlyBreakdown,
      trades,
      equityCurve,
      finalBalance: balance,
      finalEquity: equity,
    };
  }

  /**
   * Run a backtest
   */
  async run(params) {
    const result = await this._runSimulation(params);
    const saved = await backtestsDb.insert({
      ...result,
      batchJobId: params.batchJobId || null,
      isBatchChild: Boolean(params.batchJobId),
      createdAt: new Date(),
    });
    result.backtestId = saved._id;
    return result;
  }

  /**
   * Run a backtest without persisting the result.
   */
  async simulate(params) {
    return this._runSimulation(params);
  }

  /**
   * Check if SL or TP was hit during a candle
   */
  _checkSlTp(position, candle) {
    if (position.type === 'BUY') {
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
    const currentPrice = position.type === 'BUY' ? candle.high : candle.low;
    const result = breakevenService.calculateBreakevenStop(
      position,
      currentPrice,
      instrument,
      position.breakevenConfig || null
    );

    if (!result.shouldUpdate) {
      return { updated: false, phase: result.phase };
    }

    return { updated: true, newSl: result.newSl, phase: result.phase };
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
  _generateSummary(trades, initialBalance, finalBalance) {
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
    const totalProfitPips = winners.reduce((sum, trade) => sum + trade.profitPips, 0);
    const totalLossPips = losers.reduce((sum, trade) => sum + trade.profitPips, 0);
    const totalProfitMoney = winners.reduce((sum, trade) => sum + trade.profitLoss, 0);
    const totalLossMoney = losers.reduce((sum, trade) => sum + Math.abs(trade.profitLoss), 0);

    let maxConsWins = 0;
    let maxConsLosses = 0;
    let consWins = 0;
    let consLosses = 0;
    for (const trade of trades) {
      if (trade.profitPips > 0) {
        consWins++;
        consLosses = 0;
      } else {
        consLosses++;
        consWins = 0;
      }
      maxConsWins = Math.max(maxConsWins, consWins);
      maxConsLosses = Math.max(maxConsLosses, consLosses);
    }

    let peak = initialBalance;
    let maxDD = 0;
    let runningBalance = initialBalance;
    for (const trade of trades) {
      runningBalance += trade.profitLoss;
      if (runningBalance > peak) peak = runningBalance;
      const dd = (peak - runningBalance) / peak;
      if (dd > maxDD) maxDD = dd;
    }

    const returns = trades.map((trade) => trade.profitLoss / initialBalance);
    const avgReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const stdReturn = Math.sqrt(
      returns.reduce((sum, value) => sum + Math.pow(value - avgReturn, 2), 0) / returns.length
    );
    const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

    let totalHours = 0;
    let holdingCount = 0;
    for (const trade of trades) {
      if (trade.entryTime && trade.exitTime) {
        const diff = new Date(trade.exitTime) - new Date(trade.entryTime);
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

    for (const trade of trades) {
      const month = trade.exitTime ? trade.exitTime.substring(0, 7) : trade.entryTime.substring(0, 7);
      if (!months[month]) {
        months[month] = { month, trades: 0, wins: 0, netPips: 0, netMoney: 0 };
      }
      months[month].trades++;
      if (trade.profitPips > 0) months[month].wins++;
      months[month].netPips += trade.profitPips;
      months[month].netMoney += trade.profitLoss;
    }

    return Object.values(months).map((month) => ({
      month: month.month,
      trades: month.trades,
      winRate: month.trades > 0 ? parseFloat((month.wins / month.trades).toFixed(2)) : 0,
      netPips: parseFloat(month.netPips.toFixed(1)),
      netMoney: parseFloat(month.netMoney.toFixed(2)),
    })).sort((a, b) => a.month.localeCompare(b.month));
  }

  async getResults(limit = 50, options = {}) {
    const query = options.includeBatchChildren ? {} : { isBatchChild: { $ne: true } };
    const results = await backtestsDb.find(query).sort({ createdAt: -1 }).limit(limit);
    return results.map((result) => ({
      _id: result._id,
      symbol: result.symbol,
      strategy: result.strategy,
      timeframe: result.timeframe,
      period: result.period,
      parameters: result.parameters,
      parameterSource: result.parameterSource,
      summary: result.summary,
      createdAt: result.createdAt,
    }));
  }

  async getResult(id) {
    return backtestsDb.findOne({ _id: id });
  }

  async deleteResult(id) {
    return backtestsDb.remove({ _id: id });
  }
}

const backtestEngine = new BacktestEngine();

module.exports = backtestEngine;
