#!/usr/bin/env node

/**
 * Read-only in-sample edge discovery runner.
 *
 * For each ordinary strategy/symbol combo that is not already live-enabled,
 * this script runs the optimizer in four market periods on the strategy's
 * default execution timeframe and explicitly re-simulates the optimizer top
 * ten parameter selections in the same period. Results are a research screen,
 * not permission to apply parameters to live trading.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const mt5RootService = require('../src/services/mt5Service');
const optimizerService = require('../src/services/optimizerService');
const backtestEngine = require('../src/services/backtestEngine');
const notificationService = require('../src/services/notificationService');
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
const { getStrategyExecutionConfig } = require('../src/config/strategyExecution');
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

const PERIODS = Object.freeze([
  { id: '2024_H2', from: '2024-07-01', to: '2025-01-01' },
  { id: '2025_H1', from: '2025-01-01', to: '2025-07-01' },
  { id: '2025_H2', from: '2025-07-01', to: '2026-01-01' },
  { id: '2026_YTD', from: '2026-01-01', to: '2026-05-24' },
]);

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

const SCREEN_GATES = Object.freeze({
  selectedBacktestHardGate: {
    totalTrades: 20,
    returnPercent: 0,
    netProfitMoney: 0,
    profitFactor: 1.25,
    maxDrawdownPercent: 20,
    sharpeRatio: 0.8,
    expectancyPerTrade: 0,
    maxConsecutiveLosses: 5,
    linearEquityRequired: true,
  },
  paperResearchCandidate: {
    completedPeriods: 3,
    linearPassRate: 0.75,
    profitablePeriodRatio: 1,
    worstReturnPercent: 0,
    avgProfitFactor: 1.4,
    avgSharpeRatio: 1,
    avgMaxDrawdownPercent: 15,
    combinedEquityLinearRequired: true,
    profitConcentrationByPeriodTop1: 0.7,
  },
  note: 'Optimizer and selected-parameter backtests use the same period; this is in-sample screening and cannot establish LIVE eligibility.',
});

function parseArgs(argv) {
  const args = {};
  argv.slice(2).forEach((entry) => {
    if (!entry.startsWith('--')) return;
    const [key, ...parts] = entry.slice(2).split('=');
    args[key] = parts.length > 0 ? parts.join('=') : 'true';
  });
  return args;
}

function csvList(value) {
  if (!value) return null;
  const values = String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
  return values.length > 0 ? values : null;
}

function numberArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function intArg(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boolArg(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function round(value, digits = 4) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? parseFloat(numeric.toFixed(digits)) : 0;
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + numeric(value), 0) / values.length : 0;
}

function sanitizeTag(value) {
  return String(value || 'non-live-four-regime-top10').replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function todayString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, nested) => (
    typeof nested === 'number' && !Number.isFinite(nested) ? null : nested
  )));
}

function parseRange(period) {
  const start = new Date(period.from);
  const endExclusive = new Date(period.to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(endExclusive.getTime()) || endExclusive <= start) {
    throw new Error(`Invalid period range ${JSON.stringify(period)}`);
  }
  return { start, endExclusive };
}

function comboKey(combo) {
  return `${combo.strategy}:${combo.symbol}:${combo.timeframe}`;
}

function mergeObjects(baseValue, overrideValue) {
  return {
    ...((baseValue && typeof baseValue === 'object') ? baseValue : {}),
    ...((overrideValue && typeof overrideValue === 'object') ? overrideValue : {}),
  };
}

function isStrategySupportedForSymbol(strategy, symbol) {
  return strategy !== STRATEGY_TYPES.VOLUME_FLOW_HYBRID || VOLUME_FLOW_SUPPORTED_SYMBOLS.has(symbol);
}

function buildCostModel(instrument, costPreset) {
  if (instrument?.costModel && typeof instrument.costModel === 'object') {
    return { costModel: { ...instrument.costModel }, source: 'instrument.costModel' };
  }
  const costModel = { ...DEFAULT_COST_MODEL };
  if (costPreset === 'conservative' || HIGH_COST_CATEGORIES.has(instrument?.category)) {
    costModel.spreadPips = Math.max(costModel.spreadPips, numeric(instrument?.spread));
  }
  return { costModel, source: 'conservative_default_plus_instrument_spread' };
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

function passGate(checks) {
  const reasons = checks.filter(([pass]) => !pass).map(([, reason]) => reason);
  return { pass: reasons.length === 0, reasons };
}

function evaluateSelectedBacktest(summary, quality) {
  const s = summary || {};
  const hard = passGate([
    [numeric(s.totalTrades) >= 20, `totalTrades ${numeric(s.totalTrades)} < 20`],
    [numeric(s.returnPercent) > 0, `returnPercent ${numeric(s.returnPercent)} <= 0`],
    [numeric(s.netProfitMoney) > 0, `netProfitMoney ${numeric(s.netProfitMoney)} <= 0`],
    [numeric(s.profitFactor) >= 1.25, `profitFactor ${numeric(s.profitFactor)} < 1.25`],
    [numeric(s.maxDrawdownPercent) <= 20, `maxDrawdownPercent ${numeric(s.maxDrawdownPercent)} > 20`],
    [numeric(s.sharpeRatio) >= 0.8, `sharpeRatio ${numeric(s.sharpeRatio)} < 0.8`],
    [numeric(s.expectancyPerTrade) > 0, `expectancyPerTrade ${numeric(s.expectancyPerTrade)} <= 0`],
    [numeric(s.maxConsecutiveLosses) <= 5, `maxConsecutiveLosses ${numeric(s.maxConsecutiveLosses)} > 5`],
    [quality?.isLinearUptrend === true, 'equity curve is not a linear uptrend'],
  ]);
  return { hard, linear: quality?.isLinearUptrend === true };
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
  const tradeManagement = mergeObjects(strategyRecord?.tradeManagement, storedInstance?.tradeManagement);
  const mergedStrategy = {
    ...(strategyRecord || { name: strategy }),
    tradeManagement: Object.keys(tradeManagement).length ? tradeManagement : null,
  };
  return {
    storedParameters: resolveStrategyParameters({
      strategyType: strategy,
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

async function fetchCandleBundle({ getCachedCandles, symbol, executionConfig, start, endExclusive }) {
  const timeframe = executionConfig.timeframe || '1h';
  const primaryStart = getWarmupStart(start, timeframe, DEFAULT_WARMUP_BARS);
  const primaryLimit = estimateFetchLimit(timeframe, primaryStart, endExclusive);
  const rawPrimary = await getCachedCandles(symbol, timeframe, primaryStart, primaryLimit, endExclusive);
  const candles = filterCandlesByRange(rawPrimary || [], primaryStart, endExclusive);
  const inRangeCandles = filterCandlesByRange(rawPrimary || [], start, endExclusive);

  let higherTfCandles = null;
  if (executionConfig.higherTimeframe) {
    const higherStart = getWarmupStart(start, executionConfig.higherTimeframe, DEFAULT_WARMUP_BARS);
    const higherLimit = estimateFetchLimit(executionConfig.higherTimeframe, higherStart, endExclusive);
    const rawHigher = await getCachedCandles(symbol, executionConfig.higherTimeframe, higherStart, higherLimit, endExclusive);
    higherTfCandles = filterCandlesByRange(rawHigher || [], higherStart, endExclusive);
  }

  let lowerTfCandles = null;
  if (executionConfig.entryTimeframe) {
    const lowerStart = getWarmupStart(start, executionConfig.entryTimeframe, DEFAULT_WARMUP_BARS);
    const lowerLimit = estimateFetchLimit(executionConfig.entryTimeframe, lowerStart, endExclusive);
    const rawLower = await getCachedCandles(symbol, executionConfig.entryTimeframe, lowerStart, lowerLimit, endExclusive);
    lowerTfCandles = filterCandlesByRange(rawLower || [], lowerStart, endExclusive);
  }

  return {
    candles,
    higherTfCandles,
    lowerTfCandles,
    effectiveStart: inRangeCandles[0] ? new Date(inRangeCandles[0].time) : start,
    effectiveEnd: inRangeCandles.length
      ? new Date(inRangeCandles[inRangeCandles.length - 1].time)
      : new Date(endExclusive.getTime() - 1),
    fetchMeta: {
      timeframe,
      inRangeCount: inRangeCandles.length,
      withWarmupCount: candles.length,
      higherTfCount: higherTfCandles ? higherTfCandles.length : 0,
      entryTfCount: lowerTfCandles ? lowerTfCandles.length : 0,
      requestedFrom: start.toISOString(),
      requestedToExclusive: endExclusive.toISOString(),
    },
  };
}

async function runOptimizerWithTimeout(params, timeoutMs) {
  let timedOut = false;
  const timer = timeoutMs > 0 ? setTimeout(() => {
    timedOut = true;
    optimizerService.requestStop();
  }, timeoutMs) : null;
  try {
    const result = await optimizerService.run(params);
    return { ...result, timedOut };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function outputPaths(args) {
  const reportsDir = path.resolve(process.cwd(), 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  if (args.resumeReport) {
    const jsonPath = path.resolve(process.cwd(), args.resumeReport);
    const base = jsonPath.replace(/\.json$/i, '');
    return { jsonPath, csvPath: `${base}.csv`, mdPath: `${base}.md` };
  }
  const base = path.join(
    reportsDir,
    `default-timeframe-edge-discovery-${todayString()}-${sanitizeTag(args.outputTag)}`
  );
  return { jsonPath: `${base}.json`, csvPath: `${base}.csv`, mdPath: `${base}.md` };
}

function writeJsonAtomic(filePath, report) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(jsonSafe(report), null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

function csvEscape(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function refreshDerived(report) {
  report.paperResearchCandidates = report.combos.filter((combo) => combo.status === 'PAPER_RESEARCH_CANDIDATE');
  report.regimeDependent = report.combos.filter((combo) => combo.status === 'REGIME_DEPENDENT');
  report.noEdge = report.combos.filter((combo) => combo.status === 'NO_EDGE');
  report.incompleteEvidence = report.combos.filter((combo) => combo.status === 'INSUFFICIENT_DATA' || combo.status === 'INCOMPLETE_EVIDENCE');
  const done = new Set(['COMPLETED', 'NO_VALID_OPTIMIZER_RESULT', 'INSUFFICIENT_DATA', 'OPTIMIZER_TIMEOUT', 'ERROR']);
  const allPeriods = report.combos.flatMap((combo) => combo.periods || []);
  report.progress.completedComboPeriods = allPeriods.filter((period) => done.has(period.status)).length;
  report.progress.percent = report.progress.totalComboPeriods
    ? round((report.progress.completedComboPeriods / report.progress.totalComboPeriods) * 100, 2)
    : 0;
  report.progress.completedCombos = report.combos.filter((combo) => combo.aggregate).length;
  report.progress.paperResearchCandidates = report.paperResearchCandidates.length;
  report.progress.regimeDependent = report.regimeDependent.length;
  report.progress.noEdge = report.noEdge.length;
}

function writeCsv(report, csvPath) {
  const columns = [
    'strategy', 'symbol', 'timeframe', 'status', 'completedPeriods', 'linearPassRate',
    'profitablePeriodRatio', 'aggregateNetProfitMoney', 'avgReturnPercent', 'worstReturnPercent',
    'avgProfitFactor', 'avgSharpeRatio', 'avgMaxDrawdownPercent', 'combinedEquityLinear',
    'combinedEquityRSquared', 'combinedUnderwaterPercent', 'combinedPositiveSegmentRatio',
    'profitConcentrationByPeriodTop1', 'recommendation', 'reasons',
  ];
  const rows = report.combos.map((combo) => {
    const a = combo.aggregate || {};
    const q = a.combinedEquityQuality || {};
    return [
      combo.strategy, combo.symbol, combo.timeframe, combo.status, a.completedPeriods || 0,
      a.linearPassRate, a.profitablePeriodRatio, a.aggregateNetProfitMoney, a.avgReturnPercent,
      a.worstReturnPercent, a.avgProfitFactor, a.avgSharpeRatio, a.avgMaxDrawdownPercent,
      q.isLinearUptrend, q.rSquared, q.underwaterPercent, q.positiveSegmentRatio,
      a.profitConcentrationByPeriodTop1, combo.recommendation, (combo.reasons || []).join('; '),
    ].map(csvEscape).join(',');
  });
  fs.writeFileSync(csvPath, `${columns.join(',')}\n${rows.join('\n')}\n`);
}

function markdownTable(rows) {
  if (!rows.length) return '_None_';
  const output = ['| Combo | Status | Periods | Linear pass | Net | PF | Sharpe | R2 | Underwater |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  rows.forEach((combo) => {
    const a = combo.aggregate || {};
    const q = a.combinedEquityQuality || {};
    output.push(`| ${combo.strategy}:${combo.symbol}:${combo.timeframe} | ${combo.status} | ${a.completedPeriods || 0} | ${a.linearPassRate || 0} | ${a.aggregateNetProfitMoney || 0} | ${a.avgProfitFactor || 0} | ${a.avgSharpeRatio || 0} | ${q.rSquared || 0} | ${q.underwaterPercent || 0} |`);
  });
  return output.join('\n');
}

function writeMarkdown(report, mdPath) {
  const ranked = [...report.combos].filter((combo) => combo.aggregate).sort(
    (a, b) => numeric(b.aggregate?.aggregateNetProfitMoney) - numeric(a.aggregate?.aggregateNetProfitMoney)
  );
  const lines = [
    '# Default-Timeframe Edge Discovery',
    '',
    `Generated: ${report.generatedAt}`,
    `Finished: ${report.finishedAt || 'running'}`,
    '',
    '## Method',
    '- Read-only analysis; live config and strategy instances are not changed.',
    '- Existing live-enabled strategy/symbol combinations and SymbolCustom strategies are excluded.',
    '- Each optimizer period is re-tested with its own top 10 selected parameters in the same period.',
    '- Because parameter selection and backtest share data, passing results are paper research candidates only, not live-qualified evidence.',
    '',
    '## Progress',
    `- Combo-periods: ${report.progress.completedComboPeriods}/${report.progress.totalComboPeriods} (${report.progress.percent}%)`,
    `- Combos completed: ${report.progress.completedCombos}/${report.progress.totalCombos}`,
    `- PAPER_RESEARCH_CANDIDATE: ${report.paperResearchCandidates.length}`,
    `- REGIME_DEPENDENT: ${report.regimeDependent.length}`,
    `- NO_EDGE: ${report.noEdge.length}`,
    '',
    '## PAPER_RESEARCH_CANDIDATE',
    markdownTable(report.paperResearchCandidates),
    '',
    '## REGIME_DEPENDENT',
    markdownTable(report.regimeDependent),
    '',
    '## Top Results',
    markdownTable(ranked.slice(0, 30)),
    '',
    '## Excluded Live Combinations',
    '```json',
    JSON.stringify(report.runConfig.excludedLiveCombinations, null, 2),
    '```',
    '',
    '## Reasons',
  ];
  ranked.forEach((combo) => lines.push(`- ${combo.strategy}:${combo.symbol}:${combo.timeframe}: ${(combo.reasons || []).join('; ')}`));
  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`);
}

function writeReports(report, paths, includeSummaryFiles = true) {
  refreshDerived(report);
  writeJsonAtomic(paths.jsonPath, report);
  if (includeSummaryFiles) {
    writeCsv(report, paths.csvPath);
    writeMarkdown(report, paths.mdPath);
  }
}

function buildUniverse(symbols, strategies, livePairs) {
  const combos = [];
  const skipped = [];
  strategies.forEach((strategy) => {
    symbols.forEach((symbol) => {
      const executionConfig = getStrategyExecutionConfig(symbol, strategy);
      const combo = { strategy, symbol, timeframe: executionConfig?.timeframe || null };
      const key = `${strategy}:${symbol}`;
      if (!getInstrument(symbol)) {
        skipped.push({ ...combo, reason: 'UNKNOWN_SYMBOL' });
      } else if (!STRATEGIES.includes(strategy)) {
        skipped.push({ ...combo, reason: 'UNKNOWN_STRATEGY' });
      } else if (livePairs.has(key)) {
        skipped.push({ ...combo, reason: 'LIVE_ENABLED_COMBINATION_EXCLUDED' });
      } else if (!isStrategySupportedForSymbol(strategy, symbol)) {
        skipped.push({ ...combo, reason: 'STRATEGY_NOT_SUPPORTED_FOR_SYMBOL' });
      } else if (!getOptimizerParameterRanges(strategy) || !Object.keys(getOptimizerParameterRanges(strategy)).length) {
        skipped.push({ ...combo, reason: 'NO_OPTIMIZER_RANGES' });
      } else {
        combos.push(combo);
      }
    });
  });
  return { combos, skipped };
}

function ensureCombo(report, combo) {
  let result = report.combos.find((entry) => comboKey(entry) === comboKey(combo));
  if (!result) {
    result = {
      ...combo,
      status: 'PENDING',
      recommendation: 'NONE',
      periods: [],
      aggregate: null,
      reasons: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    report.combos.push(result);
  }
  return result;
}

function periodResultExists(comboResult, periodId) {
  return comboResult.periods.some((period) => period.id === periodId);
}

async function runComboPeriod({
  combo,
  period,
  config,
  strategyRecord,
  activeProfile,
  getCachedCandles,
}) {
  const startedAt = new Date().toISOString();
  const range = parseRange(period);
  const executionConfig = getStrategyExecutionConfig(combo.symbol, combo.strategy);
  const runtime = await buildEffectiveRuntime(combo.strategy, combo.symbol, strategyRecord, activeProfile);
  const costInfo = buildCostModel(getInstrument(combo.symbol), config.costPreset);

  try {
    const bundle = await fetchCandleBundle({
      getCachedCandles,
      symbol: combo.symbol,
      executionConfig,
      start: range.start,
      endExclusive: range.endExclusive,
    });
    if (bundle.candles.length < DEFAULT_WARMUP_BARS + 2 || bundle.fetchMeta.inRangeCount < 50) {
      return {
        id: period.id,
        status: 'INSUFFICIENT_DATA',
        reason: `Only ${bundle.fetchMeta.inRangeCount} primary candles were available in period.`,
        startedAt,
        finishedAt: new Date().toISOString(),
        fetchMeta: bundle.fetchMeta,
      };
    }

    const optimizerResult = await runOptimizerWithTimeout({
      symbol: combo.symbol,
      strategyType: combo.strategy,
      timeframe: executionConfig.timeframe,
      candles: bundle.candles,
      higherTfCandles: bundle.higherTfCandles,
      lowerTfCandles: bundle.lowerTfCandles,
      initialBalance: config.initialBalance,
      costModel: costInfo.costModel,
      optimizeFor: config.optimizeFor,
      minimumTrades: config.minimumTrades,
      parallelWorkers: config.parallelWorkers,
      tradeStartTime: bundle.effectiveStart.toISOString(),
      tradeEndTime: bundle.effectiveEnd.toISOString(),
      storedStrategyParameters: runtime.storedParameters,
      breakevenConfig: runtime.breakevenConfig,
      executionPolicy: runtime.executionPolicy,
      executionConfigOverride: executionConfig,
      onProgress: (progress) => {
        if (progress.current === progress.total || progress.current % 100 === 0) {
          console.log(`[EdgeDiscovery] optimizer ${comboKey(combo)} ${period.id}: ${progress.current}/${progress.total}`);
        }
      },
    }, config.maxComboMs);

    const optimizer = {
      status: optimizerResult.status,
      timedOut: Boolean(optimizerResult.timedOut),
      totalCombinations: optimizerResult.totalCombinations,
      processedCombinations: optimizerResult.processedCombinations,
      validResults: optimizerResult.validResults,
      optimizeFor: optimizerResult.optimizeFor,
      top10: (optimizerResult.top10 || []).map((row) => ({
        parameters: row.parameters,
        optimizerSummary: compactSummary(row.summary),
      })),
    };
    if (optimizerResult.timedOut) {
      return {
        id: period.id,
        status: 'OPTIMIZER_TIMEOUT',
        reason: `Optimizer exceeded ${config.maxComboMs} ms.`,
        startedAt,
        finishedAt: new Date().toISOString(),
        fetchMeta: bundle.fetchMeta,
        optimizer,
      };
    }
    if (!optimizerResult.top10 || optimizerResult.top10.length === 0) {
      return {
        id: period.id,
        status: 'NO_VALID_OPTIMIZER_RESULT',
        reason: 'Optimizer returned no parameter set meeting minimumTrades.',
        startedAt,
        finishedAt: new Date().toISOString(),
        fetchMeta: bundle.fetchMeta,
        optimizer,
      };
    }

    const selectedBacktests = [];
    const selectedErrors = [];
    for (let index = 0; index < optimizerResult.top10.length; index += 1) {
      const selected = optimizerResult.top10[index];
      try {
        const simulation = await backtestEngine.simulate({
          symbol: combo.symbol,
          strategyType: combo.strategy,
          timeframe: executionConfig.timeframe,
          candles: bundle.candles,
          higherTfCandles: bundle.higherTfCandles,
          lowerTfCandles: bundle.lowerTfCandles,
          initialBalance: config.initialBalance,
          costModel: costInfo.costModel,
          tradeStartTime: bundle.effectiveStart.toISOString(),
          tradeEndTime: bundle.effectiveEnd.toISOString(),
          strategyParams: selected.parameters,
          storedStrategyParameters: runtime.storedParameters,
          breakevenConfig: runtime.breakevenConfig,
          executionPolicy: runtime.executionPolicy,
          executionConfigOverride: executionConfig,
          parameterPreset: 'optimizer_top10_in_sample',
          parameterPresetResolution: {
            preset: 'optimizer_top10_in_sample',
            fallbackUsed: false,
            resolvedFrom: 'current_period_optimizer',
            optimizerHistoryId: null,
            optimizerCompletedAt: optimizerResult.completedAt,
            optimizerTimeframe: executionConfig.timeframe,
            optimizerOptimizeFor: config.optimizeFor,
          },
        });
        const quality = analyzeEquityCurveQuality(simulation.equityCurve || [], config.initialBalance);
        selectedBacktests.push({
          rank: index + 1,
          parameters: selected.parameters,
          summary: compactSummary(simulation.summary),
          equityCurveQuality: quality,
          gates: evaluateSelectedBacktest(simulation.summary, quality),
          _equityCurve: simulation.equityCurve || [],
        });
      } catch (error) {
        selectedErrors.push({ rank: index + 1, message: error.message });
      }
    }
    if (!selectedBacktests.length) {
      return {
        id: period.id,
        status: 'ERROR',
        reason: 'Every selected-parameter backtest failed.',
        startedAt,
        finishedAt: new Date().toISOString(),
        fetchMeta: bundle.fetchMeta,
        optimizer,
        selectedErrors,
      };
    }

    const passes = selectedBacktests.filter((result) => result.gates.hard.pass);
    const representative = (passes.length ? passes : selectedBacktests)
      .slice()
      .sort((a, b) => numeric(b.summary.robustScore) - numeric(a.summary.robustScore))[0];
    const persistedBacktests = selectedBacktests.map((result) => {
      const { _equityCurve, ...safeResult } = result;
      return safeResult;
    });
    return {
      id: period.id,
      status: 'COMPLETED',
      startedAt,
      finishedAt: new Date().toISOString(),
      methodology: 'IN_SAMPLE_SELECTED_PARAMS',
      fetchMeta: bundle.fetchMeta,
      costModel: costInfo,
      optimizer,
      selectedBacktests: persistedBacktests,
      selectedErrors,
      linearHardPassCount: passes.length,
      representative: {
        rank: representative.rank,
        parameters: representative.parameters,
        summary: representative.summary,
        equityCurveQuality: representative.equityCurveQuality,
        gates: representative.gates,
        _equityCurve: representative._equityCurve,
      },
    };
  } catch (error) {
    return {
      id: period.id,
      status: 'ERROR',
      reason: error.message,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: { message: error.message, stack: error.stack },
    };
  }
}

function buildCombinedCurve(completed, initialBalance) {
  const combined = [];
  let running = numeric(initialBalance);
  completed.forEach((period) => {
    const curve = period.representative?._equityCurve || [];
    if (!curve.length) return;
    const base = numeric(curve[0].equity);
    curve.forEach((point, index) => {
      if (combined.length && index === 0) return;
      combined.push({ time: point.time, equity: round(running + numeric(point.equity) - base, 4) });
    });
    running += numeric(period.representative.summary.netProfitMoney);
  });
  return combined;
}

function finalizeCombo(combo, initialBalance) {
  const completed = combo.periods.filter((period) => period.status === 'COMPLETED' && period.representative);
  if (!completed.length) {
    const errors = combo.periods.filter((period) => ['ERROR', 'OPTIMIZER_TIMEOUT'].includes(period.status)).length;
    combo.status = errors > combo.periods.length / 2 ? 'ERROR' : 'INSUFFICIENT_DATA';
    combo.recommendation = 'NONE';
    combo.reasons = ['No period supplied usable selected-parameter backtest evidence.'];
    combo.aggregate = { completedPeriods: 0 };
    combo.finishedAt = new Date().toISOString();
    return;
  }

  const reps = completed.map((period) => period.representative);
  const profits = reps.map((result) => numeric(result.summary.netProfitMoney));
  const returns = reps.map((result) => numeric(result.summary.returnPercent));
  const profitFactors = reps.map((result) => numeric(result.summary.profitFactor));
  const sharpes = reps.map((result) => numeric(result.summary.sharpeRatio));
  const drawdowns = reps.map((result) => numeric(result.summary.maxDrawdownPercent));
  const positiveProfit = profits.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const combinedCurve = buildCombinedCurve(completed, initialBalance);
  const combinedEquityQuality = analyzeEquityCurveQuality(combinedCurve, initialBalance);
  const aggregate = {
    completedPeriods: completed.length,
    linearPassRate: round(reps.filter((result) => result.gates.hard.pass).length / completed.length, 4),
    profitablePeriodRatio: round(profits.filter((value) => value > 0).length / completed.length, 4),
    aggregateNetProfitMoney: round(profits.reduce((sum, value) => sum + value, 0), 2),
    avgReturnPercent: round(average(returns), 2),
    worstReturnPercent: round(Math.min(...returns), 2),
    avgProfitFactor: round(average(profitFactors), 2),
    worstProfitFactor: round(Math.min(...profitFactors), 2),
    avgSharpeRatio: round(average(sharpes), 2),
    worstSharpeRatio: round(Math.min(...sharpes), 2),
    avgMaxDrawdownPercent: round(average(drawdowns), 2),
    worstMaxDrawdownPercent: round(Math.max(...drawdowns), 2),
    profitConcentrationByPeriodTop1: positiveProfit
      ? round(Math.max(...profits.map((profit) => Math.max(profit, 0))) / positiveProfit, 4)
      : 1,
    combinedEquityQuality,
    selectedParametersByPeriod: Object.fromEntries(completed.map((period) => [period.id, period.representative.parameters])),
  };

  const researchPass = aggregate.completedPeriods >= 3
    && aggregate.linearPassRate >= 0.75
    && aggregate.profitablePeriodRatio >= 1
    && aggregate.aggregateNetProfitMoney > 0
    && aggregate.worstReturnPercent > 0
    && aggregate.avgProfitFactor >= 1.4
    && aggregate.avgSharpeRatio >= 1
    && aggregate.avgMaxDrawdownPercent <= 15
    && aggregate.combinedEquityQuality.isLinearUptrend === true
    && aggregate.profitConcentrationByPeriodTop1 <= 0.7;

  if (researchPass) {
    combo.status = 'PAPER_RESEARCH_CANDIDATE';
    combo.recommendation = 'PAPER_OBSERVATION_ONLY_REQUIRES_OOS_CONFIRMATION';
    combo.reasons = ['Stable in-sample curves across market periods; requires separate OOS validation before live consideration.'];
  } else if (aggregate.aggregateNetProfitMoney > 0) {
    combo.status = 'REGIME_DEPENDENT';
    combo.recommendation = 'NONE';
    combo.reasons = ['Positive aggregate result did not pass stable multi-period linear equity screen.'];
    if (!aggregate.combinedEquityQuality.isLinearUptrend) combo.reasons.push('Combined equity curve is not linear.');
    if (aggregate.profitConcentrationByPeriodTop1 > 0.7) combo.reasons.push('Profit is concentrated in one period.');
    if (aggregate.profitablePeriodRatio < 1) combo.reasons.push('At least one representative period was not profitable.');
  } else {
    combo.status = 'NO_EDGE';
    combo.recommendation = 'NONE';
    combo.reasons = ['Aggregate selected-parameter result is not profitable across periods.'];
  }

  combo.aggregate = aggregate;
  combo.finishedAt = new Date().toISOString();
  combo.periods.forEach((period) => {
    if (period.representative) delete period.representative._equityCurve;
  });
}

function htmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTelegram(text) {
  try {
    await notificationService.sendTelegramRaw(text);
  } catch (error) {
    console.warn(`[EdgeDiscovery] Telegram notification failed: ${error.message}`);
  }
}

async function maybeNotifyProgress(report, config, message, force = false) {
  const now = Date.now();
  if (!force && now - (report.progress.lastTelegramAtMs || 0) < config.telegramIntervalMs) return;
  report.progress.lastTelegramAtMs = now;
  const p = report.progress;
  await sendTelegram(
    `<b>Edge discovery progress</b>\n`
    + `${htmlEscape(message)}\n`
    + `Periods: ${p.completedComboPeriods}/${p.totalComboPeriods} (${p.percent}%)\n`
    + `Paper research: ${p.paperResearchCandidates || 0} | Regime: ${p.regimeDependent || 0} | No edge: ${p.noEdge || 0}`
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const paths = outputPaths(args);
  const symbols = csvList(args.symbols) || getAllSymbols();
  const strategies = csvList(args.strategies) || STRATEGIES;
  const initialBalance = numberArg(args.initialBalance, 500);
  const strategyRecords = await Strategy.findAll().catch(() => []);
  const strategyRecordsByName = new Map(strategyRecords.map((record) => [record.name, record]));
  const [instances, activeProfile] = await Promise.all([
    StrategyInstance.findAll().catch(() => []),
    getActiveRiskProfileReadOnly(),
  ]);
  const liveCombinations = instances
    .filter((instance) => instance.liveEnabled === true && STRATEGIES.includes(instance.strategyName))
    .map((instance) => ({ strategy: instance.strategyName, symbol: instance.symbol }));
  const livePairs = new Set(liveCombinations.map((combo) => `${combo.strategy}:${combo.symbol}`));
  const universe = buildUniverse(symbols, strategies, livePairs);
  const config = {
    outputTag: args.outputTag || 'non-live-four-regime-top10',
    initialBalance,
    optimizeFor: args.optimizeFor || 'robustScore',
    optimizeForPolicy: 'robustScore is used uniformly to prefer risk-adjusted stability over raw period profit.',
    minimumTrades: intArg(args.minimumTrades, 30),
    parallelWorkers: intArg(args.parallelWorkers, 2),
    mt5Scope: args.mt5Scope || 'live',
    costPreset: args.costPreset || 'conservative',
    maxComboMs: intArg(args.maxComboMs, 1800000),
    telegramIntervalMs: intArg(args.telegramIntervalMs, 300000),
    periods: PERIODS,
    symbols,
    strategies,
    totalCombos: universe.combos.length,
    totalComboPeriods: universe.combos.length * PERIODS.length,
    excludedLiveCombinations: liveCombinations,
    excludesSymbolCustom: true,
    timeframes: 'strategy defaults',
    methodology: 'IN_SAMPLE_OPTIMIZER_TOP10_SELECTED_PARAMS_SCREEN',
    liveEligibilityFromThisRun: false,
    readOnly: true,
    appliesParametersToLive: false,
    mutatesStrategyInstances: false,
    reportJsonPath: paths.jsonPath,
    reportCsvPath: paths.csvPath,
    reportMarkdownPath: paths.mdPath,
  };

  let report;
  if (args.resumeReport && fs.existsSync(paths.jsonPath)) {
    report = JSON.parse(fs.readFileSync(paths.jsonPath, 'utf8'));
    report.runConfig = { ...report.runConfig, ...config, resumedAt: new Date().toISOString() };
  } else {
    report = {
      runConfig: config,
      thresholds: SCREEN_GATES,
      periods: PERIODS,
      progress: {
        totalCombos: config.totalCombos,
        totalComboPeriods: config.totalComboPeriods,
        completedCombos: 0,
        completedComboPeriods: 0,
        percent: 0,
        lastTelegramAtMs: 0,
        current: null,
      },
      combos: [],
      skipped: universe.skipped,
      paperResearchCandidates: [],
      regimeDependent: [],
      noEdge: [],
      incompleteEvidence: [],
      errors: [],
      generatedAt: new Date().toISOString(),
      finishedAt: null,
    };
  }
  report.skipped = universe.skipped;
  notificationService.init();
  writeReports(report, paths);
  await maybeNotifyProgress(report, config, `Started ${config.totalCombos} non-live standard combos on default timeframes.`, true);
  writeReports(report, paths);

  const mt5 = typeof mt5RootService.getScopedService === 'function'
    ? mt5RootService.getScopedService(config.mt5Scope)
    : mt5RootService;
  if (typeof mt5.reloadConnectionEnvFromFile === 'function') mt5.reloadConnectionEnvFromFile();
  try {
    if (!mt5.isConnected()) await mt5.connect();
  } catch (error) {
    report.errors.push({ status: 'MT5_CONNECT_FAILED', message: error.message, at: new Date().toISOString() });
    report.finishedAt = new Date().toISOString();
    writeReports(report, paths);
    await sendTelegram(`<b>Edge discovery stopped</b>\nMT5 connection failed: ${htmlEscape(error.message)}`);
    process.exitCode = 1;
    return;
  }

  const getCachedCandles = buildCandleCache(mt5);
  const telegramHeartbeat = setInterval(() => {
    refreshDerived(report);
    const current = report.progress.current;
    const label = current
      ? `${current.strategy}:${current.symbol}:${current.timeframe} / ${current.periodId}`
      : 'preparing next combo';
    maybeNotifyProgress(report, config, `Still running ${label}.`).catch((error) => {
      console.warn(`[EdgeDiscovery] Telegram heartbeat failed: ${error.message}`);
    });
  }, config.telegramIntervalMs);

  try {
    for (let comboIndex = 0; comboIndex < universe.combos.length; comboIndex += 1) {
      const combo = universe.combos[comboIndex];
      const result = ensureCombo(report, combo);
      if (result.aggregate) continue;
      for (const period of PERIODS) {
        if (periodResultExists(result, period.id)) continue;
        report.progress.current = { ...combo, periodId: period.id, comboIndex: comboIndex + 1 };
        console.log(`[EdgeDiscovery] running ${comboKey(combo)} ${period.id}`);
        const periodResult = await runComboPeriod({
          combo,
          period,
          config,
          strategyRecord: strategyRecordsByName.get(combo.strategy) || null,
          activeProfile,
          getCachedCandles,
        });
        result.periods.push(periodResult);
        writeReports(report, paths, false);
        refreshDerived(report);
        await maybeNotifyProgress(report, config, `Running ${comboKey(combo)} / ${period.id}: ${periodResult.status}`);
        writeReports(report, paths, false);
        console.log(`[EdgeDiscovery] saved ${comboKey(combo)} ${period.id}: ${periodResult.status}`);
      }
      finalizeCombo(result, config.initialBalance);
      writeReports(report, paths);
      if (result.status === 'PAPER_RESEARCH_CANDIDATE') {
        await maybeNotifyProgress(report, config, `Candidate found: ${comboKey(combo)} (paper research only).`, true);
        writeReports(report, paths);
      }
    }
    report.progress.current = null;
    report.finishedAt = new Date().toISOString();
    writeReports(report, paths);
    await maybeNotifyProgress(
      report,
      config,
      `Finished. Paper research candidates: ${report.paperResearchCandidates.length}; no combo is live-qualified from an in-sample screen.`,
      true
    );
    writeReports(report, paths);
  } finally {
    clearInterval(telegramHeartbeat);
    if (mt5.isConnected()) await mt5.disconnect().catch(() => {});
  }

  console.log('[EdgeDiscovery] Complete');
  console.log(`JSON: ${paths.jsonPath}`);
  console.log(`CSV: ${paths.csvPath}`);
  console.log(`MD: ${paths.mdPath}`);
}

main().catch(async (error) => {
  console.error(`[EdgeDiscovery] Fatal: ${error.message}`);
  await sendTelegram(`<b>Edge discovery failed</b>\n${htmlEscape(error.message)}`);
  process.exitCode = 1;
});
