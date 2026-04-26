/**
 * Backtest Engine
 * Simulates strategy execution on historical data
 * Outputs machine-readable JSON for analysis and strategy tuning
 */

const indicatorService = require('./indicatorService');
const breakevenService = require('./breakevenService');
const volumeFeatureService = require('./volumeFeatureService');
const backtestChartService = require('./backtestChartService');
const { DEFAULT_EXECUTION_POLICY, calculateExecutionScore } = require('./executionPolicyService');
const { getInstrument } = require('../config/instruments');
const { getStrategyExecutionConfig } = require('../config/strategyExecution');
const { backtestsDb } = require('../config/db');
const {
  resolveStrategyParameters,
} = require('../config/strategyParameters');
const TrendFollowingStrategy = require('../strategies/TrendFollowingStrategy');
const MeanReversionStrategy = require('../strategies/MeanReversionStrategy');
const MultiTimeframeStrategy = require('../strategies/MultiTimeframeStrategy');
const MomentumStrategy = require('../strategies/MomentumStrategy');
const BreakoutStrategy = require('../strategies/BreakoutStrategy');
const VolumeFlowHybridStrategy = require('../strategies/VolumeFlowHybridStrategy');
const { estimateBarDistance } = require('../utils/timeframe');

const HISTORY_WINDOW_SIZE = 251;

const STRATEGY_MAP = {
  TrendFollowing: TrendFollowingStrategy,
  MeanReversion: MeanReversionStrategy,
  MultiTimeframe: MultiTimeframeStrategy,
  Momentum: MomentumStrategy,
  Breakout: BreakoutStrategy,
  // Additive — backtesting support for the new volume hybrid strategy.
  VolumeFlowHybrid: VolumeFlowHybridStrategy,
};

class BacktestEngine {
  _createStrategy(strategyType) {
    const StrategyClass = STRATEGY_MAP[strategyType];
    if (!StrategyClass) throw new Error(`Unknown strategy: ${strategyType}`);
    return new StrategyClass();
  }

  _buildTradingInstrument(instrument, resolvedParams, strategyType = null, executionConfigOverride = null) {
    // Additive: layer the strategy's execution config (setup/higher/entry timeframes)
    // on top of the instrument so per-strategy timeframes (e.g. VolumeFlowHybrid M5/M1/M15)
    // are honoured by the strategy at backtest time without mutating the base instrument.
    // When an override is supplied (e.g. batch forced-timeframe mode), we
    // use it directly instead of the strategy's default execution config so
    // the strategy sees cohesive primary/higher/entry timeframes.
    const executionConfig = executionConfigOverride
      || (strategyType ? getStrategyExecutionConfig(instrument.symbol, strategyType) : null);
    const merged = executionConfig ? { ...instrument, ...executionConfig } : { ...instrument };
    return {
      ...merged,
      riskParams: {
        ...instrument.riskParams,
        ...(executionConfig?.riskParams || {}),
        riskPercent: Number(resolvedParams.riskPercent ?? instrument.riskParams.riskPercent),
        slMultiplier: Number(resolvedParams.slMultiplier ?? instrument.riskParams.slMultiplier),
        tpMultiplier: Number(resolvedParams.tpMultiplier ?? instrument.riskParams.tpMultiplier),
      },
    };
  }

  _buildIndicators(candles, resolvedParams, strategyType = null) {
    return indicatorService.calculateForStrategy(strategyType, candles, resolvedParams);
  }

  _strategyNeedsEntryIndicators(strategyType) {
    return strategyType === 'TrendFollowing' || strategyType === 'MultiTimeframe';
  }

