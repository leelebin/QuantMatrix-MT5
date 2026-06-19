#!/usr/bin/env node

/**
 * Read-only walk-forward optimizer + out-of-sample edge selection runner.
 *
 * Writes reports only under reports/. It does not persist optimizer history,
 * apply parameters, or enable/disable strategy instances.
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
  getAllSymbols,
  getInstrument,
  INSTRUMENT_CATEGORIES,
  STRATEGY_TYPES,
  VOLUME_FLOW_HYBRID_DEFAULT_SYMBOLS,
  VOLUME_FLOW_HYBRID_OPTIONAL_SYMBOLS,
} = require('../src/config/instruments');
const {
  getStrategyExecutionConfig,
  getForcedTimeframeExecutionConfig,
  isValidForcedTimeframe,
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

const STRATEGIES = [
  'TrendFollowing',
  'MeanReversion',
  'MultiTimeframe',
  'Momentum',
  'Breakout',
  'VolumeFlowHybrid',
];

const DEFAULT_TIMEFRAMES = ['1m', '5m', '15m'];
const DEFAULT_OUTPUT_TAG = 'full-overnight';

const WINDOWS = Object.freeze([
  {
    id: '2024_FULL',
    optimizer: { from: '2024-01-01', to: '2024-07-01' },
    backtest: { from: '2024-07-01', to: '2025-01-01' },
  },
  {
    id: '2025_H1_TO_H2',
    optimizer: { from: '2025-01-01', to: '2025-07-01' },
    backtest: { from: '2025-07-01', to: '2026-01-01' },
  },
  {
    id: '2025_MID_TO_END',
    optimizer: { from: '2025-06-01', to: '2025-10-01' },
    backtest: { from: '2025-10-01', to: '2026-01-01' },
  },
  {
    id: 'RECENT_ROBUSTNESS',
    optimizer: { from: '2025-10-01', to: '2026-02-01' },
    backtest: { from: '2026-02-01', to: '2026-05-01' },
  },
]);

const THRESHOLDS = Object.freeze({
  hardGate: {
    totalTrades: 20,
    returnPercent: 0,
    netProfitMoney: 0,
    profitFactor: 1.25,
    maxDrawdownPercent: 20,
    sharpeRatio: 0.8,
    expectancyPerTrade: 0,
    maxConsecutiveLosses: 5,
    equityCurveLinearRequired: true,
  },
  paperGate: {
    totalTrades: 30,
    profitFactor: 1.40,
    maxDrawdownPercent: 15,
    sharpeRatio: 1.0,
    returnToDrawdown: 1.5,
    expectancyPerTrade: 0,
    equityRSquared: 0.70,
    positiveSegmentRatio: 0.75,
  },
  liveGate: {
    totalTrades: 50,
    profitFactor: 1.50,
    maxDrawdownPercent: 12,
    sharpeRatio: 1.20,
    returnToDrawdown: 2.0,
    expectancyPerTrade: 0,
    maxConsecutiveLosses: 3,
    profitConcentrationTop1: 0.35,
    equityRSquared: 0.75,
    positiveSegmentRatio: 0.75,
    worstSegmentReturnPercent: -3,
  },
  comboPaper: {
    completedWindows: 3,
    hardPassRate: 0.70,
    paperPassRate: 0.50,
    aggregateNetProfitMoney: 0,
    worstReturnPercent: 0,
    worstProfitFactor: 1.20,
    avgProfitFactor: 1.40,
    avgSharpeRatio: 1.0,
    avgMaxDrawdownPercent: 15,
    profitConcentrationByWindowTop1: 0.70,
  },
  comboLive: {
    completedWindows: 3,
    profitableWindowRatio: 1.00,
    hardPassRate: 0.80,
    paperPassRate: 0.70,
    livePassRate: 0.50,
    aggregateNetProfitMoney: 0,
    worstReturnPercent: 0,
    avgProfitFactor: 1.50,
    worstProfitFactor: 1.25,
    avgSharpeRatio: 1.20,
    worstMaxDrawdownPercent: 15,
    equityRSquared: 0.75,
    positiveSegmentRatio: 0.75,
    profitConcentrationByWindowTop1: 0.60,
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
  const args = {};
  argv.slice(2).forEach((entry) => {
    if (!entry.startsWith('--')) return;
    const [rawKey, ...rest] = entry.slice(2).split('=');
    args[rawKey] = rest.length > 0 ? rest.join('=') : 'true';
  });
  return args;
}

function csvList(value) {
  if (!value) return null;
  const items = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

function boolArg(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function intArg(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function todayString() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

function timestampTag() {
  const now = new Date();
  return now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
}

function sanitizeTag(value) {
  return String(value || DEFAULT_OUTPUT_TAG).replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function loadWindows(windowsFile) {
  if (!windowsFile) return WINDOWS;

  const resolvedPath = path.resolve(process.cwd(), windowsFile);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read --windowsFile=${resolvedPath}: ${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`--windowsFile=${resolvedPath} must contain a non-empty JSON array`);
  }

  const ids = new Set();
  const windows = parsed.map((window, index) => {
    if (!window || typeof window !== 'object' || !String(window.id || '').trim()) {
      throw new Error(`Window ${index + 1} in --windowsFile must have an id`);
    }
    const id = String(window.id).trim();
    if (ids.has(id)) {
      throw new Error(`Duplicate window id in --windowsFile: ${id}`);
    }
    ids.add(id);

    const optimizer = parseDateRange(window.optimizer || {});
    const backtest = parseDateRange(window.backtest || {});
    if (optimizer.endExclusive > backtest.start) {
      throw new Error(`Window ${id} overlaps optimizer and OOS backtest ranges`);
    }

    return {
      id,
      optimizer: { from: window.optimizer.from, to: window.optimizer.to },
      backtest: { from: window.backtest.from, to: window.backtest.to },
    };
  });

  return Object.freeze(windows);
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function numberOrZero(value) {
  return numberOrNull(value) ?? 0;
}

function round(value, digits = 4) {
  const numeric = numberOrZero(value);
  return parseFloat(numeric.toFixed(digits));
}

function average(values) {
  const finite = values.map(numberOrNull).filter((value) => value !== null);
  if (finite.length === 0) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function minValue(values) {
  const finite = values.map(numberOrNull).filter((value) => value !== null);
  return finite.length > 0 ? Math.min(...finite) : 0;
}

function maxValue(values) {
  const finite = values.map(numberOrNull).filter((value) => value !== null);
  return finite.length > 0 ? Math.max(...finite) : 0;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function mergeObjects(baseValue, overrideValue) {
  const base = baseValue && typeof baseValue === 'object' && !Array.isArray(baseValue)
    ? clone(baseValue)
    : {};
  const override = overrideValue && typeof overrideValue === 'object' && !Array.isArray(overrideValue)
    ? clone(overrideValue)
    : {};
  return { ...base, ...override };
}

function jsonSafe(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, jsonSafe(nested)]));
  }
  return value;
}

function safeText(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '/')
    .trim();
}

function parseDateRange(range) {
  const start = new Date(range.from);
  const endExclusive = new Date(range.to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(endExclusive.getTime()) || endExclusive <= start) {
    throw new Error(`Invalid window range ${JSON.stringify(range)}`);
  }
  return { start, endExclusive };
}

function isHighCostInstrument(instrument) {
  return instrument && HIGH_COST_CATEGORIES.has(instrument.category);
}

function isStrategySupportedForSymbol(strategy, symbol) {
  if (strategy === STRATEGY_TYPES.VOLUME_FLOW_HYBRID) {
    return VOLUME_FLOW_SUPPORTED_SYMBOLS.has(symbol);
  }
  return true;
}

function buildCostModel(instrument, costPreset) {
  if (instrument && instrument.costModel && typeof instrument.costModel === 'object') {
    return {
      costModel: { ...instrument.costModel },
      source: 'instrument.costModel',
      tags: isHighCostInstrument(instrument) ? ['HIGH_COST_SENSITIVITY'] : [],
    };
  }

  const base = { ...DEFAULT_COST_MODEL };
  const tags = [];
  if (costPreset === 'conservative' || isHighCostInstrument(instrument)) {
    base.spreadPips = Math.max(base.spreadPips, Number(instrument?.spread) || base.spreadPips);
    if (isHighCostInstrument(instrument)) {
      tags.push('HIGH_COST_SENSITIVITY');
    }
  }

  return {
    costModel: base,
    source: costPreset === 'conservative' || isHighCostInstrument(instrument)
      ? 'default+instrument.spread'
      : 'default',
    tags,
  };
}

function comboKey(combo) {
  return `${combo.strategy}:${combo.symbol}:${combo.timeframe}`;
}

function windowKey(combo, windowId) {
  return `${comboKey(combo)}:${windowId}`;
}

async function getActiveRiskProfileReadOnly() {
  try {
    return await riskProfilesDb.findOne({ isActive: true }) || await riskProfilesDb.findOne({});
  } catch (_) {
    return null;
  }
}

async function buildEffectiveRuntime(strategy, symbol, strategyRecord, activeProfile) {
  const instrument = getInstrument(symbol);
  const storedInstance = await StrategyInstance.findByKey(strategy, symbol).catch(() => null);
  const mergedTradeManagement = mergeObjects(
    strategyRecord?.tradeManagement || {},
    storedInstance?.tradeManagement || {}
  );
  const mergedStrategy = {
    ...(strategyRecord || { name: strategy }),
    tradeManagement: Object.keys(mergedTradeManagement).length > 0 ? mergedTradeManagement : null,
  };

  const parameters = resolveStrategyParameters({
    strategyType: strategy,
    instrument,
    storedParameters: strategyRecord?.parameters || {},
    overrides: storedInstance?.parameters || {},
  });

  return {
    storedParameters: parameters,
    storedInstance: storedInstance || null,
    breakevenConfig: breakevenService.resolveEffectiveBreakeven(activeProfile, mergedStrategy),
    executionPolicy: resolveExecutionPolicy(
      strategyRecord?.executionPolicy || null,
      storedInstance?.executionPolicy || null
    ),
  };
}

function buildCandleCache(mt5) {
  const cache = new Map();
  return async function getCachedCandles(symbol, timeframe, fetchStart, limit, endExclusive) {
    const key = [
      symbol,
      timeframe,
      fetchStart.toISOString(),
      endExclusive.toISOString(),
      limit,
    ].join('|');

    if (!cache.has(key)) {
      cache.set(key, mt5.getCandles(symbol, timeframe, fetchStart, limit, endExclusive));
    }
    return cache.get(key);
  };
}

async function fetchCandleBundle({ getCachedCandles, symbol, executionConfig, start, endExclusive }) {
  const timeframe = executionConfig.timeframe || '1h';
  const fetchStart = getWarmupStart(start, timeframe, DEFAULT_WARMUP_BARS);
  const candleLimit = estimateFetchLimit(timeframe, fetchStart, endExclusive);
  const rawPrimary = await getCachedCandles(symbol, timeframe, fetchStart, candleLimit, endExclusive);
  const candles = filterCandlesByRange(rawPrimary || [], fetchStart, endExclusive);
  const inRangeCandles = filterCandlesByRange(rawPrimary || [], start, endExclusive);

  let higherTfCandles = null;
  if (executionConfig.higherTimeframe) {
    const higherStart = getWarmupStart(start, executionConfig.higherTimeframe, DEFAULT_WARMUP_BARS);
    const higherLimit = estimateFetchLimit(executionConfig.higherTimeframe, higherStart, endExclusive);
    const higherRaw = await getCachedCandles(symbol, executionConfig.higherTimeframe, higherStart, higherLimit, endExclusive);
    higherTfCandles = filterCandlesByRange(higherRaw || [], higherStart, endExclusive);
  }

  let lowerTfCandles = null;
  if (executionConfig.entryTimeframe) {
    const lowerStart = getWarmupStart(start, executionConfig.entryTimeframe, DEFAULT_WARMUP_BARS);
    const lowerLimit = estimateFetchLimit(executionConfig.entryTimeframe, lowerStart, endExclusive);
    const lowerRaw = await getCachedCandles(symbol, executionConfig.entryTimeframe, lowerStart, lowerLimit, endExclusive);
    lowerTfCandles = filterCandlesByRange(lowerRaw || [], lowerStart, endExclusive);
  }

  const effectiveStart = inRangeCandles[0] ? new Date(inRangeCandles[0].time) : start;
  const effectiveEnd = inRangeCandles[inRangeCandles.length - 1]
    ? new Date(inRangeCandles[inRangeCandles.length - 1].time)
    : new Date(endExclusive.getTime() - 1);

  return {
    timeframe,
    candles,
    inRangeCandles,
    higherTfCandles,
    lowerTfCandles,
    effectiveStart,
    effectiveEnd,
    fetchMeta: {
      primaryRawCount: Array.isArray(rawPrimary) ? rawPrimary.length : 0,
      primaryWithWarmup: candles.length,
      primaryInRange: inRangeCandles.length,
      higherCount: higherTfCandles ? higherTfCandles.length : 0,
      lowerCount: lowerTfCandles ? lowerTfCandles.length : 0,
      fetchStart: fetchStart.toISOString(),
      endExclusive: endExclusive.toISOString(),
    },
  };
}

async function runOptimizerWithTimeout(params, maxComboMs) {
  let timedOut = false;
  let timer = null;

  if (maxComboMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      optimizerService.requestStop();
    }, maxComboMs);
  }

  try {
    const result = await optimizerService.run(params);
    return {
      ...result,
      timedOut,
      timeoutMs: timedOut ? maxComboMs : null,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function passGate(checks) {
  const reasons = [];
  checks.forEach(([pass, reason]) => {
    if (!pass) reasons.push(reason);
  });
  return { pass: reasons.length === 0, reasons };
}

function evaluateWindowGates(summary, equityQuality) {
  const s = summary || {};
  const hard = passGate([
    [numberOrZero(s.totalTrades) >= 20, `totalTrades ${numberOrZero(s.totalTrades)} < 20`],
    [numberOrZero(s.returnPercent) > 0, `returnPercent ${numberOrZero(s.returnPercent)} <= 0`],
    [numberOrZero(s.netProfitMoney) > 0, `netProfitMoney ${numberOrZero(s.netProfitMoney)} <= 0`],
    [numberOrZero(s.profitFactor) >= 1.25, `profitFactor ${numberOrZero(s.profitFactor)} < 1.25`],
    [numberOrZero(s.maxDrawdownPercent) <= 20, `maxDrawdownPercent ${numberOrZero(s.maxDrawdownPercent)} > 20`],
    [numberOrZero(s.sharpeRatio) >= 0.8, `sharpeRatio ${numberOrZero(s.sharpeRatio)} < 0.8`],
    [numberOrZero(s.expectancyPerTrade) > 0, `expectancyPerTrade ${numberOrZero(s.expectancyPerTrade)} <= 0`],
    [numberOrZero(s.maxConsecutiveLosses) <= 5, `maxConsecutiveLosses ${numberOrZero(s.maxConsecutiveLosses)} > 5`],
    [equityQuality?.isLinearUptrend === true, 'equityCurveQuality.isLinearUptrend is false'],
  ]);

  const paper = passGate([
    [numberOrZero(s.totalTrades) >= 30, `totalTrades ${numberOrZero(s.totalTrades)} < 30`],
    [numberOrZero(s.profitFactor) >= 1.40, `profitFactor ${numberOrZero(s.profitFactor)} < 1.40`],
    [numberOrZero(s.maxDrawdownPercent) <= 15, `maxDrawdownPercent ${numberOrZero(s.maxDrawdownPercent)} > 15`],
    [numberOrZero(s.sharpeRatio) >= 1.0, `sharpeRatio ${numberOrZero(s.sharpeRatio)} < 1.0`],
    [numberOrZero(s.returnToDrawdown) >= 1.5, `returnToDrawdown ${numberOrZero(s.returnToDrawdown)} < 1.5`],
    [numberOrZero(s.expectancyPerTrade) > 0, `expectancyPerTrade ${numberOrZero(s.expectancyPerTrade)} <= 0`],
    [numberOrZero(equityQuality?.rSquared) >= 0.70, `equity rSquared ${numberOrZero(equityQuality?.rSquared)} < 0.70`],
    [numberOrZero(equityQuality?.positiveSegmentRatio) >= 0.75, `positiveSegmentRatio ${numberOrZero(equityQuality?.positiveSegmentRatio)} < 0.75`],
  ]);

  const live = passGate([
    [numberOrZero(s.totalTrades) >= 50, `totalTrades ${numberOrZero(s.totalTrades)} < 50`],
    [numberOrZero(s.profitFactor) >= 1.50, `profitFactor ${numberOrZero(s.profitFactor)} < 1.50`],
    [numberOrZero(s.maxDrawdownPercent) <= 12, `maxDrawdownPercent ${numberOrZero(s.maxDrawdownPercent)} > 12`],
    [numberOrZero(s.sharpeRatio) >= 1.20, `sharpeRatio ${numberOrZero(s.sharpeRatio)} < 1.20`],
    [numberOrZero(s.returnToDrawdown) >= 2.0, `returnToDrawdown ${numberOrZero(s.returnToDrawdown)} < 2.0`],
    [numberOrZero(s.expectancyPerTrade) > 0, `expectancyPerTrade ${numberOrZero(s.expectancyPerTrade)} <= 0`],
    [numberOrZero(s.maxConsecutiveLosses) <= 3, `maxConsecutiveLosses ${numberOrZero(s.maxConsecutiveLosses)} > 3`],
    [numberOrZero(s.profitConcentrationTop1) <= 0.35, `profitConcentrationTop1 ${numberOrZero(s.profitConcentrationTop1)} > 0.35`],
    [numberOrZero(equityQuality?.rSquared) >= 0.75, `equity rSquared ${numberOrZero(equityQuality?.rSquared)} < 0.75`],
    [numberOrZero(equityQuality?.positiveSegmentRatio) >= 0.75, `positiveSegmentRatio ${numberOrZero(equityQuality?.positiveSegmentRatio)} < 0.75`],
    [numberOrZero(equityQuality?.worstSegmentReturnPercent) >= -3, `worstSegmentReturnPercent ${numberOrZero(equityQuality?.worstSegmentReturnPercent)} < -3`],
  ]);

  return { hard, paper, live };
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
  return Object.fromEntries(keys.map((key) => [key, jsonSafe(summary[key])]));
}

function buildContinuousEquityCurve(completedWindows, initialBalance) {
  const combined = [];
  let runningStart = Number(initialBalance) || 0;

  completedWindows.forEach((windowResult) => {
    const curve = windowResult.oos?.equityCurve || [];
    if (!Array.isArray(curve) || curve.length === 0) return;
    const base = numberOrNull(curve[0].equity) ?? runningStart;

    curve.forEach((point, index) => {
      const equity = numberOrNull(point.equity);
      if (equity === null) return;
      if (combined.length > 0 && index === 0) return;
      combined.push({
        time: point.time || `${windowResult.id}:${index}`,
        equity: round(runningStart + (equity - base), 4),
      });
    });

    runningStart += numberOrZero(windowResult.oos?.summary?.netProfitMoney);
  });

  return combined.length > 0 ? combined : [{ time: '', equity: Number(initialBalance) || 0 }];
}

function classifyCombo(comboResult, initialBalance) {
  const windows = comboResult.windows || [];
  const completed = windows.filter((windowResult) => windowResult.status === 'COMPLETED');
  const completedWindows = completed.length;
  const reasons = [];
  const statusCounts = windows.reduce((acc, windowResult) => {
    acc[windowResult.status] = (acc[windowResult.status] || 0) + 1;
    return acc;
  }, {});

  if (completedWindows === 0) {
    const insufficientCount = (statusCounts.INSUFFICIENT_DATA || 0) + (statusCounts.NO_VALID_OPTIMIZER_RESULT || 0);
    const errorCount = (statusCounts.ERROR || 0) + (statusCounts.OPTIMIZER_TIMEOUT || 0) + (statusCounts.MT5_CONNECT_FAILED || 0);
    const status = insufficientCount >= errorCount ? 'INSUFFICIENT_DATA' : 'ERROR';
    reasons.push(status === 'INSUFFICIENT_DATA' ? 'No completed OOS windows due to insufficient data or no valid optimizer result.' : 'No completed OOS windows due to errors or timeouts.');
    return {
      status,
      completedWindows,
      hardPassRate: 0,
      paperPassRate: 0,
      livePassRate: 0,
      profitableWindowRatio: 0,
      aggregateNetProfitMoney: 0,
      avgReturnPercent: 0,
      worstReturnPercent: 0,
      avgProfitFactor: 0,
      worstProfitFactor: 0,
      avgSharpeRatio: 0,
      worstSharpeRatio: 0,
      avgMaxDrawdownPercent: 0,
      worstMaxDrawdownPercent: 0,
      profitConcentrationByWindowTop1: 0,
      combinedEquityQuality: analyzeEquityCurveQuality([], initialBalance),
      bestWindowId: null,
      worstWindowId: null,
      reasons,
    };
  }

  const summaries = completed.map((windowResult) => windowResult.oos.summary || {});
  const gates = completed.map((windowResult) => windowResult.gates || evaluateWindowGates(windowResult.oos.summary, windowResult.oos.equityCurveQuality));
  const profits = summaries.map((summary) => numberOrZero(summary.netProfitMoney));
  const returns = summaries.map((summary) => numberOrZero(summary.returnPercent));
  const profitFactors = summaries.map((summary) => numberOrZero(summary.profitFactor));
  const sharpe = summaries.map((summary) => numberOrZero(summary.sharpeRatio));
  const drawdowns = summaries.map((summary) => numberOrZero(summary.maxDrawdownPercent));
  const robustScores = summaries.map((summary) => numberOrZero(summary.robustScore));
  const aggregateNetProfitMoney = round(profits.reduce((sum, value) => sum + value, 0), 2);
  const positiveProfitSum = profits.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const profitConcentrationByWindowTop1 = positiveProfitSum > 0
    ? Math.max(...profits.map((value) => Math.max(0, value))) / positiveProfitSum
    : 1;
  const combinedEquityCurve = buildContinuousEquityCurve(completed, initialBalance);
  const combinedEquityQuality = analyzeEquityCurveQuality(combinedEquityCurve, initialBalance);
  const warningFlags = new Set();
  summaries.forEach((summary) => (summary.warningFlags || []).forEach((flag) => warningFlags.add(flag)));

  const aggregate = {
    completedWindows,
    hardPassRate: round(gates.filter((gate) => gate.hard.pass).length / completedWindows, 4),
    paperPassRate: round(gates.filter((gate) => gate.paper.pass).length / completedWindows, 4),
    livePassRate: round(gates.filter((gate) => gate.live.pass).length / completedWindows, 4),
    profitableWindowRatio: round(profits.filter((value) => value > 0).length / completedWindows, 4),
    aggregateNetProfitMoney,
    avgReturnPercent: round(average(returns), 2),
    worstReturnPercent: round(minValue(returns), 2),
    avgProfitFactor: round(average(profitFactors), 2),
    worstProfitFactor: round(minValue(profitFactors), 2),
    avgSharpeRatio: round(average(sharpe), 2),
    worstSharpeRatio: round(minValue(sharpe), 2),
    avgRobustScore: round(average(robustScores), 2),
    worstRobustScore: round(minValue(robustScores), 2),
    avgMaxDrawdownPercent: round(average(drawdowns), 2),
    worstMaxDrawdownPercent: round(maxValue(drawdowns), 2),
    profitConcentrationByWindowTop1: round(profitConcentrationByWindowTop1, 4),
    combinedEquityQuality,
    bestWindowId: completed[profits.indexOf(maxValue(profits))]?.id || null,
    worstWindowId: completed[profits.indexOf(minValue(profits))]?.id || null,
    warningFlags: Array.from(warningFlags).sort(),
  };

  const hasBadWarnings = warningFlags.has('HIGH_DRAWDOWN')
    || warningFlags.has('LOW_EXPECTANCY')
    || warningFlags.has('PROFIT_CONCENTRATED');

  const livePass = completedWindows >= 3
    && aggregate.profitableWindowRatio >= 1.00
    && aggregate.hardPassRate >= 0.80
    && aggregate.paperPassRate >= 0.70
    && aggregate.livePassRate >= 0.50
    && aggregate.aggregateNetProfitMoney > 0
    && aggregate.worstReturnPercent > 0
    && aggregate.avgProfitFactor >= 1.50
    && aggregate.worstProfitFactor >= 1.25
    && aggregate.avgSharpeRatio >= 1.20
    && aggregate.worstMaxDrawdownPercent <= 15
    && aggregate.combinedEquityQuality.rSquared >= 0.75
    && aggregate.combinedEquityQuality.positiveSegmentRatio >= 0.75
    && aggregate.profitConcentrationByWindowTop1 <= 0.60
    && !hasBadWarnings;

  if (livePass) {
    reasons.push('Meets cross-window LIVE_CANDIDATE gate.');
    return { status: 'LIVE_CANDIDATE', ...aggregate, reasons };
  }

  const paperPass = completedWindows >= 3
    && aggregate.hardPassRate >= 0.70
    && aggregate.paperPassRate >= 0.50
    && aggregate.aggregateNetProfitMoney > 0
    && aggregate.worstReturnPercent > 0
    && aggregate.worstProfitFactor >= 1.20
    && aggregate.avgProfitFactor >= 1.40
    && aggregate.avgSharpeRatio >= 1.0
    && aggregate.avgMaxDrawdownPercent <= 15
    && aggregate.combinedEquityQuality.isLinearUptrend === true
    && aggregate.profitConcentrationByWindowTop1 <= 0.70;

  if (paperPass) {
    reasons.push('Meets cross-window PAPER_ONLY gate.');
    return { status: 'PAPER_ONLY', ...aggregate, reasons };
  }

  const regimeDependent = aggregate.aggregateNetProfitMoney > 0
    && (
      aggregate.profitConcentrationByWindowTop1 > 0.70
      || aggregate.profitableWindowRatio < 0.70
      || aggregate.combinedEquityQuality.isLinearUptrend !== true
    );

  if (regimeDependent) {
    if (aggregate.profitConcentrationByWindowTop1 > 0.70) reasons.push('Profit is concentrated in one OOS window.');
    if (aggregate.profitableWindowRatio < 0.70) reasons.push('Profitable window ratio is below 0.70.');
    if (aggregate.combinedEquityQuality.isLinearUptrend !== true) reasons.push('Combined equity curve is not linear despite positive aggregate profit.');
    return { status: 'REGIME_DEPENDENT', ...aggregate, reasons };
  }

  const majorityLosing = profits.filter((value) => value <= 0).length > completedWindows / 2;
  const noEdge = (completedWindows >= 2 && aggregate.aggregateNetProfitMoney <= 0)
    || aggregate.avgProfitFactor < 1.10
    || aggregate.avgSharpeRatio < 0.50
    || aggregate.combinedEquityQuality.slope <= 0
    || aggregate.combinedEquityQuality.rSquared < 0.40
    || majorityLosing
    || aggregate.worstReturnPercent < -5;

  if (noEdge) {
    if (aggregate.aggregateNetProfitMoney <= 0) reasons.push('Aggregate net profit is not positive.');
    if (aggregate.avgProfitFactor < 1.10) reasons.push('Average profit factor below 1.10.');
    if (aggregate.avgSharpeRatio < 0.50) reasons.push('Average Sharpe below 0.50.');
    if (aggregate.combinedEquityQuality.slope <= 0) reasons.push('Combined equity slope is not positive.');
    if (aggregate.combinedEquityQuality.rSquared < 0.40) reasons.push('Combined equity rSquared below 0.40.');
    if (majorityLosing) reasons.push('Majority of OOS windows are losing.');
    if (aggregate.worstReturnPercent < -5) reasons.push('Worst OOS return is below -5%.');
    return { status: 'NO_EDGE', ...aggregate, reasons };
  }

  reasons.push('Did not meet live/paper gates and is not clearly regime-dependent.');
  return { status: 'REJECT', ...aggregate, reasons };
}

function compactCombo(combo) {
  return {
    strategy: combo.strategy,
    symbol: combo.symbol,
    timeframe: combo.timeframe,
    status: combo.status,
    completedWindows: combo.aggregate?.completedWindows || 0,
    aggregate: combo.aggregate || null,
    bestParameters: combo.bestParameters || null,
    reasons: combo.reasons || [],
  };
}

function buildSymbolSummary(combos) {
  const bySymbol = new Map();
  combos.forEach((combo) => {
    if (!bySymbol.has(combo.symbol)) bySymbol.set(combo.symbol, []);
    bySymbol.get(combo.symbol).push(combo);
  });

  return Array.from(bySymbol.entries()).map(([symbol, rows]) => {
    const testedCombos = rows.length;
    const live = rows.filter((row) => row.status === 'LIVE_CANDIDATE').length;
    const paper = rows.filter((row) => row.status === 'PAPER_ONLY').length;
    const regime = rows.filter((row) => row.status === 'REGIME_DEPENDENT').length;
    const insufficient = rows.filter((row) => row.status === 'INSUFFICIENT_DATA').length;
    const heavyErrors = rows.filter((row) => row.status === 'ERROR' || row.status === 'OPTIMIZER_TIMEOUT').length;
    const negativeCombos = rows.filter((row) => numberOrZero(row.aggregate?.aggregateNetProfitMoney) <= 0).length;

    let status = 'NEGATIVE_EDGE';
    let reason = 'No live/paper candidates and most combos do not show positive aggregate profit.';
    if (live > 0) {
      status = 'HAS_LIVE_CANDIDATE';
      reason = 'At least one combo reached LIVE_CANDIDATE.';
    } else if (paper > 0) {
      status = 'HAS_PAPER_EDGE';
      reason = 'At least one combo reached PAPER_ONLY.';
    } else if (regime > 0) {
      status = 'REGIME_DEPENDENT_ONLY';
      reason = 'Only regime-dependent positive edges were found.';
    } else if (insufficient > testedCombos / 2) {
      status = 'INSUFFICIENT_DATA';
      reason = 'Most combos could not complete because of insufficient data or no optimizer result.';
    } else if (heavyErrors > testedCombos / 2) {
      status = 'ERROR_HEAVY';
      reason = 'Most combos ended in errors or optimizer timeout.';
    } else if (negativeCombos <= testedCombos / 2) {
      status = 'NEGATIVE_EDGE';
      reason = 'No live/paper edge; mixed or weak rejected results remain.';
    }

    const bestRejectedCombo = rows
      .filter((row) => !['LIVE_CANDIDATE', 'PAPER_ONLY'].includes(row.status))
      .sort((a, b) => numberOrZero(b.aggregate?.aggregateNetProfitMoney) - numberOrZero(a.aggregate?.aggregateNetProfitMoney))[0] || null;

    return {
      symbol,
      status,
      reason,
      testedCombos,
      liveCandidates: live,
      paperOnlyCandidates: paper,
      regimeDependent: regime,
      negativeCombos,
      insufficientCombos: insufficient,
      errorHeavyCombos: heavyErrors,
      bestRejectedCombo: bestRejectedCombo ? compactCombo(bestRejectedCombo) : null,
      notes: [],
    };
  }).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function refreshDerivedCollections(report) {
  const combos = report.combos || [];
  report.liveCandidates = combos.filter((combo) => combo.status === 'LIVE_CANDIDATE').map(compactCombo);
  report.paperOnlyCandidates = combos.filter((combo) => combo.status === 'PAPER_ONLY').map(compactCombo);
  report.regimeDependent = combos.filter((combo) => combo.status === 'REGIME_DEPENDENT').map(compactCombo);
  report.rejects = combos.filter((combo) => combo.status === 'REJECT').map(compactCombo);
  report.noEdgeCombos = combos.filter((combo) => combo.status === 'NO_EDGE').map(compactCombo);
  report.symbolSummary = buildSymbolSummary(combos);
  report.negativeEdgeSymbols = report.symbolSummary
    .filter((row) => row.status === 'NEGATIVE_EDGE')
    .map((row) => ({
      symbol: row.symbol,
      status: row.status,
      reason: row.reason,
      testedCombos: row.testedCombos,
      negativeCombos: row.negativeCombos,
      bestRejectedCombo: row.bestRejectedCombo,
      notes: row.notes,
    }));

  const allWindows = combos.flatMap((combo) => combo.windows || []);
  const doneStatuses = new Set([
    'COMPLETED',
    'INSUFFICIENT_DATA',
    'NO_VALID_OPTIMIZER_RESULT',
    'OPTIMIZER_TIMEOUT',
    'ERROR',
    'SKIPPED',
    'MT5_CONNECT_FAILED',
  ]);
  const completedComboWindows = allWindows.filter((row) => doneStatuses.has(row.status)).length;
  const totalComboWindows = report.progress?.totalComboWindows || report.runConfig.totalComboWindows || 0;
  report.progress = {
    ...(report.progress || {}),
    completedComboWindows,
    totalComboWindows,
    percent: totalComboWindows > 0 ? round((completedComboWindows / totalComboWindows) * 100, 2) : 0,
    completedCombos: combos.filter((combo) => combo.aggregate).length,
    totalCombos: report.runConfig.totalCombos || combos.length,
    liveCandidateCount: report.liveCandidates.length,
    paperOnlyCount: report.paperOnlyCandidates.length,
    regimeDependentCount: report.regimeDependent.length,
    rejectCount: report.rejects.length,
    noEdgeCount: report.noEdgeCombos.length,
  };
}

function outputPaths(args) {
  const reportsDir = path.resolve(process.cwd(), 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  if (args.resumeReport) {
    const jsonPath = path.resolve(process.cwd(), args.resumeReport);
    const base = jsonPath.replace(/\.json$/i, '');
    return {
      reportsDir,
      jsonPath,
      csvPath: `${base}.csv`,
      mdPath: `${base}.md`,
    };
  }

  const baseName = `walkforward-edge-selection-${todayString()}-${sanitizeTag(args.outputTag || DEFAULT_OUTPUT_TAG)}`;
  const base = path.join(reportsDir, baseName);
  return {
    reportsDir,
    jsonPath: `${base}.json`,
    csvPath: `${base}.csv`,
    mdPath: `${base}.md`,
  };
}

function loadResumeReport(jsonPath) {
  try {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    const backupPath = `${jsonPath}.corrupt-${timestampTag()}.bak`;
    if (fs.existsSync(jsonPath)) {
      fs.copyFileSync(jsonPath, backupPath);
    }
    const error = new Error(`Failed to parse resume report: ${jsonPath}. Backup saved to ${backupPath}. ${err.message}`);
    error.backupPath = backupPath;
    throw error;
  }
}

function writeJsonAtomic(filePath, payload) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(jsonSafe(payload), null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

function csvEscape(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const text = raw == null ? '' : String(raw);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function writeCsv(report, csvPath) {
  const headers = [
    'strategy',
    'symbol',
    'timeframe',
    'status',
    'completedWindows',
    'hardPassRate',
    'paperPassRate',
    'livePassRate',
    'profitableWindowRatio',
    'aggregateNetProfitMoney',
    'avgReturnPercent',
    'worstReturnPercent',
    'avgProfitFactor',
    'worstProfitFactor',
    'avgSharpeRatio',
    'worstSharpeRatio',
    'avgMaxDrawdownPercent',
    'worstMaxDrawdownPercent',
    'combinedEquityRSquared',
    'combinedPositiveSegmentRatio',
    'combinedUnderwaterPercent',
    'profitConcentrationByWindowTop1',
    'bestWindowId',
    'worstWindowId',
    'reasons',
    'bestParametersJson',
  ];

  const lines = [headers.join(',')];
  (report.combos || []).forEach((combo) => {
    const aggregate = combo.aggregate || {};
    const quality = aggregate.combinedEquityQuality || {};
    const row = [
      combo.strategy,
      combo.symbol,
      combo.timeframe,
      combo.status,
      aggregate.completedWindows,
      aggregate.hardPassRate,
      aggregate.paperPassRate,
      aggregate.livePassRate,
      aggregate.profitableWindowRatio,
      aggregate.aggregateNetProfitMoney,
      aggregate.avgReturnPercent,
      aggregate.worstReturnPercent,
      aggregate.avgProfitFactor,
      aggregate.worstProfitFactor,
      aggregate.avgSharpeRatio,
      aggregate.worstSharpeRatio,
      aggregate.avgMaxDrawdownPercent,
      aggregate.worstMaxDrawdownPercent,
      quality.rSquared,
      quality.positiveSegmentRatio,
      quality.underwaterPercent,
      aggregate.profitConcentrationByWindowTop1,
      aggregate.bestWindowId,
      aggregate.worstWindowId,
      (combo.reasons || []).join('; '),
      JSON.stringify(combo.bestParameters || {}),
    ];
    lines.push(row.map(csvEscape).join(','));
  });

  fs.writeFileSync(csvPath, `${lines.join('\n')}\n`);
}

function markdownTable(rows, columns) {
  if (!rows || rows.length === 0) return '_None_';
  const header = `| ${columns.map((column) => column.label).join(' |')} |`;
  const divider = `| ${columns.map(() => '---').join(' |')} |`;
  const body = rows.map((row) => `| ${columns.map((column) => safeText(column.value(row))).join(' |')} |`);
  return [header, divider, ...body].join('\n');
}

function metricColumns() {
  return [
    { label: 'Combo', value: (row) => `${row.strategy}:${row.symbol}:${row.timeframe}` },
    { label: 'Status', value: (row) => row.status },
    { label: 'Win', value: (row) => row.aggregate?.completedWindows ?? 0 },
    { label: 'Net', value: (row) => row.aggregate?.aggregateNetProfitMoney ?? 0 },
    { label: 'PF', value: (row) => row.aggregate?.avgProfitFactor ?? 0 },
    { label: 'Worst Ret%', value: (row) => row.aggregate?.worstReturnPercent ?? 0 },
    { label: 'Sharpe', value: (row) => row.aggregate?.avgSharpeRatio ?? 0 },
    { label: 'R2', value: (row) => row.aggregate?.combinedEquityQuality?.rSquared ?? 0 },
    { label: 'Reasons', value: (row) => (row.reasons || []).slice(0, 2).join('; ') },
  ];
}

function topRows(report, sorter, limit = 20) {
  return [...(report.combos || [])]
    .filter((combo) => combo.aggregate)
    .sort(sorter)
    .slice(0, limit);
}

function writeMarkdown(report, mdPath) {
  const live = report.liveCandidates || [];
  const paper = report.paperOnlyCandidates || [];
  const regime = report.regimeDependent || [];
  const rejectLike = [...(report.rejects || []), ...(report.noEdgeCombos || [])];
  const combosByKey = new Map((report.combos || []).map((combo) => [comboKey(combo), combo]));
  const candidateCombos = [...live, ...paper, ...regime]
    .map((row) => combosByKey.get(comboKey(row)) || row);

  const lines = [
    '# Walk-forward Edge Selection Report',
    '',
    `Generated: ${report.generatedAt || ''}`,
    `Finished: ${report.finishedAt || 'running'}`,
    '',
    '## Executive Summary',
    `- Total combos: ${report.progress?.totalCombos || report.runConfig?.totalCombos || 0}`,
    `- Completed combo-windows: ${report.progress?.completedComboWindows || 0}/${report.progress?.totalComboWindows || 0}`,
    `- LIVE_CANDIDATE: ${live.length}`,
    `- PAPER_ONLY: ${paper.length}`,
    `- REGIME_DEPENDENT: ${regime.length}`,
    `- REJECT: ${(report.rejects || []).length}`,
    `- NO_EDGE: ${(report.noEdgeCombos || []).length}`,
    `- Negative edge symbols: ${(report.negativeEdgeSymbols || []).length}`,
    '',
    '## Run Config',
    '```json',
    JSON.stringify(report.runConfig || {}, null, 2),
    '```',
    '',
    '## Thresholds',
    '```json',
    JSON.stringify(report.thresholds || {}, null, 2),
    '```',
    '',
    '## LIVE_CANDIDATE',
    markdownTable(live, metricColumns()),
    '',
    '## PAPER_ONLY',
    markdownTable(paper, metricColumns()),
    '',
    '## REGIME_DEPENDENT',
    markdownTable(regime, metricColumns()),
    '',
    '## REJECT / NO_EDGE',
    markdownTable(rejectLike, metricColumns()),
    '',
    '## NEGATIVE_EDGE SYMBOLS',
    markdownTable(report.negativeEdgeSymbols || [], [
      { label: 'Symbol', value: (row) => row.symbol },
      { label: 'Status', value: (row) => row.status },
      { label: 'Tested', value: (row) => row.testedCombos },
      { label: 'Negative', value: (row) => row.negativeCombos },
      { label: 'Reason', value: (row) => row.reason },
    ]),
    '',
    '## Symbol Summary',
    markdownTable(report.symbolSummary || [], [
      { label: 'Symbol', value: (row) => row.symbol },
      { label: 'Status', value: (row) => row.status },
      { label: 'Live', value: (row) => row.liveCandidates },
      { label: 'Paper', value: (row) => row.paperOnlyCandidates },
      { label: 'Regime', value: (row) => row.regimeDependent },
      { label: 'Reason', value: (row) => row.reason },
    ]),
    '',
    '## Top 20 by Robustness',
    markdownTable(topRows(report, (a, b) => numberOrZero(b.aggregate?.avgRobustScore) - numberOrZero(a.aggregate?.avgRobustScore)), metricColumns()),
    '',
    '## Top 20 by Profit Factor',
    markdownTable(topRows(report, (a, b) => numberOrZero(b.aggregate?.avgProfitFactor) - numberOrZero(a.aggregate?.avgProfitFactor)), metricColumns()),
    '',
    '## Top 20 by Equity Linearity',
    markdownTable(topRows(report, (a, b) => numberOrZero(b.aggregate?.combinedEquityQuality?.rSquared) - numberOrZero(a.aggregate?.combinedEquityQuality?.rSquared)), metricColumns()),
    '',
    '## Candidate Parameters and Windows',
  ];

  candidateCombos.forEach((combo) => {
    lines.push(
      '',
      `### ${combo.strategy}:${combo.symbol}:${combo.timeframe} - ${combo.status}`,
      '',
      'Best parameters:',
      '```json',
      JSON.stringify(combo.bestParameters || {}, null, 2),
      '```',
      '',
      markdownTable((combo.windows || []).filter((row) => row.status === 'COMPLETED'), [
        { label: 'Window', value: (row) => row.id },
        { label: 'Trades', value: (row) => row.oos?.summary?.totalTrades ?? 0 },
        { label: 'Net', value: (row) => row.oos?.summary?.netProfitMoney ?? 0 },
        { label: 'Return%', value: (row) => row.oos?.summary?.returnPercent ?? 0 },
        { label: 'PF', value: (row) => row.oos?.summary?.profitFactor ?? 0 },
        { label: 'Sharpe', value: (row) => row.oos?.summary?.sharpeRatio ?? 0 },
        { label: 'R2', value: (row) => row.oos?.equityCurveQuality?.rSquared ?? 0 },
        { label: 'Hard/Paper/Live', value: (row) => `${row.gates?.hard?.pass ? 'Y' : 'N'}/${row.gates?.paper?.pass ? 'Y' : 'N'}/${row.gates?.live?.pass ? 'Y' : 'N'}` },
      ])
    );
  });

  lines.push('', '## Reject Reasons');
  rejectLike.forEach((combo) => {
    lines.push(`- ${combo.strategy}:${combo.symbol}:${combo.timeframe}: ${(combo.reasons || []).join('; ') || 'No reason recorded'}`);
  });

  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`);
}

function writeReportFiles(report, paths) {
  refreshDerivedCollections(report);
  writeJsonAtomic(paths.jsonPath, report);
  writeCsv(report, paths.csvPath);
  writeMarkdown(report, paths.mdPath);
}

function buildFreshReport(config, windows) {
  return {
    runConfig: config,
    thresholds: THRESHOLDS,
    windows,
    progress: {
      totalCombos: config.totalCombos,
      totalComboWindows: config.totalComboWindows,
      completedCombos: 0,
      completedComboWindows: 0,
      percent: 0,
    },
    combos: [],
    liveCandidates: [],
    paperOnlyCandidates: [],
    regimeDependent: [],
    rejects: [],
    noEdgeCombos: [],
    symbolSummary: [],
    negativeEdgeSymbols: [],
    skipped: [],
    errors: [],
    generatedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

function buildUniverse({ selectedStrategies, selectedSymbols, selectedTimeframes, universeMode, strategyRecordsByName, skipHeavyVolumeFlow }) {
  const assigned = [];
  const skipped = [];

  selectedStrategies.forEach((strategy) => {
    let symbols = selectedSymbols;
    if (universeMode !== 'all') {
      const record = strategyRecordsByName.get(strategy);
      symbols = Array.isArray(record?.symbols) && record.symbols.length > 0
        ? record.symbols.filter((symbol) => selectedSymbols.includes(symbol))
        : selectedSymbols;
    }

    symbols.forEach((symbol) => {
      selectedTimeframes.forEach((timeframe) => {
        const combo = { strategy, symbol, timeframe };
        const instrument = getInstrument(symbol);
        if (!instrument) {
          skipped.push({ ...combo, status: 'SKIPPED', reason: 'UNKNOWN_SYMBOL' });
          return;
        }
        if (!STRATEGIES.includes(strategy)) {
          skipped.push({ ...combo, status: 'SKIPPED', reason: 'UNKNOWN_STRATEGY' });
          return;
        }
        if (!isValidForcedTimeframe(timeframe)) {
          skipped.push({ ...combo, status: 'SKIPPED', reason: 'INVALID_TIMEFRAME' });
          return;
        }
        if (!isStrategySupportedForSymbol(strategy, symbol)) {
          skipped.push({ ...combo, status: 'SKIPPED', reason: 'STRATEGY_NOT_SUPPORTED_FOR_SYMBOL' });
          return;
        }
        if (strategy === STRATEGY_TYPES.VOLUME_FLOW_HYBRID && skipHeavyVolumeFlow) {
          skipped.push({ ...combo, status: 'SKIPPED', reason: 'SKIP_HEAVY_VOLUME_FLOW' });
          return;
        }
        if (!getOptimizerParameterRanges(strategy) || Object.keys(getOptimizerParameterRanges(strategy)).length === 0) {
          skipped.push({ ...combo, status: 'SKIPPED', reason: 'NO_OPTIMIZER_RANGES' });
          return;
        }
        assigned.push(combo);
      });
    });
  });

  const unique = [];
  const seen = new Set();
  assigned.forEach((combo) => {
    const key = comboKey(combo);
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(combo);
  });

  return { assigned: unique, skipped };
}

function ensureComboResult(report, combo) {
  let comboResult = (report.combos || []).find((row) => comboKey(row) === comboKey(combo));
  if (!comboResult) {
    comboResult = {
      ...combo,
      status: 'PENDING',
      windows: [],
      aggregate: null,
      bestParameters: null,
      reasons: [],
      startedAt: null,
      finishedAt: null,
    };
    report.combos.push(comboResult);
  }
  return comboResult;
}

function existingWindowResult(comboResult, windowId) {
  return (comboResult.windows || []).find((row) => row.id === windowId);
}

function estimateEta(progress, startedAtMs) {
  const completed = progress.completedComboWindows || 0;
  const total = progress.totalComboWindows || 0;
  if (completed <= 0 || total <= completed) return null;
  const elapsedMs = Date.now() - startedAtMs;
  const rate = completed / Math.max(1, elapsedMs);
  const remainingMs = (total - completed) / rate;
  return Number.isFinite(remainingMs) ? new Date(Date.now() + remainingMs).toISOString() : null;
}

function logProgress(report, currentLabel, startedAtMs) {
  refreshDerivedCollections(report);
  const eta = estimateEta(report.progress, startedAtMs);
  console.log(
    `[WalkForward] progress ${report.progress.completedComboWindows}/${report.progress.totalComboWindows}`
    + ` (${report.progress.percent}%) current=${currentLabel || '--'}`
    + (eta ? ` ETA=${eta}` : '')
  );
}

async function runComboWindow({
  combo,
  window,
  config,
  strategyRecord,
  activeProfile,
  getCachedCandles,
}) {
  const startedAt = new Date().toISOString();
  const instrument = getInstrument(combo.symbol);
  const costInfo = buildCostModel(instrument, config.costPreset);
  const executionConfig = getForcedTimeframeExecutionConfig(combo.symbol, combo.strategy, combo.timeframe)
    || getStrategyExecutionConfig(combo.symbol, combo.strategy);
  const runtime = await buildEffectiveRuntime(combo.strategy, combo.symbol, strategyRecord, activeProfile);
  const optRange = parseDateRange(window.optimizer);
  const oosRange = parseDateRange(window.backtest);

  try {
    const optimizerBundle = await fetchCandleBundle({
      getCachedCandles,
      symbol: combo.symbol,
      executionConfig,
      start: optRange.start,
      endExclusive: optRange.endExclusive,
    });

    if (!optimizerBundle.candles || optimizerBundle.candles.length < DEFAULT_WARMUP_BARS + 2 || optimizerBundle.inRangeCandles.length < 50) {
      return {
        id: window.id,
        status: 'INSUFFICIENT_DATA',
        startedAt,
        finishedAt: new Date().toISOString(),
        reason: `Optimizer window has ${optimizerBundle.inRangeCandles.length} in-range candles; need at least 50 after warmup.`,
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
        if (progress.current === 1 || progress.current === progress.total || progress.current % 100 === 0) {
          console.log(
            `[WalkForward] ${combo.strategy} ${combo.symbol} ${combo.timeframe} ${window.id}`
            + ` optimizer ${progress.current}/${progress.total} workers=${progress.workerCount}`
          );
        }
      },
    }, config.maxComboMs);

    const optimizerSummary = {
      status: optimizerResult.status,
      timedOut: Boolean(optimizerResult.timedOut),
      timeoutMs: optimizerResult.timeoutMs || null,
      totalCombinations: optimizerResult.totalCombinations,
      processedCombinations: optimizerResult.processedCombinations,
      validResults: optimizerResult.validResults,
      optimizeFor: optimizerResult.optimizeFor,
      workerCount: optimizerResult.workerCount,
      bestSummary: optimizerResult.bestResult ? compactSummary(optimizerResult.bestResult.summary) : null,
      top10: (optimizerResult.top10 || []).map((row) => ({
        parameters: row.parameters,
        summary: compactSummary(row.summary),
      })),
      fetchMeta: optimizerBundle.fetchMeta,
    };

    if (optimizerResult.timedOut) {
      return {
        id: window.id,
        status: 'OPTIMIZER_TIMEOUT',
        startedAt,
        finishedAt: new Date().toISOString(),
        reason: `Optimizer exceeded maxComboMs=${config.maxComboMs}`,
        optimizer: optimizerSummary,
      };
    }

    if (!optimizerResult.bestResult || !optimizerResult.bestResult.parameters) {
      return {
        id: window.id,
        status: 'NO_VALID_OPTIMIZER_RESULT',
        startedAt,
        finishedAt: new Date().toISOString(),
        reason: 'Optimizer completed without a bestResult that met minimumTrades.',
        optimizer: optimizerSummary,
      };
    }

    const bestParameters = optimizerResult.bestResult.parameters;
    const oosBundle = await fetchCandleBundle({
      getCachedCandles,
      symbol: combo.symbol,
      executionConfig,
      start: oosRange.start,
      endExclusive: oosRange.endExclusive,
    });

    if (!oosBundle.candles || oosBundle.candles.length < DEFAULT_WARMUP_BARS + 2 || oosBundle.inRangeCandles.length < 20) {
      return {
        id: window.id,
        status: 'INSUFFICIENT_DATA',
        startedAt,
        finishedAt: new Date().toISOString(),
        reason: `OOS window has ${oosBundle.inRangeCandles.length} in-range candles; need enough data after warmup.`,
        optimizer: optimizerSummary,
        bestParameters,
        oos: { fetchMeta: oosBundle.fetchMeta },
      };
    }

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
      strategyParams: bestParameters,
      storedStrategyParameters: runtime.storedParameters,
      breakevenConfig: runtime.breakevenConfig,
      executionPolicy: runtime.executionPolicy,
      executionConfigOverride: executionConfig,
      costModel: costInfo.costModel,
      parameterPreset: 'walkforward_optimizer_best',
      parameterPresetResolution: {
        preset: 'walkforward_optimizer_best',
        fallbackUsed: false,
        resolvedFrom: 'walkforward_optimizer',
        optimizerHistoryId: null,
        optimizerCompletedAt: optimizerResult.completedAt || null,
        optimizerTimeframe: executionConfig.timeframe,
        optimizerOptimizeFor: optimizerResult.optimizeFor,
      },
    });

    const equityCurveQuality = analyzeEquityCurveQuality(simulation.equityCurve, config.initialBalance);
    const gates = evaluateWindowGates(simulation.summary, equityCurveQuality);

    return {
      id: window.id,
      status: 'COMPLETED',
      startedAt,
      finishedAt: new Date().toISOString(),
      optimizer: optimizerSummary,
      bestParameters,
      oos: {
        summary: compactSummary(simulation.summary),
        equityCurveQuality,
        monthlyBreakdown: simulation.monthlyBreakdown || [],
        tradesCount: Array.isArray(simulation.trades) ? simulation.trades.length : 0,
        equityCurve: simulation.equityCurve || [],
        fetchMeta: oosBundle.fetchMeta,
      },
      gates,
      costModel: {
        source: costInfo.source,
        tags: costInfo.tags,
        costModel: costInfo.costModel,
      },
    };
  } catch (err) {
    return {
      id: window.id,
      status: 'ERROR',
      startedAt,
      finishedAt: new Date().toISOString(),
      reason: err.message,
      error: {
        message: err.message,
        stack: err.stack,
        code: err.code || null,
      },
    };
  }
}

function finalizeCombo(comboResult, initialBalance) {
  const aggregate = classifyCombo(comboResult, initialBalance);
  comboResult.status = aggregate.status;
  comboResult.aggregate = aggregate;
  comboResult.reasons = aggregate.reasons || [];
  const completed = (comboResult.windows || []).filter((row) => row.status === 'COMPLETED');
  const bestWindow = completed
    .slice()
    .sort((a, b) => numberOrZero(b.oos?.summary?.netProfitMoney) - numberOrZero(a.oos?.summary?.netProfitMoney))[0];
  comboResult.bestParameters = bestWindow?.bestParameters || completed[0]?.bestParameters || null;
  comboResult.finishedAt = new Date().toISOString();
}

async function markMt5ConnectFailure(report, universe, error, paths, windows) {
  const now = new Date().toISOString();
  report.errors.push({
    status: 'MT5_CONNECT_FAILED',
    message: error.message,
    code: error.code || null,
    details: error.details || null,
    createdAt: now,
  });
  report.runConfig.mt5ConnectFailed = true;
  report.runConfig.mt5ConnectError = error.message;

  universe.assigned.forEach((combo) => {
    const comboResult = ensureComboResult(report, combo);
    windows.forEach((window) => {
      if (!existingWindowResult(comboResult, window.id)) {
        comboResult.windows.push({
          id: window.id,
          status: 'MT5_CONNECT_FAILED',
          reason: error.message,
          startedAt: now,
          finishedAt: now,
        });
      }
    });
    finalizeCombo(comboResult, report.runConfig.initialBalance);
  });

  report.finishedAt = now;
  writeReportFiles(report, paths);
}

async function main() {
  const args = parseArgs(process.argv);
  const paths = outputPaths(args);
  const resumePath = args.resumeReport ? paths.jsonPath : null;
  const windows = loadWindows(args.windowsFile);
  const selectedStrategies = csvList(args.strategies) || STRATEGIES;
  const selectedSymbols = csvList(args.symbols) || getAllSymbols();
  const selectedTimeframes = csvList(args.timeframes) || DEFAULT_TIMEFRAMES;
  const fullMode = boolArg(args.fullMode, true);
  const universeMode = args.universe || 'all';

  if (!['all', 'assigned'].includes(universeMode)) {
    throw new Error(`Invalid --universe=${universeMode}; expected all or assigned`);
  }
  selectedTimeframes.forEach((timeframe) => {
    if (!isValidForcedTimeframe(timeframe)) {
      throw new Error(`Invalid --timeframes entry: ${timeframe}`);
    }
  });

  const [strategyRecords, activeProfile] = await Promise.all([
    Strategy.findAll().catch(() => []),
    getActiveRiskProfileReadOnly(),
  ]);
  const strategyRecordsByName = new Map(strategyRecords.map((strategy) => [strategy.name, strategy]));
  const universe = buildUniverse({
    selectedStrategies,
    selectedSymbols,
    selectedTimeframes,
    universeMode,
    strategyRecordsByName,
    skipHeavyVolumeFlow: boolArg(args.skipHeavyVolumeFlow, false),
  });

  const runConfig = {
    generatedAt: new Date().toISOString(),
    outputTag: args.outputTag || DEFAULT_OUTPUT_TAG,
    fullMode,
    universe: universeMode,
    symbols: selectedSymbols,
    strategies: selectedStrategies,
    timeframes: selectedTimeframes,
    windows: windows.map((window) => window.id),
    windowsFile: args.windowsFile ? path.resolve(process.cwd(), args.windowsFile) : null,
    initialBalance: Number(args.initialBalance || 500),
    optimizeFor: args.optimizeFor || 'robustScore',
    minimumTrades: intArg(args.minimumTrades, 30),
    parallelWorkers: intArg(args.parallelWorkers, 2),
    mt5Scope: args.mt5Scope || 'live',
    costPreset: args.costPreset || 'conservative',
    maxComboMs: intArg(args.maxComboMs, 1800000),
    skipHeavyVolumeFlow: boolArg(args.skipHeavyVolumeFlow, false),
    totalCombos: universe.assigned.length,
    totalComboWindows: universe.assigned.length * windows.length,
    skippedAtBuild: universe.skipped.length,
    reportJsonPath: paths.jsonPath,
    reportCsvPath: paths.csvPath,
    reportMarkdownPath: paths.mdPath,
    resumeReport: resumePath,
    readOnly: true,
    appliesParametersToLive: false,
    mutatesStrategyInstances: false,
  };

  let report = resumePath && fs.existsSync(resumePath)
    ? loadResumeReport(resumePath)
    : buildFreshReport(runConfig, windows);

  report.runConfig = {
    ...(report.runConfig || {}),
    ...runConfig,
    resumedAt: resumePath ? new Date().toISOString() : report.runConfig?.resumedAt || null,
  };
  report.thresholds = THRESHOLDS;
  report.windows = windows;
  report.skipped = Array.isArray(report.skipped) ? report.skipped : [];
  report.errors = Array.isArray(report.errors) ? report.errors : [];
  report.combos = Array.isArray(report.combos) ? report.combos : [];
  universe.skipped.forEach((skip) => {
    if (!report.skipped.some((row) => comboKey(row) === comboKey(skip) && row.reason === skip.reason)) {
      report.skipped.push(skip);
    }
  });

  writeReportFiles(report, paths);

  const mt5 = typeof mt5RootService.getScopedService === 'function'
    ? mt5RootService.getScopedService(runConfig.mt5Scope)
    : mt5RootService;
  if (typeof mt5.reloadConnectionEnvFromFile === 'function') {
    mt5.reloadConnectionEnvFromFile();
  }

  console.log('[WalkForward] Connecting to MT5...');
  try {
    if (!mt5.isConnected()) {
      await mt5.connect();
    }
  } catch (err) {
    console.error(`[WalkForward] MT5 connect failed: ${err.message}`);
    await markMt5ConnectFailure(report, universe, err, paths, windows);
    process.exitCode = 1;
    return;
  }

  const getCachedCandles = buildCandleCache(mt5);
  const startedAtMs = Date.now();
  let lastProgressLog = 0;

  try {
    for (let comboIndex = 0; comboIndex < universe.assigned.length; comboIndex += 1) {
      const combo = universe.assigned[comboIndex];
      const comboResult = ensureComboResult(report, combo);
      comboResult.startedAt = comboResult.startedAt || new Date().toISOString();

      const strategyRecord = strategyRecordsByName.get(combo.strategy) || null;
      for (const window of windows) {
        const label = `${combo.strategy} ${combo.symbol} ${combo.timeframe} ${window.id}`;
        if (existingWindowResult(comboResult, window.id)) {
          continue;
        }

        report.progress.current = {
          comboIndex: comboIndex + 1,
          totalCombos: universe.assigned.length,
          strategy: combo.strategy,
          symbol: combo.symbol,
          timeframe: combo.timeframe,
          windowId: window.id,
        };
        console.log(`[WalkForward] Running ${label}`);

        const windowResult = await runComboWindow({
          combo,
          window,
          config: runConfig,
          strategyRecord,
          activeProfile,
          getCachedCandles,
        });
        comboResult.windows.push(windowResult);
        writeReportFiles(report, paths);
        console.log(`[WalkForward] Saved ${label}: ${windowResult.status}`);

        if (Date.now() - lastProgressLog >= 5 * 60 * 1000) {
          logProgress(report, label, startedAtMs);
          lastProgressLog = Date.now();
        }
      }

      if (!comboResult.aggregate || (comboResult.windows || []).length >= windows.length) {
        finalizeCombo(comboResult, runConfig.initialBalance);
        writeReportFiles(report, paths);
      }
    }

    report.finishedAt = new Date().toISOString();
    report.progress.current = null;
    writeReportFiles(report, paths);
  } finally {
    if (mt5.isConnected()) {
      await mt5.disconnect().catch(() => {});
    }
  }

  console.log('[WalkForward] Complete');
  console.log(`JSON: ${paths.jsonPath}`);
  console.log(`CSV:  ${paths.csvPath}`);
  console.log(`MD:   ${paths.mdPath}`);
}

main().catch((err) => {
  console.error('[WalkForward] Fatal:', err.message);
  if (err.backupPath) {
    console.error(`[WalkForward] Corrupt resume backup: ${err.backupPath}`);
  }
  process.exitCode = 1;
});
