/**
 * Strategy Engine
 * Manages strategy lifecycle, fetches data, calculates indicators, runs strategies
 */

const indicatorService = require('./indicatorService');
const volumeFeatureService = require('./volumeFeatureService');
const Strategy = require('../models/Strategy');
const { instruments, getInstrumentsByStrategy, STRATEGY_TYPES } = require('../config/instruments');
const { getStrategyExecutionConfig } = require('../config/strategyExecution');
const {
  getStrategyParameterDefinitions,
  resolveStrategyParameters,
} = require('../config/strategyParameters');
const TrendFollowingStrategy = require('../strategies/TrendFollowingStrategy');
const MeanReversionStrategy = require('../strategies/MeanReversionStrategy');
const MultiTimeframeStrategy = require('../strategies/MultiTimeframeStrategy');
const MomentumStrategy = require('../strategies/MomentumStrategy');
const BreakoutStrategy = require('../strategies/BreakoutStrategy');
const VolumeFlowHybridStrategy = require('../strategies/VolumeFlowHybridStrategy');
const auditService = require('./auditService');
const { getStrategyInstance } = require('./strategyInstanceService');
const { isInstanceEnabledForScope } = require('./assignmentRuntimeService');
const economicCalendarService = require('./economicCalendarService');
const { calculateExecutionScore } = require('./executionPolicyService');

function strategyNeedsEntryIndicators(strategyType) {
  return strategyType === STRATEGY_TYPES.TREND_FOLLOWING
    || strategyType === STRATEGY_TYPES.MULTI_TIMEFRAME;
}

function buildVolumeFeatureSnapshot(strategyType, candles, resolvedParams) {
  if (strategyType !== STRATEGY_TYPES.VOLUME_FLOW_HYBRID) {
    return null;
  }

  const series = volumeFeatureService.buildFeatureSeries(candles, {
    volumeAvgPeriod: Math.max(5, Math.round(Number(resolvedParams.volume_avg_period) || 20)),
    deltaSmoothing: Math.max(2, Math.round(Number(resolvedParams.cumulative_delta_smoothing) || 8)),
  });
  return series.length > 0 ? series[series.length - 1] : null;
}