  _buildVolumeFeatureSeries(candles, resolvedParams, strategyType = null) {
    if (strategyType !== 'VolumeFlowHybrid') {
      return null;
    }

    return volumeFeatureService.buildFeatureSeries(candles, {
      volumeAvgPeriod: Math.max(5, Math.round(Number(resolvedParams.volume_avg_period) || 20)),
      deltaSmoothing: Math.max(2, Math.round(Number(resolvedParams.cumulative_delta_smoothing) || 8)),
    });
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

  _prepareIndicatorSeries(fullIndicators, totalCandles) {
    const constants = {};
    const series = [];

    for (const [key, values] of Object.entries(fullIndicators || {})) {
      if (!Array.isArray(values)) {
        constants[key] = values;
        continue;
      }

      series.push({
        key,
        values,
        offset: totalCandles - values.length,
      });
    }

    return { constants, series };
  }

  _buildPreparedIndicatorWindow(preparedSeries, windowStart, windowEnd) {
    if (!preparedSeries) {
      return null;
    }

    const sliced = { ...preparedSeries.constants };

    for (const entry of preparedSeries.series) {
      const sliceStart = Math.max(0, windowStart - entry.offset);
      const sliceEnd = Math.max(0, windowEnd - entry.offset);
      sliced[entry.key] = sliceStart < sliceEnd ? entry.values.slice(sliceStart, sliceEnd) : [];
    }

    return sliced;
  }

  _createRollingArrayWindowState(source = [], maxSize = HISTORY_WINDOW_SIZE) {
    return {
      source,
      maxSize,
      cursor: -1,
      window: [],
    };
  }

  _advanceRollingArrayWindowState(state, cursor) {
    if (!state) {
      return null;
    }

    if (!Array.isArray(state.source) || cursor < 0) {
      state.cursor = cursor;
      state.window = [];
      return state.window;
    }

    if (
      state.cursor === -1
      || !Array.isArray(state.window)
      || cursor < state.cursor
      || (cursor - state.cursor) >= state.maxSize
    ) {
      const start = Math.max(0, cursor - state.maxSize + 1);
      state.window = state.source.slice(start, cursor + 1);
      state.cursor = cursor;
      return state.window;
    }

    for (let index = state.cursor + 1; index <= cursor; index++) {
      state.window.push(state.source[index]);
      if (state.window.length > state.maxSize) {
        state.window.shift();
      }
    }

    state.cursor = cursor;
    return state.window;
  }

  _createRollingIndicatorWindowState(preparedSeries = null, maxSize = HISTORY_WINDOW_SIZE) {
    return {
      preparedSeries,
      maxSize,
      cursor: -1,
      window: preparedSeries ? { ...preparedSeries.constants } : null,
    };
  }

  _advanceRollingIndicatorWindowState(state, cursor) {
    if (!state || !state.preparedSeries) {
      return null;
    }

    if (cursor < 0) {
      state.cursor = cursor;
      state.window = { ...state.preparedSeries.constants };
      for (const entry of state.preparedSeries.series) {
        state.window[entry.key] = [];
      }
      return state.window;
    }

    if (
      state.cursor === -1
      || !state.window
      || cursor < state.cursor
      || (cursor - state.cursor) >= state.maxSize
    ) {
      const start = Math.max(0, cursor - state.maxSize + 1);
      state.window = this._buildPreparedIndicatorWindow(state.preparedSeries, start, cursor + 1);
      state.cursor = cursor;
      return state.window;
    }

    for (let index = state.cursor + 1; index <= cursor; index++) {
      const previousStart = Math.max(0, index - state.maxSize);
      const nextStart = Math.max(0, index - state.maxSize + 1);

      for (const entry of state.preparedSeries.series) {
        const removedValueIndex = previousStart - entry.offset;
        if (
          nextStart > previousStart
          && removedValueIndex >= 0
          && removedValueIndex < entry.values.length
          && state.window[entry.key].length > 0
        ) {
          state.window[entry.key].shift();
        }

        const valueIndex = index - entry.offset;
        if (valueIndex >= 0 && valueIndex < entry.values.length) {
          state.window[entry.key].push(entry.values[valueIndex]);
        }
      }
    }

    state.cursor = cursor;
    return state.window;
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
      parameterPreset = 'default',
      parameterPresetResolution = null,
      breakevenConfig = null,
      executionPolicy = null,
      executionConfigOverride = null,
      includeChartData = false,
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
    const tradingInstrument = this._buildTradingInstrument(instrument, resolvedParams, strategyType, executionConfigOverride);
    const strategy = this._createStrategy(strategyType);
    const effectiveExecutionPolicy = executionPolicy || DEFAULT_EXECUTION_POLICY;
    const spread = (spreadPips || instrument.spread) * instrument.pipSize;
    const slippage = slippagePips * instrument.pipSize;
    const needsEntryIndicators = this._strategyNeedsEntryIndicators(strategyType);

    let balance = initialBalance;
    let equity = initialBalance;
    const trades = [];
    const equityCurve = [{ time: tradeStartTime || candles[0]?.time || '', equity: initialBalance }];
    let openPosition = null;
    const warmupPeriod = 250;
    const tradeStartMs = tradeStartTime ? new Date(tradeStartTime).getTime() : null;
    const candleTimes = candles.map((candle) => this._toTimeMs(candle.time));
    const fullIndicators = this._buildIndicators(candles, resolvedParams, strategyType);
    const preparedIndicators = this._prepareIndicatorSeries(fullIndicators, candles.length);
    const fullVolumeFeatureSeries = this._buildVolumeFeatureSeries(candles, resolvedParams, strategyType);
    const lowerTfTimes = lowerTfCandles ? lowerTfCandles.map((candle) => this._toTimeMs(candle.time)) : null;
    const fullLowerIndicators = lowerTfCandles && tradingInstrument.entryTimeframe && needsEntryIndicators
      ? this._buildIndicators(lowerTfCandles, resolvedParams, strategyType)
      : null;
    const preparedLowerIndicators = fullLowerIndicators
      ? this._prepareIndicatorSeries(fullLowerIndicators, lowerTfCandles.length)
      : null;
    const higherTfTimes = higherTfCandles ? higherTfCandles.map((candle) => this._toTimeMs(candle.time)) : null;
    const higherTrendSeries = this._buildHigherTimeframeTrendSeries(higherTfCandles, resolvedParams);
    const historyWindowState = this._createRollingArrayWindowState(candles);
    const indicatorWindowState = this._createRollingIndicatorWindowState(preparedIndicators);
    const lowerHistoryWindowState = lowerTfCandles && tradingInstrument.entryTimeframe
      ? this._createRollingArrayWindowState(lowerTfCandles)
      : null;
    const lowerIndicatorWindowState = preparedLowerIndicators
      ? this._createRollingIndicatorWindowState(preparedLowerIndicators)
      : null;
    let lowerCursor = -1;
    let higherCursor = -1;

    if (!candles || candles.length < warmupPeriod + 2) {
      throw new Error(`Need at least ${warmupPeriod + 2} candles including warmup, got ${candles ? candles.length : 0}`);
    }

    for (let i = warmupPeriod; i < candles.length; i++) {
      const currentCandle = candles[i];
      const currentTimeMs = candleTimes[i];
      const nextCandle = candles[i + 1] || null;
      const historicalCandles = this._advanceRollingArrayWindowState(historyWindowState, i);
      const ind = this._advanceRollingIndicatorWindowState(indicatorWindowState, i);
      let lowerHistoricalCandles = null;
      let lowerInd = null;
      let pendingEntry = null;

      if (lowerTfCandles && tradingInstrument.entryTimeframe) {
        while (lowerCursor + 1 < lowerTfTimes.length && lowerTfTimes[lowerCursor + 1] <= currentTimeMs) {
          lowerCursor += 1;
        }

        if (lowerCursor >= 0) {
          lowerHistoricalCandles = this._advanceRollingArrayWindowState(lowerHistoryWindowState, lowerCursor);
          if (preparedLowerIndicators) {
            lowerInd = this._advanceRollingIndicatorWindowState(lowerIndicatorWindowState, lowerCursor);
          }
        }

        if (needsEntryIndicators && lowerHistoricalCandles && lowerHistoricalCandles.length > 1) {
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
          equity = balance;
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
          volumeFeatureSnapshot: fullVolumeFeatureSeries ? fullVolumeFeatureSeries[i] : null,
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
          const signalTime = result.entryCandleTime || result.setupCandleTime || currentCandle.time;
          const duplicateWindowBars = Number(effectiveExecutionPolicy.duplicateEntryWindowBars) || 0;
          const cooldownBarsAfterLoss = Number(effectiveExecutionPolicy.cooldownBarsAfterLoss) || 0;
          const duplicateReference = duplicateWindowBars > 0
            ? [...trades].reverse().find((trade) => {
                if (trade.type !== result.signal) return false;
                const referenceTime = trade.entryCandleTime || trade.setupCandleTime || trade.entryTime;
                return estimateBarDistance(referenceTime, signalTime, result.setupTimeframe || result.entryTimeframe || timeframe) <= duplicateWindowBars;
              })
            : null;
          const lastLossTrade = cooldownBarsAfterLoss > 0
            ? [...trades].reverse().find((trade) => Number(trade.profitLoss) < 0 && trade.exitTime)
            : null;

          if (
            lastLossTrade
            && estimateBarDistance(
              lastLossTrade.exitTime,
              signalTime,
              result.setupTimeframe || result.entryTimeframe || timeframe
            ) <= cooldownBarsAfterLoss
          ) {
            continue;
          }

          const executionScore = calculateExecutionScore(result, effectiveExecutionPolicy, {
            sameDirectionSymbolPositions: openPosition && openPosition.type === result.signal ? 1 : 0,
            sameDirectionCategoryPositions: openPosition && openPosition.type === result.signal ? 1 : 0,
            duplicatePenalty: Boolean(duplicateReference),
          });
          if (executionScore.score < effectiveExecutionPolicy.minExecutionScore) {
            continue;
          }
          const plannedRiskAmount = parseFloat((slPips * tradingInstrument.pipValue * lotSize).toFixed(4));
          const targetRMultiple = slDistance > 0
            ? parseFloat((Math.abs(result.tp - entryPrice) / slDistance).toFixed(4))
            : null;

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
            executionPolicy: effectiveExecutionPolicy,
            executionScore: executionScore.score,
            executionScoreDetails: executionScore.details,
            plannedRiskAmount,
            targetRMultiple,
            indicatorsSnapshot: result.indicatorsSnapshot,
            reason: result.reason,
            entryReason: result.entryReason || [result.reason, result.triggerReason].filter(Boolean).join(' | ') || result.reason,
            setupReason: result.setupReason || result.reason || '',
            triggerReason: result.triggerReason || '',
            setupTimeframe: result.setupTimeframe || timeframe,
            entryTimeframe: result.entryTimeframe || null,
            setupCandleTime: result.setupCandleTime || currentCandle.time,
            entryCandleTime: result.entryCandleTime || signalTime,
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
      equityCurve.push({ time: lastCandle.time, equity: balance });
    }

    equity = balance;
    const summary = this._generateSummary(trades, initialBalance, balance, equityCurve);
    const monthlyBreakdown = this._generateMonthlyBreakdown(trades);
    const resolvedPreset = parameterPresetResolution || {
      preset: parameterPreset || 'default',
      fallbackUsed: false,
      resolvedFrom: strategyParams && Object.keys(strategyParams).length > 0 ? 'runtime_overrides' : 'instance',
      optimizerHistoryId: null,
      optimizerCompletedAt: null,
      optimizerTimeframe: null,
      optimizerOptimizeFor: null,
    };
    const chartData = includeChartData
      ? backtestChartService.buildChartData({
          symbol,
          strategyType,
          timeframe,
          candles,
          indicators: fullIndicators,
          resolvedParams,
          tradeStartTime: tradeStartTime || candles[warmupPeriod]?.time || '',
          tradeEndTime: tradeEndTime || candles[candles.length - 1]?.time || '',
          trades,
          volumeFeatureSeries: fullVolumeFeatureSeries,
        })
      : null;

    return {
      symbol,
      strategy: strategyType,
      timeframe,
      period: {
        start: tradeStartTime || candles[warmupPeriod]?.time || '',
        end: tradeEndTime || candles[candles.length - 1]?.time || '',
      },
      parameters: resolvedParams,
      parameterPreset: resolvedPreset.preset || 'default',
      parameterPresetResolution: resolvedPreset,
      parameterSource: {
        hasStoredParameters: Boolean(storedStrategyParameters && Object.keys(storedStrategyParameters).length > 0),
        hasRuntimeOverrides: Boolean(strategyParams && Object.keys(strategyParams).length > 0),
        preset: resolvedPreset.preset || 'default',
        resolvedFrom: resolvedPreset.resolvedFrom || 'instance',
        fallbackUsed: Boolean(resolvedPreset.fallbackUsed),
        optimizerHistoryId: resolvedPreset.optimizerHistoryId || null,
        optimizerCompletedAt: resolvedPreset.optimizerCompletedAt || null,
        optimizerTimeframe: resolvedPreset.optimizerTimeframe || null,
        optimizerOptimizeFor: resolvedPreset.optimizerOptimizeFor || null,
      },
      breakevenConfigUsed: effectiveBreakeven,
      executionPolicyUsed: effectiveExecutionPolicy,
      summary,
      monthlyBreakdown,
      trades,
      equityCurve,
      chartData,
      initialBalance,
      finalBalance: balance,
      finalEquity: equity,
    };
  }

  /**
   * Run a backtest
   */
  async run(params) {
    const result = await this._runSimulation(params);
    const persistedResult = { ...result };
    delete persistedResult.chartData;
    const saved = await backtestsDb.insert({
      ...persistedResult,
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
    const realizedRMultiple = Number(position.plannedRiskAmount) > 0
      ? parseFloat((profitLoss / position.plannedRiskAmount).toFixed(4))
      : null;
    const targetRMultipleCaptured = Number.isFinite(realizedRMultiple)
      && Number(position.targetRMultiple) > 0
      ? parseFloat((realizedRMultiple / position.targetRMultiple).toFixed(4))
      : null;

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
      realizedRMultiple,
      targetRMultipleCaptured,
      exitReason: reason,
      exitReasonText: backtestChartService.humanizeExitReason(reason),
      reason: position.reason,
      entryReason: position.entryReason || position.reason || '',
      setupReason: position.setupReason || position.reason || '',
      triggerReason: position.triggerReason || '',
      executionScore: position.executionScore ?? null,
      executionScoreDetails: position.executionScoreDetails || null,
      executionPolicy: position.executionPolicy || null,
      setupTimeframe: position.setupTimeframe || null,
      entryTimeframe: position.entryTimeframe || null,
      setupCandleTime: position.setupCandleTime || null,
      entryCandleTime: position.entryCandleTime || null,
      indicatorsAtEntry: position.indicatorsSnapshot,
    };
  }

  /**
   * Generate summary statistics
   */
  _calculateMaxDrawdownFromCurve(equityCurve = [], initialBalance = 0) {
    const points = Array.isArray(equityCurve) ? equityCurve : [];
    const startingEquity = Number(initialBalance) || 0;

    if (points.length === 0 && startingEquity <= 0) {
      return 0;
    }

    let peak = startingEquity > 0
      ? startingEquity
      : Number(points[0] && points[0].equity) || 0;
    let maxDrawdown = 0;

    for (const point of points) {
      const equityValue = Number(point && point.equity);
      if (!Number.isFinite(equityValue)) {
        continue;
      }

      if (equityValue > peak) {
        peak = equityValue;
      }

      if (peak > 0) {
        const drawdown = (peak - equityValue) / peak;
        if (drawdown > maxDrawdown) {
          maxDrawdown = drawdown;
        }
      }
    }

    return maxDrawdown;
  }

  _generateSummary(trades, initialBalance, finalBalance, equityCurve = null) {
    if (trades.length === 0) {
      return {
        totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0,
        profitFactor: 0, grossProfitMoney: 0, grossLossMoney: 0,
        totalProfitPips: 0, totalLossPips: 0, netProfitPips: 0,
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

    const maxDD = this._calculateMaxDrawdownFromCurve(equityCurve, initialBalance);

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
      // grossProfitMoney/grossLossMoney are kept alongside profitFactor so
      // portfolio-level aggregation can compute true PF across many runs
      // without averaging each run's individual PF.
      grossProfitMoney: parseFloat(totalProfitMoney.toFixed(2)),
      grossLossMoney: parseFloat(totalLossMoney.toFixed(2)),
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
    const result = await backtestsDb.findOne({ _id: id });
    if (!result) {
      return null;
    }

    if (
      (result.initialBalance == null || Number.isNaN(Number(result.initialBalance)))
      && result.finalBalance != null
      && result.summary
      && result.summary.netProfitMoney != null
    ) {
      result.initialBalance = Number(result.finalBalance) - Number(result.summary.netProfitMoney);
    }

    if (typeof result.chartData === 'undefined') {
      result.chartData = null;
    }

    return result;
  }

  async deleteResult(id) {
    return backtestsDb.remove({ _id: id });
  }
}

const backtestEngine = new BacktestEngine();

module.exports = backtestEngine;
