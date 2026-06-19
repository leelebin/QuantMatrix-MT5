#!/usr/bin/env node

/**
 * Read-only optimizer strategy selection runner.
 *
 * This script fetches MT5 candles, runs optimizerService directly, and writes
 * reports only under reports/. It deliberately does not call controller paths
 * that persist optimizer history or mutate strategy/runtime state.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const mt5Service = require('../src/services/mt5Service');
const optimizerService = require('../src/services/optimizerService');
const backtestEngine = require('../src/services/backtestEngine');
const Strategy = require('../src/models/Strategy');
const StrategyInstance = require('../src/models/StrategyInstance');
const RiskProfile = require('../src/models/RiskProfile');
const breakevenService = require('../src/services/breakevenService');
const { resolveExecutionPolicy } = require('../src/services/executionPolicyService');
const {
  instruments,
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
const { DEFAULT_STRATEGY_SYMBOL_ASSIGNMENTS } = require('../src/config/defaultAssignments');
const {
  clampDateRangeToNow,
  DEFAULT_WARMUP_BARS,
  estimateFetchLimit,
  filterCandlesByRange,
  getWarmupStart,
  normalizeDateRange,
} = require('../src/utils/candleRange');
const {
  CANDIDATE_BUCKETS,
  assessWalkForwardMetrics,
  buildCostStressScenarios,
  classifyOptimizerCandidate,
  evaluateCostStressResults,
} = require('../src/utils/optimizerCandidateValidation');

const STRATEGIES = [
  'TrendFollowing',
  'MeanReversion',
  'MultiTimeframe',
  'Momentum',
  'Breakout',
  'VolumeFlowHybrid',
];

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

const HIGH_VOLATILITY_SYMBOLS = new Set([
  'XAUUSD',
  'XAGUSD',
  'US30',
  'NAS100',
  'SPX500',
  'XTIUSD',
  'XBRUSD',
  'BTCUSD',
  'ETHUSD',
  'LTCUSD',
  'XRPUSD',
  'BCHUSD',
  'SOLUSD',
  'ADAUSD',
  'DOGEUSD',
]);

const VOLUME_FLOW_SUPPORTED_SYMBOLS = new Set([
  ...VOLUME_FLOW_HYBRID_DEFAULT_SYMBOLS,
  ...VOLUME_FLOW_HYBRID_OPTIONAL_SYMBOLS,
]);

const DEFAULT_WALK_FORWARD_SPLIT = Object.freeze({
  train: 0.6,
  validation: 0.2,
  outOfSample: 0.2,
});

function parseArgs(argv) {
  const args = {};
  argv.slice(2).forEach((entry) => {
    if (!entry.startsWith('--')) return;
    const [rawKey, ...rest] = entry.slice(2).split('=');
    const value = rest.length > 0 ? rest.join('=') : 'true';
    args[rawKey] = value;
  });
  return args;
}

function csvList(value) {
  if (!value) return null;
  const items = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : null;
}

function boolArg(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function intArg(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function todayString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function summarizeWindow(range) {
  if (!range) return null;
  return {
    start: formatIso(range.start),
    endExclusive: formatIso(range.endExclusive),
  };
}

function buildWalkForwardRanges(range, split = DEFAULT_WALK_FORWARD_SPLIT) {
  if (!range || !(range.start instanceof Date) || !(range.endExclusive instanceof Date)) {
    return null;
  }

  const startMs = range.start.getTime();
  const endMs = range.endExclusive.getTime();
  const totalMs = endMs - startMs;
  if (!Number.isFinite(totalMs) || totalMs <= 0) return null;

  const trainRatio = Number(split.train) > 0 ? Number(split.train) : DEFAULT_WALK_FORWARD_SPLIT.train;
  const validationRatio = Number(split.validation) > 0 ? Number(split.validation) : DEFAULT_WALK_FORWARD_SPLIT.validation;
  const trainEndMs = Math.floor(startMs + totalMs * trainRatio);
  const validationEndMs = Math.floor(startMs + totalMs * (trainRatio + validationRatio));

  const trainEnd = new Date(trainEndMs);
  const validationEnd = new Date(Math.min(validationEndMs, endMs));
  if (trainEnd <= range.start || validationEnd <= trainEnd || range.endExclusive <= validationEnd) {
    return null;
  }

  return {
    split,
    train: { start: range.start, endExclusive: trainEnd },
    validation: { start: trainEnd, endExclusive: validationEnd },
    outOfSample: { start: validationEnd, endExclusive: range.endExclusive },
  };
}

function serializeWalkForwardRanges(walkForwardRanges) {
  if (!walkForwardRanges) return null;
  return {
    split: walkForwardRanges.split || DEFAULT_WALK_FORWARD_SPLIT,
    train: summarizeWindow(walkForwardRanges.train),
    validation: summarizeWindow(walkForwardRanges.validation),
    outOfSample: summarizeWindow(walkForwardRanges.outOfSample),
  };
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

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatNumber(value, digits = 2) {
  const numeric = numberOrNull(value);
  return numeric == null ? '' : numeric.toFixed(digits);
}

function safeText(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '/')
    .trim();
}

function jsonSafe(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, jsonSafe(nested)]));
  }
  return value;
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

function buildSupportedUniverse(strategyRecords, selectedStrategies, selectedSymbols, includeUnassignedSkips) {
  const strategyRecordMap = new Map(strategyRecords.map((strategy) => [strategy.name, strategy]));
  const selectedSymbolSet = new Set(selectedSymbols);
  const assigned = [];
  const assignedKeys = new Set();
  const skipped = [];

  selectedStrategies.forEach((strategy) => {
    const record = strategyRecordMap.get(strategy);
    const symbolSource = Array.isArray(record?.symbols) && record.symbols.length > 0
      ? record.symbols
      : DEFAULT_STRATEGY_SYMBOL_ASSIGNMENTS[strategy] || [];
    const uniqueSymbols = [...new Set(symbolSource)].filter((symbol) => selectedSymbolSet.has(symbol));

    uniqueSymbols.forEach((symbol) => {
      const key = `${strategy}:${symbol}`;
      assignedKeys.add(key);
      assigned.push({
        strategy,
        symbol,
        assignmentSource: record ? 'strategy_db' : 'default_assignments',
      });
    });
  });

  if (includeUnassignedSkips) {
    selectedStrategies.forEach((strategy) => {
      selectedSymbols.forEach((symbol) => {
        const key = `${strategy}:${symbol}`;
        if (!assignedKeys.has(key)) {
          skipped.push({
            strategy,
            symbol,
            timeframe: null,
            status: 'SKIPPED',
            reason: 'NOT_ASSIGNED_IN_CURRENT_UNIVERSE',
          });
        }
      });
    });
  }

  return { assigned, skipped };
}

function buildAllUniverse(selectedStrategies, selectedSymbols) {
  const assigned = [];
  selectedStrategies.forEach((strategy) => {
    selectedSymbols.forEach((symbol) => {
      assigned.push({
        strategy,
        symbol,
        assignmentSource: 'all_universe',
      });
    });
  });
  return { assigned, skipped: [] };
}

function comboKey(strategy, symbol) {
  return `${strategy}:${symbol}`;
}

function loadPreviousReport(previousReportPath) {
  if (!previousReportPath || !fs.existsSync(previousReportPath)) {
    return {
      path: previousReportPath || null,
      testedKeys: new Set(),
      skippedKeys: new Set(),
      results: [],
      skipped: [],
      warning: previousReportPath ? `Previous report not found: ${previousReportPath}` : null,
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(previousReportPath, 'utf8'));
    const results = Array.isArray(parsed.results) ? parsed.results : [];
    const skipped = Array.isArray(parsed.skipped) ? parsed.skipped : [];
    return {
      path: previousReportPath,
      testedKeys: new Set(results.map((row) => comboKey(row.strategy, row.symbol))),
      skippedKeys: new Set(skipped.map((row) => comboKey(row.strategy, row.symbol))),
      results,
      skipped,
      warning: null,
    };
  } catch (error) {
    return {
      path: previousReportPath,
      testedKeys: new Set(),
      skippedKeys: new Set(),
      results: [],
      skipped: [],
      warning: `Unable to parse previous report: ${error.message}`,
    };
  }
}

function filterAlreadyTested(universe, previousReport, skipAlreadyTested) {
  if (!skipAlreadyTested || !previousReport || previousReport.testedKeys.size === 0) {
    return {
      assigned: universe.assigned,
      skipped: universe.skipped,
      alreadyTested: [],
    };
  }

  const assigned = [];
  const alreadyTested = [];
  universe.assigned.forEach((combo) => {
    if (previousReport.testedKeys.has(comboKey(combo.strategy, combo.symbol))) {
      alreadyTested.push({
        ...combo,
        status: 'ALREADY_TESTED',
        previousReport: previousReport.path,
      });
      return;
    }
    assigned.push(combo);
  });

  return {
    assigned,
    skipped: universe.skipped,
    alreadyTested,
  };
}

function filterResumed(universe, resumeReport, resumeEnabled) {
  if (!resumeEnabled || !resumeReport || (!resumeReport.results.length && !resumeReport.skipped.length)) {
    return {
      assigned: universe.assigned,
      skipped: universe.skipped,
      resumedResults: [],
      resumedSkipped: [],
    };
  }

  const targetKeys = new Set(universe.assigned.map((combo) => comboKey(combo.strategy, combo.symbol)));
  const resumedResults = resumeReport.results.filter((row) => targetKeys.has(comboKey(row.strategy, row.symbol)));
  const resumedSkipped = resumeReport.skipped.filter((row) => targetKeys.has(comboKey(row.strategy, row.symbol)));
  const resumedKeys = new Set([
    ...resumedResults.map((row) => comboKey(row.strategy, row.symbol)),
    ...resumedSkipped.map((row) => comboKey(row.strategy, row.symbol)),
  ]);

  return {
    assigned: universe.assigned.filter((combo) => !resumedKeys.has(comboKey(combo.strategy, combo.symbol))),
    skipped: universe.skipped,
    resumedResults,
    resumedSkipped,
  };
}

async function buildEffectiveRuntime(strategy, symbol, strategyRecord, activeProfile) {
  const instrument = getInstrument(symbol);
  const storedInstance = await StrategyInstance.findByKey(strategy, symbol);
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

async function fetchCandleBundle({ mt5, symbol, executionConfig, start, endExclusive }) {
  const getCachedCandles = fetchCandleBundle.cache || (fetchCandleBundle.cache = buildCandleCache(mt5));
  const timeframe = executionConfig.timeframe || '1h';
  const fetchStart = getWarmupStart(start, timeframe, DEFAULT_WARMUP_BARS);
  const candleLimit = estimateFetchLimit(timeframe, fetchStart, endExclusive);

  const primaryRaw = await getCachedCandles(symbol, timeframe, fetchStart, candleLimit, endExclusive);
  const primaryCandles = filterCandlesByRange(primaryRaw, fetchStart, endExclusive);
  const inRangeCandles = filterCandlesByRange(primaryRaw, start, endExclusive);

  let higherTfCandles = null;
  if (executionConfig.higherTimeframe) {
    const higherStart = getWarmupStart(start, executionConfig.higherTimeframe, DEFAULT_WARMUP_BARS);
    const higherLimit = estimateFetchLimit(executionConfig.higherTimeframe, higherStart, endExclusive);
    const higherRaw = await getCachedCandles(symbol, executionConfig.higherTimeframe, higherStart, higherLimit, endExclusive);
    higherTfCandles = filterCandlesByRange(higherRaw, higherStart, endExclusive);
  }

  let lowerTfCandles = null;
  if (executionConfig.entryTimeframe) {
    const lowerStart = getWarmupStart(start, executionConfig.entryTimeframe, DEFAULT_WARMUP_BARS);
    const lowerLimit = estimateFetchLimit(executionConfig.entryTimeframe, lowerStart, endExclusive);
    const lowerRaw = await getCachedCandles(symbol, executionConfig.entryTimeframe, lowerStart, lowerLimit, endExclusive);
    lowerTfCandles = filterCandlesByRange(lowerRaw, lowerStart, endExclusive);
  }

  const effectiveStart = inRangeCandles[0] ? new Date(inRangeCandles[0].time) : start;
  const effectiveEnd = inRangeCandles[inRangeCandles.length - 1]
    ? new Date(inRangeCandles[inRangeCandles.length - 1].time)
    : new Date(endExclusive.getTime() - 1);

  return {
    timeframe,
    candles: primaryCandles,
    inRangeCandles,
    higherTfCandles,
    lowerTfCandles,
    effectiveStart,
    effectiveEnd,
    fetchMeta: {
      primaryRawCount: Array.isArray(primaryRaw) ? primaryRaw.length : 0,
      primaryWithWarmup: primaryCandles.length,
      primaryInRange: inRangeCandles.length,
      higherCount: higherTfCandles ? higherTfCandles.length : 0,
      lowerCount: lowerTfCandles ? lowerTfCandles.length : 0,
    },
  };
}

function buildWalkForwardInsufficientSummary(reason) {
  return {
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRate: 0,
    profitFactor: 0,
    expectancyPerTrade: 0,
    netProfitMoney: 0,
    returnPercent: 0,
    maxDrawdownPercent: 0,
    maxConsecutiveLosses: 0,
    robustScore: 0,
    profitConcentrationTop1: 0,
    warningFlags: ['VERY_SMALL_SAMPLE', 'WALK_FORWARD_INSUFFICIENT_DATA'],
    walkForwardSkipped: true,
    walkForwardSkipReason: reason,
  };
}

async function simulateFixedParamsForSegment({
  row,
  segmentName,
  segmentRange,
  config,
  strategyRecordsByName,
  activeProfile,
  mt5,
}) {
  const executionConfig = config.forcedTimeframe
    ? getForcedTimeframeExecutionConfig(row.symbol, row.strategy, config.forcedTimeframe)
    : getStrategyExecutionConfig(row.symbol, row.strategy);
  const candleBundle = await fetchCandleBundle({
    mt5,
    symbol: row.symbol,
    executionConfig,
    start: segmentRange.start,
    endExclusive: segmentRange.endExclusive,
  });

  const minimumInRangeCandles = Math.max(10, Math.min(50, Math.floor((config.minimumTrades || 30) / 2)));
  if (
    candleBundle.candles.length < DEFAULT_WARMUP_BARS + 2
    || candleBundle.inRangeCandles.length < minimumInRangeCandles
  ) {
    const reason = `INSUFFICIENT_${segmentName.toUpperCase()}_CANDLES inRange=${candleBundle.inRangeCandles.length} warmup=${candleBundle.candles.length}`;
    return {
      segmentName,
      skipped: true,
      reason,
      window: summarizeWindow(segmentRange),
      fetchMeta: candleBundle.fetchMeta,
      summary: buildWalkForwardInsufficientSummary(reason),
    };
  }

  const runtime = await buildEffectiveRuntime(
    row.strategy,
    row.symbol,
    strategyRecordsByName.get(row.strategy),
    activeProfile
  );
  const simulation = await backtestEngine.simulate({
    symbol: row.symbol,
    strategyType: row.strategy,
    timeframe: candleBundle.timeframe,
    candles: candleBundle.candles,
    higherTfCandles: candleBundle.higherTfCandles,
    lowerTfCandles: candleBundle.lowerTfCandles,
    initialBalance: config.initialBalance,
    costModel: row.costModelUsed || buildCostModel(getInstrument(row.symbol), config.costPreset).costModel,
    tradeStartTime: candleBundle.effectiveStart.toISOString(),
    tradeEndTime: candleBundle.effectiveEnd.toISOString(),
    storedStrategyParameters: runtime.storedParameters,
    breakevenConfig: runtime.breakevenConfig,
    executionPolicy: runtime.executionPolicy,
    strategyParams: row.bestParameters || {},
  });

  return {
    segmentName,
    skipped: false,
    window: summarizeWindow(segmentRange),
    fetchMeta: candleBundle.fetchMeta,
    summary: simulation.summary || {},
  };
}

function classifyResult(row, passType) {
  return classifyOptimizerCandidate(row, {
    passType,
    symbol: row.symbol,
    strategy: row.strategy,
    requireCostStress: false,
  });
}

function applyUpdatedClassification(row, classification, hiddenDiscovery, extraReasons = []) {
  row.selection = classification;
  row.baseBucket = classification.bucket;
  row.bucket = mapBucketForReport(classification.bucket, hiddenDiscovery);
  row.suggestedRiskPerTrade = classification.suggestedRiskPerTrade;
  row.selectionReasons = [
    ...new Set([
      ...((classification && classification.reasons) || []),
      ...extraReasons,
    ]),
  ];
  return row;
}

function mapBucketForReport(bucket, hiddenDiscovery) {
  if (!hiddenDiscovery) return bucket;
  if (bucket === 'LIVE_CANDIDATE') return 'HIDDEN_LIVE_CANDIDATE';
  if (bucket === 'PAPER_ONLY') return 'HIDDEN_PAPER_CANDIDATE';
  return bucket;
}

function bucketKeysForReport(hiddenDiscovery) {
  return hiddenDiscovery
    ? ['HIDDEN_LIVE_CANDIDATE', 'HIDDEN_PAPER_CANDIDATE', 'REJECT']
    : ['LIVE_CANDIDATE', 'PAPER_ONLY', 'REJECT'];
}

function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const sa = a.summary || {};
    const sb = b.summary || {};
    const keys = [
      ['robustScore', -1],
      ['returnToDrawdown', -1],
      ['expectancyPerTrade', -1],
      ['profitFactor', -1],
      ['maxDrawdownPercent', 1],
      ['totalTrades', -1],
    ];
    for (const [key, direction] of keys) {
      const av = numberOrNull(sa[key]) ?? (direction === -1 ? -Infinity : Infinity);
      const bv = numberOrNull(sb[key]) ?? (direction === -1 ? -Infinity : Infinity);
      if (av !== bv) return direction * (av - bv);
    }
    return `${a.strategy}:${a.symbol}`.localeCompare(`${b.strategy}:${b.symbol}`);
  });
}

function buildIntrabarValidationFlags(row) {
  const summary = row.summary || {};
  const flags = Array.isArray(summary.warningFlags) ? summary.warningFlags : [];
  const totalTrades = numberOrNull(summary.totalTrades) || 0;
  const breakevenTriggeredTrades = numberOrNull(summary.breakevenTriggeredTrades) || 0;
  const breakevenTriggerRate = totalTrades > 0 ? breakevenTriggeredTrades / totalTrades : 0;
  const timeframe = String(row.timeframe || '').toLowerCase();
  const needsValidation = breakevenTriggerRate > 0.3
    || numberOrNull(summary.trailingExitTrades) > 0
    || ['1h', '4h', '1d'].includes(timeframe)
    || flags.includes('AVG_LOSS_GT_AVG_WIN')
    || HIGH_VOLATILITY_SYMBOLS.has(row.symbol);

  const reasons = [];
  if (breakevenTriggerRate > 0.3) reasons.push('breakevenTriggeredTrades / totalTrades > 0.3');
  if (numberOrNull(summary.trailingExitTrades) > 0) reasons.push('trailing exits present');
  if (['1h', '4h', '1d'].includes(timeframe)) reasons.push('strategy uses 1h or higher timeframe');
  if (flags.includes('AVG_LOSS_GT_AVG_WIN')) reasons.push('AVG_LOSS_GT_AVG_WIN');
  if (HIGH_VOLATILITY_SYMBOLS.has(row.symbol)) reasons.push('high volatility symbol');

  return {
    needsIntrabarValidation: needsValidation,
    intrabarValidationFlags: needsValidation ? ['NEEDS_INTRABAR_BE_VALIDATION'] : [],
    intrabarValidationReasons: reasons,
  };
}

function attachIntrabarValidationFlags(row) {
  const flags = buildIntrabarValidationFlags(row);
  row.needsIntrabarValidation = flags.needsIntrabarValidation;
  row.intrabarValidationFlags = flags.intrabarValidationFlags;
  row.intrabarValidationReasons = flags.intrabarValidationReasons;
  return row;
}

function flattenResult(row) {
  const s = row.summary || {};
  const rec = row.recommendation || {};
  const selection = row.selection || {};
  const vfhAudit = row.volumeFlowHybridAudit || {};
  const vfhManagement = vfhAudit.management || {};
  const vfhFilterImpact = vfhAudit.filterImpact || {};
  return {
    bucket: row.bucket,
    baseBucket: row.baseBucket || row.bucket,
    passType: row.passType,
    strategy: row.strategy,
    symbol: row.symbol,
    timeframe: row.timeframe,
    optimizeFor: row.optimizeFor,
    minimumTrades: row.minimumTrades,
    totalTrades: s.totalTrades ?? null,
    winRate: s.winRate ?? null,
    profitFactor: s.profitFactor ?? null,
    returnPercent: s.returnPercent ?? null,
    netProfitMoney: s.netProfitMoney ?? null,
    maxDrawdownPercent: s.maxDrawdownPercent ?? null,
    sharpeRatio: s.sharpeRatio ?? null,
    robustScore: s.robustScore ?? null,
    sampleQuality: s.sampleQuality ?? null,
    warningFlags: Array.isArray(s.warningFlags) ? s.warningFlags.join(';') : '',
    expectancyPerTrade: s.expectancyPerTrade ?? null,
    returnToDrawdown: s.returnToDrawdown ?? null,
    avgRealizedR: s.avgRealizedR ?? null,
    medianRealizedR: s.medianRealizedR ?? null,
    profitConcentrationTop1: s.profitConcentrationTop1 ?? null,
    maxConsecutiveLosses: s.maxConsecutiveLosses ?? null,
    recommendationTier: rec.tier || null,
    selectionTier: selection.bucket || row.baseBucket || row.bucket,
    recommendationReasons: Array.isArray(rec.reasons) ? rec.reasons.join('; ') : '',
    riskNotes: Array.isArray(rec.riskNotes) ? rec.riskNotes.join('; ') : '',
    suggestedRiskPerTrade: row.suggestedRiskPerTrade ?? rec.suggestedRiskPerTrade ?? null,
    selectionReasons: Array.isArray(row.selectionReasons) ? row.selectionReasons.join('; ') : '',
    costRobust: row.costRobust ?? null,
    costStressPassed: row.costStressResult?.passed ?? null,
    costStressFailedScenarios: Array.isArray(row.costStressResult?.failedScenarios) ? row.costStressResult.failedScenarios.join(';') : '',
    walkForwardStatus: row.walkForwardStatus || '',
    overfittingRisk: row.walkForwardAssessment?.overfittingRisk || '',
    walkForwardFinalBucket: row.walkForwardAssessment?.finalBucket || '',
    validationDegradationPercent: row.walkForwardAssessment?.validationDegradationPercent ?? '',
    outOfSampleDegradationPercent: row.walkForwardAssessment?.outOfSampleDegradationPercent ?? '',
    trainTrades: row.walkForwardAssessment?.trainMetrics?.totalTrades ?? '',
    validationTrades: row.walkForwardAssessment?.validationMetrics?.totalTrades ?? '',
    outOfSampleTrades: row.walkForwardAssessment?.outOfSampleMetrics?.totalTrades ?? '',
    trainProfitFactor: row.walkForwardAssessment?.trainMetrics?.profitFactor ?? '',
    validationProfitFactor: row.walkForwardAssessment?.validationMetrics?.profitFactor ?? '',
    outOfSampleProfitFactor: row.walkForwardAssessment?.outOfSampleMetrics?.profitFactor ?? '',
    trainNetProfitMoney: row.walkForwardAssessment?.trainMetrics?.netProfitMoney ?? '',
    validationNetProfitMoney: row.walkForwardAssessment?.validationMetrics?.netProfitMoney ?? '',
    outOfSampleNetProfitMoney: row.walkForwardAssessment?.outOfSampleMetrics?.netProfitMoney ?? '',
    needsIntrabarValidation: row.needsIntrabarValidation ?? null,
    intrabarValidationReasons: Array.isArray(row.intrabarValidationReasons) ? row.intrabarValidationReasons.join('; ') : '',
    directionControlNotes: Array.isArray(row.directionControlAuditNotes) ? row.directionControlAuditNotes.join('; ') : '',
    volumeFlowHybridAuditNotes: Array.isArray(vfhAudit.notes) ? vfhAudit.notes.join('; ') : '',
    vfhBreakoutTrades: vfhAudit.moduleBreakout?.totalTrades ?? '',
    vfhBreakoutProfitFactor: vfhAudit.moduleBreakout?.profitFactor ?? '',
    vfhReversalTrades: vfhAudit.moduleReversal?.totalTrades ?? '',
    vfhReversalProfitFactor: vfhAudit.moduleReversal?.profitFactor ?? '',
    vfhSessionFilteredSignals: countFilterImpactSignals(vfhFilterImpact, 'session') || '',
    vfhNewsFilteredSignals: countFilterImpactSignals(vfhFilterImpact, 'news') || '',
    vfhSpreadFilteredSignals: countFilterImpactSignals(vfhFilterImpact, 'spread') || '',
    vfhBreakevenExitTrades: vfhManagement.breakevenExitTrades ?? '',
    vfhTrailingExitTrades: vfhManagement.trailingExitTrades ?? '',
    vfhPartialCloseTrades: vfhManagement.partialCloseTrades ?? '',
    vfhMaxHoldingExitTrades: vfhManagement.maxHoldingExitTrades ?? '',
    vfhDirectionControlTriggeredTrades: vfhManagement.directionControlTriggeredTrades ?? '',
    vfhDirectionControlTpRateAfterTrigger: vfhManagement.directionControlTpRateAfterTrigger ?? '',
    vfhDirectionControlSlRateAfterTrigger: vfhManagement.directionControlSlRateAfterTrigger ?? '',
    vfhIntrabarOptimisticBiasRisk: vfhAudit.intrabarOptimisticBiasRisk ?? '',
    costModel: JSON.stringify(row.costModelUsed || null),
    costModelSource: row.costModelSource || '',
    bestParameters: JSON.stringify(row.bestParameters || {}),
  };
}

function toCsv(rows) {
  const flattened = rows.map(flattenResult);
  const headers = Object.keys(flattened[0] || {
    bucket: '',
    strategy: '',
    symbol: '',
  });
  const escape = (value) => {
    const text = String(value ?? '');
    if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  };
  return [
    headers.join(','),
    ...flattened.map((row) => headers.map((header) => escape(row[header])).join(',')),
  ].join('\n');
}

function markdownTable(rows) {
  if (!rows.length) return '_None_\n';
  const headers = ['strategy', 'symbol', 'timeframe', 'robustScore', 'PF', 'return', 'maxDD', 'trades', 'expectancy', 'warnings', 'cost', 'suggestedRisk', 'reason'];
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];
  rows.forEach((row) => {
    const s = row.summary || {};
    const rec = row.recommendation || {};
    const cells = [
      row.strategy,
      row.symbol,
      row.timeframe,
      formatNumber(s.robustScore, 1),
      formatNumber(s.profitFactor, 2),
      s.returnPercent == null ? '' : `${formatNumber(s.returnPercent, 2)}%`,
      s.maxDrawdownPercent == null ? '' : `${formatNumber(s.maxDrawdownPercent, 2)}%`,
      s.totalTrades ?? '',
      formatNumber(s.expectancyPerTrade, 2),
      Array.isArray(s.warningFlags) ? s.warningFlags.join(', ') : '',
      row.costRobust === true ? 'PASS' : row.costRobust === false ? 'FAIL' : '',
      (row.suggestedRiskPerTrade ?? rec.suggestedRiskPerTrade) == null ? '' : formatNumber(row.suggestedRiskPerTrade ?? rec.suggestedRiskPerTrade, 4),
      safeText((row.selectionReasons || rec.reasons || []).join('; ')),
    ].map(safeText);
    lines.push(`| ${cells.join(' | ')} |`);
  });
  return `${lines.join('\n')}\n`;
}

function walkForwardMarkdown(rows) {
  const testedRows = rows.filter((row) => row.walkForwardAssessment);
  if (!testedRows.length) return '_None_\n';
  const lines = [
    '| strategy | symbol | status | train PF/net/trades | validation PF/net/trades | OOS PF/net/trades | OOS degradation | risk | finalBucket |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  testedRows.forEach((row) => {
    const assessment = row.walkForwardAssessment || {};
    const train = assessment.trainMetrics || {};
    const validation = assessment.validationMetrics || {};
    const outOfSample = assessment.outOfSampleMetrics || {};
    const cells = [
      row.strategy,
      row.symbol,
      row.walkForwardStatus || '',
      `${formatNumber(train.profitFactor, 2)}/${formatNumber(train.netProfitMoney, 2)}/${train.totalTrades ?? ''}`,
      `${formatNumber(validation.profitFactor, 2)}/${formatNumber(validation.netProfitMoney, 2)}/${validation.totalTrades ?? ''}`,
      `${formatNumber(outOfSample.profitFactor, 2)}/${formatNumber(outOfSample.netProfitMoney, 2)}/${outOfSample.totalTrades ?? ''}`,
      assessment.outOfSampleDegradationPercent == null ? '' : `${formatNumber(assessment.outOfSampleDegradationPercent, 1)}%`,
      assessment.overfittingRisk || '',
      assessment.finalBucket || '',
    ].map(safeText);
    lines.push(`| ${cells.join(' | ')} |`);
  });
  return `${lines.join('\n')}\n`;
}

function skippedTable(rows) {
  if (!rows.length) return '_None_\n';
  const lines = [
    '| strategy | symbol | reason |',
    '| --- | --- | --- |',
  ];
  rows.forEach((row) => {
    lines.push(`| ${safeText(row.strategy)} | ${safeText(row.symbol)} | ${safeText(row.reason || row.error || '')} |`);
  });
  return `${lines.join('\n')}\n`;
}

function getDirectionControlSummary(row = {}) {
  return row.summary?.directionControl
    || row.directionControlSummary
    || row.sharedSummary?.directionControl
    || row.portfolioSummary?.directionControl
    || null;
}

function buildDirectionControlAuditNotes(row = {}) {
  const summary = getDirectionControlSummary(row);
  if (!summary) {
    return ['Direction Control audit data not present for this optimizer result.'];
  }
  return [
    `Direction Control audit: triggeredTrades=${summary.triggeredTrades ?? 0}/${summary.totalTrades ?? row.summary?.totalTrades ?? 'unknown'}`,
    `netHypotheticalImpactR=${summary.netHypotheticalImpactR ?? summary.hypotheticalExitAtFirstTriggerImpactR ?? 'n/a'}`,
    'Direction Control remains audit-only; no SL/close/partial action is enabled by this report.',
  ];
}

function countFilterImpactSignals(filterImpact = {}, category) {
  return Number(filterImpact?.[category]?.totalSignals) || 0;
}

function getVfhModuleStats(breakdown = {}, moduleName) {
  return breakdown?.module?.[moduleName] || {};
}

function buildVolumeFlowHybridAudit(row = {}) {
  if (row.strategy !== STRATEGY_TYPES.VOLUME_FLOW_HYBRID) {
    return null;
  }

  const breakdown = row.volumeFlowHybridBreakdown || {};
  const management = breakdown.management || {};
  const filterImpact = breakdown.filterImpact || {};
  const breakout = getVfhModuleStats(breakdown, 'BREAKOUT_CONTINUATION');
  const reversal = getVfhModuleStats(breakdown, 'EXHAUSTION_REVERSAL');
  const timeframe = String(row.timeframe || '').toLowerCase();
  const setupTimeframes = new Set();
  if (timeframe) setupTimeframes.add(timeframe);
  Object.values(breakdown.module || {}).forEach((moduleStats) => {
    if (moduleStats?.setupTimeframe) setupTimeframes.add(String(moduleStats.setupTimeframe).toLowerCase());
    if (moduleStats?.entryTimeframe) setupTimeframes.add(String(moduleStats.entryTimeframe).toLowerCase());
  });

  const notes = [
    'VolumeFlowHybrid audit is report-only; it does not change entries, exits, P/L, equity, or runtime state.',
  ];
  const hasFineTimeframeBias = timeframe === '5m'
    || timeframe === '1m'
    || setupTimeframes.has('5m')
    || setupTimeframes.has('1m');
  if (hasFineTimeframeBias) {
    notes.push('Uses 5m/1m replay assumptions; require MT5 paper/demo confirmation before live consideration.');
  }
  if (countFilterImpactSignals(filterImpact, 'session') > 0) {
    notes.push(`Session filter blocked ${countFilterImpactSignals(filterImpact, 'session')} setup(s).`);
  }
  if (countFilterImpactSignals(filterImpact, 'news') > 0) {
    notes.push(`News filter blocked ${countFilterImpactSignals(filterImpact, 'news')} setup(s).`);
  }
  if (countFilterImpactSignals(filterImpact, 'spread') > 0) {
    notes.push(`Spread filter blocked ${countFilterImpactSignals(filterImpact, 'spread')} setup(s).`);
  }
  if (management.configuredPartialPlanTrades > 0 && management.partialCloseTrades === 0) {
    notes.push('Partial close plan exists but no executed partial event was observed in this backtest result.');
  }
  if (management.configuredTimeExitTrades > 0 && management.maxHoldingExitTrades === 0) {
    notes.push('Max-holding time plan exists but no max-hold exit was observed in this backtest result.');
  }
  if (management.bePostExitTpReachStatus === 'requires_post_exit_candle_capture') {
    notes.push('BE-after-exit TP reach requires post-exit candle capture; this optimizer report does not infer it from closed-trade P/L.');
  }
  if (management.directionControlTriggeredTrades > 0) {
    notes.push(`Direction Control triggered ${management.directionControlTriggeredTrades} VFH trade(s): TP rate ${management.directionControlTpRateAfterTrigger}, SL rate ${management.directionControlSlRateAfterTrigger}.`);
  }

  return {
    moduleBreakout: breakout,
    moduleReversal: reversal,
    filterImpact,
    management,
    intrabarOptimisticBiasRisk: hasFineTimeframeBias,
    notes,
  };
}

function volumeFlowHybridMarkdown(rows) {
  const auditedRows = rows.filter((row) => row.volumeFlowHybridAudit);
  if (!auditedRows.length) return '_None_\n';
  const lines = [
    '| strategy | symbol | breakout trades/PF | reversal trades/PF | session/news/spread filtered | BE/trailing/partial/maxHold | DC TP/SL after trigger | notes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  auditedRows.forEach((row) => {
    const audit = row.volumeFlowHybridAudit || {};
    const management = audit.management || {};
    const cells = [
      row.strategy,
      row.symbol,
      `${audit.moduleBreakout?.totalTrades ?? 0}/${formatNumber(audit.moduleBreakout?.profitFactor, 2)}`,
      `${audit.moduleReversal?.totalTrades ?? 0}/${formatNumber(audit.moduleReversal?.profitFactor, 2)}`,
      `${countFilterImpactSignals(audit.filterImpact, 'session')}/${countFilterImpactSignals(audit.filterImpact, 'news')}/${countFilterImpactSignals(audit.filterImpact, 'spread')}`,
      `${management.breakevenExitTrades ?? 0}/${management.trailingExitTrades ?? 0}/${management.partialCloseTrades ?? 0}/${management.maxHoldingExitTrades ?? 0}`,
      `${management.directionControlThenHitTp ?? 0}/${management.directionControlThenHitSl ?? 0}`,
      Array.isArray(audit.notes) ? audit.notes.join('; ') : '',
    ].map(safeText);
    lines.push(`| ${cells.join(' | ')} |`);
  });
  return `${lines.join('\n')}\n`;
}

function notesList(rows, extractor) {
  const notes = [];
  rows.forEach((row) => {
    const extracted = extractor(row);
    if (!extracted) return;
    const values = Array.isArray(extracted) ? extracted : [extracted];
    values.filter(Boolean).forEach((note) => {
      notes.push(`- ${safeText(row.strategy)} ${safeText(row.symbol)}: ${safeText(note)}`);
    });
  });
  return notes.length ? notes.join('\n') : '- None';
}

function buildMarkdownReport(report) {
  const live = sortRows(report.resultsByBucket.LIVE_CANDIDATE || []);
  const paper = sortRows(report.resultsByBucket.PAPER_ONLY || []);
  const reject = sortRows(report.resultsByBucket.REJECT || []);
  const top10 = sortRows(report.results).slice(0, 10);
  const suggestedLive = live.map((row) => ({
    strategy: row.strategy,
    symbol: row.symbol,
    timeframe: row.timeframe,
    suggestedRiskPerTrade: row.suggestedRiskPerTrade ?? row.recommendation?.suggestedRiskPerTrade ?? null,
    reason: (row.selectionReasons || row.recommendation?.reasons || []).join('; '),
  }));
  const suggestedPaper = paper.map((row) => ({
    strategy: row.strategy,
    symbol: row.symbol,
    timeframe: row.timeframe,
    suggestedRiskPerTrade: row.suggestedRiskPerTrade ?? row.recommendation?.suggestedRiskPerTrade ?? null,
    reason: (row.selectionReasons || row.recommendation?.reasons || []).join('; '),
  }));
  const doNotEnable = reject.map((row) => ({
    strategy: row.strategy,
    symbol: row.symbol,
    timeframe: row.timeframe,
    reason: (row.selectionReasons || row.recommendation?.reasons || []).join('; '),
  }));

  return [
    '# Optimizer Strategy Selection Report',
    '',
    '> Safety: LIVE_CANDIDATE does not mean guaranteed profit. This report is read-only, does not auto-enable live, and every candidate must pass paper/demo observation before any small-risk live decision.',
    '',
    '## Run Config',
    `- date/time: ${report.runConfig.generatedAt}`,
    `- optimizeFor: ${report.runConfig.optimizeFor}`,
    `- minimumTrades: ${report.runConfig.minimumTrades}`,
    `- secondaryPass: ${report.runConfig.secondaryPass}`,
    `- costModel default: \`${JSON.stringify(report.runConfig.defaultCostModel)}\``,
    `- strategies tested: ${report.runConfig.strategies.join(', ')}`,
    `- symbols tested: ${report.runConfig.symbols.join(', ')}`,
    `- date range used: ${report.runConfig.from} to ${report.runConfig.to}`,
    `- walkForward: ${report.runConfig.walkForward === true ? 'true' : 'false'}`,
    `- optimizationWindowMode: ${report.runConfig.optimizationWindowMode || 'full_range'}`,
    `- readOnly: ${report.runConfig.readOnly === false ? 'false' : 'true'}`,
    `- mutates live/paper runtime: ${report.runConfig.mutatesRuntimeState === true ? 'YES' : 'NO'}`,
    '',
    '## Executive Summary',
    `- combinations scheduled: ${report.summary.totalScheduled}`,
    `- optimizer success: ${report.summary.successCount}`,
    `- skipped: ${report.summary.skippedCount}`,
    `- LIVE_CANDIDATE: ${live.length}`,
    `- PAPER_ONLY / WATCHLIST: ${paper.length}`,
    `- REJECT / DO_NOT_ENABLE: ${reject.length}`,
    `- main warnings: ${report.summary.mainWarnings.length ? report.summary.mainWarnings.join('; ') : 'None'}`,
    '',
    '## LIVE_CANDIDATE',
    markdownTable(live),
    '## PAPER_ONLY / WATCHLIST',
    markdownTable(paper),
    '## REJECT / DO_NOT_ENABLE',
    markdownTable(reject),
    '## SKIPPED',
    skippedTable(report.skipped),
    '## Top 10 Overall',
    markdownTable(top10),
    '## Cost Sensitivity Notes',
    report.costSensitivityNotes.length
      ? report.costSensitivityNotes.map((note) => `- ${safeText(note)}`).join('\n')
      : '- None',
    '',
    '## Walk-Forward / OOS Validation',
    walkForwardMarkdown(report.results),
    '',
    '## Overfitting Risk Notes',
    notesList(report.results, (row) => row.walkForwardAssessment
      ? `overfittingRisk=${row.walkForwardAssessment.overfittingRisk}; finalBucket=${row.walkForwardAssessment.finalBucket}`
      : null),
    '',
    '## Direction Control Audit Notes',
    notesList([...live, ...paper], buildDirectionControlAuditNotes),
    '',
    '## VolumeFlowHybrid Audit Notes',
    volumeFlowHybridMarkdown(report.results),
    '',
    '## Suggested Live Candidate List',
    '```json',
    JSON.stringify(suggestedLive, null, 2),
    '```',
    '',
    '## Suggested Paper Enable List',
    '```json',
    JSON.stringify(suggestedPaper, null, 2),
    '```',
    '',
    '## Do Not Enable Yet',
    '```json',
    JSON.stringify(doNotEnable, null, 2),
    '```',
    '',
  ].join('\n');
}

function alreadyTestedTable(rows) {
  if (!rows.length) return '_None_\n';
  const lines = [
    '| strategy | symbol | status |',
    '| --- | --- | --- |',
  ];
  rows.forEach((row) => {
    lines.push(`| ${safeText(row.strategy)} | ${safeText(row.symbol)} | ${safeText(row.status || 'ALREADY_TESTED')} |`);
  });
  return `${lines.join('\n')}\n`;
}

function costSensitivityMarkdown(rows) {
  const testedRows = rows.filter((row) => Array.isArray(row.costSensitivityQuickTest));
  if (!testedRows.length) return '_None_\n';
  const lines = [
    '| strategy | symbol | costRobust | scenario | PF | return | robustScore | maxDD | tier |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  testedRows.forEach((row) => {
    row.costSensitivityQuickTest.forEach((scenario) => {
      lines.push([
        row.strategy,
        row.symbol,
        row.costRobust ? 'YES' : 'NO',
        scenario.name,
        formatNumber(scenario.profitFactor, 2),
        scenario.returnPercent == null ? '' : `${formatNumber(scenario.returnPercent, 2)}%`,
        formatNumber(scenario.robustScore, 1),
        scenario.maxDrawdownPercent == null ? '' : `${formatNumber(scenario.maxDrawdownPercent, 2)}%`,
        scenario.recommendationTier || '',
      ].map(safeText).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
    });
  });
  return `${lines.join('\n')}\n`;
}

function buildHiddenMarkdownReport(report) {
  const live = sortRows(report.resultsByBucket.HIDDEN_LIVE_CANDIDATE || []);
  const paper = sortRows(report.resultsByBucket.HIDDEN_PAPER_CANDIDATE || []);
  const reject = sortRows(report.resultsByBucket.REJECT || []);
  const top20 = sortRows(report.results).slice(0, 20);
  const suggestedNewPaper = [...live, ...paper].map((row) => ({
    strategy: row.strategy,
    symbol: row.symbol,
    timeframe: row.timeframe,
    suggestedRiskPerTrade: row.suggestedRiskPerTrade ?? row.recommendation?.suggestedRiskPerTrade ?? null,
    reason: (row.selectionReasons || row.recommendation?.reasons || []).join('; '),
    riskLevel: row.bucket === 'HIDDEN_LIVE_CANDIDATE' && row.costRobust ? 'LOW' : 'MEDIUM',
  }));
  const doNotEnable = reject.map((row) => ({
    strategy: row.strategy,
    symbol: row.symbol,
    timeframe: row.timeframe,
    reason: (row.selectionReasons || row.recommendation?.reasons || []).join('; '),
  }));
  const candidateRows = [...live, ...paper];
  const needsIntrabar = sortRows(candidateRows.filter((row) => row.needsIntrabarValidation));
  const costRobustRows = sortRows(report.results.filter((row) => row.costRobust === true));

  return [
    '# Hidden Optimizer Combo Discovery Report',
    '',
    '> Safety: hidden candidates are research leads only. This report is read-only, does not auto-enable paper/live, and any live consideration must first go through paper/demo observation.',
    '',
    '## Run Config',
    `- date/time: ${report.runConfig.generatedAt}`,
    `- universe: ${report.runConfig.universeMode}`,
    `- optimizeFor: ${report.runConfig.optimizeFor}`,
    `- minimumTrades: ${report.runConfig.minimumTrades}`,
    `- secondaryPass: ${report.runConfig.secondaryPass}`,
    `- secondaryMinimumTrades: ${report.runConfig.secondaryMinimumTrades}`,
    `- parallelWorkers: ${report.runConfig.parallelWorkers}`,
    `- maxComboMs: ${report.runConfig.maxComboMs || 'none'}`,
    `- skipHeavyVolumeFlow: ${report.runConfig.skipHeavyVolumeFlow}`,
    `- costModel default: \`${JSON.stringify(report.runConfig.defaultCostModel)}\``,
    `- strategies tested: ${report.runConfig.strategies.join(', ')}`,
    `- symbols tested: ${report.runConfig.symbols.join(', ')}`,
    `- date range used: ${report.runConfig.from} to ${report.runConfig.to}`,
    `- walkForward: ${report.runConfig.walkForward === true ? 'true' : 'false'}`,
    `- optimizationWindowMode: ${report.runConfig.optimizationWindowMode || 'full_range'}`,
    `- readOnly: ${report.runConfig.readOnly === false ? 'false' : 'true'}`,
    `- mutates live/paper runtime: ${report.runConfig.mutatesRuntimeState === true ? 'YES' : 'NO'}`,
    `- total combinations in universe: ${report.summary.totalUniverseCount}`,
    `- total combinations scheduled: ${report.summary.totalScheduled}`,
    `- remaining combinations run in this invocation: ${report.summary.remainingScheduledCount ?? report.summary.totalScheduled}`,
    `- already tested count: ${report.summary.alreadyTestedCount}`,
    `- resumed result count: ${report.summary.resumedResultCount || 0}`,
    `- resumed skipped count: ${report.summary.resumedSkippedCount || 0}`,
    `- newly tested count: ${report.summary.successCount}`,
    `- skipped count: ${report.summary.skippedCount}`,
    '',
    '## Executive Summary',
    `- hidden live candidates: ${live.length}`,
    `- hidden paper candidates: ${paper.length}`,
    `- reject count: ${reject.length}`,
    `- skipped count: ${report.skipped.length}`,
    `- cost robust hidden candidates: ${costRobustRows.length}`,
    `- needs intrabar validation: ${needsIntrabar.length}`,
    `- main warnings: ${report.summary.mainWarnings.length ? report.summary.mainWarnings.join('; ') : 'None'}`,
    '',
    '## Hidden LIVE_CANDIDATE',
    markdownTable(live),
    '## Hidden PAPER_CANDIDATE',
    markdownTable(paper),
    '## REJECT',
    markdownTable(reject),
    '## SKIPPED',
    skippedTable(report.skipped),
    '## Already Tested',
    alreadyTestedTable(report.alreadyTested || []),
    '## Top 20 Hidden Combos',
    markdownTable(top20),
    '## Cost Sensitivity Quick Test',
    costSensitivityMarkdown(report.results),
    '## Walk-Forward / OOS Validation',
    walkForwardMarkdown(report.results),
    '## Overfitting Risk Notes',
    notesList(report.results, (row) => row.walkForwardAssessment
      ? `overfittingRisk=${row.walkForwardAssessment.overfittingRisk}; finalBucket=${row.walkForwardAssessment.finalBucket}`
      : null),
    '## Direction Control Audit Notes',
    notesList(candidateRows, buildDirectionControlAuditNotes),
    '## VolumeFlowHybrid Audit Notes',
    volumeFlowHybridMarkdown(report.results),
    '## Intrabar BE Quick Flags',
    markdownTable(needsIntrabar),
    '## Suggested New Paper Whitelist Candidates',
    '```json',
    JSON.stringify(suggestedNewPaper, null, 2),
    '```',
    '',
    '## Do Not Enable',
    '```json',
    JSON.stringify(doNotEnable, null, 2),
    '```',
    '',
  ].join('\n');
}

function completeReport(report) {
  const bucketKeys = bucketKeysForReport(report.runConfig.hiddenDiscovery);
  report.resultsByBucket = Object.fromEntries(bucketKeys.map((bucket) => [bucket, []]));
  report.results.forEach((row) => {
    row.directionControlAuditNotes = buildDirectionControlAuditNotes(row);
    row.volumeFlowHybridAudit = buildVolumeFlowHybridAudit(row);
    const bucket = row.bucket || mapBucketForReport(row.baseBucket || 'REJECT', report.runConfig.hiddenDiscovery);
    if (!report.resultsByBucket[bucket]) {
      report.resultsByBucket[bucket] = [];
    }
    report.resultsByBucket[bucket].push(row);
  });
  report.results = sortRows(report.results);
  Object.keys(report.resultsByBucket).forEach((bucket) => {
    report.resultsByBucket[bucket] = sortRows(report.resultsByBucket[bucket]);
  });
  report.summary.skippedCount = report.skipped.length;
  report.summary.alreadyTestedCount = Array.isArray(report.alreadyTested) ? report.alreadyTested.length : 0;
  report.summary.newlyTestedCount = report.summary.successCount;
  report.summary.mainWarnings = [
    report.skipped.length > 0 ? `${report.skipped.length} combinations skipped` : null,
    report.summary.alreadyTestedCount > 0 ? `${report.summary.alreadyTestedCount} combinations already tested in previous report` : null,
    report.costSensitivityNotes.length > 0 ? 'High-cost instruments require sensitivity review' : null,
    report.summary.walkForwardFailedCount > 0 ? `${report.summary.walkForwardFailedCount} walk-forward validations failed` : null,
    report.runConfig.walkForward === true && report.summary.walkForwardValidatedCount === 0 && report.results.length > 0
      ? 'No walk-forward validations completed'
      : null,
    report.runConfig.secondaryPass ? 'Secondary pass results are paper/watchlist only' : null,
    report.previousReport?.warning || null,
    report.summary.fatalError ? `Fatal: ${report.summary.fatalError}` : null,
  ].filter(Boolean);
  const costNotes = new Set(report.costSensitivityNotes || []);
  report.results.forEach((row) => {
    if (row.costStressResult && row.costStressResult.passed === false) {
      costNotes.add(`${row.strategy} ${row.symbol} failed cost stress: ${(row.costStressResult.reasons || []).join('; ')}`);
    }
  });
  report.costSensitivityNotes = [...costNotes];
  return report;
}

function writeReportFiles(report, reportsDir, reportDate) {
  completeReport(report);
  const baseName = report.runConfig.hiddenDiscovery
    ? `optimizer-hidden-combo-discovery-${reportDate}`
    : `optimizer-strategy-selection-${reportDate}`;
  const jsonPath = path.join(reportsDir, `${baseName}.json`);
  const csvPath = path.join(reportsDir, `${baseName}.csv`);
  const mdPath = path.join(reportsDir, `${baseName}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(jsonSafe(report), null, 2));
  fs.writeFileSync(csvPath, toCsv(report.results));
  fs.writeFileSync(mdPath, report.runConfig.hiddenDiscovery
    ? buildHiddenMarkdownReport(report)
    : buildMarkdownReport(report));

  return { jsonPath, csvPath, mdPath };
}

function printConsoleSummary(report, paths) {
  const bucketKeys = bucketKeysForReport(report.runConfig.hiddenDiscovery);
  console.log('\n[OptimizerSelection] Complete');
  console.log(`Scheduled: ${report.summary.totalScheduled}`);
  if (report.summary.remainingScheduledCount !== undefined) {
    console.log(`Remaining run this invocation: ${report.summary.remainingScheduledCount}`);
  }
  console.log(`Success: ${report.summary.successCount}`);
  console.log(`Skipped: ${report.summary.skippedCount}`);
  console.log(`Already tested: ${report.summary.alreadyTestedCount || 0}`);
  bucketKeys.forEach((bucket) => {
    console.log(`${bucket}: ${report.resultsByBucket[bucket]?.length || 0}`);
  });
  console.log(`Markdown: ${paths.mdPath}`);
  console.log(`JSON: ${paths.jsonPath}`);
  console.log(`CSV: ${paths.csvPath}`);
}

async function runOptimizerWithTimeout(params, maxComboMs = 0) {
  const maxMs = Number(maxComboMs);
  if (!Number.isFinite(maxMs) || maxMs <= 0) {
    return optimizerService.run(params);
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    optimizerService.requestStop();
  }, maxMs);

  try {
    const result = await optimizerService.run(params);
    return {
      ...result,
      timedOut: timedOut || (result.stopped && (result.processedCombinations || 0) < (result.totalCombinations || 0)),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runOptimizerForCombination({
  combo,
  config,
  range,
  strategyRecordsByName,
  activeProfile,
  mt5,
}) {
  const { strategy, symbol } = combo;
  const instrument = getInstrument(symbol);
  if (!instrument) {
    return {
      skipped: {
        strategy,
        symbol,
        timeframe: null,
        status: 'SKIPPED',
        reason: 'UNKNOWN_SYMBOL',
      },
    };
  }

  if (!isStrategySupportedForSymbol(strategy, symbol)) {
    return {
      skipped: {
        strategy,
        symbol,
        timeframe: null,
        status: 'SKIPPED',
        reason: 'STRATEGY_NOT_SUPPORTED',
      },
    };
  }

  if (strategy === STRATEGY_TYPES.VOLUME_FLOW_HYBRID && config.skipHeavyVolumeFlow) {
    return {
      skipped: {
        strategy,
        symbol,
        timeframe: getStrategyExecutionConfig(symbol, strategy)?.timeframe || null,
        status: 'SKIPPED',
        reason: 'OPTIMIZER_TIMEOUT',
        note: 'VolumeFlowHybrid all-universe grid is intentionally deferred because 5m+1m replay was too slow for batch discovery.',
      },
    };
  }

  const executionConfig = config.forcedTimeframe
    ? getForcedTimeframeExecutionConfig(symbol, strategy, config.forcedTimeframe)
    : getStrategyExecutionConfig(symbol, strategy);
  if (!executionConfig) {
    return {
      skipped: {
        strategy,
        symbol,
        timeframe: null,
        status: 'SKIPPED',
        reason: 'NO_EXECUTION_CONFIG',
      },
    };
  }

  const ranges = getOptimizerParameterRanges(strategy);
  if (!ranges || Object.keys(ranges).length === 0) {
    return {
      skipped: {
        strategy,
        symbol,
        timeframe: executionConfig.timeframe || null,
        status: 'SKIPPED',
        reason: 'NO_OPTIMIZER_RANGES',
      },
    };
  }

  const walkForwardRanges = config.walkForward
    ? buildWalkForwardRanges(range)
    : null;
  const optimizationRange = walkForwardRanges ? walkForwardRanges.train : range;
  const candleBundle = await fetchCandleBundle({
    mt5,
    symbol,
    executionConfig,
    start: optimizationRange.start,
    endExclusive: optimizationRange.endExclusive,
  });

  if (
    candleBundle.candles.length < DEFAULT_WARMUP_BARS + 2
    || candleBundle.inRangeCandles.length < 50
  ) {
    return {
      skipped: {
        strategy,
        symbol,
        timeframe: candleBundle.timeframe,
        status: 'SKIPPED',
        reason: `INSUFFICIENT_CANDLES inRange=${candleBundle.inRangeCandles.length} warmup=${candleBundle.candles.length}`,
        fetchMeta: candleBundle.fetchMeta,
      },
    };
  }

  const runtime = await buildEffectiveRuntime(
    strategy,
    symbol,
    strategyRecordsByName.get(strategy),
    activeProfile
  );
  const costInfo = buildCostModel(instrument, config.costPreset);
  const baseRunParams = {
    symbol,
    strategyType: strategy,
    timeframe: candleBundle.timeframe,
    candles: candleBundle.candles,
    higherTfCandles: candleBundle.higherTfCandles,
    lowerTfCandles: candleBundle.lowerTfCandles,
    initialBalance: config.initialBalance,
    paramRanges: ranges,
    optimizeFor: config.optimizeFor,
    costModel: costInfo.costModel,
    parallelWorkers: config.parallelWorkers,
    tradeStartTime: candleBundle.effectiveStart.toISOString(),
    tradeEndTime: candleBundle.effectiveEnd.toISOString(),
    storedStrategyParameters: runtime.storedParameters,
    breakevenConfig: runtime.breakevenConfig,
    executionPolicy: runtime.executionPolicy,
  };

  let result = await runOptimizerWithTimeout({
    ...baseRunParams,
    minimumTrades: config.minimumTrades,
  }, config.maxComboMs);
  if (result.stopped || result.timedOut) {
    return {
      skipped: {
        strategy,
        symbol,
        timeframe: candleBundle.timeframe,
        status: 'SKIPPED',
        reason: result.timedOut ? 'OPTIMIZER_TIMEOUT' : 'OPTIMIZER_STOPPED',
        optimizerMeta: {
          totalCombinations: result.totalCombinations,
          processedCombinations: result.processedCombinations,
          validResults: result.validResults,
        },
      },
    };
  }
  let passType = 'primary';
  let minimumTrades = config.minimumTrades;

  if ((!result.bestResult || result.validResults === 0) && config.secondaryPass) {
    result = await runOptimizerWithTimeout({
      ...baseRunParams,
      minimumTrades: config.secondaryMinimumTrades,
    }, config.maxComboMs);
    if (result.stopped || result.timedOut) {
      return {
        skipped: {
          strategy,
          symbol,
          timeframe: candleBundle.timeframe,
          status: 'SKIPPED',
          reason: result.timedOut ? 'OPTIMIZER_TIMEOUT' : 'OPTIMIZER_STOPPED',
          optimizerMeta: {
            totalCombinations: result.totalCombinations,
            processedCombinations: result.processedCombinations,
            validResults: result.validResults,
          },
        },
      };
    }
    passType = 'secondary';
    minimumTrades = config.secondaryMinimumTrades;
  }

  if (!result.bestResult) {
    return {
      skipped: {
        strategy,
        symbol,
        timeframe: candleBundle.timeframe,
        status: 'SKIPPED',
        reason: passType === 'secondary'
          ? 'NO_VALID_RESULTS_AFTER_SECONDARY_PASS'
          : 'NO_VALID_RESULTS',
        fetchMeta: candleBundle.fetchMeta,
        costModelUsed: costInfo.costModel,
      },
    };
  }

  const best = result.bestResult;
  const classification = classifyResult(best, passType);
  const summary = best.summary || {};
  const warningFlags = Array.isArray(summary.warningFlags) ? summary.warningFlags : [];
  const costTags = costInfo.tags || [];
  const reportBucket = mapBucketForReport(classification.bucket, config.hiddenDiscovery);
  const selectionReasons = [
    ...classification.reasons,
    ...costTags,
  ];

  if (numberOrNull(summary.profitFactor) > 2 && warningFlags.length > 0) {
    selectionReasons.push(`PF high but not recommended because warningFlags=${warningFlags.join(',')}.`);
  }

  return {
    result: attachIntrabarValidationFlags({
      bucket: reportBucket,
      baseBucket: classification.bucket,
      passType,
      strategy,
      symbol,
      timeframe: candleBundle.timeframe,
      assignmentSource: combo.assignmentSource,
      optimizeFor: config.optimizeFor,
      minimumTrades,
      bestParameters: best.parameters || {},
      summary,
      selection: classification,
      recommendation: best.recommendation || null,
      suggestedRiskPerTrade: classification.suggestedRiskPerTrade,
      selectionReasons,
      riskNotes: best.recommendation?.riskNotes || [],
      costModelUsed: costInfo.costModel,
      costModelSource: costInfo.source,
      costTags,
      volumeFlowHybridBreakdown: best.volumeFlowHybridBreakdown || null,
      optimizationWindow: walkForwardRanges ? 'train' : 'full_range',
      walkForwardStatus: walkForwardRanges ? 'pending' : 'disabled',
      walkForwardWindows: serializeWalkForwardRanges(walkForwardRanges),
      fetchMeta: candleBundle.fetchMeta,
      optimizerMeta: {
        totalCombinations: result.totalCombinations,
        processedCombinations: result.processedCombinations,
        validResults: result.validResults,
        recommendationSummary: result.recommendationSummary || null,
      },
    }),
  };
}

function buildCostSensitivityTargets(report) {
  const seen = new Set();
  return sortRows(report.results).filter((row) => {
    if ((row.baseBucket || row.bucket) === 'REJECT' || row.bucket === 'REJECT') return false;
    const key = comboKey(row.strategy, row.symbol);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildWalkForwardTargets(report) {
  const seen = new Set();
  return sortRows(report.results).filter((row) => {
    if (row.walkForwardStatus === 'completed') return false;
    if ((row.baseBucket || row.bucket) === 'REJECT' || row.bucket === 'REJECT') return false;
    const key = comboKey(row.strategy, row.symbol);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function runWalkForwardValidation({
  report,
  config,
  range,
  strategyRecordsByName,
  activeProfile,
  mt5,
}) {
  if (report.runConfig.walkForward !== true) {
    return;
  }

  const walkForwardRanges = buildWalkForwardRanges(range);
  if (!walkForwardRanges) {
    report.summary.mainWarnings = [
      ...(report.summary.mainWarnings || []),
      'Walk-forward validation skipped because the date range cannot be split safely.',
    ];
    return;
  }

  const targets = buildWalkForwardTargets(report);
  if (!targets.length) {
    return;
  }

  console.log(`[OptimizerSelection] Running walk-forward/OOS validation for ${targets.length} candidates...`);
  report.summary.walkForwardScheduledCount = targets.length;
  report.summary.walkForwardValidatedCount = report.summary.walkForwardValidatedCount || 0;
  report.summary.walkForwardFailedCount = report.summary.walkForwardFailedCount || 0;

  for (const row of targets) {
    try {
      const validationResult = await simulateFixedParamsForSegment({
        row,
        segmentName: 'validation',
        segmentRange: walkForwardRanges.validation,
        config,
        strategyRecordsByName,
        activeProfile,
        mt5,
      });
      const outOfSampleResult = await simulateFixedParamsForSegment({
        row,
        segmentName: 'outOfSample',
        segmentRange: walkForwardRanges.outOfSample,
        config,
        strategyRecordsByName,
        activeProfile,
        mt5,
      });
      const assessment = assessWalkForwardMetrics({
        trainSummary: row.summary || {},
        validationSummary: validationResult.summary || {},
        outOfSampleSummary: outOfSampleResult.summary || {},
      });

      row.walkForwardStatus = 'completed';
      row.walkForwardValidation = {
        mode: 'train_validation_out_of_sample',
        optimization: 'train_only',
        windows: serializeWalkForwardRanges(walkForwardRanges),
        train: {
          window: summarizeWindow(walkForwardRanges.train),
          summary: row.summary || {},
        },
        validation: validationResult,
        outOfSample: outOfSampleResult,
      };
      row.walkForwardAssessment = assessment;

      const updatedClassification = classifyOptimizerCandidate(row, {
        passType: row.passType,
        symbol: row.symbol,
        strategy: row.strategy,
        requireCostStress: Boolean(row.costStressResult),
        costStressResult: row.costStressResult,
        walkForwardAssessment: assessment,
      });
      applyUpdatedClassification(row, updatedClassification, report.runConfig.hiddenDiscovery, [
        `Walk-forward overfittingRisk=${assessment.overfittingRisk}; finalBucket=${assessment.finalBucket}.`,
      ]);
      report.summary.walkForwardValidatedCount += 1;
      console.log(`[OptimizerSelection] Walk-forward ${row.strategy} ${row.symbol}: ${assessment.overfittingRisk}/${assessment.finalBucket}`);
    } catch (error) {
      const failedAssessment = {
        trainMetrics: row.summary || {},
        validationMetrics: {},
        outOfSampleMetrics: {},
        validationDegradationPercent: null,
        outOfSampleDegradationPercent: null,
        profitFactorDegradationPercent: null,
        overfittingRisk: 'UNKNOWN',
        finalBucket: CANDIDATE_BUCKETS.PAPER_ONLY,
        reasons: [`Walk-forward/OOS validation failed: ${error.message}`],
      };
      row.walkForwardStatus = 'failed';
      row.walkForwardError = error.message;
      row.walkForwardAssessment = failedAssessment;
      const failedClassification = classifyOptimizerCandidate(row, {
        passType: row.passType,
        symbol: row.symbol,
        strategy: row.strategy,
        requireCostStress: Boolean(row.costStressResult),
        costStressResult: row.costStressResult,
        walkForwardAssessment: failedAssessment,
      });
      applyUpdatedClassification(row, failedClassification, report.runConfig.hiddenDiscovery, failedAssessment.reasons);
      report.summary.walkForwardFailedCount += 1;
      console.warn(`[OptimizerSelection] Walk-forward failed ${row.strategy} ${row.symbol}: ${error.message}`);
    }
  }
}

async function runCostSensitivityQuickTests({
  report,
  config,
  range,
  strategyRecordsByName,
  activeProfile,
  mt5,
}) {
  const targets = buildCostSensitivityTargets(report);
  if (!targets.length) {
    return;
  }

  console.log(`[OptimizerSelection] Running cost sensitivity quick tests for ${targets.length} candidates...`);
  for (const row of targets) {
    try {
      const executionConfig = config.forcedTimeframe
        ? getForcedTimeframeExecutionConfig(row.symbol, row.strategy, config.forcedTimeframe)
        : getStrategyExecutionConfig(row.symbol, row.strategy);
      const candleBundle = await fetchCandleBundle({
        mt5,
        symbol: row.symbol,
        executionConfig,
        start: range.start,
        endExclusive: range.endExclusive,
      });
      const runtime = await buildEffectiveRuntime(
        row.strategy,
        row.symbol,
        strategyRecordsByName.get(row.strategy),
        activeProfile
      );

      const baseCostModel = row.costModelUsed || buildCostModel(getInstrument(row.symbol), config.costPreset).costModel;
      const scenarioResults = [];
      for (const scenario of buildCostStressScenarios(baseCostModel)) {
        const costModel = scenario.costModel;
        const simulation = await backtestEngine.simulate({
          symbol: row.symbol,
          strategyType: row.strategy,
          timeframe: candleBundle.timeframe,
          candles: candleBundle.candles,
          higherTfCandles: candleBundle.higherTfCandles,
          lowerTfCandles: candleBundle.lowerTfCandles,
          initialBalance: config.initialBalance,
          costModel,
          tradeStartTime: candleBundle.effectiveStart.toISOString(),
          tradeEndTime: candleBundle.effectiveEnd.toISOString(),
          storedStrategyParameters: runtime.storedParameters,
          breakevenConfig: runtime.breakevenConfig,
          executionPolicy: runtime.executionPolicy,
          strategyParams: row.bestParameters || {},
        });
        const classified = classifyResult({ summary: simulation.summary }, 'primary');
        scenarioResults.push({
          name: scenario.name,
          costModel,
          summary: simulation.summary || {},
          profitFactor: simulation.summary?.profitFactor ?? null,
          returnPercent: simulation.summary?.returnPercent ?? null,
          expectancyPerTrade: simulation.summary?.expectancyPerTrade ?? null,
          robustScore: simulation.summary?.robustScore ?? null,
          maxDrawdownPercent: simulation.summary?.maxDrawdownPercent ?? null,
          maxConsecutiveLosses: simulation.summary?.maxConsecutiveLosses ?? null,
          recommendationTier: classified.bucket,
          netProfitMoney: simulation.summary?.netProfitMoney ?? null,
        });
      }

      row.costSensitivityQuickTest = scenarioResults;
      row.costStressResult = evaluateCostStressResults(scenarioResults, {
        symbol: row.symbol,
        strategy: row.strategy,
      });
      row.costRobust = row.costStressResult.passed;

      const updatedClassification = classifyOptimizerCandidate(row, {
        passType: row.passType,
        symbol: row.symbol,
        strategy: row.strategy,
        requireCostStress: true,
        costStressResult: row.costStressResult,
      });
      row.selection = updatedClassification;
      row.baseBucket = updatedClassification.bucket;
      row.bucket = mapBucketForReport(updatedClassification.bucket, report.runConfig.hiddenDiscovery);
      row.suggestedRiskPerTrade = updatedClassification.suggestedRiskPerTrade;
      row.selectionReasons = updatedClassification.reasons;

      if (!row.costRobust) {
        row.selectionReasons = [
          ...(row.selectionReasons || []),
          'Cost sensitivity quick test is not robust across all scenarios.',
        ];
      }
      console.log(`[OptimizerSelection] Cost quick test ${row.strategy} ${row.symbol}: ${row.costRobust ? 'YES' : 'NO'}`);
    } catch (error) {
      row.costRobust = false;
      row.costSensitivityError = error.message;
      row.costStressResult = {
        passed: false,
        scenarios: [],
        missingScenarios: buildCostStressScenarios(row.costModelUsed || {}).map((scenario) => scenario.name),
        failedScenarios: [],
        defaultScenarioPassed: false,
        allScenariosNetNegative: false,
        reasons: [`Cost sensitivity quick test failed: ${error.message}`],
      };
      const failedClassification = classifyOptimizerCandidate(row, {
        passType: row.passType,
        symbol: row.symbol,
        strategy: row.strategy,
        requireCostStress: true,
        costStressResult: row.costStressResult,
      });
      row.selection = failedClassification;
      row.baseBucket = failedClassification.bucket;
      row.bucket = mapBucketForReport(failedClassification.bucket, report.runConfig.hiddenDiscovery);
      row.suggestedRiskPerTrade = failedClassification.suggestedRiskPerTrade;
      row.selectionReasons = [
        ...(failedClassification.reasons || row.selectionReasons || []),
        `Cost sensitivity quick test failed: ${error.message}`,
      ];
      console.warn(`[OptimizerSelection] Cost quick test failed ${row.strategy} ${row.symbol}: ${error.message}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const selectedStrategies = csvList(args.strategies) || STRATEGIES;
  const selectedSymbols = csvList(args.symbols) || getAllSymbols();
  const optimizeFor = args.optimizeFor || 'robustScore';
  const minimumTrades = intArg(args.minimumTrades, 30);
  const secondaryPass = boolArg(args.secondaryPass, false);
  const secondaryMinimumTrades = intArg(args.secondaryMinimumTrades, 10);
  const initialBalance = Number(args.initialBalance || 10000);
  const parallelWorkers = intArg(args.parallelWorkers, 2);
  const includeUnassignedSkips = boolArg(args.includeUnassignedSkips, true);
  const costPreset = args.costPreset || 'default';
  const forcedTimeframe = args.timeframe || null;
  const mt5Scope = args.mt5Scope || 'live';
  const universeMode = args.universe || 'assigned';
  const hiddenDiscovery = boolArg(args.hiddenDiscovery, universeMode === 'all');
  const skipAlreadyTested = boolArg(args.skipAlreadyTested, hiddenDiscovery);
  const maxComboMs = intArg(args.maxComboMs, 0);
  const skipHeavyVolumeFlow = boolArg(args.skipHeavyVolumeFlow, false);
  const walkForward = boolArg(args.walkForward, true) && !boolArg(args.skipWalkForward, false);

  if (forcedTimeframe && !isValidForcedTimeframe(forcedTimeframe)) {
    throw new Error(`Invalid --timeframe=${forcedTimeframe}`);
  }
  if (!['assigned', 'all'].includes(universeMode)) {
    throw new Error(`Invalid --universe=${universeMode}; expected assigned or all`);
  }

  const normalizedRange = normalizeDateRange(
    args.from || '2025-01-01',
    args.to || todayString()
  );
  const range = clampDateRangeToNow(normalizedRange.start, normalizedRange.endExclusive);

  const generatedAt = new Date().toISOString();
  const reportDate = todayString();
  const reportsDir = path.resolve(process.cwd(), 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const previousReportPath = args.previousReport
    ? path.resolve(process.cwd(), args.previousReport)
    : path.join(reportsDir, 'optimizer-strategy-selection-2026-05-06.json');
  const previousReport = loadPreviousReport(previousReportPath);
  const resumeReportPath = args.resumeReport
    ? path.resolve(process.cwd(), args.resumeReport)
    : null;
  const resumeReport = resumeReportPath ? loadPreviousReport(resumeReportPath) : null;

  console.log('[OptimizerSelection] Loading read-only strategy universe...');
  const [strategyRecords, activeProfile] = await Promise.all([
    Strategy.findAll().catch(() => []),
    RiskProfile.getActive().catch(() => null),
  ]);
  const strategyRecordsByName = new Map(strategyRecords.map((strategy) => [strategy.name, strategy]));
  const rawUniverse = universeMode === 'all'
    ? buildAllUniverse(selectedStrategies, selectedSymbols)
    : buildSupportedUniverse(
        strategyRecords,
        selectedStrategies,
        selectedSymbols,
        includeUnassignedSkips
      );
  const discoveryUniverse = filterAlreadyTested(rawUniverse, previousReport, skipAlreadyTested);
  const resumeState = filterResumed(discoveryUniverse, resumeReport, Boolean(resumeReportPath));
  const universe = {
    assigned: resumeState.assigned,
    skipped: discoveryUniverse.skipped,
    alreadyTested: discoveryUniverse.alreadyTested,
  };
  const bucketKeys = bucketKeysForReport(hiddenDiscovery);
  const resultsByBucket = Object.fromEntries(bucketKeys.map((bucket) => [bucket, []]));
  resumeState.resumedResults.forEach((row) => {
    const bucket = row.bucket || mapBucketForReport(row.baseBucket || 'REJECT', hiddenDiscovery);
    if (!resultsByBucket[bucket]) {
      resultsByBucket[bucket] = [];
    }
    resultsByBucket[bucket].push(row);
  });

  const report = {
    runConfig: {
      generatedAt,
      from: range.start.toISOString(),
      to: range.endExclusive.toISOString(),
      optimizeFor,
      minimumTrades,
      secondaryPass,
      secondaryMinimumTrades,
      initialBalance,
      parallelWorkers,
      costPreset,
      mt5Scope,
      maxComboMs,
      skipHeavyVolumeFlow,
      walkForward,
      walkForwardSplit: DEFAULT_WALK_FORWARD_SPLIT,
      optimizationWindowMode: walkForward ? 'train_only' : 'full_range',
      defaultCostModel: DEFAULT_COST_MODEL,
      strategies: selectedStrategies,
      symbols: selectedSymbols,
      forcedTimeframe,
      universeMode,
      hiddenDiscovery,
      skipAlreadyTested,
      previousReportPath: previousReport.path,
      resumeReportPath: resumeReport?.path || null,
      readOnly: true,
      mutatesRuntimeState: false,
      mutatesStrategyInstances: false,
      autoEnablesPaper: false,
      autoEnablesLive: false,
    },
    summary: {
      totalUniverseCount: rawUniverse.assigned.length,
      totalScheduled: discoveryUniverse.assigned.length,
      remainingScheduledCount: universe.assigned.length,
      successCount: resumeState.resumedResults.length,
      skippedCount: universe.skipped.length + resumeState.resumedSkipped.length,
      alreadyTestedCount: universe.alreadyTested.length,
      resumedResultCount: resumeState.resumedResults.length,
      resumedSkippedCount: resumeState.resumedSkipped.length,
      newlyTestedCount: 0,
      mainWarnings: [],
    },
    results: [...resumeState.resumedResults],
    resultsByBucket,
    skipped: [...universe.skipped, ...resumeState.resumedSkipped],
    alreadyTested: universe.alreadyTested,
    previousReport: {
      path: previousReport.path,
      resultCount: previousReport.results.length,
      skippedCount: previousReport.skipped.length,
      warning: previousReport.warning,
    },
    resumeReport: resumeReport ? {
      path: resumeReport.path,
      resultCount: resumeReport.results.length,
      skippedCount: resumeReport.skipped.length,
      warning: resumeReport.warning,
    } : null,
    costSensitivityNotes: [],
  };

  const mt5 = typeof mt5Service.getScopedService === 'function'
    ? mt5Service.getScopedService(mt5Scope)
    : mt5Service;

  if (typeof mt5.reloadConnectionEnvFromFile === 'function') {
    mt5.reloadConnectionEnvFromFile();
  }

  console.log('[OptimizerSelection] Connecting to MT5 for candle data...');
  try {
    await mt5.connect();
  } catch (error) {
    universe.assigned.forEach((combo) => {
      report.skipped.push({
        strategy: combo.strategy,
        symbol: combo.symbol,
        timeframe: null,
        status: 'SKIPPED',
        reason: 'MT5_CONNECT_FAILED',
        error: error.message,
      });
    });
    report.summary.fatalError = `MT5_CONNECT_FAILED: ${error.message}`;
    const paths = writeReportFiles(report, reportsDir, reportDate);
    printConsoleSummary(report, paths);
    process.exitCode = 1;
    return;
  }

  let paths = writeReportFiles(report, reportsDir, reportDate);

  try {
    for (let index = 0; index < universe.assigned.length; index++) {
      const combo = universe.assigned[index];
      const prefix = `[${index + 1}/${universe.assigned.length}] ${combo.strategy} ${combo.symbol}`;
      try {
        console.log(`${prefix} optimizing...`);
        const outcome = await runOptimizerForCombination({
          combo,
          config: {
            optimizeFor,
            minimumTrades,
            secondaryPass,
            secondaryMinimumTrades,
            initialBalance,
            parallelWorkers,
            costPreset,
            forcedTimeframe,
            hiddenDiscovery,
            maxComboMs,
            skipHeavyVolumeFlow,
            walkForward,
          },
          range,
          strategyRecordsByName,
          activeProfile,
          mt5,
        });

        if (outcome.skipped) {
          report.skipped.push(outcome.skipped);
          report.summary.skippedCount += 1;
          paths = writeReportFiles(report, reportsDir, reportDate);
          console.log(`${prefix} skipped: ${outcome.skipped.reason}`);
          continue;
        }

        const row = outcome.result;
        report.results.push(row);
        report.resultsByBucket[row.bucket].push(row);
        report.summary.successCount += 1;

        if (row.costTags.includes('HIGH_COST_SENSITIVITY')) {
          report.costSensitivityNotes.push(
            `${row.strategy} ${row.symbol} uses ${row.costModelSource}; review spread/slippage sensitivity before live.`
          );
        }

        paths = writeReportFiles(report, reportsDir, reportDate);

        console.log(
          `${prefix} -> ${row.bucket} robust=${row.summary.robustScore} PF=${row.summary.profitFactor} trades=${row.summary.totalTrades}`
        );
      } catch (error) {
        const skipped = {
          strategy: combo.strategy,
          symbol: combo.symbol,
          timeframe: null,
          status: 'SKIPPED',
          reason: 'OPTIMIZER_ERROR',
          error: error.message,
        };
        report.skipped.push(skipped);
        report.summary.skippedCount += 1;
        paths = writeReportFiles(report, reportsDir, reportDate);
        console.warn(`${prefix} error: ${error.message}`);
      }
    }
    await runWalkForwardValidation({
      report,
      config: {
        initialBalance,
        costPreset,
        forcedTimeframe,
        minimumTrades,
      },
      range,
      strategyRecordsByName,
      activeProfile,
      mt5,
    });
    paths = writeReportFiles(report, reportsDir, reportDate);
    await runCostSensitivityQuickTests({
      report,
      config: {
        initialBalance,
        costPreset,
        forcedTimeframe,
      },
      range,
      strategyRecordsByName,
      activeProfile,
      mt5,
    });
    paths = writeReportFiles(report, reportsDir, reportDate);
  } finally {
    await mt5.disconnect().catch(() => {});
  }
  paths = writeReportFiles(report, reportsDir, reportDate);
  printConsoleSummary(report, paths);
}

main().catch((error) => {
  console.error('[OptimizerSelection] Fatal:', error.message);
  if (error.stack) console.error(error.stack);
  process.exitCode = 1;
});
