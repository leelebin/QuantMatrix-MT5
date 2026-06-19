#!/usr/bin/env node

/**
 * Read-only OOS walk-forward validation for selected strategy/symbol combos.
 *
 * Optimizers see optimizer windows only. Each optimizer top-10 parameter set
 * is simulated on its subsequent OOS window, with no persistence or live
 * configuration changes.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const mt5RootService = require('../src/services/mt5Service');
const optimizerService = require('../src/services/optimizerService');
const backtestEngine = require('../src/services/backtestEngine');
const Strategy = require('../src/models/Strategy');
const StrategyInstance = require('../src/models/StrategyInstance');
const breakevenService = require('../src/services/breakevenService');
const { resolveExecutionPolicy } = require('../src/services/executionPolicyService');
const { riskProfilesDb } = require('../src/config/db');
const {
  getInstrument,
  INSTRUMENT_CATEGORIES,
  STRATEGY_TYPES,
  VOLUME_FLOW_HYBRID_DEFAULT_SYMBOLS,
  VOLUME_FLOW_HYBRID_OPTIONAL_SYMBOLS,
} = require('../src/config/instruments');
const {
  getStrategyExecutionConfig,
  getForcedTimeframeExecutionConfig,
} = require('../src/config/strategyExecution');
const {
  getOptimizerParameterRanges,
  resolveStrategyParameters,
} = require('../src/config/strategyParameters');
const {
  DEFAULT_WARMUP_BARS,
  estimateFetchLimit,
  filterCandlesByRange,
  getWarmupStart,
} = require('../src/utils/candleRange');
const { analyzeEquityCurveQuality } = require('../src/utils/equityCurveQuality');

const SOURCE_REPORT_DEFAULT = 'reports/default-timeframe-edge-discovery-2026-05-23-non-live-four-regime-top10.json';
const OUTPUT_BASE_DEFAULT = 'reports/oos-walkforward-validation-2026-05-23-top-regime-dependent';
const CANDIDATE_KEYS = Object.freeze([
  'Momentum:XAUUSD:1h',
  'Breakout:XAUUSD:1h',
  'Breakout:XAGUSD:1h',
  'Momentum:XAGUSD:1h',
  'Momentum:BTCUSD:1h',
  'MeanReversion:US30:1h',
  'Breakout:NAS100:1h',
  'Momentum:XRPUSD:1h',
  'VolumeFlowHybrid:XAUUSD:5m',
  'VolumeFlowHybrid:NAS100:5m',
]);

const WINDOWS = Object.freeze([
  {
    id: '2024_H1_TO_H2',
    optimizer: { from: '2024-01-01', to: '2024-07-01' },
    oos: { from: '2024-07-01', to: '2025-01-01' },
  },
  {
    id: '2024_H2_TO_2025_H1',
    optimizer: { from: '2024-07-01', to: '2025-01-01' },
    oos: { from: '2025-01-01', to: '2025-07-01' },
  },
  {
    id: '2025_H1_TO_H2',
    optimizer: { from: '2025-01-01', to: '2025-07-01' },
    oos: { from: '2025-07-01', to: '2026-01-01' },
  },
  {
    id: '2025_H2_TO_2026_RECENT',
    optimizer: { from: '2025-07-01', to: '2026-01-01' },
    oos: { from: '2026-01-01', to: '2026-05-01' },
  },
]);

const THRESHOLDS = Object.freeze({
  STRICT_PASS: {
    oosWindows: 3,
    profitableWindowRatio: 0.75,
    aggregateNetProfitMoney: 0,
    avgProfitFactor: 1.30,
    worstProfitFactor: 1.05,
    avgSharpeRatio: 0.8,
    worstReturnPercent: -5,
    avgMaxDrawdownPercent: 20,
    profitConcentrationByWindowTop1: 0.65,
    combinedPositiveSegmentRatio: 0.60,
  },
  PAPER_WATCH: {
    oosWindows: 3,
    profitableWindowRatio: 0.60,
    aggregateNetProfitMoney: 0,
    avgProfitFactor: 1.15,
    avgSharpeRatio: 0.5,
    worstReturnPercent: -10,
    profitConcentrationByWindowTop1: 0.75,
  },
  REJECT: {
    aggregateNetProfitMoney: 0,
    profitableWindowRatio: 0.50,
    avgProfitFactor: 1.05,
    profitConcentrationByWindowTop1: 0.80,
  },
  underwaterRiskOnly: {
    goodMaximum: 0.65,
    cautionMaximum: 0.80,
    aboveCaution: 'HIGH_STAGNATION_RISK',
  },
});

const DEFAULT_COST_MODEL = Object.freeze({
  spreadPips: 2,
  slippagePips: 1,
  commissionPerLot: 7,
  commissionPerSide: true,
  fixedFeePerTrade: 0,
});

const HIGH_COST_CATEGORIES = new Set([
  INSTRUMENT_CATEGORIES.METALS,
  INSTRUMENT_CATEGORIES.INDICES,
  INSTRUMENT_CATEGORIES.ENERGY,
  INSTRUMENT_CATEGORIES.CRYPTO,
]);

const VOLUME_FLOW_SUPPORTED_SYMBOLS = new Set([
  ...VOLUME_FLOW_HYBRID_DEFAULT_SYMBOLS,
  ...VOLUME_FLOW_HYBRID_OPTIONAL_SYMBOLS,
]);

function parseArgs(argv) {
  const result = {};
  argv.slice(2).forEach((entry) => {
    if (!entry.startsWith('--')) return;
    const [key, ...rest] = entry.slice(2).split('=');
    result[key] = rest.length ? rest.join('=') : 'true';
  });
  return result;
}

function intArg(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function numberArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numberOrZero(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function round(value, digits = 4) {
  return parseFloat(numberOrZero(value).toFixed(digits));
}

function average(values) {
  return values.length
    ? values.reduce((sum, value) => sum + numberOrZero(value), 0) / values.length
    : 0;
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, nested) => (
    typeof nested === 'number' && !Number.isFinite(nested) ? null : nested
  )));
}

function comboKey(combo) {
  return `${combo.strategy}:${combo.symbol}:${combo.timeframe}`;
}

function parseComboKey(key) {
  const parts = String(key).split(':');
  if (parts.length !== 3) throw new Error(`Invalid candidate key: ${key}`);
  return { strategy: parts[0], symbol: parts[1], timeframe: parts[2] };
}

function parseRange(range) {
  const start = new Date(range.from);
  const endExclusive = new Date(range.to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(endExclusive.getTime()) || endExclusive <= start) {
    throw new Error(`Invalid date range: ${JSON.stringify(range)}`);
  }
  return { start, endExclusive };
}

function outputPaths(args) {
  const resumeBase = args.resumeReport
    ? path.resolve(process.cwd(), args.resumeReport).replace(/\.json$/i, '')
    : null;
  const base = resumeBase || path.resolve(process.cwd(), args.outputBase || OUTPUT_BASE_DEFAULT);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  return { json: `${base}.json`, csv: `${base}.csv`, md: `${base}.md` };
}

function compactSummary(summary = {}) {
  const keys = [
    'totalTrades',
    'netProfitMoney',
    'returnPercent',
    'profitFactor',
    'maxDrawdownPercent',
    'sharpeRatio',
    'returnToDrawdown',
    'expectancyPerTrade',
    'maxConsecutiveLosses',
    'profitConcentrationTop1',
    'robustScore',
    'warningFlags',
    'sampleQuality',
  ];
  return Object.fromEntries(keys.map((key) => [key, summary[key] ?? null]));
}

function mergeObjects(base, override) {
  return {
    ...((base && typeof base === 'object') ? base : {}),
    ...((override && typeof override === 'object') ? override : {}),
  };
}

function underwaterRiskLabel(quality) {
  const underwater = numberOrZero(quality?.underwaterPercent);
  if (underwater <= THRESHOLDS.underwaterRiskOnly.goodMaximum) return 'GOOD';
  if (underwater <= THRESHOLDS.underwaterRiskOnly.cautionMaximum) return 'CAUTION';
  return 'HIGH_STAGNATION_RISK';
}

function isStrategySupported(combo) {
  return combo.strategy !== STRATEGY_TYPES.VOLUME_FLOW_HYBRID
    || VOLUME_FLOW_SUPPORTED_SYMBOLS.has(combo.symbol);
}

function buildCostModel(instrument, costPreset) {
  if (instrument?.costModel && typeof instrument.costModel === 'object') {
    return { costModel: { ...instrument.costModel }, source: 'instrument.costModel' };
  }
  const costModel = { ...DEFAULT_COST_MODEL };
  if (costPreset === 'conservative' || HIGH_COST_CATEGORIES.has(instrument?.category)) {
    costModel.spreadPips = Math.max(costModel.spreadPips, numberOrZero(instrument?.spread));
  }
  return {
    costModel,
    source: costPreset === 'conservative' ? 'conservative_default_plus_instrument_spread' : 'default',
  };
}

async function getActiveRiskProfileReadOnly() {
  try {
    return await riskProfilesDb.findOne({ isActive: true }) || await riskProfilesDb.findOne({});
  } catch (_) {
    return null;
  }
}

async function buildEffectiveRuntime(combo, strategyRecord, activeProfile) {
  const instrument = getInstrument(combo.symbol);
  const storedInstance = await StrategyInstance.findByKey(combo.strategy, combo.symbol).catch(() => null);
  const tradeManagement = mergeObjects(strategyRecord?.tradeManagement, storedInstance?.tradeManagement);
  const mergedStrategy = {
    ...(strategyRecord || { name: combo.strategy }),
    tradeManagement: Object.keys(tradeManagement).length ? tradeManagement : null,
  };
  return {
    liveEnabledAtRun: Boolean(storedInstance?.liveEnabled),
    storedParameters: resolveStrategyParameters({
      strategyType: combo.strategy,
      instrument,
      storedParameters: strategyRecord?.parameters || {},
      overrides: storedInstance?.parameters || {},
    }),
    breakevenConfig: breakevenService.resolveEffectiveBreakeven(activeProfile, mergedStrategy),
    executionPolicy: resolveExecutionPolicy(
      strategyRecord?.executionPolicy || null,
      storedInstance?.executionPolicy || null
    ),
  };
}

function resolveExecutionConfig(combo) {
  const defaults = getStrategyExecutionConfig(combo.symbol, combo.strategy);
  if (!defaults) return null;
  return defaults.timeframe === combo.timeframe
    ? defaults
    : getForcedTimeframeExecutionConfig(combo.symbol, combo.strategy, combo.timeframe);
}

function buildCandleCache(mt5) {
  const cache = new Map();
  return async (symbol, timeframe, fetchStart, limit, endExclusive) => {
    const key = [symbol, timeframe, fetchStart.toISOString(), endExclusive.toISOString(), limit].join('|');
    if (!cache.has(key)) {
      cache.set(key, mt5.getCandles(symbol, timeframe, fetchStart, limit, endExclusive));
    }
    return cache.get(key);
  };
}

async function fetchBundle(getCachedCandles, combo, executionConfig, range) {
  const timeframe = executionConfig.timeframe || combo.timeframe;
  const start = range.start;
  const endExclusive = range.endExclusive;
  const primaryStart = getWarmupStart(start, timeframe, DEFAULT_WARMUP_BARS);
  const primaryLimit = estimateFetchLimit(timeframe, primaryStart, endExclusive);
  const raw = await getCachedCandles(combo.symbol, timeframe, primaryStart, primaryLimit, endExclusive);
  const candles = filterCandlesByRange(raw || [], primaryStart, endExclusive);
  const inRange = filterCandlesByRange(raw || [], start, endExclusive);

  let higherTfCandles = null;
  if (executionConfig.higherTimeframe) {
    const higherStart = getWarmupStart(start, executionConfig.higherTimeframe, DEFAULT_WARMUP_BARS);
    const higherLimit = estimateFetchLimit(executionConfig.higherTimeframe, higherStart, endExclusive);
    const higherRaw = await getCachedCandles(combo.symbol, executionConfig.higherTimeframe, higherStart, higherLimit, endExclusive);
    higherTfCandles = filterCandlesByRange(higherRaw || [], higherStart, endExclusive);
  }

  let lowerTfCandles = null;
  if (executionConfig.entryTimeframe) {
    const lowerStart = getWarmupStart(start, executionConfig.entryTimeframe, DEFAULT_WARMUP_BARS);
    const lowerLimit = estimateFetchLimit(executionConfig.entryTimeframe, lowerStart, endExclusive);
    const lowerRaw = await getCachedCandles(combo.symbol, executionConfig.entryTimeframe, lowerStart, lowerLimit, endExclusive);
    lowerTfCandles = filterCandlesByRange(lowerRaw || [], lowerStart, endExclusive);
  }

  return {
    candles,
    higherTfCandles,
    lowerTfCandles,
    effectiveStart: inRange[0] ? new Date(inRange[0].time) : start,
    effectiveEnd: inRange.length ? new Date(inRange[inRange.length - 1].time) : new Date(endExclusive.getTime() - 1),
    fetchMeta: {
      timeframe,
      primaryInRange: inRange.length,
      primaryWithWarmup: candles.length,
      higherCount: higherTfCandles ? higherTfCandles.length : 0,
      lowerCount: lowerTfCandles ? lowerTfCandles.length : 0,
      requestedFrom: start.toISOString(),
      requestedToExclusive: endExclusive.toISOString(),
    },
  };
}

async function runOptimizerWithTimeout(params, maxWindowMs) {
  let timedOut = false;
  const timer = maxWindowMs > 0 ? setTimeout(() => {
    timedOut = true;
    optimizerService.requestStop();
  }, maxWindowMs) : null;
  try {
    const result = await optimizerService.run(params);
    return { ...result, timedOut };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function oosStabilityScore(summary, quality) {
  const profit = numberOrZero(summary.netProfitMoney);
  const pf = Math.min(3, Math.max(0, numberOrZero(summary.profitFactor)));
  const sharpe = Math.min(5, Math.max(-5, numberOrZero(summary.sharpeRatio)));
  const drawdown = Math.max(0, numberOrZero(summary.maxDrawdownPercent));
  const returnPercent = numberOrZero(summary.returnPercent);
  let score = 0;
  if (profit > 0) score += 1000;
  if (pf >= 1.05) score += 200;
  if (sharpe >= 0) score += 100;
  if (quality?.isLinearUptrend) score += 100;
  score += pf * 20;
  score += sharpe * 10;
  score += numberOrZero(quality?.positiveSegmentRatio) * 50;
  score += numberOrZero(quality?.rSquared) * 40;
  score -= Math.max(0, drawdown - 20) * 5;
  score -= Math.max(0, -returnPercent - 5) * 5;
  return round(score, 4);
}

function selectStableOosResult(results) {
  return results.slice().sort((a, b) => (
    b.oosStabilityScore - a.oosStabilityScore
    || numberOrZero(b.oosSummary.robustScore) - numberOrZero(a.oosSummary.robustScore)
    || numberOrZero(b.oosSummary.netProfitMoney) - numberOrZero(a.oosSummary.netProfitMoney)
  ))[0];
}

async function runWindow({ combo, window, config, strategyRecord, activeProfile, getCachedCandles }) {
  const startedAt = new Date().toISOString();
  const instrument = getInstrument(combo.symbol);
  const executionConfig = resolveExecutionConfig(combo);
  const costInfo = buildCostModel(instrument, config.costPreset);
  const runtime = await buildEffectiveRuntime(combo, strategyRecord, activeProfile);
  const optimizerRange = parseRange(window.optimizer);
  const oosRange = parseRange(window.oos);

  try {
    const optimizerBundle = await fetchBundle(getCachedCandles, combo, executionConfig, optimizerRange);
    if (optimizerBundle.candles.length < DEFAULT_WARMUP_BARS + 2 || optimizerBundle.fetchMeta.primaryInRange < 50) {
      return {
        id: window.id,
        status: 'INSUFFICIENT_OPTIMIZER_DATA',
        reason: `Optimizer range has ${optimizerBundle.fetchMeta.primaryInRange} in-range primary candles.`,
        startedAt,
        finishedAt: new Date().toISOString(),
        optimizer: { fetchMeta: optimizerBundle.fetchMeta },
      };
    }

    const optimizerResult = await runOptimizerWithTimeout({
      symbol: combo.symbol,
      strategyType: combo.strategy,
      timeframe: executionConfig.timeframe,
      candles: optimizerBundle.candles,
      higherTfCandles: optimizerBundle.higherTfCandles,
      lowerTfCandles: optimizerBundle.lowerTfCandles,
      initialBalance: config.initialBalance,
      optimizeFor: config.optimizeFor,
      minimumTrades: config.minimumTrades,
      parallelWorkers: config.parallelWorkers,
      costModel: costInfo.costModel,
      tradeStartTime: optimizerBundle.effectiveStart.toISOString(),
      tradeEndTime: optimizerBundle.effectiveEnd.toISOString(),
      storedStrategyParameters: runtime.storedParameters,
      breakevenConfig: runtime.breakevenConfig,
      executionPolicy: runtime.executionPolicy,
      executionConfigOverride: executionConfig,
      onProgress: (progress) => {
        if (progress.current === progress.total || progress.current % 100 === 0) {
          console.log(`[OOS] optimizer ${comboKey(combo)} ${window.id}: ${progress.current}/${progress.total}`);
        }
      },
    }, config.maxWindowMs);

    const optimizer = {
      status: optimizerResult.status,
      timedOut: Boolean(optimizerResult.timedOut),
      totalCombinations: optimizerResult.totalCombinations,
      processedCombinations: optimizerResult.processedCombinations,
      validResults: optimizerResult.validResults,
      optimizeFor: optimizerResult.optimizeFor,
      fetchMeta: optimizerBundle.fetchMeta,
      top10: (optimizerResult.top10 || []).map((result, index) => ({
        optimizerRank: index + 1,
        parameters: result.parameters,
        optimizerSummary: compactSummary(result.summary),
      })),
    };

    if (optimizerResult.timedOut) {
      return {
        id: window.id,
        status: 'OPTIMIZER_TIMEOUT',
        reason: `Optimizer exceeded maxWindowMs=${config.maxWindowMs}.`,
        startedAt,
        finishedAt: new Date().toISOString(),
        optimizer,
      };
    }

    if (!optimizerResult.top10 || optimizerResult.top10.length === 0) {
      return {
        id: window.id,
        status: 'NO_VALID_OPTIMIZER_RESULT',
        reason: 'Optimizer returned no top parameters meeting minimumTrades.',
        startedAt,
        finishedAt: new Date().toISOString(),
        optimizer,
      };
    }

    const oosBundle = await fetchBundle(getCachedCandles, combo, executionConfig, oosRange);
    if (oosBundle.candles.length < DEFAULT_WARMUP_BARS + 2 || oosBundle.fetchMeta.primaryInRange < 20) {
      return {
        id: window.id,
        status: 'INSUFFICIENT_OOS_DATA',
        reason: `OOS range has ${oosBundle.fetchMeta.primaryInRange} in-range primary candles.`,
        startedAt,
        finishedAt: new Date().toISOString(),
        optimizer,
        oos: { fetchMeta: oosBundle.fetchMeta },
      };
    }

    const top10Oos = [];
    const oosErrors = [];
    for (let index = 0; index < optimizerResult.top10.length; index += 1) {
      const optimizerSelection = optimizerResult.top10[index];
      try {
        const simulation = await backtestEngine.simulate({
          symbol: combo.symbol,
          strategyType: combo.strategy,
          timeframe: executionConfig.timeframe,
          candles: oosBundle.candles,
          higherTfCandles: oosBundle.higherTfCandles,
          lowerTfCandles: oosBundle.lowerTfCandles,
          initialBalance: config.initialBalance,
          tradeStartTime: oosBundle.effectiveStart.toISOString(),
          tradeEndTime: oosBundle.effectiveEnd.toISOString(),
          strategyParams: optimizerSelection.parameters,
          storedStrategyParameters: runtime.storedParameters,
          breakevenConfig: runtime.breakevenConfig,
          executionPolicy: runtime.executionPolicy,
          executionConfigOverride: executionConfig,
          costModel: costInfo.costModel,
          parameterPreset: 'oos_optimizer_top10',
          parameterPresetResolution: {
            preset: 'oos_optimizer_top10',
            fallbackUsed: false,
            resolvedFrom: 'optimizer_window_only',
            optimizerHistoryId: null,
            optimizerCompletedAt: optimizerResult.completedAt,
            optimizerTimeframe: executionConfig.timeframe,
            optimizerOptimizeFor: config.optimizeFor,
          },
        });
        const oosSummary = compactSummary(simulation.summary);
        const equityCurveQuality = analyzeEquityCurveQuality(simulation.equityCurve || [], config.initialBalance);
        top10Oos.push({
          optimizerRank: index + 1,
          parameters: optimizerSelection.parameters,
          optimizerSummary: compactSummary(optimizerSelection.summary),
          oosSummary,
          equityCurveQuality,
          underwaterRisk: underwaterRiskLabel(equityCurveQuality),
          oosStabilityScore: oosStabilityScore(oosSummary, equityCurveQuality),
          selectedAsWindowRepresentative: false,
          _equityCurve: simulation.equityCurve || [],
        });
      } catch (error) {
        oosErrors.push({ optimizerRank: index + 1, message: error.message });
      }
    }

    if (!top10Oos.length) {
      return {
        id: window.id,
        status: 'ERROR',
        reason: 'Every top-10 OOS simulation failed.',
        startedAt,
        finishedAt: new Date().toISOString(),
        optimizer,
        oosErrors,
      };
    }

    const selected = selectStableOosResult(top10Oos);
    selected.selectedAsWindowRepresentative = true;
    return {
      id: window.id,
      status: 'COMPLETED',
      methodology: 'OPTIMIZE_IN_PRIOR_WINDOW_TEST_TOP10_ON_FUTURE_OOS',
      selectionWarning: 'Representative parameter is selected after observing top-10 OOS stability; reserve a fresh holdout before live use.',
      startedAt,
      finishedAt: new Date().toISOString(),
      liveEnabledAtRun: runtime.liveEnabledAtRun,
      costModel: costInfo,
      optimizer,
      oos: {
        fetchMeta: oosBundle.fetchMeta,
        top10Metrics: top10Oos.map((result) => {
          const { _equityCurve, ...persisted } = result;
          return persisted;
        }),
        selectedRepresentative: selected,
      },
      oosErrors,
    };
  } catch (error) {
    return {
      id: window.id,
      status: 'ERROR',
      reason: error.message,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: { message: error.message, stack: error.stack },
    };
  }
}

function buildCombinedCurve(windows, initialBalance) {
  const combined = [];
  let runningStart = numberOrZero(initialBalance);
  windows.forEach((window) => {
    const selected = window.oos?.selectedRepresentative;
    const curve = selected?._equityCurve || [];
    if (!curve.length) return;
    const base = numberOrZero(curve[0].equity);
    curve.forEach((point, index) => {
      if (combined.length && index === 0) return;
      combined.push({
        time: point.time,
        equity: round(runningStart + (numberOrZero(point.equity) - base), 4),
      });
    });
    runningStart += numberOrZero(selected.oosSummary.netProfitMoney);
  });
  return combined;
}

function classifyCombo(combo, initialBalance) {
  const completed = combo.windows.filter((window) => window.status === 'COMPLETED' && window.oos?.selectedRepresentative);
  if (!completed.length) {
    return {
      status: 'REJECT',
      recommendation: 'DO_NOT_ADVANCE',
      reasons: ['No completed OOS window with valid selected-parameter simulations.'],
      aggregate: { completedOosWindows: 0 },
    };
  }

  const selected = completed.map((window) => window.oos.selectedRepresentative);
  const profits = selected.map((item) => numberOrZero(item.oosSummary.netProfitMoney));
  const returns = selected.map((item) => numberOrZero(item.oosSummary.returnPercent));
  const profitFactors = selected.map((item) => numberOrZero(item.oosSummary.profitFactor));
  const sharpes = selected.map((item) => numberOrZero(item.oosSummary.sharpeRatio));
  const drawdowns = selected.map((item) => numberOrZero(item.oosSummary.maxDrawdownPercent));
  const positiveProfitSum = profits.filter((profit) => profit > 0).reduce((sum, profit) => sum + profit, 0);
  const combinedQuality = analyzeEquityCurveQuality(buildCombinedCurve(completed, initialBalance), initialBalance);
  const aggregate = {
    completedOosWindows: completed.length,
    profitableWindowRatio: round(profits.filter((profit) => profit > 0).length / completed.length, 4),
    aggregateNetProfitMoney: round(profits.reduce((sum, profit) => sum + profit, 0), 2),
    avgReturnPercent: round(average(returns), 2),
    worstReturnPercent: round(Math.min(...returns), 2),
    avgProfitFactor: round(average(profitFactors), 2),
    worstProfitFactor: round(Math.min(...profitFactors), 2),
    avgSharpeRatio: round(average(sharpes), 2),
    worstSharpeRatio: round(Math.min(...sharpes), 2),
    avgMaxDrawdownPercent: round(average(drawdowns), 2),
    worstMaxDrawdownPercent: round(Math.max(...drawdowns), 2),
    profitConcentrationByWindowTop1: positiveProfitSum > 0
      ? round(Math.max(...profits.map((profit) => Math.max(profit, 0))) / positiveProfitSum, 4)
      : 1,
    combinedEquityQuality: combinedQuality,
    combinedUnderwaterRisk: underwaterRiskLabel(combinedQuality),
    selectedParametersByWindow: Object.fromEntries(
      completed.map((window) => [window.id, window.oos.selectedRepresentative.parameters])
    ),
  };

  const strictChecks = [
    [aggregate.completedOosWindows >= 3, 'completed OOS windows < 3'],
    [aggregate.profitableWindowRatio >= 0.75, 'profitable window ratio < 0.75'],
    [aggregate.aggregateNetProfitMoney > 0, 'aggregate net profit <= 0'],
    [aggregate.avgProfitFactor >= 1.30, 'average profit factor < 1.30'],
    [aggregate.worstProfitFactor >= 1.05, 'worst profit factor < 1.05'],
    [aggregate.avgSharpeRatio >= 0.8, 'average Sharpe < 0.8'],
    [aggregate.worstReturnPercent > -5, 'worst return <= -5%'],
    [aggregate.avgMaxDrawdownPercent <= 20, 'average max drawdown > 20%'],
    [aggregate.profitConcentrationByWindowTop1 <= 0.65, 'profit concentration > 0.65'],
    [numberOrZero(combinedQuality.positiveSegmentRatio) >= 0.60, 'combined positive segment ratio < 0.60'],
  ];
  const strictFailures = strictChecks.filter(([pass]) => !pass).map(([, reason]) => reason);
  if (!strictFailures.length) {
    return {
      status: 'STRICT_PASS',
      recommendation: 'ENTER_DEMO_OR_PAPER_WATCH_ONLY',
      reasons: ['Meets all STRICT_PASS OOS thresholds.', 'Fresh untouched holdout is required before any live consideration.'],
      aggregate,
    };
  }

  const paperChecks = [
    [aggregate.completedOosWindows >= 3, 'completed OOS windows < 3'],
    [aggregate.profitableWindowRatio >= 0.60, 'profitable window ratio < 0.60'],
    [aggregate.aggregateNetProfitMoney > 0, 'aggregate net profit <= 0'],
    [aggregate.avgProfitFactor >= 1.15, 'average profit factor < 1.15'],
    [aggregate.avgSharpeRatio >= 0.5, 'average Sharpe < 0.5'],
    [aggregate.worstReturnPercent > -10, 'worst return <= -10%'],
    [aggregate.profitConcentrationByWindowTop1 <= 0.75, 'profit concentration > 0.75'],
  ];
  const paperFailures = paperChecks.filter(([pass]) => !pass).map(([, reason]) => reason);
  if (!paperFailures.length) {
    return {
      status: 'PAPER_WATCH',
      recommendation: 'ENTER_DEMO_OR_PAPER_WATCH_ONLY',
      reasons: ['Meets PAPER_WATCH OOS thresholds.', `STRICT_PASS failed: ${strictFailures.join('; ')}.`],
      aggregate,
    };
  }

  const explicitReject = [];
  if (aggregate.aggregateNetProfitMoney <= 0) explicitReject.push('aggregate net profit <= 0');
  if (aggregate.profitableWindowRatio < 0.50) explicitReject.push('profitable window ratio < 0.50');
  if (aggregate.avgProfitFactor < 1.05) explicitReject.push('average profit factor < 1.05');
  if (aggregate.profitConcentrationByWindowTop1 > 0.80) explicitReject.push('one window dominates more than 80% of positive profit');
  return {
    status: 'REJECT',
    recommendation: 'DO_NOT_ADVANCE',
    reasons: explicitReject.length
      ? explicitReject
      : [`Did not meet PAPER_WATCH thresholds: ${paperFailures.join('; ')}.`],
    aggregate,
  };
}

function removeTransientEquityCurves(combo) {
  combo.windows.forEach((window) => {
    if (window.oos?.selectedRepresentative) delete window.oos.selectedRepresentative._equityCurve;
  });
}

function writeJsonAtomic(filePath, payload) {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(jsonSafe(payload), null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

function csvEscape(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function refreshCollections(report) {
  report.strictPass = report.combos.filter((combo) => combo.status === 'STRICT_PASS');
  report.paperWatch = report.combos.filter((combo) => combo.status === 'PAPER_WATCH');
  report.rejects = report.combos.filter((combo) => combo.status === 'REJECT');
  const terminal = new Set([
    'COMPLETED',
    'INSUFFICIENT_OPTIMIZER_DATA',
    'INSUFFICIENT_OOS_DATA',
    'NO_VALID_OPTIMIZER_RESULT',
    'OPTIMIZER_TIMEOUT',
    'ERROR',
  ]);
  const windows = report.combos.flatMap((combo) => combo.windows || []);
  report.progress.completedComboWindows = windows.filter((window) => terminal.has(window.status)).length;
  report.progress.completedCombos = report.combos.filter((combo) => combo.aggregate).length;
  report.progress.percent = report.progress.totalComboWindows
    ? round((report.progress.completedComboWindows / report.progress.totalComboWindows) * 100, 2)
    : 0;
  report.progress.strictPassCount = report.strictPass.length;
  report.progress.paperWatchCount = report.paperWatch.length;
  report.progress.rejectCount = report.rejects.length;
}

function writeCsv(report, filePath) {
  const headers = [
    'strategy', 'symbol', 'timeframe', 'status', 'recommendation', 'completedOosWindows',
    'profitableWindowRatio', 'aggregateNetProfitMoney', 'avgReturnPercent', 'worstReturnPercent',
    'avgProfitFactor', 'worstProfitFactor', 'avgSharpeRatio', 'worstSharpeRatio',
    'avgMaxDrawdownPercent', 'worstMaxDrawdownPercent', 'profitConcentrationByWindowTop1',
    'combinedPositiveSegmentRatio', 'combinedEquityRSquared', 'combinedUnderwaterPercent',
    'combinedUnderwaterRisk', 'reasons', 'selectedParametersByWindow',
  ];
  const rows = report.combos.map((combo) => {
    const aggregate = combo.aggregate || {};
    const quality = aggregate.combinedEquityQuality || {};
    return [
      combo.strategy, combo.symbol, combo.timeframe, combo.status, combo.recommendation,
      aggregate.completedOosWindows, aggregate.profitableWindowRatio, aggregate.aggregateNetProfitMoney,
      aggregate.avgReturnPercent, aggregate.worstReturnPercent, aggregate.avgProfitFactor,
      aggregate.worstProfitFactor, aggregate.avgSharpeRatio, aggregate.worstSharpeRatio,
      aggregate.avgMaxDrawdownPercent, aggregate.worstMaxDrawdownPercent,
      aggregate.profitConcentrationByWindowTop1, quality.positiveSegmentRatio, quality.rSquared,
      quality.underwaterPercent, aggregate.combinedUnderwaterRisk, (combo.reasons || []).join('; '),
      aggregate.selectedParametersByWindow,
    ].map(csvEscape).join(',');
  });
  fs.writeFileSync(filePath, `${headers.join(',')}\n${rows.join('\n')}\n`);
}

function markdownTable(combos) {
  if (!combos.length) return '_None_';
  const lines = [
    '| Combo | Status | OOS Windows | Net | Profitable | Avg PF | Worst PF | Avg Sharpe | Worst Return | Pos Seg | Underwater Risk |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  combos.forEach((combo) => {
    const a = combo.aggregate || {};
    const q = a.combinedEquityQuality || {};
    lines.push(`| ${comboKey(combo)} | ${combo.status} | ${a.completedOosWindows || 0} | ${a.aggregateNetProfitMoney || 0} | ${a.profitableWindowRatio || 0} | ${a.avgProfitFactor || 0} | ${a.worstProfitFactor || 0} | ${a.avgSharpeRatio || 0} | ${a.worstReturnPercent || 0} | ${q.positiveSegmentRatio || 0} | ${a.combinedUnderwaterRisk || ''} |`);
  });
  return lines.join('\n');
}

function writeMarkdown(report, filePath) {
  const ranked = report.combos.slice().sort(
    (a, b) => numberOrZero(b.aggregate?.aggregateNetProfitMoney) - numberOrZero(a.aggregate?.aggregateNetProfitMoney)
  );
  const lines = [
    '# OOS Walk-forward Edge Validation',
    '',
    `Generated: ${report.generatedAt}`,
    `Finished: ${report.finishedAt || 'running'}`,
    '',
    '## Executive Summary',
    `- Candidate combos: ${report.runConfig.totalCombos}`,
    `- Completed combo-windows: ${report.progress.completedComboWindows}/${report.progress.totalComboWindows}`,
    `- STRICT_PASS: ${report.strictPass.length}`,
    `- PAPER_WATCH: ${report.paperWatch.length}`,
    `- REJECT: ${report.rejects.length}`,
    '- No parameters were applied to live; no live config or strategy instance was changed.',
    '',
    '## Method',
    '- Each optimizer uses its optimizer period only; each subsequent OOS period is not used in optimization.',
    '- The optimizer top 10 parameter sets are all simulated on OOS and their OOS metrics are retained in JSON.',
    '- A window representative is selected by OOS stability score. This is useful for demo/paper screening, but introduces selection bias and requires a new untouched holdout before live use.',
    '- Underwater percentage is risk commentary only, not a pass/fail gate.',
    '',
    '## STRICT_PASS',
    markdownTable(report.strictPass),
    '',
    '## PAPER_WATCH',
    markdownTable(report.paperWatch),
    '',
    '## REJECT',
    markdownTable(report.rejects),
    '',
    '## Ranked Results',
    markdownTable(ranked),
    '',
    '## Window-by-window Metrics',
  ];

  ranked.forEach((combo) => {
    lines.push('', `### ${comboKey(combo)} - ${combo.status}`, '', `Recommendation: ${combo.recommendation}`, '', `Reasons: ${(combo.reasons || []).join('; ')}`, '');
    const completed = (combo.windows || []).filter((window) => window.status === 'COMPLETED');
    if (!completed.length) {
      lines.push('_No completed OOS windows._');
      return;
    }
    lines.push('| Window | Selected Optimizer Rank | OOS Net | Return% | PF | Sharpe | DD% | Pos Seg | Underwater Risk |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
    completed.forEach((window) => {
      const selected = window.oos.selectedRepresentative;
      const summary = selected.oosSummary;
      const quality = selected.equityCurveQuality;
      lines.push(`| ${window.id} | ${selected.optimizerRank} | ${summary.netProfitMoney} | ${summary.returnPercent} | ${summary.profitFactor} | ${summary.sharpeRatio} | ${summary.maxDrawdownPercent} | ${quality.positiveSegmentRatio} | ${selected.underwaterRisk} |`);
    });
  });

  lines.push('', '## Thresholds', '```json', JSON.stringify(report.thresholds, null, 2), '```');
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function writeReports(report, paths, summaries = true) {
  refreshCollections(report);
  writeJsonAtomic(paths.json, report);
  if (summaries) {
    writeCsv(report, paths.csv);
    writeMarkdown(report, paths.md);
  }
}

function loadSourceCandidates(sourceReportPath, candidateKeys) {
  const sourceReport = JSON.parse(fs.readFileSync(sourceReportPath, 'utf8'));
  const byKey = new Map((sourceReport.combos || []).map((combo) => [comboKey(combo), combo]));
  return candidateKeys.map((key) => {
    const source = byKey.get(key);
    if (!source) throw new Error(`Candidate absent from source report: ${key}`);
    const combo = parseComboKey(key);
    const instrument = getInstrument(combo.symbol);
    if (!instrument) throw new Error(`Unknown symbol in candidate: ${key}`);
    if (!isStrategySupported(combo)) throw new Error(`Unsupported strategy/symbol candidate: ${key}`);
    return {
      ...combo,
      sourceScreen: {
        status: source.status,
        aggregateNetProfitMoney: source.aggregate?.aggregateNetProfitMoney ?? null,
        avgProfitFactor: source.aggregate?.avgProfitFactor ?? null,
        avgSharpeRatio: source.aggregate?.avgSharpeRatio ?? null,
        rSquared: source.aggregate?.combinedEquityQuality?.rSquared ?? null,
      },
    };
  });
}

function ensureCombo(report, candidate) {
  let combo = report.combos.find((item) => comboKey(item) === comboKey(candidate));
  if (!combo) {
    combo = {
      ...candidate,
      status: 'PENDING',
      recommendation: 'PENDING',
      windows: [],
      aggregate: null,
      reasons: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    report.combos.push(combo);
  }
  return combo;
}

function existingWindow(combo, windowId) {
  return combo.windows.find((window) => window.id === windowId);
}

async function main() {
  const args = parseArgs(process.argv);
  const paths = outputPaths(args);
  const sourceReportPath = path.resolve(process.cwd(), args.sourceReport || SOURCE_REPORT_DEFAULT);
  const candidateKeys = args.candidates
    ? args.candidates.split(',').map((key) => key.trim()).filter(Boolean)
    : CANDIDATE_KEYS;
  const candidates = loadSourceCandidates(sourceReportPath, candidateKeys);
  const [strategyRecords, activeProfile] = await Promise.all([
    Strategy.findAll().catch(() => []),
    getActiveRiskProfileReadOnly(),
  ]);
  const strategyRecordsByName = new Map(strategyRecords.map((strategy) => [strategy.name, strategy]));
  const config = {
    sourceReportPath,
    candidateKeys,
    initialBalance: numberArg(args.initialBalance, 500),
    optimizeFor: args.optimizeFor || 'robustScore',
    minimumTrades: intArg(args.minimumTrades, 30),
    parallelWorkers: intArg(args.parallelWorkers, 2),
    mt5Scope: args.mt5Scope || 'live',
    costPreset: args.costPreset || 'conservative',
    maxWindowMs: intArg(args.maxWindowMs, 1800000),
    totalCombos: candidates.length,
    totalComboWindows: candidates.length * WINDOWS.length,
    methodology: 'OOS_WALKFORWARD_TOP10_STABILITY_SELECTION',
    methodologyWarning: 'Top-10 candidates are selected using OOS stability metrics; this validates transfer beyond training but remains exploratory until confirmed on a fresh untouched holdout.',
    readOnly: true,
    appliesParametersToLive: false,
    mutatesLiveConfig: false,
    mutatesStrategyInstances: false,
    reportPaths: paths,
  };

  let report;
  if (args.resumeReport && fs.existsSync(paths.json)) {
    report = JSON.parse(fs.readFileSync(paths.json, 'utf8'));
    report.runConfig = { ...report.runConfig, ...config, resumedAt: new Date().toISOString() };
  } else {
    report = {
      runConfig: config,
      thresholds: THRESHOLDS,
      windows: WINDOWS,
      progress: {
        totalCombos: config.totalCombos,
        totalComboWindows: config.totalComboWindows,
        completedCombos: 0,
        completedComboWindows: 0,
        percent: 0,
        current: null,
      },
      combos: [],
      strictPass: [],
      paperWatch: [],
      rejects: [],
      errors: [],
      generatedAt: new Date().toISOString(),
      finishedAt: null,
    };
  }
  writeReports(report, paths);

  const mt5 = typeof mt5RootService.getScopedService === 'function'
    ? mt5RootService.getScopedService(config.mt5Scope)
    : mt5RootService;
  if (typeof mt5.reloadConnectionEnvFromFile === 'function') mt5.reloadConnectionEnvFromFile();
  console.log('[OOS] Connecting to MT5...');
  try {
    if (!mt5.isConnected()) await mt5.connect();
  } catch (error) {
    report.errors.push({ status: 'MT5_CONNECT_FAILED', message: error.message, at: new Date().toISOString() });
    report.finishedAt = new Date().toISOString();
    writeReports(report, paths);
    process.exitCode = 1;
    return;
  }

  const getCachedCandles = buildCandleCache(mt5);
  try {
    for (let comboIndex = 0; comboIndex < candidates.length; comboIndex += 1) {
      const candidate = candidates[comboIndex];
      const combo = ensureCombo(report, candidate);
      if (combo.aggregate) continue;
      for (const window of WINDOWS) {
        if (existingWindow(combo, window.id)) continue;
        report.progress.current = {
          comboIndex: comboIndex + 1,
          strategy: combo.strategy,
          symbol: combo.symbol,
          timeframe: combo.timeframe,
          windowId: window.id,
        };
        console.log(`[OOS] Running ${comboKey(combo)} ${window.id}`);
        const result = await runWindow({
          combo,
          window,
          config,
          strategyRecord: strategyRecordsByName.get(combo.strategy) || null,
          activeProfile,
          getCachedCandles,
        });
        combo.windows.push(result);
        writeReports(report, paths, false);
        console.log(`[OOS] Saved ${comboKey(combo)} ${window.id}: ${result.status}`);
      }
      const classification = classifyCombo(combo, config.initialBalance);
      combo.status = classification.status;
      combo.recommendation = classification.recommendation;
      combo.reasons = classification.reasons;
      combo.aggregate = classification.aggregate;
      combo.finishedAt = new Date().toISOString();
      removeTransientEquityCurves(combo);
      writeReports(report, paths);
    }
    report.finishedAt = new Date().toISOString();
    report.progress.current = null;
    writeReports(report, paths);
  } finally {
    if (mt5.isConnected()) await mt5.disconnect().catch(() => {});
  }
  console.log('[OOS] Complete');
  console.log(`JSON: ${paths.json}`);
  console.log(`CSV: ${paths.csv}`);
  console.log(`MD: ${paths.md}`);
}

main().catch((error) => {
  console.error(`[OOS] Fatal: ${error.message}`);
  process.exitCode = 1;
});
