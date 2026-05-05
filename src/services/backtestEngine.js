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
const instrumentValuation = require('../utils/instrumentValuation');
const backtestCostModel = require('../utils/backtestCostModel');
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
const BREAKEVEN_NEUTRAL_R_EPSILON = 0.05;
const BREAKEVEN_NEUTRAL_PIPS_EPSILON = 1;
const PROTECTIVE_STOP_REASONS = new Set([
  'BREAKEVEN_SL_HIT',
  'TRAILING_SL_HIT',
  'PROTECTIVE_SL_HIT',
  // Legacy aliases kept so old history records still classify correctly.
  'BREAKEVEN',
  'TRAILING_STOP',
]);

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
      candles: inputCandles,
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
      costModel: requestCostModel = null,
    } = params;

    const tradeEndMs = tradeEndTime ? new Date(tradeEndTime).getTime() : null;
    const candles = Number.isFinite(tradeEndMs)
      ? (inputCandles || []).filter((candle) => this._toTimeMs(candle.time) <= tradeEndMs)
      : inputCandles;

    const instrument = getInstrument(symbol);
    if (!instrument) throw new Error(`Unknown symbol: ${symbol}`);

    const resolvedParams = resolveStrategyParameters({
      strategyType,
      instrument,
      storedParameters: storedStrategyParameters,
      overrides: strategyParams,
    });
    const { costModel: resolvedCostModel, sources: costModelSources } = backtestCostModel.resolveCostModel({
      instrumentCostModel: instrument.costModel || null,
      strategyCostModel: resolvedParams && resolvedParams.costModel ? resolvedParams.costModel : null,
      requestCostModel,
    });
    const effectiveBreakeven = breakevenConfig
      ? breakevenService.normalizeBreakevenConfig(breakevenConfig, {
          partial: false,
          defaults: breakevenService.DEFAULT_BREAKEVEN_CONFIG,
          baseConfig: breakevenService.DEFAULT_BREAKEVEN_CONFIG,
        })
      : breakevenService.getDefaultBreakevenConfig();
    const tradingInstrument = this._buildTradingInstrument(instrument, resolvedParams, strategyType, executionConfigOverride);
    const valuation = instrumentValuation.getValuationContext(tradingInstrument);
    const strategy = this._createStrategy(strategyType);
    const effectiveExecutionPolicy = executionPolicy || DEFAULT_EXECUTION_POLICY;
    // costModel.spreadPips / slippagePips (when not null) override the legacy
    // request-level spreadPips / slippagePips params. Old callers that pass
    // spreadPips directly still work — costModel just adds another layer.
    const costModelSpreadPips = Number.isFinite(resolvedCostModel.spreadPips) ? resolvedCostModel.spreadPips : null;
    const costModelSlippagePips = Number.isFinite(resolvedCostModel.slippagePips) ? resolvedCostModel.slippagePips : null;
    const effectiveSpreadPips = costModelSpreadPips !== null
      ? costModelSpreadPips
      : (spreadPips || valuation.spreadPips);
    const effectiveSlippagePips = costModelSlippagePips !== null
      ? costModelSlippagePips
      : slippagePips;
    const spread = effectiveSpreadPips * valuation.pipSize;
    const slippage = effectiveSlippagePips * valuation.pipSize;
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
          this._markBreakevenState(openPosition, trailingResult.phase);
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
          const lotSize = instrumentValuation.calculateLotSize({
            entryPrice,
            slPrice: result.sl,
            balance,
            riskPercent: tradingInstrument.riskParams.riskPercent,
            instrument: tradingInstrument,
          });

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
          const plannedRiskAmount = parseFloat(
            instrumentValuation.calculatePlannedRiskAmount({
              entryPrice,
              slPrice: result.sl,
              lotSize,
              instrument: tradingInstrument,
            }).toFixed(4)
          );
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
            breakevenActivated: false,
            trailingActivated: false,
            breakevenPhase: null,
            lotSize,
            atrAtEntry: currentAtr,
            breakevenConfig: effectiveBreakeven,
            executionPolicy: effectiveExecutionPolicy,
            executionScore: executionScore.score,
            executionScoreDetails: executionScore.details,
            plannedRiskAmount,
            targetRMultiple,
            costModel: resolvedCostModel,
            costModelSources,
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
          currentEquity += instrumentValuation.calculateGrossProfitLoss({
            type: openPosition.type,
            entryPrice: openPosition.entryPrice,
            exitPrice: currentCandle.close,
            lotSize: openPosition.lotSize,
            instrument: tradingInstrument,
          });
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
      costModelUsed: {
        costModel: resolvedCostModel,
        sources: costModelSources,
      },
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
        return { exitPrice: position.currentSl, reason: this._classifyStopExitReason(position) };
      }
      if (candle.high >= position.tp) {
        return { exitPrice: position.tp, reason: 'TP_HIT' };
      }
    } else {
      if (candle.high >= position.currentSl) {
        return { exitPrice: position.currentSl, reason: this._classifyStopExitReason(position) };
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

  _markBreakevenState(position, phase) {
    if (!position || !phase) return;
    if (phase === 'breakeven') {
      position.breakevenActivated = true;
      position.breakevenPhase = 'breakeven';
    } else if (phase === 'trailing') {
      position.breakevenActivated = true;
      position.trailingActivated = true;
      position.breakevenPhase = 'trailing';
    }
  }

  _classifyStopExitReason(position) {
    if (!position) return 'INITIAL_SL_HIT';
    if (position.trailingActivated) return 'TRAILING_SL_HIT';
    if (position.breakevenActivated) return 'BREAKEVEN_SL_HIT';

    const currentSl = Number(position.currentSl);
    const originalSl = Number(position.sl);
    if (Number.isFinite(currentSl) && Number.isFinite(originalSl)) {
      const movedProtectively = position.type === 'BUY'
        ? currentSl > originalSl
        : currentSl < originalSl;
      if (movedProtectively) return 'PROTECTIVE_SL_HIT';
    }

    return 'INITIAL_SL_HIT';
  }

  _isProtectiveStopTrade(trade) {
    if (!trade) return false;
    if (PROTECTIVE_STOP_REASONS.has(trade.exitReason)) return true;
    if (trade.exitReason === 'TP_HIT') return false;
    return Boolean(trade.breakevenActivated || trade.trailingActivated);
  }

  _classifyTradeOutcome(trade, basis = 'pips') {
    if (!trade) return 'neutral';

    if (this._isProtectiveStopTrade(trade)) {
      const realizedR = Number(trade.realizedRMultiple);
      if (Number.isFinite(realizedR)) {
        if (Math.abs(realizedR) <= BREAKEVEN_NEUTRAL_R_EPSILON) return 'neutral';
        return realizedR > 0 ? 'win' : 'loss';
      }

      const profitPips = Number(trade.profitPips);
      if (Number.isFinite(profitPips)) {
        if (Math.abs(profitPips) <= BREAKEVEN_NEUTRAL_PIPS_EPSILON) return 'neutral';
        return profitPips > 0 ? 'win' : 'loss';
      }
    }

    const value = basis === 'net'
      ? Number(trade.profitLoss)
      : Number(trade.profitPips);
    if (value > 0) return 'win';
    if (value < 0) return 'loss';
    return 'neutral';
  }

  /**
   * Close a trade and calculate P/L
   *
   * Money math is delegated to instrumentValuation so the same gross/net
   * logic applies to backtests, paper, and any live fallback path. Cost
   * fields (commission/swap/fee) are kept in the trade record for future
   * cost-model work — they default to 0 today.
   */
  _closeTrade(position, exitPrice, reason, exitTime, instrument) {
    const profitPips = instrumentValuation.calculateProfitPips({
      type: position.type,
      entryPrice: position.entryPrice,
      exitPrice,
      instrument,
    });
    const grossProfitLoss = instrumentValuation.calculateGrossProfitLoss({
      type: position.type,
      entryPrice: position.entryPrice,
      exitPrice,
      lotSize: position.lotSize,
      instrument,
    });
    const costs = backtestCostModel.calculateTradeCosts({
      costModel: position.costModel,
      lotSize: position.lotSize,
      type: position.type,
      entryTime: position.entryTime,
      exitTime,
    });
    const commission = costs.commission;
    const swap = costs.swap;
    const fee = costs.fee;
    const profitLoss = instrumentValuation.calculateNetProfitLoss({
      grossProfitLoss,
      commission,
      swap,
      fee,
    });
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
      grossProfitLoss: parseFloat(grossProfitLoss.toFixed(2)),
      commission: parseFloat(commission.toFixed(2)),
      swap: parseFloat(swap.toFixed(2)),
      fee: parseFloat(fee.toFixed(2)),
      profitLoss: parseFloat(profitLoss.toFixed(2)),
      overnightDays: costs.overnightDays,
      costModelUsed: position.costModelSources || ['default'],
      plannedRiskAmount: Number(position.plannedRiskAmount) || 0,
      realizedRMultiple,
      targetRMultipleCaptured,
      breakevenActivated: Boolean(position.breakevenActivated),
      trailingActivated: Boolean(position.trailingActivated),
      breakevenPhase: position.breakevenPhase || null,
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
        neutralTrades: 0, neutralRate: 0, decisiveTrades: 0, lossRate: 0,
        sharpeRatio: 0, averageHoldingPeriodHours: 0,
        totalCommission: 0, totalSwap: 0, totalFees: 0, totalTradingCosts: 0,
        grossNetDifference: 0, netWinningTrades: 0, netLosingTrades: 0,
        netWinRate: 0, netProfitFactor: 0, netGrossProfitMoney: 0,
        netGrossLossMoney: 0, averageNetTradeMoney: 0,
        netNeutralTrades: 0, netDecisiveTrades: 0,
        breakevenExitTrades: 0, breakevenExitRate: 0,
        breakevenTriggeredTrades: 0, breakevenTriggerRate: 0,
        requiredBreakevenWinRate: 0,
      };
    }

    const outcomes = trades.map((trade) => this._classifyTradeOutcome(trade, 'pips'));
    const netOutcomes = trades.map((trade) => this._classifyTradeOutcome(trade, 'net'));
    const winners = trades.filter((_, index) => outcomes[index] === 'win');
    const losers = trades.filter((_, index) => outcomes[index] === 'loss');
    const neutralTrades = trades.filter((_, index) => outcomes[index] === 'neutral');
    const decisiveTrades = winners.length + losers.length;
    const totalProfitPips = winners.reduce((sum, trade) => sum + trade.profitPips, 0);
    const totalLossPips = losers.reduce((sum, trade) => sum + trade.profitPips, 0);
    const netProfitPips = trades.reduce((sum, trade) => sum + (Number(trade.profitPips) || 0), 0);
    const tradeGross = (trade) => {
      const gross = Number(trade.grossProfitLoss);
      return Number.isFinite(gross) ? gross : Number(trade.profitLoss) || 0;
    };
    const tradeNet = (trade) => Number(trade.profitLoss) || 0;
    // Gross PF uses pre-cost grossProfitLoss so the metric stays comparable
    // across runs with and without a cost model. Net impact is exposed
    // separately via netProfitFactor/netWinRate + grossNetDifference.
    const grossWinners = trades.filter((t) => tradeGross(t) > 0);
    const grossLosers = trades.filter((t) => tradeGross(t) <= 0);
    const totalProfitMoney = grossWinners.reduce((sum, trade) => sum + tradeGross(trade), 0);
    const totalLossMoney = grossLosers.reduce((sum, trade) => sum + Math.abs(tradeGross(trade)), 0);
    const netMoneyWinners = trades.filter((t) => tradeNet(t) > 0);
    const netMoneyLosers = trades.filter((t) => tradeNet(t) < 0);
    const netWinners = trades.filter((_, index) => netOutcomes[index] === 'win');
    const netLosers = trades.filter((_, index) => netOutcomes[index] === 'loss');
    const netNeutralTrades = trades.filter((_, index) => netOutcomes[index] === 'neutral');
    const netDecisiveTrades = netWinners.length + netLosers.length;
    const netGrossProfitMoney = netMoneyWinners.reduce((sum, trade) => sum + tradeNet(trade), 0);
    const netGrossLossMoney = netMoneyLosers.reduce((sum, trade) => sum + Math.abs(tradeNet(trade)), 0);
    const breakevenExitTrades = trades.filter((trade) => (
      trade.exitReason === 'BREAKEVEN_SL_HIT' || trade.exitReason === 'BREAKEVEN'
    )).length;
    const breakevenTriggeredTrades = trades.filter((trade) => {
      return Boolean(trade.breakevenActivated || trade.trailingActivated)
        || PROTECTIVE_STOP_REASONS.has(trade.exitReason);
    }).length;
    const decisiveNetWinners = trades.filter((trade, index) => netOutcomes[index] === 'win' && tradeNet(trade) > 0);
    const decisiveNetLosers = trades.filter((trade, index) => netOutcomes[index] === 'loss' && tradeNet(trade) < 0);
    const decisiveNetProfitMoney = decisiveNetWinners.reduce((sum, trade) => sum + tradeNet(trade), 0);
    const decisiveNetLossMoney = decisiveNetLosers.reduce((sum, trade) => sum + Math.abs(tradeNet(trade)), 0);
    const avgNetWinMoney = decisiveNetWinners.length > 0 ? decisiveNetProfitMoney / decisiveNetWinners.length : 0;
    const avgNetLossMoney = decisiveNetLosers.length > 0 ? decisiveNetLossMoney / decisiveNetLosers.length : 0;
    let requiredBreakevenWinRate = 0;
    if (avgNetWinMoney > 0 && avgNetLossMoney > 0) {
      requiredBreakevenWinRate = avgNetLossMoney / (avgNetWinMoney + avgNetLossMoney);
    } else if (avgNetWinMoney <= 0 && avgNetLossMoney > 0) {
      requiredBreakevenWinRate = 1;
    }

    let maxConsWins = 0;
    let maxConsLosses = 0;
    let consWins = 0;
    let consLosses = 0;
    for (const trade of trades) {
      const outcome = this._classifyTradeOutcome(trade, 'pips');
      if (outcome === 'win') {
        consWins++;
        consLosses = 0;
      } else if (outcome === 'loss') {
        consLosses++;
        consWins = 0;
      } else {
        consWins = 0;
        consLosses = 0;
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

    const costs = backtestCostModel.summarizeCosts(trades);
    const grossNet = totalProfitMoney - totalLossMoney;
    const netProfitMoney = parseFloat((finalBalance - initialBalance).toFixed(2));
    const netProfitFactor = netGrossLossMoney > 0
      ? parseFloat((netGrossProfitMoney / netGrossLossMoney).toFixed(2))
      : netGrossProfitMoney > 0 ? 999 : 0;

    return {
      totalTrades: trades.length,
      winningTrades: winners.length,
      losingTrades: losers.length,
      neutralTrades: neutralTrades.length,
      decisiveTrades,
      winRate: decisiveTrades > 0 ? parseFloat((winners.length / decisiveTrades).toFixed(4)) : 0,
      lossRate: decisiveTrades > 0 ? parseFloat((losers.length / decisiveTrades).toFixed(4)) : 0,
      neutralRate: parseFloat((neutralTrades.length / trades.length).toFixed(4)),
      profitFactor: totalLossMoney > 0 ? parseFloat((totalProfitMoney / totalLossMoney).toFixed(2)) : totalProfitMoney > 0 ? 999 : 0,
      // grossProfitMoney/grossLossMoney are kept alongside profitFactor so
      // portfolio-level aggregation can compute true PF across many runs
      // without averaging each run's individual PF.
      grossProfitMoney: parseFloat(totalProfitMoney.toFixed(2)),
      grossLossMoney: parseFloat(totalLossMoney.toFixed(2)),
      netWinningTrades: netWinners.length,
      netLosingTrades: netLosers.length,
      netNeutralTrades: netNeutralTrades.length,
      netDecisiveTrades,
      netWinRate: netDecisiveTrades > 0 ? parseFloat((netWinners.length / netDecisiveTrades).toFixed(4)) : 0,
      netProfitFactor,
      netGrossProfitMoney: parseFloat(netGrossProfitMoney.toFixed(2)),
      netGrossLossMoney: parseFloat(netGrossLossMoney.toFixed(2)),
      breakevenExitTrades,
      breakevenExitRate: parseFloat((breakevenExitTrades / trades.length).toFixed(4)),
      breakevenTriggeredTrades,
      breakevenTriggerRate: parseFloat((breakevenTriggeredTrades / trades.length).toFixed(4)),
      requiredBreakevenWinRate: parseFloat(requiredBreakevenWinRate.toFixed(4)),
      totalProfitPips: parseFloat(totalProfitPips.toFixed(1)),
      totalLossPips: parseFloat(totalLossPips.toFixed(1)),
      netProfitPips: parseFloat(netProfitPips.toFixed(1)),
      netProfitMoney,
      returnPercent: parseFloat(((finalBalance - initialBalance) / initialBalance * 100).toFixed(2)),
      averageNetTradeMoney: trades.length > 0 ? parseFloat((netProfitMoney / trades.length).toFixed(2)) : 0,
      averageWinPips: winners.length > 0 ? parseFloat((totalProfitPips / winners.length).toFixed(1)) : 0,
      averageLossPips: losers.length > 0 ? parseFloat((totalLossPips / losers.length).toFixed(1)) : 0,
      maxConsecutiveWins: maxConsWins,
      maxConsecutiveLosses: maxConsLosses,
      maxDrawdownPercent: parseFloat((maxDD * 100).toFixed(2)),
      sharpeRatio: parseFloat(sharpe.toFixed(2)),
      averageHoldingPeriodHours: holdingCount > 0 ? parseFloat((totalHours / holdingCount).toFixed(1)) : 0,
      totalCommission: parseFloat(costs.totalCommission.toFixed(2)),
      totalSwap: parseFloat(costs.totalSwap.toFixed(2)),
      totalFees: parseFloat(costs.totalFees.toFixed(2)),
      totalTradingCosts: parseFloat(costs.totalTradingCosts.toFixed(2)),
      // grossNetDifference = (gross gain - gross loss) - net P&L. With cost
      // model active this equals -totalTradingCosts; with no costs it's 0.
      grossNetDifference: parseFloat((grossNet - netProfitMoney).toFixed(2)),
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
      if (this._classifyTradeOutcome(trade, 'pips') === 'win') months[month].wins++;
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
