#!/usr/bin/env node

/**
 * Read-only strict stability validation for fixed candidate combinations.
 *
 * Inputs:
 * - reports/expanded-stable-combo-prescreen-*.json
 * - optional previous portfolio/monthly reports for diversifying candidates
 *
 * Outputs:
 * - reports/expanded-candidate-strict-validation-*.json/.csv/.md
 *
 * The script never mutates strategy instances, SymbolCustom rows, or live config.
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

const DEFAULT_SOURCE = 'reports/expanded-stable-combo-prescreen-2026-06-04.json';
const DEFAULT_OUTPUT_BASE = 'reports/expanded-candidate-strict-validation-2026-06-04';
const DEFAULT_PORTFOLIO_SOURCE = 'reports/candidate-portfolio-weight-screen-2026-06-03.json';
const DEFAULT_MONTHLY_SOURCE = 'reports/all-positive-candidate-monthly-screen-2026-06-03.json';

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

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

function comboKey(candidate) {
  return `${candidate.strategy}:${candidate.symbol}:${candidate.timeframe}`;
}

function candidateKey(candidate) {
  return `${comboKey(candidate)}:${parameterKey(candidate.parameters)}`;
}

function parseCombo(combo) {
  const [strategy, symbol, timeframe] = String(combo || '').split(':');
  return { strategy, symbol, timeframe };
}

function toCandidate(row, source, rank = null) {
  const parsed = parseCombo(row.combo);
  const candidate = {
    id: row.id || `${source}_${rank || 'candidate'}`,
    source,
    sourceRank: rank,
    combo: row.combo || `${row.strategy}:${row.symbol}:${row.timeframe}`,
    strategy: row.strategy || parsed.strategy,
    symbol: row.symbol || parsed.symbol,
    timeframe: row.timeframe || parsed.timeframe,
    parameters: row.parameters || {},
    prescreenScore: row.score || null,
  };
  candidate.key = candidateKey(candidate);
  return candidate;
}

function addUniqueCandidate(candidates, seen, candidate) {
  if (!candidate.strategy || !candidate.symbol || !candidate.timeframe) return;
  if (!candidate.parameters || Object.keys(candidate.parameters).length === 0) return;
  if (seen.has(candidate.key)) return;
  seen.add(candidate.key);
  candidates.push(candidate);
}

function loadCandidates(config) {
  const candidates = [];
  const seen = new Set();

  const expanded = readJsonIfExists(config.sourcePath);
  (expanded?.top || []).slice(0, config.expandedTop).forEach((row, index) => {
    addUniqueCandidate(candidates, seen, toCandidate(row, 'expanded_prescreen', index + 1));
  });

  const portfolio = readJsonIfExists(config.portfolioSourcePath);
  (portfolio?.selected || []).forEach((row, index) => {
    addUniqueCandidate(candidates, seen, toCandidate(row, 'previous_portfolio_screen', index + 1));
  });

  const monthly = readJsonIfExists(config.monthlySourcePath);
  const btcRows = (monthly?.results || [])
    .filter((row) => row.symbol === 'BTCUSD' || String(row.combo || '').includes(':BTCUSD:'))
    .slice(0, config.extraBtcCandidates);
  btcRows.forEach((row, index) => {
    addUniqueCandidate(candidates, seen, toCandidate(row, 'previous_monthly_btc', index + 1));
  });

  return candidates.map((candidate, index) => ({
    ...candidate,
    validationId: `V${String(index + 1).padStart(3, '0')}_${candidate.strategy}_${candidate.symbol}_${candidate.timeframe}`,
  }));
}

function monthId(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(date, months) {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function buildMonthlyWindows(from, to) {
  const windows = [];
  let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cursor < to) {
    const next = addMonths(cursor, 1);
    const end = next < to ? next : to;
    windows.push({
      id: `M_${monthId(cursor)}`,
      from: cursor.toISOString().slice(0, 10),
      to: end.toISOString(),
      type: 'monthly',
    });
    cursor = next;
  }
  return windows;
}

function buildQuarterWindows(from, to) {
  const windows = [];
  let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cursor < to) {
    const end = addMonths(cursor, 3);
    windows.push({
      id: `Q_${monthId(cursor)}_${monthId(addMonths(cursor, 2))}`,
      from: cursor.toISOString().slice(0, 10),
      to: (end < to ? end : to).toISOString(),
      type: 'quarter',
    });
    cursor = end;
  }
  return windows;
}

function buildRollingWindows(from, to, days, stepDays) {
  const windows = [];
  let cursor = new Date(from);
  while (addDays(cursor, days) <= to) {
    const end = addDays(cursor, days);
    windows.push({
      id: `R${days}_${cursor.toISOString().slice(0, 10)}`,
      from: cursor.toISOString().slice(0, 10),
      to: end.toISOString(),
      type: `rolling${days}`,
    });
    cursor = addDays(cursor, stepDays);
  }
  return windows;
}

function parseRange(window) {
  const start = new Date(window.from);
  const endExclusive = new Date(window.to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(endExclusive.getTime()) || endExclusive <= start) {
    throw new Error(`Invalid window range: ${JSON.stringify(window)}`);
  }
  return { start, endExclusive };
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

function mergeObjects(base, override) {
  return {
    ...((base && typeof base === 'object') ? base : {}),
    ...((override && typeof override === 'object') ? override : {}),
  };
}

async function getActiveRiskProfileReadOnly() {
  try {
    return await riskProfilesDb.findOne({ isActive: true }) || await riskProfilesDb.findOne({});
  } catch (_) {
    return null;
  }
}

async function buildRuntime(candidate, strategyRecord, activeProfile) {
  const instrument = getInstrument(candidate.symbol);
  const instance = await StrategyInstance.findByKey(candidate.strategy, candidate.symbol).catch(() => null);
  const tradeManagement = mergeObjects(strategyRecord?.tradeManagement, instance?.tradeManagement);
  const mergedStrategy = {
    ...(strategyRecord || { name: candidate.strategy }),
    tradeManagement: Object.keys(tradeManagement).length ? tradeManagement : null,
  };
  return {
    storedParameters: resolveStrategyParameters({
      strategyType: candidate.strategy,
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

function resolveExecutionConfig(candidate) {
  const defaults = getStrategyExecutionConfig(candidate.symbol, candidate.strategy);
  if (!defaults) return null;
  return defaults.timeframe === candidate.timeframe
    ? defaults
    : getForcedTimeframeExecutionConfig(candidate.symbol, candidate.strategy, candidate.timeframe);
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

async function fetchBundle({ getCachedCandles, candidate, executionConfig, window }) {
  const { start, endExclusive } = parseRange(window);
  const timeframe = executionConfig.timeframe || candidate.timeframe;
  const fetchStart = getWarmupStart(start, timeframe, DEFAULT_WARMUP_BARS);
  const limit = estimateFetchLimit(timeframe, fetchStart, endExclusive);
  const rawPrimary = await getCachedCandles(candidate.symbol, timeframe, fetchStart, limit, endExclusive);
  const candles = filterCandlesByRange(rawPrimary || [], fetchStart, endExclusive);
  const inRangeCandles = filterCandlesByRange(rawPrimary || [], start, endExclusive);

  let higherTfCandles = null;
  if (executionConfig.higherTimeframe) {
    const higherStart = getWarmupStart(start, executionConfig.higherTimeframe, DEFAULT_WARMUP_BARS);
    const higherLimit = estimateFetchLimit(executionConfig.higherTimeframe, higherStart, endExclusive);
    const higherRaw = await getCachedCandles(
      candidate.symbol,
      executionConfig.higherTimeframe,
      higherStart,
      higherLimit,
      endExclusive
    );
    higherTfCandles = filterCandlesByRange(higherRaw || [], higherStart, endExclusive);
  }

  let lowerTfCandles = null;
  if (executionConfig.entryTimeframe) {
    const lowerStart = getWarmupStart(start, executionConfig.entryTimeframe, DEFAULT_WARMUP_BARS);
    const lowerLimit = estimateFetchLimit(executionConfig.entryTimeframe, lowerStart, endExclusive);
    const lowerRaw = await getCachedCandles(
      candidate.symbol,
      executionConfig.entryTimeframe,
      lowerStart,
      lowerLimit,
      endExclusive
    );
    lowerTfCandles = filterCandlesByRange(lowerRaw || [], lowerStart, endExclusive);
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
    'sampleQuality',
  ];
  return Object.fromEntries(keys.map((key) => [key, summary[key] ?? null]));
}

async function simulateWindow({
  candidate,
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
      type: window.type,
      status: 'INSUFFICIENT_DATA',
      reason: `Only ${bundle?.fetchMeta?.primaryInRange || 0} primary in-range candles were available.`,
      net: 0,
      trades: 0,
      summary: null,
      equityCurveQuality: null,
      fetchMeta: bundle?.fetchMeta || null,
    };
  }

  try {
    const simulation = await backtestEngine.simulate({
      symbol: candidate.symbol,
      strategyType: candidate.strategy,
      timeframe: executionConfig.timeframe,
      candles: bundle.candles,
      higherTfCandles: bundle.higherTfCandles,
      lowerTfCandles: bundle.lowerTfCandles,
      initialBalance: config.initialBalance,
      tradeStartTime: bundle.effectiveStart.toISOString(),
      tradeEndTime: bundle.effectiveEnd.toISOString(),
      strategyParams: candidate.parameters,
      storedStrategyParameters: runtime.storedParameters,
      breakevenConfig: runtime.breakevenConfig,
      executionPolicy: runtime.executionPolicy,
      executionConfigOverride: executionConfig,
      costModel: costInfo.costModel,
      parameterPreset: 'strict_stability_validation',
      parameterPresetResolution: {
        preset: 'strict_stability_validation',
        fallbackUsed: false,
        resolvedFrom: candidate.source,
        optimizerHistoryId: null,
        optimizerCompletedAt: null,
        optimizerTimeframe: executionConfig.timeframe,
        optimizerOptimizeFor: null,
      },
    });
    const summary = compactSummary(simulation.summary);
    const quality = analyzeEquityCurveQuality(simulation.equityCurve || [], config.initialBalance);
    return {
      id: window.id,
      type: window.type,
      status: 'COMPLETED',
      from: window.from,
      to: window.to,
      net: round(summary.netProfitMoney, 4),
      trades: Number(summary.totalTrades || 0),
      profitFactor: summary.profitFactor,
      maxDrawdownPercent: summary.maxDrawdownPercent,
      summary,
      equityCurveQuality: quality,
      fetchMeta: bundle.fetchMeta,
    };
  } catch (error) {
    return {
      id: window.id,
      type: window.type,
      status: 'ERROR',
      from: window.from,
      to: window.to,
      reason: error.message,
      error: { message: error.message, stack: error.stack },
      net: 0,
      trades: 0,
      summary: null,
      equityCurveQuality: null,
      fetchMeta: bundle.fetchMeta,
    };
  }
}

function summarizeWindows(windows) {
  const completed = windows.filter((window) => window.status === 'COMPLETED');
  const tradable = completed.filter((window) => window.trades > 0);
  const positives = tradable.filter((window) => window.net > 0);
  const negatives = tradable.filter((window) => window.net < 0);
  const nets = tradable.map((window) => window.net);
  const drawdowns = tradable.map((window) => numberOrZero(window.maxDrawdownPercent));
  return {
    completed: completed.length,
    tradable: tradable.length,
    positive: positives.length,
    negative: negatives.length,
    zero: tradable.length - positives.length - negatives.length,
    positiveRatio: tradable.length ? round(positives.length / tradable.length, 4) : 0,
    net: round(nets.reduce((sum, value) => sum + value, 0), 4),
    worstNet: nets.length ? round(Math.min(...nets), 4) : 0,
    bestNet: nets.length ? round(Math.max(...nets), 4) : 0,
    avgNet: round(average(nets), 4),
    worstDrawdownPercent: drawdowns.length ? round(Math.max(...drawdowns), 4) : 0,
    negativeWindows: negatives.map((window) => ({
      id: window.id,
      net: window.net,
      trades: window.trades,
      profitFactor: window.profitFactor,
      maxDrawdownPercent: window.maxDrawdownPercent,
    })),
  };
}

function monthlyScore(summary) {
  return (
    summary.positive * 100000
    + summary.worstNet * 100
    + summary.net
    - summary.worstDrawdownPercent
  );
}

function selectPortfolioUniverse(candidateResults, maxUniverse) {
  const bestByBucket = new Map();
  candidateResults.forEach((entry) => {
    const bucket = `${entry.strategy}:${entry.symbol}`;
    const current = bestByBucket.get(bucket);
    if (!current || monthlyScore(entry.monthlySummary) > monthlyScore(current.monthlySummary)) {
      bestByBucket.set(bucket, entry);
    }
  });

  const selected = Array.from(bestByBucket.values());
  const seen = new Set(selected.map((entry) => entry.validationId));
  candidateResults
    .slice()
    .sort((a, b) => monthlyScore(b.monthlySummary) - monthlyScore(a.monthlySummary))
    .forEach((entry) => {
      if (selected.length >= maxUniverse) return;
      if (seen.has(entry.validationId)) return;
      selected.push(entry);
      seen.add(entry.validationId);
    });
  return selected.slice(0, maxUniverse);
}

function enumerateWeights(count, steps, onWeights) {
  const weights = new Array(count).fill(0);
  function walk(index, remaining) {
    if (index === count - 1) {
      weights[index] = remaining;
      onWeights(weights);
      return;
    }
    for (let step = 0; step <= remaining; step += 1) {
      weights[index] = step;
      walk(index + 1, remaining - step);
    }
  }
  walk(0, steps);
}

function scorePortfolio(monthlyNets, totalNet, maxDrawdownPercent) {
  const positives = monthlyNets.filter((item) => item.net > 0).length;
  const negatives = monthlyNets.filter((item) => item.net < 0).length;
  const worst = monthlyNets.length ? Math.min(...monthlyNets.map((item) => item.net)) : 0;
  const avg = monthlyNets.length ? totalNet / monthlyNets.length : 0;
  const variance = monthlyNets.length
    ? monthlyNets.reduce((sum, item) => sum + ((item.net - avg) ** 2), 0) / monthlyNets.length
    : 0;
  const stdDev = Math.sqrt(variance);
  return {
    positives,
    negatives,
    worst,
    totalNet,
    stdDev,
    maxDrawdownPercent,
    score: (
      positives * 100000
      + worst * 250
      + totalNet
      - stdDev * 10
      - maxDrawdownPercent * 25
      - negatives * 5000
    ),
  };
}

function buildPortfolioCurve(monthlyNets, initialBalance) {
  let balance = initialBalance;
  let peak = initialBalance;
  let maxDrawdownPercent = 0;
  return monthlyNets.map((item) => {
    balance += item.net;
    peak = Math.max(peak, balance);
    const drawdownPercent = peak > 0 ? ((peak - balance) / peak) * 100 : 0;
    maxDrawdownPercent = Math.max(maxDrawdownPercent, drawdownPercent);
    return {
      id: item.id,
      net: round(item.net, 4),
      balance: round(balance, 4),
      drawdownPercent: round(drawdownPercent, 4),
      _maxDrawdownPercent: maxDrawdownPercent,
    };
  });
}

function searchPortfolio(universe, monthlyWindows, config) {
  const steps = Math.round(1 / config.weightStep);
  let checked = 0;
  let best = null;

  const netsByCandidate = universe.map((entry) => {
    const byId = new Map(entry.monthlyWindows.map((window) => [window.id, window.net || 0]));
    return monthlyWindows.map((window) => byId.get(window.id) || 0);
  });

  enumerateWeights(universe.length, steps, (stepWeights) => {
    if (stepWeights.every((step) => step === 0)) return;
    checked += 1;
    const weights = stepWeights.map((step) => step / steps);
    const monthlyNets = monthlyWindows.map((window, monthIndex) => ({
      id: window.id,
      net: round(weights.reduce((sum, weight, candidateIndex) => (
        sum + weight * netsByCandidate[candidateIndex][monthIndex]
      ), 0), 4),
    }));
    const curve = buildPortfolioCurve(monthlyNets, config.initialBalance);
    const totalNet = round(monthlyNets.reduce((sum, item) => sum + item.net, 0), 4);
    const maxDrawdownPercent = curve.length
      ? round(Math.max(...curve.map((point) => point.drawdownPercent)), 4)
      : 0;
    const scored = scorePortfolio(monthlyNets, totalNet, maxDrawdownPercent);
    const nonZeroWeights = weights
      .map((weight, index) => ({ weight, candidate: universe[index] }))
      .filter((item) => item.weight > 0);
    const row = {
      weights: nonZeroWeights.map((item) => ({
        validationId: item.candidate.validationId,
        combo: comboKey(item.candidate),
        weight: round(item.weight, 4),
        parameters: item.candidate.parameters,
      })),
      monthlyNets,
      curve: curve.map(({ _maxDrawdownPercent, ...point }) => point),
      totalNet,
      positiveMonths: scored.positives,
      negativeMonths: scored.negatives,
      worstMonthNet: round(scored.worst, 4),
      stdDev: round(scored.stdDev, 4),
      maxDrawdownPercent,
      score: round(scored.score, 4),
    };
    if (
      !best
      || row.positiveMonths > best.positiveMonths
      || (row.positiveMonths === best.positiveMonths && row.worstMonthNet > best.worstMonthNet)
      || (row.positiveMonths === best.positiveMonths && row.worstMonthNet === best.worstMonthNet && row.score > best.score)
    ) {
      best = row;
    }
  });

  return { checked, best };
}

function evaluatePortfolioWindows(weightRows, candidateWindowResults, windows, initialBalance = 0) {
  const byCandidate = new Map(candidateWindowResults.map((entry) => [entry.validationId, entry]));
  const weighted = windows.map((window) => {
    const net = weightRows.reduce((sum, weightRow) => {
      const entry = byCandidate.get(weightRow.validationId);
      const result = entry?.windows?.find((item) => item.id === window.id);
      return sum + weightRow.weight * numberOrZero(result?.net);
    }, 0);
    return { id: window.id, type: window.type, net: round(net, 4) };
  });
  const curve = buildPortfolioCurve(weighted, initialBalance);
  return {
    windows: weighted,
    summary: {
      tradable: weighted.length,
      positive: weighted.filter((item) => item.net > 0).length,
      negative: weighted.filter((item) => item.net < 0).length,
      net: round(weighted.reduce((sum, item) => sum + item.net, 0), 4),
      worstNet: weighted.length ? round(Math.min(...weighted.map((item) => item.net)), 4) : 0,
      maxDrawdownFromWindowNets: curve.length
        ? round(Math.max(...curve.map((point) => point.drawdownPercent)), 4)
        : 0,
    },
  };
}

function weightedWindowsForRows(weightRows, universe, windows, groupKey) {
  const weightsById = new Map(weightRows.map((row) => [row.validationId, row.weight]));
  return windows.map((window) => {
    const net = universe.reduce((sum, entry) => {
      const weight = weightsById.get(entry.validationId) || 0;
      if (!weight) return sum;
      const result = (entry.windowGroups?.[groupKey] || []).find((item) => item.id === window.id);
      return sum + weight * numberOrZero(result?.net);
    }, 0);
    return { id: window.id, type: window.type, net: round(net, 4) };
  });
}

function summarizeWeightedNets(weighted, initialBalance) {
  const curve = buildPortfolioCurve(weighted, initialBalance);
  const nets = weighted.map((item) => item.net);
  const totalNet = round(nets.reduce((sum, value) => sum + value, 0), 4);
  const avg = average(nets);
  const variance = nets.length
    ? nets.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / nets.length
    : 0;
  return {
    tradable: weighted.length,
    positive: weighted.filter((item) => item.net > 0).length,
    negative: weighted.filter((item) => item.net < 0).length,
    net: totalNet,
    worstNet: nets.length ? round(Math.min(...nets), 4) : 0,
    stdDev: round(Math.sqrt(variance), 4),
    maxDrawdownPercent: curve.length
      ? round(Math.max(...curve.map((point) => point.drawdownPercent)), 4)
      : 0,
  };
}

function compareCompositePortfolio(a, b) {
  if (!b) return 1;
  if (a.totalNegativeWindows !== b.totalNegativeWindows) {
    return b.totalNegativeWindows - a.totalNegativeWindows;
  }
  if (a.rollingNegativeWindows !== b.rollingNegativeWindows) {
    return b.rollingNegativeWindows - a.rollingNegativeWindows;
  }
  if (a.worstAllNet !== b.worstAllNet) return a.worstAllNet - b.worstAllNet;
  if (a.groupSummaries.monthly.positive !== b.groupSummaries.monthly.positive) {
    return a.groupSummaries.monthly.positive - b.groupSummaries.monthly.positive;
  }
  if (a.groupSummaries.monthly.maxDrawdownPercent !== b.groupSummaries.monthly.maxDrawdownPercent) {
    return b.groupSummaries.monthly.maxDrawdownPercent - a.groupSummaries.monthly.maxDrawdownPercent;
  }
  if (a.groupSummaries.monthly.net !== b.groupSummaries.monthly.net) {
    return a.groupSummaries.monthly.net - b.groupSummaries.monthly.net;
  }
  return b.groupSummaries.monthly.stdDev - a.groupSummaries.monthly.stdDev;
}

function searchCompositePortfolio(universe, windowSets, config) {
  const steps = Math.round(1 / config.weightStep);
  let checked = 0;
  let best = null;
  const groupEntries = Object.entries(windowSets);

  enumerateWeights(universe.length, steps, (stepWeights) => {
    checked += 1;
    const weights = stepWeights.map((step) => step / steps);
    const weightRows = weights
      .map((weight, index) => ({ weight, candidate: universe[index] }))
      .filter((item) => item.weight > 0)
      .map((item) => ({
        validationId: item.candidate.validationId,
        combo: comboKey(item.candidate),
        weight: round(item.weight, 4),
        parameters: item.candidate.parameters,
      }));
    if (!weightRows.length) return;

    const groupSummaries = {};
    const groupWindows = {};
    for (const [groupKey, windows] of groupEntries) {
      const weighted = weightedWindowsForRows(weightRows, universe, windows, groupKey);
      groupWindows[groupKey] = weighted;
      groupSummaries[groupKey] = summarizeWeightedNets(weighted, config.initialBalance);
    }
    const worstAllNet = round(Math.min(...Object.values(groupSummaries).map((summary) => summary.worstNet)), 4);
    const rollingNegativeWindows = numberOrZero(groupSummaries.rolling60?.negative)
      + numberOrZero(groupSummaries.rolling90?.negative);
    const totalNegativeWindows = Object.values(groupSummaries)
      .reduce((sum, summary) => sum + numberOrZero(summary.negative), 0);
    const row = {
      weights: weightRows,
      groupSummaries,
      worstAllNet,
      rollingNegativeWindows,
      totalNegativeWindows,
      monthlyNets: groupWindows.monthly,
      monthlyCurve: buildPortfolioCurve(groupWindows.monthly || [], config.initialBalance)
        .map(({ _maxDrawdownPercent, ...point }) => point),
    };
    if (compareCompositePortfolio(row, best) > 0) {
      best = row;
    }
  });

  return { checked, best };
}

function outputPaths(base) {
  const resolved = path.resolve(process.cwd(), base);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return { json: `${resolved}.json`, csv: `${resolved}.csv`, md: `${resolved}.md` };
}

function writeReports(report, paths) {
  fs.writeFileSync(paths.json, JSON.stringify(jsonSafe(report), null, 2));

  const rows = [
    [
      'validationId',
      'combo',
      'source',
      'positiveMonths',
      'tradableMonths',
      'negativeMonths',
      'net',
      'worstNet',
      'worstDrawdownPercent',
      'parameters',
    ].join(','),
    ...(report.candidates || []).map((entry) => [
      entry.validationId,
      comboKey(entry),
      entry.source,
      entry.monthlySummary?.positive ?? '',
      entry.monthlySummary?.tradable ?? '',
      entry.monthlySummary?.negative ?? '',
      entry.monthlySummary?.net ?? '',
      entry.monthlySummary?.worstNet ?? '',
      entry.monthlySummary?.worstDrawdownPercent ?? '',
      JSON.stringify(entry.parameters).replace(/"/g, '""'),
    ].map((cell) => `"${String(cell)}"`).join(',')),
  ];
  fs.writeFileSync(paths.csv, `${rows.join('\n')}\n`);

  const lines = [];
  lines.push('# Expanded Candidate Strict Validation');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Finished: ${report.finishedAt || ''}`);
  lines.push('');
  lines.push(`Candidates: ${report.candidates?.length || 0}`);
  lines.push(`Range: ${report.range.from} -> ${report.range.to}`);
  lines.push(`Initial balance: ${report.initialBalance}`);
  lines.push('');
  lines.push('## Top Candidates By Strict Monthly Stability');
  lines.push('');
  lines.push('| Rank | Candidate | Monthly + | Neg | Net | Worst Month | Worst Net | Worst DD | Source | Params |');
  lines.push('| ---: | --- | ---: | ---: | ---: | --- | ---: | ---: | --- | --- |');
  (report.candidates || [])
    .slice()
    .sort((a, b) => monthlyScore(b.monthlySummary) - monthlyScore(a.monthlySummary))
    .slice(0, 20)
    .forEach((entry, index) => {
      const worst = (entry.monthlySummary.negativeWindows || [])
        .slice()
        .sort((a, b) => a.net - b.net)[0];
      lines.push(`| ${index + 1} | ${comboKey(entry)} | ${entry.monthlySummary.positive}/${entry.monthlySummary.tradable} | ${entry.monthlySummary.negative} | ${entry.monthlySummary.net} | ${worst?.id || ''} | ${entry.monthlySummary.worstNet} | ${entry.monthlySummary.worstDrawdownPercent} | ${entry.source} | \`${JSON.stringify(entry.parameters)}\` |`);
    });

  lines.push('');
  lines.push('## Best Weighted Portfolio');
  lines.push('');
  if (report.portfolio?.best) {
    const best = report.portfolio.best;
    lines.push(`Checked weight vectors: ${report.portfolio.checked}`);
    lines.push(`Monthly positives: ${best.positiveMonths}/${report.monthlyWindows.length}`);
    lines.push(`Negative months: ${best.negativeMonths}`);
    lines.push(`Net: ${best.totalNet}`);
    lines.push(`Worst month net: ${best.worstMonthNet}`);
    lines.push(`Max drawdown from monthly balance: ${best.maxDrawdownPercent}%`);
    lines.push('');
    lines.push('| Weight | Combo | Params |');
    lines.push('| ---: | --- | --- |');
    best.weights.forEach((weight) => {
      lines.push(`| ${weight.weight} | ${weight.combo} | \`${JSON.stringify(weight.parameters)}\` |`);
    });
    lines.push('');
    lines.push('| Month | Net | Balance | DD % |');
    lines.push('| --- | ---: | ---: | ---: |');
    best.curve.forEach((point) => {
      lines.push(`| ${point.id} | ${point.net} | ${point.balance} | ${point.drawdownPercent} |`);
    });
  } else {
    lines.push('No portfolio generated.');
  }

  if (report.portfolioValidation) {
    lines.push('');
    lines.push('## Monthly-Best Portfolio Rolling Validation');
    lines.push('');
    Object.entries(report.portfolioValidation).forEach(([key, value]) => {
      lines.push(`- ${key}: ${value.summary.positive}/${value.summary.tradable} positive, net ${value.summary.net}, worst ${value.summary.worstNet}, window-DD ${value.summary.maxDrawdownFromWindowNets}%`);
    });
  }

  if (report.compositePortfolio?.best) {
    lines.push('');
    lines.push('## Best Composite Portfolio');
    lines.push('');
    lines.push(`Checked weight vectors: ${report.compositePortfolio.checked}`);
    lines.push(`Total negative windows: ${report.compositePortfolio.best.totalNegativeWindows}`);
    lines.push(`Rolling negative windows: ${report.compositePortfolio.best.rollingNegativeWindows}`);
    lines.push(`Worst all-window net: ${report.compositePortfolio.best.worstAllNet}`);
    lines.push('');
    lines.push('| Group | Positive | Negative | Net | Worst | Max DD % |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
    Object.entries(report.compositePortfolio.best.groupSummaries || {}).forEach(([key, summary]) => {
      lines.push(`| ${key} | ${summary.positive}/${summary.tradable} | ${summary.negative} | ${summary.net} | ${summary.worstNet} | ${summary.maxDrawdownPercent} |`);
    });
    lines.push('');
    lines.push('| Weight | Combo | Params |');
    lines.push('| ---: | --- | --- |');
    report.compositePortfolio.best.weights.forEach((weight) => {
      lines.push(`| ${weight.weight} | ${weight.combo} | \`${JSON.stringify(weight.parameters)}\` |`);
    });
  }

  fs.writeFileSync(paths.md, `${lines.join('\n')}\n`);
}

async function runCandidateWindows({
  candidates,
  windows,
  config,
  getCachedCandles,
  strategyRecordsByName,
  activeProfile,
}) {
  const results = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const executionConfig = resolveExecutionConfig(candidate);
    if (!executionConfig) {
      results.push({
        ...candidate,
        windows: windows.map((window) => ({
          id: window.id,
          type: window.type,
          status: 'ERROR',
          reason: `No execution config for ${comboKey(candidate)}`,
          net: 0,
          trades: 0,
        })),
      });
      continue;
    }
    const instrument = getInstrument(candidate.symbol);
    const costInfo = buildCostModel(instrument, config.costPreset);
    const runtime = await buildRuntime(candidate, strategyRecordsByName.get(candidate.strategy) || null, activeProfile);
    const entry = { ...candidate, windows: [] };
    console.log(`[StrictValidation] ${index + 1}/${candidates.length} ${comboKey(candidate)} ${candidate.validationId}`);
    for (const window of windows) {
      const bundle = await fetchBundle({ getCachedCandles, candidate, executionConfig, window }).catch((error) => ({ error }));
      const result = bundle?.error
        ? {
          id: window.id,
          type: window.type,
          status: 'ERROR',
          from: window.from,
          to: window.to,
          reason: bundle.error.message,
          net: 0,
          trades: 0,
        }
        : await simulateWindow({
          candidate,
          window,
          config,
          bundle,
          runtime,
          costInfo,
          executionConfig,
        });
      entry.windows.push(result);
    }
    results.push(entry);
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  const config = {
    sourcePath: args.source || DEFAULT_SOURCE,
    portfolioSourcePath: args.portfolioSource || DEFAULT_PORTFOLIO_SOURCE,
    monthlySourcePath: args.monthlySource || DEFAULT_MONTHLY_SOURCE,
    outputBase: args.outputBase || DEFAULT_OUTPUT_BASE,
    expandedTop: intArg(args.expandedTop, 12),
    extraBtcCandidates: intArg(args.extraBtcCandidates, 1),
    portfolioUniverse: intArg(args.portfolioUniverse, 8),
    weightStep: numberArg(args.weightStep, 0.05),
    initialBalance: numberArg(args.initialBalance, 500),
    costPreset: args.costPreset || 'conservative',
    mt5Scope: args.mt5Scope || 'live',
    from: args.from || '2024-07-01',
    to: args.to || '2026-06-04',
  };

  const from = new Date(config.from);
  const to = new Date(config.to);
  const paths = outputPaths(config.outputBase);
  const monthlyWindows = buildMonthlyWindows(from, to);
  const candidates = loadCandidates(config);
  const strategyRecords = await Strategy.findAll().catch(() => []);
  const strategyRecordsByName = new Map(strategyRecords.map((strategy) => [strategy.name, strategy]));
  const activeProfile = await getActiveRiskProfileReadOnly();

  const report = {
    generatedAt: new Date().toISOString(),
    finishedAt: null,
    readOnly: true,
    mutatesLiveConfig: false,
    range: { from: config.from, to: config.to },
    initialBalance: config.initialBalance,
    config,
    monthlyWindows,
    candidates: [],
    portfolioUniverse: [],
    portfolioUniverseWindowGroups: [],
    portfolio: null,
    portfolioValidation: null,
    compositePortfolio: null,
    errors: [],
  };
  writeReports(report, paths);

  const mt5 = typeof mt5RootService.getScopedService === 'function'
    ? mt5RootService.getScopedService(config.mt5Scope)
    : mt5RootService;
  if (typeof mt5.reloadConnectionEnvFromFile === 'function') mt5.reloadConnectionEnvFromFile();
  console.log('[StrictValidation] Connecting to MT5...');
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
    const monthlyResults = await runCandidateWindows({
      candidates,
      windows: monthlyWindows,
      config,
      getCachedCandles,
      strategyRecordsByName,
      activeProfile,
    });
    report.candidates = monthlyResults.map((entry) => ({
      ...entry,
      monthlyWindows: entry.windows,
      monthlySummary: summarizeWindows(entry.windows),
    })).map(({ windows, ...entry }) => entry);

    const universe = selectPortfolioUniverse(report.candidates, config.portfolioUniverse);
    report.portfolioUniverse = universe.map((entry) => ({
      validationId: entry.validationId,
      combo: comboKey(entry),
      source: entry.source,
      monthlySummary: entry.monthlySummary,
      parameters: entry.parameters,
    }));
    report.portfolio = searchPortfolio(universe, monthlyWindows, config);
    writeReports(report, paths);

    const validationSets = {
      quarters: buildQuarterWindows(from, to),
      rolling60: buildRollingWindows(from, to, 60, 30),
      rolling90: buildRollingWindows(from, to, 90, 30),
    };
    const universeValidation = {};
    for (const [key, windows] of Object.entries(validationSets)) {
      console.log(`[StrictValidation] Universe ${key} validation (${windows.length} windows)`);
      universeValidation[key] = await runCandidateWindows({
        candidates: universe,
        windows,
        config,
        getCachedCandles,
        strategyRecordsByName,
        activeProfile,
      });
    }

    if (report.portfolio?.best?.weights?.length) {
      report.portfolioValidation = Object.fromEntries(
        Object.entries(validationSets).map(([key, windows]) => [
          key,
          evaluatePortfolioWindows(
            report.portfolio.best.weights,
            universeValidation[key],
            windows,
            config.initialBalance
          ),
        ])
      );
    }

    const universeWithGroups = universe.map((entry) => ({
      ...entry,
      windowGroups: {
        monthly: entry.monthlyWindows,
        quarters: universeValidation.quarters.find((item) => item.validationId === entry.validationId)?.windows || [],
        rolling60: universeValidation.rolling60.find((item) => item.validationId === entry.validationId)?.windows || [],
        rolling90: universeValidation.rolling90.find((item) => item.validationId === entry.validationId)?.windows || [],
      },
    }));
    report.portfolioUniverseWindowGroups = universeWithGroups.map((entry) => ({
      validationId: entry.validationId,
      combo: comboKey(entry),
      source: entry.source,
      parameters: entry.parameters,
      windowGroups: entry.windowGroups,
    }));
    report.compositePortfolio = searchCompositePortfolio(
      universeWithGroups,
      { monthly: monthlyWindows, ...validationSets },
      config
    );

    report.finishedAt = new Date().toISOString();
    writeReports(report, paths);
  } finally {
    if (mt5.isConnected()) await mt5.disconnect().catch(() => {});
  }

  console.log('[StrictValidation] Complete');
  console.log(`JSON: ${paths.json}`);
  console.log(`CSV: ${paths.csv}`);
  console.log(`MD: ${paths.md}`);
}

main().catch((error) => {
  console.error(`[StrictValidation] Fatal: ${error.message}`);
  process.exitCode = 1;
});
