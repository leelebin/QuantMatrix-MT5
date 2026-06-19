#!/usr/bin/env node

/**
 * Read-only fixed-parameter holdout validation.
 *
 * Collects unique parameter sets from a previous OOS walk-forward report,
 * selects up to 20 fixed parameter candidates per combo, then runs each fixed
 * parameter set across every holdout window without changing parameters per
 * window. Writes reports only; never applies parameters to live config.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const mt5RootService = require('../src/services/mt5Service');
const backtestEngine = require('../src/services/backtestEngine');
const Strategy = require('../src/models/Strategy');
const StrategyInstance = require('../src/models/StrategyInstance');
const breakevenService = require('../src/services/breakevenService');
const { resolveExecutionPolicy } = require('../src/services/executionPolicyService');
const { riskProfilesDb } = require('../src/config/db');
const { getInstrument, INSTRUMENT_CATEGORIES } = require('../src/config/instruments');
const {
  getStrategyExecutionConfig,
  getForcedTimeframeExecutionConfig,
} = require('../src/config/strategyExecution');
const { resolveStrategyParameters } = require('../src/config/strategyParameters');
const {
  DEFAULT_WARMUP_BARS,
  estimateFetchLimit,
  filterCandlesByRange,
  getWarmupStart,
} = require('../src/utils/candleRange');
const { analyzeEquityCurveQuality } = require('../src/utils/equityCurveQuality');

const DEFAULT_SOURCE_REPORT = 'reports/oos-walkforward-validation-2026-05-23-top-regime-dependent.json';
const DEFAULT_OUTPUT_BASE = 'reports/fixed-parameter-holdout-validation-2026-05-24';
const DEFAULT_CANDIDATE_STATUSES = ['STRICT_PASS', 'PAPER_WATCH'];
const DEFAULT_TARGET_KEYS = [
  'Breakout:XAUUSD:1h',
  'Breakout:NAS100:1h',
  'Momentum:XRPUSD:1h',
  'Breakout:XAGUSD:1h',
  'Momentum:BTCUSD:1h',
];

const BASE_WINDOWS = Object.freeze([
  { id: '2024_H2', from: '2024-07-01', to: '2025-01-01' },
  { id: '2025_H1', from: '2025-01-01', to: '2025-07-01' },
  { id: '2025_H2', from: '2025-07-01', to: '2026-01-01' },
  { id: '2026_RECENT', from: '2026-01-01', to: '2026-05-01' },
]);

const FRESH_HOLDOUT_FROM = '2026-05-01';

const THRESHOLDS = Object.freeze({
  PASS_DEMO: {
    completedWindows: 4,
    profitableWindowRatio: 0.75,
    aggregateNetProfitMoney: 0,
    avgProfitFactor: 1.25,
    worstProfitFactor: 1.0,
    avgSharpeRatio: 0.8,
    worstReturnPercent: -8,
    avgMaxDrawdownPercent: 20,
    worstMaxDrawdownPercent: 30,
    profitConcentrationByWindowTop1: 0.65,
  },
  STRONG_DEMO: {
    completedWindows: 4,
    profitableWindowRatio: 1,
    aggregateNetProfitMoney: 0,
    avgProfitFactor: 1.35,
    worstProfitFactor: 1.10,
    avgSharpeRatio: 1.0,
    worstReturnPercent: 0,
    avgMaxDrawdownPercent: 15,
    profitConcentrationByWindowTop1: 0.60,
  },
  REJECT: {
    aggregateNetProfitMoney: 0,
    profitableWindowRatio: 0.75,
    worstReturnPercent: -10,
    avgProfitFactor: 1.15,
    profitConcentrationByWindowTop1: 0.75,
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

function parseArgs(argv) {
  const args = {};
  argv.slice(2).forEach((entry) => {
    if (!entry.startsWith('--')) return;
    const [key, ...rest] = entry.slice(2).split('=');
    args[key] = rest.length ? rest.join('=') : 'true';
  });
  return args;
}

function csvList(value) {
  if (!value) return null;
  const values = String(value).split(',').map((item) => item.trim()).filter(Boolean);
  return values.length ? values : null;
}

function numberArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function intArg(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = canonicalize(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function parameterKey(parameters) {
  return JSON.stringify(canonicalize(parameters || {}));
}

function parseRange(window) {
  const start = new Date(window.from);
  const endExclusive = new Date(window.to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(endExclusive.getTime()) || endExclusive <= start) {
    throw new Error(`Invalid window range: ${JSON.stringify(window)}`);
  }
  return { start, endExclusive };
}

function freshHoldoutEndExclusive() {
  const now = new Date();
  const nextUtcMidnight = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1
  ));
  const from = new Date(FRESH_HOLDOUT_FROM);
  return nextUtcMidnight > from ? nextUtcMidnight : null;
}

function outputPaths(args) {
  const base = args.resumeReport
    ? path.resolve(process.cwd(), args.resumeReport).replace(/\.json$/i, '')
    : path.resolve(process.cwd(), args.outputBase || DEFAULT_OUTPUT_BASE);
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

async function buildRuntime(combo, strategyRecord, activeProfile) {
  const instrument = getInstrument(combo.symbol);
  const instance = await StrategyInstance.findByKey(combo.strategy, combo.symbol).catch(() => null);
  const tradeManagement = mergeObjects(strategyRecord?.tradeManagement, instance?.tradeManagement);
  const mergedStrategy = {
    ...(strategyRecord || { name: combo.strategy }),
    tradeManagement: Object.keys(tradeManagement).length ? tradeManagement : null,
  };
  return {
    liveEnabledAtRun: Boolean(instance?.liveEnabled),
    storedParameters: resolveStrategyParameters({
      strategyType: combo.strategy,
      instrument,
      storedParameters: strategyRecord?.parameters || {},
      overrides: instance?.parameters || {},
    }),
    breakevenConfig: breakevenService.resolveEffectiveBreakeven(activeProfile, mergedStrategy),
    executionPolicy: resolveExecutionPolicy(
      strategyRecord?.executionPolicy || null,
      instance?.executionPolicy || null
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

async function fetchBundle({ getCachedCandles, combo, executionConfig, window }) {
  const { start, endExclusive } = parseRange(window);
  const timeframe = executionConfig.timeframe || combo.timeframe;
  const fetchStart = getWarmupStart(start, timeframe, DEFAULT_WARMUP_BARS);
  const limit = estimateFetchLimit(timeframe, fetchStart, endExclusive);
  const rawPrimary = await getCachedCandles(combo.symbol, timeframe, fetchStart, limit, endExclusive);
  const candles = filterCandlesByRange(rawPrimary || [], fetchStart, endExclusive);
  const inRangeCandles = filterCandlesByRange(rawPrimary || [], start, endExclusive);

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
    const lowerLimit = estimateFetchLimit(executionConfig.entryTimeframe, lowerStart, higherLimitSafe(endExclusive));
    const lowerRaw = await getCachedCandles(combo.symbol, executionConfig.entryTimeframe, lowerStart, lowerLimit, endExclusive);
    lowerTfCandles = filterCandlesByRange(lowerRaw || [], lowerStart, endExclusive);
  }

  return {
    candles,
    higherTfCandles,
    lowerTfCandles,
    effectiveStart: inRangeCandles[0] ? new Date(inRangeCandles[0].time) : start,
    effectiveEnd: inRangeCandles.length ? new Date(inRangeCandles[inRangeCandles.length - 1].time) : new Date(endExclusive.getTime() - 1),
    fetchMeta: {
      requestedFrom: start.toISOString(),
      requestedToExclusive: endExclusive.toISOString(),
      effectiveFrom: inRangeCandles[0]?.time || null,
      effectiveTo: inRangeCandles[inRangeCandles.length - 1]?.time || null,
      primaryInRange: inRangeCandles.length,
      primaryWithWarmup: candles.length,
      higherCount: higherTfCandles ? higherTfCandles.length : 0,
      lowerCount: lowerTfCandles ? lowerTfCandles.length : 0,
      timeframe,
    },
  };
}

function higherLimitSafe(endExclusive) {
  return endExclusive;
}

function collectParameterSets(sourceCombo, maxParamSets) {
  const byKey = new Map();
  (sourceCombo.windows || []).forEach((window) => {
    (window.oos?.top10Metrics || []).forEach((metric) => {
      const key = parameterKey(metric.parameters);
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          parameters: metric.parameters,
          occurrenceCount: 0,
          sourceWindows: new Set(),
          sourceMetrics: [],
        });
      }
      const entry = byKey.get(key);
      entry.occurrenceCount += 1;
      entry.sourceWindows.add(window.id);
      entry.sourceMetrics.push({
        windowId: window.id,
        optimizerRank: metric.optimizerRank,
        oosSummary: metric.oosSummary,
        equityCurveQuality: metric.equityCurveQuality,
      });
    });
  });

  return Array.from(byKey.values()).map((entry) => {
    const profitFactors = entry.sourceMetrics.map((item) => numberOrZero(item.oosSummary?.profitFactor));
    const returns = entry.sourceMetrics.map((item) => numberOrZero(item.oosSummary?.returnPercent));
    const drawdowns = entry.sourceMetrics.map((item) => numberOrZero(item.oosSummary?.maxDrawdownPercent));
    const concentrations = entry.sourceMetrics.map((item) => numberOrZero(item.oosSummary?.profitConcentrationTop1));
    return {
      key: entry.key,
      parameters: entry.parameters,
      occurrenceCount: entry.occurrenceCount,
      distinctWindowCount: entry.sourceWindows.size,
      sourceWindowIds: Array.from(entry.sourceWindows).sort(),
      sourceAverageProfitFactor: round(average(profitFactors), 4),
      sourceWorstReturnPercent: round(Math.min(...returns), 4),
      sourceAvgMaxDrawdownPercent: round(average(drawdowns), 4),
      sourceAvgProfitConcentrationTop1: round(average(concentrations), 4),
      sourceMetrics: entry.sourceMetrics,
    };
  }).sort((a, b) => (
    b.distinctWindowCount - a.distinctWindowCount
    || b.sourceAverageProfitFactor - a.sourceAverageProfitFactor
    || b.sourceWorstReturnPercent - a.sourceWorstReturnPercent
    || a.sourceAvgMaxDrawdownPercent - b.sourceAvgMaxDrawdownPercent
    || a.sourceAvgProfitConcentrationTop1 - b.sourceAvgProfitConcentrationTop1
  )).slice(0, maxParamSets).map((entry, index) => ({
    ...entry,
    candidateRank: index + 1,
  }));
}

async function runFixedParameterWindow({
  combo,
  parameterSet,
  window,
  config,
  bundle,
  runtime,
  costInfo,
  executionConfig,
}) {
  if (!bundle || bundle.candles.length < DEFAULT_WARMUP_BARS + 2 || bundle.fetchMeta.primaryInRange < 20) {
    return {
      id: window.id,
      status: 'INSUFFICIENT_DATA',
      isFreshHoldout: Boolean(window.isFreshHoldout),
      reason: `Only ${bundle?.fetchMeta?.primaryInRange || 0} primary in-range candles were available.`,
      fetchMeta: bundle?.fetchMeta || null,
    };
  }

  try {
    const simulation = await backtestEngine.simulate({
      symbol: combo.symbol,
      strategyType: combo.strategy,
      timeframe: executionConfig.timeframe,
      candles: bundle.candles,
      higherTfCandles: bundle.higherTfCandles,
      lowerTfCandles: bundle.lowerTfCandles,
      initialBalance: config.initialBalance,
      tradeStartTime: bundle.effectiveStart.toISOString(),
      tradeEndTime: bundle.effectiveEnd.toISOString(),
      strategyParams: parameterSet.parameters,
      storedStrategyParameters: runtime.storedParameters,
      breakevenConfig: runtime.breakevenConfig,
      executionPolicy: runtime.executionPolicy,
      executionConfigOverride: executionConfig,
      costModel: costInfo.costModel,
      parameterPreset: 'fixed_parameter_holdout',
      parameterPresetResolution: {
        preset: 'fixed_parameter_holdout',
        fallbackUsed: false,
        resolvedFrom: 'deduplicated_previous_oos_top10_metrics',
        optimizerHistoryId: null,
        optimizerCompletedAt: null,
        optimizerTimeframe: executionConfig.timeframe,
        optimizerOptimizeFor: null,
      },
    });
    const quality = analyzeEquityCurveQuality(simulation.equityCurve || [], config.initialBalance);
    return {
      id: window.id,
      status: 'COMPLETED',
      isFreshHoldout: Boolean(window.isFreshHoldout),
      summary: compactSummary(simulation.summary),
      equityCurveQuality: quality,
      tradesCount: Array.isArray(simulation.trades) ? simulation.trades.length : 0,
      fetchMeta: bundle.fetchMeta,
      _equityCurve: simulation.equityCurve || [],
    };
  } catch (error) {
    return {
      id: window.id,
      status: 'ERROR',
      isFreshHoldout: Boolean(window.isFreshHoldout),
      reason: error.message,
      error: { message: error.message, stack: error.stack },
      fetchMeta: bundle.fetchMeta,
    };
  }
}

function buildCombinedCurve(windows, initialBalance) {
  const combined = [];
  let runningStart = numberOrZero(initialBalance);
  windows.forEach((window) => {
    const curve = window._equityCurve || [];
    if (!curve.length) return;
    const base = numberOrZero(curve[0].equity);
    curve.forEach((point, index) => {
      if (combined.length && index === 0) return;
      combined.push({
        time: point.time,
        equity: round(runningStart + (numberOrZero(point.equity) - base), 4),
      });
    });
    runningStart += numberOrZero(window.summary?.netProfitMoney);
  });
  return combined;
}

function classifyEvaluation(evaluation, configuredWindowCount, initialBalance) {
  const completed = evaluation.windows.filter((window) => window.status === 'COMPLETED');
  const summaries = completed.map((window) => window.summary || {});
  const profits = summaries.map((summary) => numberOrZero(summary.netProfitMoney));
  const returns = summaries.map((summary) => numberOrZero(summary.returnPercent));
  const profitFactors = summaries.map((summary) => numberOrZero(summary.profitFactor));
  const sharpes = summaries.map((summary) => numberOrZero(summary.sharpeRatio));
  const drawdowns = summaries.map((summary) => numberOrZero(summary.maxDrawdownPercent));
  const positiveProfitSum = profits.filter((profit) => profit > 0).reduce((sum, profit) => sum + profit, 0);
  const combinedQuality = analyzeEquityCurveQuality(buildCombinedCurve(completed, initialBalance), initialBalance);
  const freshWindow = evaluation.windows.find((window) => window.isFreshHoldout);

  const aggregate = {
    configuredWindows: configuredWindowCount,
    completedWindows: completed.length,
    allConfiguredWindowsCompleted: completed.length === configuredWindowCount,
    profitableWindowRatio: completed.length ? round(profits.filter((profit) => profit > 0).length / completed.length, 4) : 0,
    aggregateNetProfitMoney: round(profits.reduce((sum, profit) => sum + profit, 0), 2),
    avgReturnPercent: round(average(returns), 2),
    worstReturnPercent: completed.length ? round(Math.min(...returns), 2) : 0,
    avgProfitFactor: round(average(profitFactors), 2),
    worstProfitFactor: completed.length ? round(Math.min(...profitFactors), 2) : 0,
    avgSharpeRatio: round(average(sharpes), 2),
    worstSharpeRatio: completed.length ? round(Math.min(...sharpes), 2) : 0,
    avgMaxDrawdownPercent: round(average(drawdowns), 2),
    worstMaxDrawdownPercent: completed.length ? round(Math.max(...drawdowns), 2) : 0,
    profitConcentrationByWindowTop1: positiveProfitSum > 0
      ? round(Math.max(...profits.map((profit) => Math.max(profit, 0))) / positiveProfitSum, 4)
      : 1,
    combinedEquityQuality: combinedQuality,
    freshHoldout: freshWindow ? {
      status: freshWindow.status,
      summary: freshWindow.summary || null,
      equityCurveQuality: freshWindow.equityCurveQuality || null,
      fetchMeta: freshWindow.fetchMeta || null,
      reason: freshWindow.reason || null,
    } : null,
  };

  const strongChecks = [
    [aggregate.allConfiguredWindowsCompleted, 'not all configured windows completed'],
    [aggregate.completedWindows >= 4, 'completedWindows < 4'],
    [aggregate.profitableWindowRatio === 1, 'profitableWindowRatio != 1'],
    [aggregate.aggregateNetProfitMoney > 0, 'aggregateNetProfitMoney <= 0'],
    [aggregate.avgProfitFactor >= 1.35, 'avgProfitFactor < 1.35'],
    [aggregate.worstProfitFactor >= 1.10, 'worstProfitFactor < 1.10'],
    [aggregate.avgSharpeRatio >= 1.0, 'avgSharpeRatio < 1.0'],
    [aggregate.worstReturnPercent > 0, 'worstReturnPercent <= 0'],
    [aggregate.avgMaxDrawdownPercent <= 15, 'avgMaxDrawdownPercent > 15'],
    [aggregate.profitConcentrationByWindowTop1 <= 0.60, 'profitConcentrationByWindowTop1 > 0.60'],
  ];
  const strongFailures = strongChecks.filter(([pass]) => !pass).map(([, reason]) => reason);
  if (!strongFailures.length) {
    return {
      status: 'STRONG_DEMO',
      recommendation: 'DEMO_OR_PAPER_FIXED_PARAMETER_CANDIDATE',
      reasons: ['Fixed parameter set meets STRONG_DEMO thresholds.'],
      aggregate,
    };
  }

  const passChecks = [
    [aggregate.allConfiguredWindowsCompleted, 'not all configured windows completed'],
    [aggregate.completedWindows >= 4, 'completedWindows < 4'],
    [aggregate.profitableWindowRatio >= 0.75, 'profitableWindowRatio < 0.75'],
    [aggregate.aggregateNetProfitMoney > 0, 'aggregateNetProfitMoney <= 0'],
    [aggregate.avgProfitFactor >= 1.25, 'avgProfitFactor < 1.25'],
    [aggregate.worstProfitFactor >= 1.0, 'worstProfitFactor < 1.0'],
    [aggregate.avgSharpeRatio >= 0.8, 'avgSharpeRatio < 0.8'],
    [aggregate.worstReturnPercent > -8, 'worstReturnPercent <= -8'],
    [aggregate.avgMaxDrawdownPercent <= 20, 'avgMaxDrawdownPercent > 20'],
    [aggregate.worstMaxDrawdownPercent <= 30, 'worstMaxDrawdownPercent > 30'],
    [aggregate.profitConcentrationByWindowTop1 <= 0.65, 'profitConcentrationByWindowTop1 > 0.65'],
  ];
  const passFailures = passChecks.filter(([pass]) => !pass).map(([, reason]) => reason);
  if (!passFailures.length) {
    return {
      status: 'PASS_DEMO',
      recommendation: 'DEMO_OR_PAPER_FIXED_PARAMETER_CANDIDATE',
      reasons: ['Fixed parameter set meets PASS_DEMO thresholds.', `STRONG_DEMO failed: ${strongFailures.join('; ')}.`],
      aggregate,
    };
  }

  const explicitReject = [];
  if (aggregate.aggregateNetProfitMoney <= 0) explicitReject.push('aggregateNetProfitMoney <= 0');
  if (aggregate.profitableWindowRatio < 0.75) explicitReject.push('profitableWindowRatio < 0.75');
  if (aggregate.worstReturnPercent <= -10) explicitReject.push('worstReturnPercent <= -10');
  if (aggregate.avgProfitFactor < 1.15) explicitReject.push('avgProfitFactor < 1.15');
  if (aggregate.profitConcentrationByWindowTop1 > 0.75) explicitReject.push('profitConcentrationByWindowTop1 > 0.75');

  return {
    status: 'REJECT',
    recommendation: 'DO_NOT_ADVANCE',
    reasons: explicitReject.length ? explicitReject : [`PASS_DEMO failed: ${passFailures.join('; ')}.`],
    aggregate,
  };
}

function selectBestEvaluation(evaluations) {
  const statusRank = { STRONG_DEMO: 3, PASS_DEMO: 2, REJECT: 1 };
  return evaluations.slice().sort((a, b) => (
    statusRank[b.status] - statusRank[a.status]
    || numberOrZero(b.aggregate?.aggregateNetProfitMoney) - numberOrZero(a.aggregate?.aggregateNetProfitMoney)
    || numberOrZero(b.aggregate?.profitableWindowRatio) - numberOrZero(a.aggregate?.profitableWindowRatio)
    || numberOrZero(b.aggregate?.avgProfitFactor) - numberOrZero(a.aggregate?.avgProfitFactor)
    || numberOrZero(b.aggregate?.avgSharpeRatio) - numberOrZero(a.aggregate?.avgSharpeRatio)
    || numberOrZero(a.aggregate?.worstMaxDrawdownPercent) - numberOrZero(b.aggregate?.worstMaxDrawdownPercent)
    || numberOrZero(a.aggregate?.profitConcentrationByWindowTop1) - numberOrZero(b.aggregate?.profitConcentrationByWindowTop1)
  ))[0];
}

function stripTransientCurves(evaluation) {
  evaluation.windows.forEach((window) => {
    delete window._equityCurve;
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
  report.strongDemo = report.combos.filter((combo) => combo.status === 'STRONG_DEMO');
  report.passDemo = report.combos.filter((combo) => combo.status === 'PASS_DEMO');
  report.rejects = report.combos.filter((combo) => combo.status === 'REJECT');
  report.progress.completedCombos = report.combos.filter((combo) => combo.bestFixedParameter).length;
  report.progress.completedParameterSets = report.combos.reduce((sum, combo) => sum + (combo.parameterEvaluations || []).length, 0);
  report.progress.totalParameterSets = report.runConfig?.totalCandidateParameterSets
    || report.combos.reduce((sum, combo) => sum + (combo.parameterSets || []).length, 0);
  report.progress.percent = report.progress.totalParameterSets
    ? round((report.progress.completedParameterSets / report.progress.totalParameterSets) * 100, 2)
    : 0;
  report.progress.strongDemoCount = report.strongDemo.length;
  report.progress.passDemoCount = report.passDemo.length;
  report.progress.rejectCount = report.rejects.length;
}

function writeCsv(report, filePath) {
  const headers = [
    'combo', 'status', 'recommendation', 'parameterRank', 'sourceDistinctWindows',
    'completedWindows', 'profitableWindowRatio', 'aggregateNetProfitMoney',
    'avgProfitFactor', 'worstProfitFactor', 'avgSharpeRatio', 'worstReturnPercent',
    'avgMaxDrawdownPercent', 'worstMaxDrawdownPercent', 'profitConcentrationByWindowTop1',
    'freshHoldoutStatus', 'freshHoldoutNet', 'freshHoldoutReturnPercent', 'freshHoldoutProfitFactor',
    'reasons', 'parameters',
  ];
  const rows = [];
  report.combos.forEach((combo) => {
    (combo.parameterEvaluations || []).forEach((evaluation) => {
      const aggregate = evaluation.aggregate || {};
      const fresh = aggregate.freshHoldout || {};
      rows.push([
        comboKey(combo),
        evaluation.status,
        evaluation.recommendation,
        evaluation.candidateRank,
        evaluation.sourceSelection?.distinctWindowCount,
        aggregate.completedWindows,
        aggregate.profitableWindowRatio,
        aggregate.aggregateNetProfitMoney,
        aggregate.avgProfitFactor,
        aggregate.worstProfitFactor,
        aggregate.avgSharpeRatio,
        aggregate.worstReturnPercent,
        aggregate.avgMaxDrawdownPercent,
        aggregate.worstMaxDrawdownPercent,
        aggregate.profitConcentrationByWindowTop1,
        fresh.status,
        fresh.summary?.netProfitMoney,
        fresh.summary?.returnPercent,
        fresh.summary?.profitFactor,
        (evaluation.reasons || []).join('; '),
        evaluation.parameters,
      ].map(csvEscape).join(','));
    });
  });
  fs.writeFileSync(filePath, `${headers.join(',')}\n${rows.join('\n')}\n`);
}

function tableRows(combos) {
  if (!combos.length) return '_None_';
  const lines = [
    '| Combo | Status | Best Rank | Net | Profitable | Avg PF | Worst PF | Avg Sharpe | Worst Ret% | Avg DD% | Conc | Fresh Net | Fresh PF |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  combos.forEach((combo) => {
    const best = combo.bestFixedParameter || {};
    const a = best.aggregate || {};
    const fresh = a.freshHoldout || {};
    lines.push(`| ${comboKey(combo)} | ${combo.status} | ${best.candidateRank || ''} | ${a.aggregateNetProfitMoney || 0} | ${a.profitableWindowRatio || 0} | ${a.avgProfitFactor || 0} | ${a.worstProfitFactor || 0} | ${a.avgSharpeRatio || 0} | ${a.worstReturnPercent || 0} | ${a.avgMaxDrawdownPercent || 0} | ${a.profitConcentrationByWindowTop1 || 0} | ${fresh.summary?.netProfitMoney ?? ''} | ${fresh.summary?.profitFactor ?? ''} |`);
  });
  return lines.join('\n');
}

function writeMarkdown(report, filePath) {
  const ranked = report.combos.slice().sort((a, b) => (
    numberOrZero(b.bestFixedParameter?.aggregate?.aggregateNetProfitMoney)
    - numberOrZero(a.bestFixedParameter?.aggregate?.aggregateNetProfitMoney)
  ));
  const lines = [
    '# Fixed-Parameter Holdout Validation',
    '',
    `Generated: ${report.generatedAt}`,
    `Finished: ${report.finishedAt || 'running'}`,
    '',
    '## Executive Summary',
    `- Combos: ${report.runConfig.totalCombos}`,
    `- Parameter evaluations: ${report.progress.completedParameterSets}/${report.progress.totalParameterSets}`,
    `- STRONG_DEMO: ${report.strongDemo.length}`,
    `- PASS_DEMO: ${report.passDemo.length}`,
    `- REJECT: ${report.rejects.length}`,
    `- Fresh untouched holdout included: ${report.runConfig.freshHoldoutIncluded}`,
    '- No parameters were applied to live; no live config or strategy instances were changed.',
    '',
    '## Method',
    '- Parameters are collected from all previous OOS top10Metrics, deduplicated, ranked, and capped at 20 per combo.',
    '- Each fixed parameter set is run across every validation window without changing parameters per window.',
    '- If data after 2026-05-01 is available, FRESH_UNTOUCHED_HOLDOUT is included and listed separately.',
    '',
    '## STRONG_DEMO',
    tableRows(report.strongDemo),
    '',
    '## PASS_DEMO',
    tableRows(report.passDemo),
    '',
    '## REJECT',
    tableRows(report.rejects),
    '',
    '## Ranked Best Fixed Parameters',
    tableRows(ranked),
    '',
    '## Fresh Untouched Holdout',
  ];

  ranked.forEach((combo) => {
    const best = combo.bestFixedParameter || {};
    const fresh = best.aggregate?.freshHoldout || null;
    lines.push(`- ${comboKey(combo)}: ${fresh ? `${fresh.status}, net=${fresh.summary?.netProfitMoney ?? 'n/a'}, return=${fresh.summary?.returnPercent ?? 'n/a'}%, PF=${fresh.summary?.profitFactor ?? 'n/a'}, effectiveTo=${fresh.fetchMeta?.effectiveTo || 'n/a'}` : 'not available'}`);
  });

  lines.push('', '## Best Fixed Parameters');
  ranked.forEach((combo) => {
    const best = combo.bestFixedParameter || {};
    lines.push('', `### ${comboKey(combo)} - ${combo.status}`, '', `Reasons: ${(combo.reasons || []).join('; ')}`, '', '```json', JSON.stringify(best.parameters || {}, null, 2), '```');
  });

  lines.push('', '## Thresholds', '```json', JSON.stringify(report.thresholds, null, 2), '```');
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function writeReports(report, paths, includeSummaries = true) {
  refreshCollections(report);
  writeJsonAtomic(paths.json, report);
  if (includeSummaries) {
    writeCsv(report, paths.csv);
    writeMarkdown(report, paths.md);
  }
}

function loadCandidateCombos(sourceReport, statuses) {
  const allowed = new Set(statuses);
  const byKey = new Map((sourceReport.combos || []).map((combo) => [comboKey(combo), combo]));
  return DEFAULT_TARGET_KEYS.map((key) => byKey.get(key))
    .filter(Boolean)
    .filter((combo) => allowed.has(combo.status))
    .map((combo) => ({
      strategy: combo.strategy,
      symbol: combo.symbol,
      timeframe: combo.timeframe,
      sourceStatus: combo.status,
      sourceAggregate: combo.aggregate || null,
      sourceCombo: combo,
    }));
}

function ensureCombo(report, sourceCombo, parameterSets) {
  let combo = report.combos.find((item) => comboKey(item) === comboKey(sourceCombo));
  if (!combo) {
    combo = {
      strategy: sourceCombo.strategy,
      symbol: sourceCombo.symbol,
      timeframe: sourceCombo.timeframe,
      sourceStatus: sourceCombo.sourceStatus,
      sourceAggregate: sourceCombo.sourceAggregate,
      status: 'PENDING',
      recommendation: 'PENDING',
      reasons: [],
      parameterSets,
      parameterEvaluations: [],
      bestFixedParameter: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    report.combos.push(combo);
  }
  return combo;
}

function existingEvaluation(combo, key) {
  return (combo.parameterEvaluations || []).find((evaluation) => evaluation.parameterKey === key);
}

async function main() {
  const args = parseArgs(process.argv);
  const sourceReportPath = path.resolve(process.cwd(), args.sourceReport || DEFAULT_SOURCE_REPORT);
  const sourceReport = JSON.parse(fs.readFileSync(sourceReportPath, 'utf8'));
  const statuses = csvList(args.candidates) || DEFAULT_CANDIDATE_STATUSES;
  const maxParamSets = intArg(args.maxParamSets, 20);
  const paths = outputPaths(args);
  const freshEnd = freshHoldoutEndExclusive();
  const validationWindows = [
    ...BASE_WINDOWS,
    ...(freshEnd ? [{
      id: 'FRESH_UNTOUCHED_HOLDOUT',
      from: FRESH_HOLDOUT_FROM,
      to: freshEnd.toISOString(),
      isFreshHoldout: true,
    }] : []),
  ];
  const sourceCombos = loadCandidateCombos(sourceReport, statuses);
  const candidateDescriptors = sourceCombos.map((combo) => ({
    combo,
    parameterSets: collectParameterSets(combo.sourceCombo, maxParamSets),
  }));
  const [strategyRecords, activeProfile] = await Promise.all([
    Strategy.findAll().catch(() => []),
    getActiveRiskProfileReadOnly(),
  ]);
  const strategyRecordsByName = new Map(strategyRecords.map((strategy) => [strategy.name, strategy]));
  const config = {
    sourceReportPath,
    candidates: statuses,
    outputTag: args.outputTag || 'fixed-param-holdout',
    initialBalance: numberArg(args.initialBalance, 500),
    costPreset: args.costPreset || 'conservative',
    mt5Scope: args.mt5Scope || 'live',
    maxParamSets,
    totalCombos: candidateDescriptors.length,
    totalCandidateParameterSets: candidateDescriptors.reduce((sum, item) => sum + item.parameterSets.length, 0),
    validationWindows,
    freshHoldoutIncluded: Boolean(freshEnd),
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
      windows: validationWindows,
      progress: {
        totalCombos: config.totalCombos,
        totalParameterSets: config.totalCandidateParameterSets,
        completedCombos: 0,
        completedParameterSets: 0,
        percent: 0,
        current: null,
      },
      combos: [],
      strongDemo: [],
      passDemo: [],
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
  console.log('[FixedHoldout] Connecting to MT5...');
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
    for (let comboIndex = 0; comboIndex < candidateDescriptors.length; comboIndex += 1) {
      const descriptor = candidateDescriptors[comboIndex];
      const sourceCombo = descriptor.combo;
      const combo = ensureCombo(report, sourceCombo, descriptor.parameterSets);
      if (combo.bestFixedParameter) continue;

      const instrument = getInstrument(combo.symbol);
      const executionConfig = resolveExecutionConfig(combo);
      const costInfo = buildCostModel(instrument, config.costPreset);
      const runtime = await buildRuntime(combo, strategyRecordsByName.get(combo.strategy) || null, activeProfile);
      const bundlesByWindow = new Map();
      for (const window of validationWindows) {
        bundlesByWindow.set(window.id, await fetchBundle({
          getCachedCandles,
          combo,
          executionConfig,
          window,
        }).catch((error) => ({ error })));
      }

      for (const parameterSet of combo.parameterSets) {
        if (existingEvaluation(combo, parameterSet.key)) continue;
        report.progress.current = {
          comboIndex: comboIndex + 1,
          combo: comboKey(combo),
          candidateRank: parameterSet.candidateRank,
        };
        console.log(`[FixedHoldout] Running ${comboKey(combo)} params ${parameterSet.candidateRank}/${combo.parameterSets.length}`);
        const evaluation = {
          parameterKey: parameterSet.key,
          candidateRank: parameterSet.candidateRank,
          parameters: parameterSet.parameters,
          sourceSelection: {
            occurrenceCount: parameterSet.occurrenceCount,
            distinctWindowCount: parameterSet.distinctWindowCount,
            sourceWindowIds: parameterSet.sourceWindowIds,
            sourceAverageProfitFactor: parameterSet.sourceAverageProfitFactor,
            sourceWorstReturnPercent: parameterSet.sourceWorstReturnPercent,
            sourceAvgMaxDrawdownPercent: parameterSet.sourceAvgMaxDrawdownPercent,
            sourceAvgProfitConcentrationTop1: parameterSet.sourceAvgProfitConcentrationTop1,
          },
          windows: [],
          status: 'PENDING',
          recommendation: 'PENDING',
          reasons: [],
          aggregate: null,
        };
        for (const window of validationWindows) {
          const bundle = bundlesByWindow.get(window.id);
          const windowResult = bundle?.error
            ? {
              id: window.id,
              status: 'ERROR',
              isFreshHoldout: Boolean(window.isFreshHoldout),
              reason: bundle.error.message,
              error: { message: bundle.error.message, stack: bundle.error.stack },
            }
            : await runFixedParameterWindow({
              combo,
              parameterSet,
              window,
              config,
              bundle,
              runtime,
              costInfo,
              executionConfig,
            });
          evaluation.windows.push(windowResult);
        }
        const classification = classifyEvaluation(evaluation, validationWindows.length, config.initialBalance);
        evaluation.status = classification.status;
        evaluation.recommendation = classification.recommendation;
        evaluation.reasons = classification.reasons;
        evaluation.aggregate = classification.aggregate;
        stripTransientCurves(evaluation);
        combo.parameterEvaluations.push(evaluation);
        writeReports(report, paths, false);
      }

      const best = selectBestEvaluation(combo.parameterEvaluations);
      combo.bestFixedParameter = best;
      combo.status = best.status;
      combo.recommendation = best.recommendation;
      combo.reasons = best.reasons;
      combo.finishedAt = new Date().toISOString();
      writeReports(report, paths);
    }
    report.progress.current = null;
    report.finishedAt = new Date().toISOString();
    writeReports(report, paths);
  } finally {
    if (mt5.isConnected()) await mt5.disconnect().catch(() => {});
  }
  console.log('[FixedHoldout] Complete');
  console.log(`JSON: ${paths.json}`);
  console.log(`CSV: ${paths.csv}`);
  console.log(`MD: ${paths.md}`);
}

main().catch((error) => {
  console.error(`[FixedHoldout] Fatal: ${error.message}`);
  process.exitCode = 1;
});
