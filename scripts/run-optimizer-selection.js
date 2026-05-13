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

const COST_SENSITIVITY_SCENARIOS = [
  { name: 'default', mutate: (costModel) => ({ ...costModel }) },
  { name: 'spread_x1_5', mutate: (costModel) => ({ ...costModel, spreadPips: Number(costModel.spreadPips || 0) * 1.5 }) },
  { name: 'slippage_x2', mutate: (costModel) => ({ ...costModel, slippagePips: Number(costModel.slippagePips || 0) * 2 }) },
  { name: 'commission_x2', mutate: (costModel) => ({ ...costModel, commissionPerLot: Number(costModel.commissionPerLot || 0) * 2 }) },
];

const VOLUME_FLOW_SUPPORTED_SYMBOLS = new Set([
  ...VOLUME_FLOW_HYBRID_DEFAULT_SYMBOLS,
  ...VOLUME_FLOW_HYBRID_OPTIONAL_SYMBOLS,
]);

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

function classifyResult(row, passType) {
  const s = row.summary || {};
  const flags = new Set(Array.isArray(s.warningFlags) ? s.warningFlags : []);
  const reasons = [];

  const liveEligible = numberOrNull(s.robustScore) >= 70
    && numberOrNull(s.totalTrades) >= 50
    && numberOrNull(s.profitFactor) >= 1.3
    && numberOrNull(s.expectancyPerTrade) > 0
    && numberOrNull(s.returnPercent) > 0
    && numberOrNull(s.maxDrawdownPercent) <= 15
    && numberOrNull(s.maxConsecutiveLosses) <= 3
    && numberOrNull(s.profitConcentrationTop1) <= 0.5
    && !flags.has('VERY_SMALL_SAMPLE')
    && !flags.has('LOW_EXPECTANCY')
    && !flags.has('HIGH_DRAWDOWN');

  if (passType === 'secondary') {
    reasons.push('LOW_SAMPLE_SECONDARY_PASS: minimumTrades=10 result is observation-only.');
    const secondaryPaperEligible = numberOrNull(s.netProfitMoney) > 0
      && numberOrNull(s.profitFactor) > 1
      && numberOrNull(s.expectancyPerTrade) > 0
      && numberOrNull(s.robustScore) >= 35;
    if (secondaryPaperEligible) {
      return { bucket: 'PAPER_ONLY', reasons };
    }
    if (numberOrNull(s.robustScore) < 35) reasons.push('secondary pass robustScore is too low.');
    if (numberOrNull(s.expectancyPerTrade) <= 0) reasons.push('secondary pass expectancyPerTrade <= 0.');
    if (numberOrNull(s.netProfitMoney) <= 0) reasons.push('secondary pass netProfitMoney <= 0.');
    if (numberOrNull(s.profitFactor) <= 1) reasons.push('secondary pass profitFactor <= 1.');
    return { bucket: 'REJECT', reasons };
  }

  if (liveEligible) {
    reasons.push('Meets robust live-candidate screening thresholds.');
    return { bucket: 'LIVE_CANDIDATE', reasons };
  }

  const reject = numberOrNull(s.netProfitMoney) <= 0
    || numberOrNull(s.profitFactor) < 1
    || numberOrNull(s.expectancyPerTrade) <= 0
    || numberOrNull(s.robustScore) < 35
    || numberOrNull(s.maxDrawdownPercent) > 25
    || numberOrNull(s.maxConsecutiveLosses) > 6;

  if (reject) {
    if (numberOrNull(s.netProfitMoney) <= 0) reasons.push('netProfitMoney <= 0.');
    if (numberOrNull(s.profitFactor) < 1) reasons.push('profitFactor < 1.');
    if (numberOrNull(s.expectancyPerTrade) <= 0) reasons.push('expectancyPerTrade <= 0.');
    if (numberOrNull(s.robustScore) < 35) reasons.push('robustScore is low.');
    if (numberOrNull(s.maxDrawdownPercent) > 25) reasons.push('maxDrawdownPercent is too high.');
    if (numberOrNull(s.maxConsecutiveLosses) > 6) reasons.push('maxConsecutiveLosses is too high.');
    return { bucket: 'REJECT', reasons };
  }

  if (numberOrNull(s.netProfitMoney) > 0 && numberOrNull(s.profitFactor) > 1) {
    if (numberOrNull(s.totalTrades) < 50) reasons.push('Sample is below live threshold.');
    if (flags.has('PROFIT_CONCENTRATED')) reasons.push('Profit is concentrated.');
    if (flags.has('AVG_LOSS_GT_AVG_WIN')) reasons.push('Average loss is larger than average win.');
    if (numberOrNull(s.maxDrawdownPercent) > 15) reasons.push('Drawdown is above live threshold.');
    if (numberOrNull(s.profitConcentrationTop1) > 0.5) reasons.push('PF high but not recommended because top trade concentration is high.');
    if (reasons.length === 0) reasons.push('Profitable but does not meet every live-candidate threshold.');
    return { bucket: 'PAPER_ONLY', reasons };
  }

  reasons.push('Does not meet live or paper watchlist thresholds.');
  return { bucket: 'REJECT', reasons };
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
  return {
    bucket: row.bucket,
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
    recommendationReasons: Array.isArray(rec.reasons) ? rec.reasons.join('; ') : '',
    riskNotes: Array.isArray(rec.riskNotes) ? rec.riskNotes.join('; ') : '',
    suggestedRiskPerTrade: rec.suggestedRiskPerTrade ?? null,
    selectionReasons: Array.isArray(row.selectionReasons) ? row.selectionReasons.join('; ') : '',
    costRobust: row.costRobust ?? null,
    needsIntrabarValidation: row.needsIntrabarValidation ?? null,
    intrabarValidationReasons: Array.isArray(row.intrabarValidationReasons) ? row.intrabarValidationReasons.join('; ') : '',
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
  const headers = ['strategy', 'symbol', 'timeframe', 'robustScore', 'PF', 'return', 'maxDD', 'trades', 'expectancy', 'warnings', 'suggestedRisk', 'reason'];
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
      rec.suggestedRiskPerTrade == null ? '' : formatNumber(rec.suggestedRiskPerTrade, 4),
      safeText((row.selectionReasons || rec.reasons || []).join('; ')),
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

function buildMarkdownReport(report) {
  const live = sortRows(report.resultsByBucket.LIVE_CANDIDATE || []);
  const paper = sortRows(report.resultsByBucket.PAPER_ONLY || []);
  const reject = sortRows(report.resultsByBucket.REJECT || []);
  const top10 = sortRows(report.results).slice(0, 10);
  const suggestedLive = live.map((row) => ({
    strategy: row.strategy,
    symbol: row.symbol,
    timeframe: row.timeframe,
    suggestedRiskPerTrade: row.recommendation?.suggestedRiskPerTrade ?? null,
    reason: (row.selectionReasons || row.recommendation?.reasons || []).join('; '),
  }));
  const suggestedPaper = paper.map((row) => ({
    strategy: row.strategy,
    symbol: row.symbol,
    timeframe: row.timeframe,
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
    '## Run Config',
    `- date/time: ${report.runConfig.generatedAt}`,
    `- optimizeFor: ${report.runConfig.optimizeFor}`,
    `- minimumTrades: ${report.runConfig.minimumTrades}`,
    `- secondaryPass: ${report.runConfig.secondaryPass}`,
    `- costModel default: \`${JSON.stringify(report.runConfig.defaultCostModel)}\``,
    `- strategies tested: ${report.runConfig.strategies.join(', ')}`,
    `- symbols tested: ${report.runConfig.symbols.join(', ')}`,
    `- date range used: ${report.runConfig.from} to ${report.runConfig.to}`,
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
    '## Suggested Live Enable List',
    '```json',
    JSON.stringify(suggestedLive, null, 2),
    '```',
    '',
    '## Suggested Paper Continue List',
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
    report.runConfig.secondaryPass ? 'Secondary pass results are paper/watchlist only' : null,
    report.previousReport?.warning || null,
    report.summary.fatalError ? `Fatal: ${report.summary.fatalError}` : null,
  ].filter(Boolean);
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

  const candleBundle = await fetchCandleBundle({
    mt5,
    symbol,
    executionConfig,
    start: range.start,
    endExclusive: range.endExclusive,
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
      recommendation: best.recommendation || null,
      selectionReasons,
      riskNotes: best.recommendation?.riskNotes || [],
      costModelUsed: costInfo.costModel,
      costModelSource: costInfo.source,
      costTags,
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
  const live = sortRows(report.resultsByBucket.HIDDEN_LIVE_CANDIDATE || report.resultsByBucket.LIVE_CANDIDATE || []);
  const paper = sortRows(report.resultsByBucket.HIDDEN_PAPER_CANDIDATE || report.resultsByBucket.PAPER_ONLY || []).slice(0, 10);
  const seen = new Set();
  return [...live, ...paper].filter((row) => {
    const key = comboKey(row.strategy, row.symbol);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

  console.log(`[OptimizerSelection] Running cost sensitivity quick tests for ${targets.length} hidden candidates...`);
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
      for (const scenario of COST_SENSITIVITY_SCENARIOS) {
        const costModel = scenario.mutate(baseCostModel);
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
          profitFactor: simulation.summary?.profitFactor ?? null,
          returnPercent: simulation.summary?.returnPercent ?? null,
          robustScore: simulation.summary?.robustScore ?? null,
          maxDrawdownPercent: simulation.summary?.maxDrawdownPercent ?? null,
          recommendationTier: classified.bucket,
          netProfitMoney: simulation.summary?.netProfitMoney ?? null,
        });
      }

      row.costSensitivityQuickTest = scenarioResults;
      row.costRobust = scenarioResults.every((scenario) => {
        return numberOrNull(scenario.netProfitMoney) > 0
          && numberOrNull(scenario.profitFactor) > 1
          && numberOrNull(scenario.robustScore) >= 50
          && scenario.recommendationTier !== 'REJECT';
      });
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
      row.selectionReasons = [
        ...(row.selectionReasons || []),
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
      defaultCostModel: DEFAULT_COST_MODEL,
      strategies: selectedStrategies,
      symbols: selectedSymbols,
      forcedTimeframe,
      universeMode,
      hiddenDiscovery,
      skipAlreadyTested,
      previousReportPath: previousReport.path,
      resumeReportPath: resumeReport?.path || null,
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