function buildSignalDedupKey({ scope, symbol, strategyType, timeframe } = {}) {
  const runtimeScope = String(scope || 'live').trim().toLowerCase() || 'live';
  const normalizedSymbol = String(symbol || 'unknown').trim() || 'unknown';
  const normalizedStrategyType = String(strategyType || 'unknown').trim() || 'unknown';
  const normalizedTimeframe = String(timeframe || 'default').trim() || 'default';
  return `${runtimeScope}:${normalizedSymbol}:${normalizedStrategyType}:${normalizedTimeframe}`;
}

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
    // Additive: volume/order-flow hybrid strategy for metals + oil. Keeps
    // the rest of the map intact so existing strategies continue working.
    this.strategies[STRATEGY_TYPES.VOLUME_FLOW_HYBRID] = new VolumeFlowHybridStrategy();
  }

  _getExecutionConfig(symbol, strategyType) {
    return getStrategyExecutionConfig(symbol, strategyType);
  }

  buildSignalDedupKey(input = {}) {
    return buildSignalDedupKey(input);
  }

  _buildRuntimeInstrument(symbol, strategyType, strategyParameters = null) {
    const executionConfig = this._getExecutionConfig(symbol, strategyType);
    if (!executionConfig) {
      return null;
    }

    const resolvedParams = resolveStrategyParameters({
      strategyType,
      instrument: executionConfig,
      storedParameters: strategyParameters,
    });

    return {
      instrument: {
        ...executionConfig,
        riskParams: {
          ...executionConfig.riskParams,
          riskPercent: Number(resolvedParams.riskPercent ?? executionConfig.riskParams.riskPercent),
          slMultiplier: Number(resolvedParams.slMultiplier ?? executionConfig.riskParams.slMultiplier),
          tpMultiplier: Number(resolvedParams.tpMultiplier ?? executionConfig.riskParams.tpMultiplier),
        },
      },
      resolvedParams,
    };
  }

  _buildAnalysisTasks(strategyRecords, symbolFilter = null) {
    const filterSet = Array.isArray(symbolFilter) && symbolFilter.length > 0
      ? new Set(symbolFilter)
      : null;

    if (!strategyRecords || strategyRecords.length === 0) {
      const defaultSymbols = filterSet ? [...filterSet] : Object.keys(instruments);
      return defaultSymbols
        .filter((symbol) => instruments[symbol])
        .map((symbol) => ({
          symbol,
          strategyType: instruments[symbol].strategyType,
        }));
    }

    const seen = new Set();
    const tasks = [];
    for (const strategyRecord of strategyRecords) {
      if (!Array.isArray(strategyRecord.symbols)) {
        continue;
      }

      for (const symbol of strategyRecord.symbols) {
        if (!instruments[symbol]) {
          continue;
        }
        if (filterSet && !filterSet.has(symbol)) {
          continue;
        }

        const taskKey = `${symbol}:${strategyRecord.name}`;
        if (seen.has(taskKey)) {
          continue;
        }

        seen.add(taskKey);
        tasks.push({
          symbol,
          strategyType: strategyRecord.name,
        });
      }
    }

    return tasks;
  }

  analyzeSymbol(symbol, strategyType, candles, higherTfCandles = null, entryCandles = null, strategyContext = null) {
    const runtimeScope = strategyContext && typeof strategyContext === 'object'
      ? strategyContext.scope || strategyContext.assignmentScope || 'live'
      : 'live';
    const runtimeParameters = strategyContext && typeof strategyContext === 'object' && strategyContext.parameters
      ? strategyContext.parameters
      : strategyContext;
    const runtime = this._buildRuntimeInstrument(symbol, strategyType, runtimeParameters);
    if (!runtime) {
      return { signal: 'NONE', symbol, strategy: null, reason: 'Unknown symbol' };
    }

    const { instrument: runtimeInstrument, resolvedParams } = runtime;
    const strategy = this.strategies[strategyType];
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
      return { signal: 'NONE', symbol, strategy: strategyType, reason: 'Need more closed candles' };
    }

    if (runtimeInstrument.entryTimeframe && closedEntryCandles.length < 50) {
      return {
        signal: 'NONE',
        symbol,
        strategy: strategyType,
        reason: `Need more closed ${runtimeInstrument.entryTimeframe} candles`,
      };
    }

    const ind = indicatorService.calculateForStrategy(strategyType, closedCandles, resolvedParams);
    const entryInd = strategyNeedsEntryIndicators(strategyType) && closedEntryCandles.length > 0
      ? indicatorService.calculateForStrategy(strategyType, closedEntryCandles, resolvedParams)
      : null;
    const volumeFeatureSnapshot = buildVolumeFeatureSnapshot(strategyType, closedCandles, resolvedParams);

    if (strategyType === STRATEGY_TYPES.MULTI_TIMEFRAME && closedHigherTfCandles.length > 0) {
      const htfCloses = closedHigherTfCandles.map((c) => c.close);
      const htfEma200 = indicatorService.ema(htfCloses, Number(resolvedParams.ema_trend) || 200);
      const latestHtfEma = htfEma200.length > 0 ? htfEma200[htfEma200.length - 1] : null;
      const latestHtfPrice = closedHigherTfCandles[closedHigherTfCandles.length - 1].close;

      if (latestHtfEma) {
        const trend = latestHtfPrice > latestHtfEma ? 'BULLISH' : 'BEARISH';
        strategy.setHigherTimeframeTrend(trend, { ema200: latestHtfEma, price: latestHtfPrice });
      }
    } else if (strategyType === STRATEGY_TYPES.MULTI_TIMEFRAME) {
      strategy.higherTfTrend = null;
    }

    const result = strategy.analyze(closedCandles, ind, runtimeInstrument, {
      higherTfCandles: closedHigherTfCandles,
      entryCandles: closedEntryCandles,
      entryIndicators: entryInd,
      volumeFeatureSnapshot,
      strategyParams: resolvedParams,
    });

    const analyzedCandle = closedCandles[closedCandles.length - 1];
    const latestEntryCandle = closedEntryCandles[closedEntryCandles.length - 1] || null;
    const signalRecord = {
      scope: runtimeScope,
      symbol,
      strategy: strategyType,
      signal: result.signal,
      confidence: result.confidence,
      rawConfidence: result.confidence,
      sl: result.sl,
      tp: result.tp,
      reason: result.reason,
      filterReason: result.filterReason || '',
      strategyParams: resolvedParams,
      marketQualityScore: result.marketQualityScore ?? null,
      marketQualityThreshold: result.marketQualityThreshold ?? null,
      marketQualityDetails: result.marketQualityDetails || {},
      indicatorsSnapshot: result.indicatorsSnapshot,
      setupTimeframe: result.setupTimeframe || runtimeInstrument.timeframe || null,
      entryTimeframe: result.entryTimeframe || runtimeInstrument.entryTimeframe || null,
      triggerReason: result.triggerReason || '',
      setupActive: result.setupActive === true,
      setupDirection: result.setupDirection || null,
      status: result.status || (result.signal !== 'NONE' ? 'TRIGGERED' : 'NO_SETUP'),
      setupCandleTime: result.setupCandleTime || analyzedCandle.time,
      entryCandleTime: result.entryCandleTime || latestEntryCandle?.time || null,
      timestamp: result.entryCandleTime || latestEntryCandle?.time || analyzedCandle.time,
      candleTime: analyzedCandle.time,
      executionPolicy: strategyContext?.executionPolicy || null,
      scanMode: strategyContext?.scanMode || 'signal',
      scanReason: strategyContext?.scanReason || 'cadence',
      category: strategyContext?.category || runtimeInstrument.category || null,
      categoryFallback: strategyContext?.categoryFallback === true,
    };

    if (signalRecord.signal !== 'NONE' || signalRecord.setupActive || signalRecord.filterReason) {
      const execution = calculateExecutionScore(signalRecord, strategyContext?.executionPolicy || undefined, {
        sameDirectionSymbolPositions: 0,
        sameDirectionCategoryPositions: 0,
      });
      signalRecord.executionScore = execution.score;
      signalRecord.executionScoreDetails = execution.details;
      signalRecord.rawConfidence = execution.rawConfidence;
    }

    const shouldRecordSignal = !strategyContext || strategyContext.recordSignal !== false;
    if (shouldRecordSignal && (result.signal !== 'NONE' || result.setupActive || Boolean(result.filterReason))) {
      const signalKey = [
        strategyType,
        signalRecord.status,
        signalRecord.setupDirection || result.signal,
        signalRecord.filterReason || '',
        signalRecord.setupCandleTime || analyzedCandle.time,
        signalRecord.entryCandleTime || signalRecord.candleTime,
      ].join(':');
      const dedupTimeframe = result.entryTimeframe
        || result.setupTimeframe
        || strategyContext?.timeframe
        || runtimeInstrument.entryTimeframe
        || runtimeInstrument.timeframe
        || 'default';
      const emissionKey = buildSignalDedupKey({
        scope: runtimeScope,
        symbol,
        strategyType,
        timeframe: dedupTimeframe,
      });

      if (this.lastEmittedSignals.get(emissionKey) === signalKey) {
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

      this.lastEmittedSignals.set(emissionKey, signalKey);
      this.signals.unshift(signalRecord);
      if (this.signals.length > this.maxSignalHistory) {
        this.signals = this.signals.slice(0, this.maxSignalHistory);
      }
    }

    return signalRecord;
  }

  async analyzeAll(getCandlesFn, onSignalFn, enabledSymbols = null, options = {}) {
    const scope = options.scope || 'live';
    const mode = options.mode || scope || 'live';
    const symbolsToAnalyze = enabledSymbols || Object.keys(instruments);
    const strategyRecords = options.analysisTasks ? null : await Strategy.findAll();
    const analysisTasks = Array.isArray(options.analysisTasks)
      ? options.analysisTasks
      : this._buildAnalysisTasks(strategyRecords, symbolsToAnalyze);
    const candleCache = new Map();
    const results = [];

    for (const task of analysisTasks) {
      const taskScope = task.scope || task.assignmentScope || scope;
      try {
        const { symbol, strategyType } = task;
        const strategyInstance = task.strategyInstance || await getStrategyInstance(
          symbol,
          strategyType,
          { activeProfile: options.activeProfile, scope: taskScope }
        );
        if (!isInstanceEnabledForScope(strategyInstance, taskScope)) {
          console.log(`[Engine] Skipping disabled ${taskScope} strategy instance ${symbol}/${strategyType}`);
          continue;
        }

        console.log(`[Engine] Using strategy parameters for ${symbol}/${strategyType} source='${strategyInstance.source}'`);
        const executionConfig = this._getExecutionConfig(symbol, strategyType);
        if (!executionConfig) continue;

        const fetchCachedCandles = async (timeframe) => {
          const cacheKey = `${symbol}:${timeframe}:251`;
          if (!candleCache.has(cacheKey)) {
            candleCache.set(cacheKey, Promise.resolve(getCandlesFn(symbol, timeframe, 251)));
          }
          return candleCache.get(cacheKey);
        };

        const candles = await fetchCachedCandles(executionConfig.timeframe);
        if (!candles || candles.length < 50) {
          console.log(`[Engine] Insufficient data for ${symbol}: ${candles ? candles.length : 0} candles`);
          auditService.noSetup({
            symbol,
            strategy: strategyType,
            module: 'strategyEngine',
            scope: taskScope,
            signal: 'NONE',
            reasonCode: 'INSUFFICIENT_CANDLES',
            reasonText: `Only ${candles ? candles.length : 0} candles (need ≥50)`,
          });
          continue;
        }

        const candleTimeValue = candles.length > 1
          ? candles[candles.length - 2]?.time || candles[candles.length - 1]?.time
          : candles[candles.length - 1]?.time;
        const candleTime = candleTimeValue ? new Date(candleTimeValue) : null;

        const blackoutCfg = strategyInstance.newsBlackout;
        if (
          blackoutCfg
          && blackoutCfg.enabled
          && mode !== 'backtest'
          && candleTime
          && !Number.isNaN(candleTime.getTime())
        ) {
          await economicCalendarService.ensureCalendar();
          const blackout = economicCalendarService.isInBlackout(symbol, candleTime, blackoutCfg);
          if (blackout.blocked) {
            const blackoutResult = {
              symbol,
              strategy: strategyType,
              signal: 'NONE',
              reason: 'NEWS_BLACKOUT',
              status: 'INFO',
              candleTime: candleTime.toISOString(),
              timestamp: candleTime.toISOString(),
              blackoutEvent: blackout.event,
              parameterSource: strategyInstance.source,
            };

            auditService.record({
              type: 'NEWS_BLACKOUT',
              stage: 'NEWS_BLACKOUT',
              status: 'INFO',
              symbol,
              strategy: strategyType,
              module: 'strategyEngine',
              scope: taskScope,
              signal: 'NONE',
              reasonCode: auditService.REASON.NEWS_BLACKOUT,
              reasonText: `Blocked by scheduled ${blackout.event.impact} ${blackout.event.currency} event: ${blackout.event.title}`,
              timestamp: candleTime.toISOString(),
              setupCandleTime: candleTime.toISOString(),
              details: {
                candleTime: candleTime.toISOString(),
                event: blackout.event,
              },
            });

            this.signals.unshift(blackoutResult);
            if (this.signals.length > this.maxSignalHistory) {
              this.signals = this.signals.slice(0, this.maxSignalHistory);
            }

            console.log(
              `[Engine] News blackout blocked ${symbol}/${strategyType} `
              + `for event "${blackout.event.title}" at ${blackout.event.time}`
            );
            results.push(blackoutResult);
            continue;
          }
        }

        let higherTfCandles = null;
        if (executionConfig.higherTimeframe) {
          higherTfCandles = await fetchCachedCandles(executionConfig.higherTimeframe);
        }

        let entryCandles = null;
        if (executionConfig.entryTimeframe) {
          entryCandles = await fetchCachedCandles(executionConfig.entryTimeframe);
        }

        const result = {
          ...this.analyzeSymbol(
            symbol,
            strategyType,
            candles,
            higherTfCandles,
            entryCandles,
            {
              ...strategyInstance,
              scope: taskScope,
              scanMode: task.scanMode || 'signal',
              scanReason: task.scanReason || 'cadence',
              timeframe: task.cadenceTimeframe || executionConfig.timeframe || null,
              category: task.category || executionConfig.category || null,
              categoryFallback: task.categoryFallback === true,
            }
          ),
          parameterSource: strategyInstance.source,
          executionPolicy: strategyInstance.executionPolicy || null,
          effectiveBreakeven: strategyInstance.effectiveBreakeven || null,
          effectiveExitPlan: strategyInstance.effectiveExitPlan || null,
          effectiveTradeManagement: strategyInstance.effectiveTradeManagement || null,
          scanMode: task.scanMode || 'signal',
          scanReason: task.scanReason || 'cadence',
          category: task.category || executionConfig.category || null,
          categoryFallback: task.categoryFallback === true,
        };

        this._auditAnalysisResult(result, { scope: taskScope });
        results.push(result);

        if (result.signal !== 'NONE' && onSignalFn) {
          await onSignalFn(result);
        }
      } catch (err) {
        console.error(`[Engine] Error analyzing ${task.symbol}:`, err.message);
        auditService.noSetup({
          symbol: task.symbol,
          strategy: task.strategyType,
          module: 'strategyEngine',
          scope: taskScope,
          signal: 'NONE',
          status: 'WARN',
          reasonCode: 'ANALYSIS_ERROR',
          reasonText: err.message,
        });
      }
    }

    return results;
  }

  _auditAnalysisResult(result, { scope = 'live' } = {}) {
    if (!result || !result.symbol) return;

    const base = {
      symbol: result.symbol,
      strategy: result.strategy,
      module: 'strategyEngine',
      scope,
      signal: result.signal,
      confidence: typeof result.confidence === 'number' ? result.confidence : null,
      setupDirection: result.setupDirection || null,
      setupActive: result.setupActive === true,
      filterReason: result.filterReason || null,
      triggerReason: result.triggerReason || null,
      setupTimeframe: result.setupTimeframe || null,
      entryTimeframe: result.entryTimeframe || null,
      setupCandleTime: result.setupCandleTime || null,
      entryCandleTime: result.entryCandleTime || null,
      sl: typeof result.sl === 'number' ? result.sl : null,
      tp: typeof result.tp === 'number' ? result.tp : null,
      marketQualityScore:
        typeof result.marketQualityScore === 'number' ? result.marketQualityScore : null,
      marketQualityThreshold:
        typeof result.marketQualityThreshold === 'number' ? result.marketQualityThreshold : null,
      indicatorsSnapshot: result.indicatorsSnapshot || null,
      reasonText: result.reason || '',
      timestamp: result.timestamp || null,
      category: result.category || null,
      categoryFallback: result.categoryFallback === true,
      scanMode: result.scanMode || null,
      scanReason: result.scanReason || null,
    };

    const status = result.status || (result.signal !== 'NONE' ? 'TRIGGERED' : 'NO_SETUP');

    if (status === 'DUPLICATE') {
      auditService.duplicate({ ...base, reasonText: result.reason });
      return;
    }
    if (status === 'TRIGGERED' || result.signal !== 'NONE') {
      auditService.triggered(base);
      return;
    }
    if (status === 'FILTERED' || base.filterReason) {
      auditService.filtered({
        ...base,
        reasonCode: base.filterReason || 'FILTERED',
        reasonText: base.filterReason || base.reasonText,
      });
      return;
    }
    if (base.setupActive) {
      auditService.setupFound(base);
      return;
    }
    auditService.noSetup({
      ...base,
      reasonCode: base.reasonText ? 'NO_SETUP' : 'NO_SETUP',
      reasonText: base.reasonText || 'No setup on current candles',
    });
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
      parameterDefinitions: getStrategyParameterDefinitions(type),
    }));
  }
}

const strategyEngine = new StrategyEngine();

module.exports = strategyEngine;
