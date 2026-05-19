#!/usr/bin/env node

/**
 * Read-only intrabar BE/trailing validation.
 *
 * This script reuses the optimizer selection best parameters, runs the normal
 * 1h backtest, then replays the resulting entries with conservative OHLC and
 * lower-timeframe management. It writes reports only under reports/.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const mt5Service = require('../src/services/mt5Service');
const backtestEngine = require('../src/services/backtestEngine');
const Strategy = require('../src/models/Strategy');
const StrategyInstance = require('../src/models/StrategyInstance');
const RiskProfile = require('../src/models/RiskProfile');
const breakevenService = require('../src/services/breakevenService');
const instrumentValuation = require('../src/utils/instrumentValuation');
const { buildOptimizerRecommendation } = require('../src/utils/optimizerRecommendations');
const { getInstrument } = require('../src/config/instruments');
const { getStrategyExecutionConfig } = require('../src/config/strategyExecution');
const { resolveStrategyParameters } = require('../src/config/strategyParameters');
const { resolveExecutionPolicy } = require('../src/services/executionPolicyService');
const {
  DEFAULT_WARMUP_BARS,
  estimateFetchLimit,
  filterCandlesByRange,
  getWarmupStart,
} = require('../src/utils/candleRange');

const TARGETS = [
  ['Momentum', 'EURUSD', '1h'],
  ['MeanReversion', 'US30', '1h'],
  ['MultiTimeframe', 'NAS100', '1h'],
  ['Breakout', 'XAUUSD', '1h'],
  ['Momentum', 'XAGUSD', '1h'],
  ['Breakout', 'NAS100', '1h'],
];

const LOWER_TF_CANDIDATES = ['1m', '5m'];
const REPORT_DATE = localDateString();

function localDateString() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function parseArgs(argv) {
  const args = {};
  argv.slice(2).forEach((entry) => {
    if (!entry.startsWith('--')) return;
    const [rawKey, ...rest] = entry.slice(2).split('=');
    args[rawKey] = rest.length > 0 ? rest.join('=') : 'true';
  });
  return args;
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

function numeric(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatNumber(value, digits = 2) {
  const parsed = numeric(value);
  return parsed == null ? '' : parsed.toFixed(digits);
}

function safeText(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '/').trim();
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

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toTimeMs(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function countExitReasons(trades = []) {
  const counts = {
    tpHits: 0,
    slHits: 0,
    beExits: 0,
    trailingExits: 0,
  };

  trades.forEach((trade) => {
    if (trade.exitReason === 'TP_HIT') counts.tpHits += 1;
    if (trade.exitReason === 'INITIAL_SL_HIT' || trade.exitReason === 'PROTECTIVE_SL_HIT') counts.slHits += 1;
    if (trade.exitReason === 'BREAKEVEN_SL_HIT' || trade.exitReason === 'BREAKEVEN') counts.beExits += 1;
    if (trade.exitReason === 'TRAILING_SL_HIT' || trade.exitReason === 'TRAILING_STOP') counts.trailingExits += 1;
  });

  return counts;
}

function buildCandleCache(mt5) {
  const cache = new Map();
  return async function getCachedCandles(symbol, timeframe, fetchStart, limit, endExclusive) {
    const key = [symbol, timeframe, fetchStart.toISOString(), endExclusive.toISOString(), limit].join('|');
    if (!cache.has(key)) {
      cache.set(key, mt5.getCandles(symbol, timeframe, fetchStart, limit, endExclusive));
    }
    return cache.get(key);
  };
}

async function fetchPrimaryBundle({ cache, symbol, executionConfig, start, endExclusive }) {
  const timeframe = executionConfig.timeframe || '1h';
  const fetchStart = getWarmupStart(start, timeframe, DEFAULT_WARMUP_BARS);
  const candleLimit = estimateFetchLimit(timeframe, fetchStart, endExclusive);
  const primaryRaw = await cache(symbol, timeframe, fetchStart, candleLimit, endExclusive);
  const candles = filterCandlesByRange(primaryRaw, fetchStart, endExclusive);
  const inRangeCandles = filterCandlesByRange(primaryRaw, start, endExclusive);

  let higherTfCandles = null;
  if (executionConfig.higherTimeframe) {
    const higherStart = getWarmupStart(start, executionConfig.higherTimeframe, DEFAULT_WARMUP_BARS);
    const higherLimit = estimateFetchLimit(executionConfig.higherTimeframe, higherStart, endExclusive);
    const higherRaw = await cache(symbol, executionConfig.higherTimeframe, higherStart, higherLimit, endExclusive);
    higherTfCandles = filterCandlesByRange(higherRaw, higherStart, endExclusive);
  }

  let lowerTfCandles = null;
  if (executionConfig.entryTimeframe) {
    const lowerStart = getWarmupStart(start, executionConfig.entryTimeframe, DEFAULT_WARMUP_BARS);
    const lowerLimit = estimateFetchLimit(executionConfig.entryTimeframe, lowerStart, endExclusive);
    const lowerRaw = await cache(symbol, executionConfig.entryTimeframe, lowerStart, lowerLimit, endExclusive);
    lowerTfCandles = filterCandlesByRange(lowerRaw, lowerStart, endExclusive);
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
    tradeStartTime: effectiveStart.toISOString(),
    tradeEndTime: effectiveEnd.toISOString(),
    fetchMeta: {
      primaryRawCount: Array.isArray(primaryRaw) ? primaryRaw.length : 0,
      primaryWithWarmup: candles.length,
      primaryInRange: inRangeCandles.length,
      higherCount: higherTfCandles ? higherTfCandles.length : 0,
      lowerCount: lowerTfCandles ? lowerTfCandles.length : 0,
    },
  };
}

async function fetchBestLowerTf({ cache, symbol, start, endExclusive }) {
  const attempts = [];
  for (const timeframe of LOWER_TF_CANDIDATES) {
    try {
      const fetchStart = getWarmupStart(start, timeframe, 5);
      const candleLimit = estimateFetchLimit(timeframe, fetchStart, endExclusive, 100);
      const raw = await cache(symbol, timeframe, fetchStart, candleLimit, endExclusive);
      const candles = filterCandlesByRange(raw, fetchStart, endExclusive);
      const inRange = filterCandlesByRange(raw, start, endExclusive);
      attempts.push({
        timeframe,
        count: candles.length,
        inRangeCount: inRange.length,
        error: null,
      });
      if (inRange.length > 0) {
        return { timeframe, candles, attempts };
      }
    } catch (error) {
      attempts.push({ timeframe, count: 0, inRangeCount: 0, error: error.message });
    }
  }

  return { timeframe: null, candles: [], attempts };
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
    breakevenConfig: breakevenService.resolveEffectiveBreakeven(activeProfile, mergedStrategy),
    executionPolicy: resolveExecutionPolicy(
      strategyRecord?.executionPolicy || null,
      storedInstance?.executionPolicy || null
    ),
  };
}

function inferAtrAtEntry(trade, parameters) {
  const slDistance = Math.abs(Number(trade.entryPrice) - Number(trade.sl));
  const slMultiplier = numeric(parameters?.slMultiplier, null);
  if (slDistance > 0 && slMultiplier && slMultiplier > 0) {
    return slDistance / slMultiplier;
  }
  return slDistance || 0;
}

function buildReplayPosition({ trade, parameters, breakevenConfig, costModelUsed }) {
  const slDistance = Math.abs(Number(trade.entryPrice) - Number(trade.sl));
  const tpDistance = Math.abs(Number(trade.tp) - Number(trade.entryPrice));
  return {
    id: trade.id,
    type: trade.type,
    entryPrice: trade.entryPrice,
    entryTime: trade.entryTime,
    sl: trade.sl,
    tp: trade.tp,
    currentSl: trade.sl,
    breakevenActivated: false,
    trailingActivated: false,
    breakevenPhase: null,
    lotSize: trade.lotSize,
    atrAtEntry: inferAtrAtEntry(trade, parameters),
    breakevenConfig,
    costModel: costModelUsed?.costModel || null,
    costModelSources: costModelUsed?.sources || [],
    plannedRiskAmount: Number(trade.plannedRiskAmount) || 0,
    targetRMultiple: slDistance > 0 ? parseFloat((tpDistance / slDistance).toFixed(4)) : null,
    reason: trade.reason || '',
    entryReason: trade.entryReason || '',
    setupReason: trade.setupReason || '',
    triggerReason: trade.triggerReason || '',
    executionScore: trade.executionScore ?? null,
    executionScoreDetails: trade.executionScoreDetails || null,
    executionPolicy: trade.executionPolicy || null,
    setupTimeframe: trade.setupTimeframe || null,
    entryTimeframe: trade.entryTimeframe || null,
    setupCandleTime: trade.setupCandleTime || null,
    entryCandleTime: trade.entryCandleTime || null,
    indicatorsSnapshot: trade.indicatorsAtEntry || null,
  };
}

function existingStopHit(position, candle) {
  if (position.type === 'BUY') {
    return candle.low <= position.currentSl;
  }
  return candle.high >= position.currentSl;
}

function tpHit(position, candle) {
  if (position.type === 'BUY') {
    return candle.high >= position.tp;
  }
  return candle.low <= position.tp;
}

function stopTouchedAfterUpdate(position, candle) {
  if (position.type === 'BUY') {
    return candle.low <= position.currentSl;
  }
  return candle.high >= position.currentSl;
}

function updateProtectiveStop(position, candle, tradingInstrument) {
  const currentPrice = position.type === 'BUY' ? candle.high : candle.low;
  const result = breakevenService.calculateBreakevenStop(
    position,
    currentPrice,
    tradingInstrument,
    position.breakevenConfig || null
  );
  if (!result.shouldUpdate) {
    return { updated: false, phase: result.phase };
  }
  position.currentSl = result.newSl;
  if (result.phase === 'breakeven') {
    position.breakevenActivated = true;
    position.breakevenPhase = 'breakeven';
  } else if (result.phase === 'trailing') {
    position.breakevenActivated = true;
    position.trailingActivated = true;
    position.breakevenPhase = 'trailing';
  }
  return { updated: true, phase: result.phase };
}

function replayOneCandle(position, candle, tradingInstrument) {
  if (existingStopHit(position, candle)) {
    return {
      exitPrice: position.currentSl,
      reason: backtestEngine._classifyStopExitReason(position),
      intrabarEvent: 'existing_stop_before_tp',
    };
  }

  const update = updateProtectiveStop(position, candle, tradingInstrument);
  if (update.updated && stopTouchedAfterUpdate(position, candle)) {
    return {
      exitPrice: position.currentSl,
      reason: backtestEngine._classifyStopExitReason(position),
      intrabarEvent: `${update.phase}_same_candle_stop`,
    };
  }

  if (tpHit(position, candle)) {
    return {
      exitPrice: position.tp,
      reason: 'TP_HIT',
      intrabarEvent: update.updated ? `${update.phase}_then_tp` : 'tp',
    };
  }

  return null;
}

function filterReplayCandles(candles, startMs, endMs) {
  return candles.filter((candle) => {
    const time = toTimeMs(candle.time);
    return time >= startMs && time <= endMs;
  });
}

function replayTrades({ sourceTrades, replayCandles, replayTimeframe, tradingInstrument, currentBacktest, mode }) {
  const replayed = [];
  const events = {
    sameCandleProtectiveExits: 0,
    changedExitReason: 0,
    earlierExits: 0,
    laterExits: 0,
    sourceExitFallbacks: 0,
  };
  const parameters = currentBacktest.parameters || {};

  for (const sourceTrade of sourceTrades) {
    const position = buildReplayPosition({
      trade: sourceTrade,
      parameters,
      breakevenConfig: currentBacktest.breakevenConfigUsed,
      costModelUsed: currentBacktest.costModelUsed,
    });
    const entryMs = toTimeMs(position.entryTime);
    const sourceExitMs = toTimeMs(sourceTrade.exitTime);
    const candlesForTrade = filterReplayCandles(replayCandles, entryMs, sourceExitMs);
    let exit = null;
    for (const candle of candlesForTrade) {
      exit = replayOneCandle(position, candle, tradingInstrument);
      if (exit) {
        const replayedTrade = backtestEngine._closeTrade(
          position,
          exit.exitPrice,
          exit.reason,
          candle.time,
          tradingInstrument
        );
        replayedTrade.replayMode = mode;
        replayedTrade.replayTimeframe = replayTimeframe;
        replayedTrade.sourceExitTime = sourceTrade.exitTime;
        replayedTrade.sourceExitReason = sourceTrade.exitReason;
        replayedTrade.intrabarEvent = exit.intrabarEvent;
        if (exit.intrabarEvent && exit.intrabarEvent.includes('same_candle_stop')) {
          events.sameCandleProtectiveExits += 1;
        }
        if (replayedTrade.exitReason !== sourceTrade.exitReason) {
          events.changedExitReason += 1;
        }
        const replayExitMs = toTimeMs(replayedTrade.exitTime);
        const sourceExitMs = toTimeMs(sourceTrade.exitTime);
        if (replayExitMs < sourceExitMs) events.earlierExits += 1;
        if (replayExitMs > sourceExitMs) events.laterExits += 1;
        replayed.push(replayedTrade);
        break;
      }
    }

    if (!exit) {
      events.sourceExitFallbacks += 1;
      const replayedTrade = backtestEngine._closeTrade(
        position,
        sourceTrade.exitPrice,
        sourceTrade.exitReason,
        sourceTrade.exitTime,
        tradingInstrument
      );
      replayedTrade.replayMode = mode;
      replayedTrade.replayTimeframe = replayTimeframe;
      replayedTrade.sourceExitTime = sourceTrade.exitTime;
      replayedTrade.sourceExitReason = sourceTrade.exitReason;
      replayedTrade.intrabarEvent = 'source_exit_fallback';
      replayed.push(replayedTrade);
    }
  }

  return { trades: replayed, events };
}

function buildEquityCurveFromTrades(trades, initialBalance, startTime) {
  let balance = initialBalance;
  const points = [{ time: startTime || '', equity: initialBalance }];
  [...trades]
    .sort((a, b) => toTimeMs(a.exitTime) - toTimeMs(b.exitTime))
    .forEach((trade) => {
      balance += Number(trade.profitLoss) || 0;
      points.push({ time: trade.exitTime, equity: parseFloat(balance.toFixed(2)) });
    });
  return { equityCurve: points, finalBalance: parseFloat(balance.toFixed(2)) };
}

function summarizeReplay({ trades, initialBalance, startTime }) {
  const { equityCurve, finalBalance } = buildEquityCurveFromTrades(trades, initialBalance, startTime);
  return {
    summary: backtestEngine._generateSummary(trades, initialBalance, finalBalance, equityCurve),
    equityCurve,
    finalBalance,
  };
}

function summarizeMode({ mode, label, result, currentSummary, trades, events, recommendationContext }) {
  const summary = result.summary;
  const recommendation = buildOptimizerRecommendation({ summary }, recommendationContext);
  const exitCounts = countExitReasons(trades);
  const currentNet = numeric(currentSummary.netProfitMoney, 0);
  const currentRobust = numeric(currentSummary.robustScore, 0);
  const netDelta = numeric(summary.netProfitMoney, 0) - currentNet;
  const degradationPercent = currentNet !== 0
    ? parseFloat((((currentNet - numeric(summary.netProfitMoney, 0)) / Math.abs(currentNet)) * 100).toFixed(2))
    : null;
  return {
    mode,
    label,
    summary,
    recommendationTier: recommendation.tier,
    recommendation,
    exitCounts,
    breakevenTriggeredTrades: summary.breakevenTriggeredTrades,
    breakevenExitTrades: summary.breakevenExitTrades,
    differenceVsCurrentBacktest: {
      netProfitMoneyDelta: parseFloat(netDelta.toFixed(2)),
      returnPercentDelta: parseFloat((numeric(summary.returnPercent, 0) - numeric(currentSummary.returnPercent, 0)).toFixed(2)),
      profitFactorDelta: parseFloat((numeric(summary.profitFactor, 0) - numeric(currentSummary.profitFactor, 0)).toFixed(2)),
      robustScoreDelta: parseFloat((numeric(summary.robustScore, 0) - currentRobust).toFixed(2)),
      maxDrawdownPercentDelta: parseFloat((numeric(summary.maxDrawdownPercent, 0) - numeric(currentSummary.maxDrawdownPercent, 0)).toFixed(2)),
    },
    degradationPercent,
    events: events || {},
  };
}

function modeRowText(mode) {
  const s = mode.summary || {};
  return `${mode.recommendationTier} / trades ${s.totalTrades} / net ${formatNumber(s.netProfitMoney, 2)} / PF ${formatNumber(s.profitFactor, 2)} / return ${formatNumber(s.returnPercent, 2)}% / DD ${formatNumber(s.maxDrawdownPercent, 2)}% / robust ${formatNumber(s.robustScore, 1)} / BE exits ${mode.exitCounts.beExits} / trailing ${mode.exitCounts.trailingExits} / degradation ${mode.degradationPercent == null ? '' : `${formatNumber(mode.degradationPercent, 1)}%`}`;
}

function buildMarkdown(report) {
  const headers = [
    'strategy',
    'symbol',
    'currentBacktest',
    'conservativeOHLC',
    'lowerTfReplay',
    'biasFlag',
  ];
  const lines = [
    '# Intrabar BE / Trailing Validation Report',
    '',
    '## Run Config',
    `- generatedAt: ${report.generatedAt}`,
    `- source optimizer report: ${report.sourceOptimizerReport}`,
    `- date range: ${report.runConfig.from} to ${report.runConfig.to}`,
    '- method: original 1h entries are preserved; only post-entry SL/TP/BE/trailing management is replayed.',
    '- lowerTfReplay: M1 preferred, M5 fallback.',
    '- conservativeOHLC: when a candle can both improve stop and touch the improved stop, protective exit wins before TP.',
    '- restrictions: read-only; no DB writes; no apply; no live/paper status changes; no trading started.',
    '',
    '## Executive Summary',
    `- combinations checked: ${report.results.length}`,
    `- lowerTf degraded > 20%: ${report.results.filter((row) => row.biasFlags.lowerTfNetDegradationGt20).length}`,
    `- lowerTf tier downgraded: ${report.results.filter((row) => row.biasFlags.lowerTfTierDowngraded).length}`,
    `- conservative OHLC tier downgraded: ${report.results.filter((row) => row.biasFlags.conservativeTierDowngraded).length}`,
    '',
    '## Summary',
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];

  report.results.forEach((row) => {
    const current = row.modes.currentBacktest;
    const conservative = row.modes.conservativeOHLC;
    const lower = row.modes.lowerTfReplay;
    const flagText = Object.entries(row.biasFlags)
      .filter(([, value]) => value)
      .map(([key]) => key)
      .join(', ') || 'None';
    lines.push(`| ${[
      row.strategy,
      row.symbol,
      modeRowText(current),
      modeRowText(conservative),
      `${lower.replayTimeframe || row.lowerReplayTimeframe}: ${modeRowText(lower)}`,
      flagText,
    ].map(safeText).join(' | ')} |`);
  });

  lines.push('', '## Details');
  report.results.forEach((row) => {
    lines.push('', `### ${row.strategy} + ${row.symbol} + ${row.timeframe}`);
    lines.push(`- lower timeframe used: ${row.lowerReplayTimeframe || 'none'}; attempts: ${JSON.stringify(row.lowerTfAttempts)}`);
    ['currentBacktest', 'conservativeOHLC', 'lowerTfReplay'].forEach((key) => {
      const mode = row.modes[key];
      const s = mode.summary || {};
      lines.push(`- ${key}: totalTrades=${s.totalTrades}, net=${formatNumber(s.netProfitMoney, 2)}, PF=${formatNumber(s.profitFactor, 2)}, return=${formatNumber(s.returnPercent, 2)}%, maxDD=${formatNumber(s.maxDrawdownPercent, 2)}%, robustScore=${formatNumber(s.robustScore, 2)}, tier=${mode.recommendationTier}, BE triggered=${mode.breakevenTriggeredTrades}, BE exits=${mode.exitCounts.beExits}, TP=${mode.exitCounts.tpHits}, SL=${mode.exitCounts.slHits}, trailing=${mode.exitCounts.trailingExits}, diffNet=${formatNumber(mode.differenceVsCurrentBacktest.netProfitMoneyDelta, 2)}, degradation=${mode.degradationPercent == null ? 'n/a' : `${formatNumber(mode.degradationPercent, 2)}%`}`);
    });
  });

  return `${lines.join('\n')}\n`;
}

function buildCsv(report) {
  const headers = [
    'strategy',
    'symbol',
    'timeframe',
    'mode',
    'lowerReplayTimeframe',
    'totalTrades',
    'netProfitMoney',
    'profitFactor',
    'returnPercent',
    'maxDrawdownPercent',
    'robustScore',
    'breakevenTriggeredTrades',
    'breakevenExitTrades',
    'tpHits',
    'slHits',
    'beExits',
    'trailingExits',
    'recommendationTier',
    'netProfitDelta',
    'robustScoreDelta',
    'maxDrawdownDelta',
    'degradationPercent',
    'events',
  ];
  const rows = [headers.join(',')];
  report.results.forEach((group) => {
    Object.values(group.modes).forEach((mode) => {
      const s = mode.summary || {};
      rows.push([
        group.strategy,
        group.symbol,
        group.timeframe,
        mode.mode,
        group.lowerReplayTimeframe || '',
        s.totalTrades,
        s.netProfitMoney,
        s.profitFactor,
        s.returnPercent,
        s.maxDrawdownPercent,
        s.robustScore,
        mode.breakevenTriggeredTrades,
        mode.breakevenExitTrades,
        mode.exitCounts.tpHits,
        mode.exitCounts.slHits,
        mode.exitCounts.beExits,
        mode.exitCounts.trailingExits,
        mode.recommendationTier,
        mode.differenceVsCurrentBacktest.netProfitMoneyDelta,
        mode.differenceVsCurrentBacktest.robustScoreDelta,
        mode.differenceVsCurrentBacktest.maxDrawdownPercentDelta,
        mode.degradationPercent,
        JSON.stringify(mode.events || {}),
      ].map(csvEscape).join(','));
    });
  });
  return rows.join('\n');
}

function tierRank(tier) {
  return {
    LIVE_CANDIDATE: 3,
    PAPER_ONLY: 2,
    INSUFFICIENT_SAMPLE: 1,
    REJECT: 0,
  }[tier] ?? 0;
}

async function main() {
  const args = parseArgs(process.argv);
  const selectionPath = path.resolve(args.selection || `reports/optimizer-strategy-selection-${REPORT_DATE}.json`);
  const selection = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
  const start = new Date(selection.runConfig.from);
  const endExclusive = new Date(selection.runConfig.to);
  const initialBalance = numeric(selection.runConfig.initialBalance, 10000);

  const [strategyRecords, activeProfile] = await Promise.all([
    Strategy.findAll().catch(() => []),
    RiskProfile.getActive().catch(() => null),
  ]);
  const strategyByName = new Map(strategyRecords.map((record) => [record.name, record]));

  const mt5 = typeof mt5Service.getScopedService === 'function'
    ? mt5Service.getScopedService(args.mt5Scope || 'live')
    : mt5Service;
  if (typeof mt5.reloadConnectionEnvFromFile === 'function') {
    mt5.reloadConnectionEnvFromFile();
  }
  const cache = buildCandleCache(mt5);
  const results = [];

  console.log('[IntrabarBE] Connecting to MT5 for candle data...');
  await mt5.connect();
  try {
    for (const [strategy, symbol, timeframe] of TARGETS) {
      console.log(`[IntrabarBE] ${strategy} ${symbol} ${timeframe} starting...`);
      const selectionRow = (selection.results || []).find((row) => (
        row.strategy === strategy && row.symbol === symbol && row.timeframe === timeframe
      ));
      if (!selectionRow) {
        throw new Error(`Missing optimizer selection row for ${strategy} ${symbol} ${timeframe}`);
      }

      const executionConfig = getStrategyExecutionConfig(symbol, strategy);
      const primaryBundle = await fetchPrimaryBundle({ cache, symbol, executionConfig, start, endExclusive });
      const lowerBundle = await fetchBestLowerTf({ cache, symbol, start, endExclusive });
      const runtime = await buildEffectiveRuntime(strategy, symbol, strategyByName.get(strategy), activeProfile);
      const currentBacktest = await backtestEngine.simulate({
        symbol,
        strategyType: strategy,
        timeframe,
        candles: primaryBundle.candles,
        higherTfCandles: primaryBundle.higherTfCandles,
        lowerTfCandles: primaryBundle.lowerTfCandles,
        initialBalance,
        costModel: selectionRow.costModelUsed || null,
        tradeStartTime: primaryBundle.tradeStartTime,
        tradeEndTime: primaryBundle.tradeEndTime,
        strategyParams: selectionRow.bestParameters || {},
        storedStrategyParameters: runtime.storedParameters,
        breakevenConfig: runtime.breakevenConfig,
        executionPolicy: runtime.executionPolicy,
        executionConfigOverride: executionConfig,
      });

      const instrument = getInstrument(symbol);
      const tradingInstrument = backtestEngine._buildTradingInstrument(
        instrument,
        currentBacktest.parameters,
        strategy,
        executionConfig
      );

      const conservativeReplay = replayTrades({
        sourceTrades: currentBacktest.trades,
        replayCandles: primaryBundle.candles,
        replayTimeframe: timeframe,
        tradingInstrument,
        currentBacktest,
        mode: 'conservativeOHLC',
      });
      const conservativeSummary = summarizeReplay({
        trades: conservativeReplay.trades,
        initialBalance,
        startTime: primaryBundle.tradeStartTime,
      });

      const lowerReplay = replayTrades({
        sourceTrades: currentBacktest.trades,
        replayCandles: lowerBundle.candles.length ? lowerBundle.candles : primaryBundle.candles,
        replayTimeframe: lowerBundle.timeframe || timeframe,
        tradingInstrument,
        currentBacktest,
        mode: 'lowerTfReplay',
      });
      const lowerSummary = summarizeReplay({
        trades: lowerReplay.trades,
        initialBalance,
        startTime: primaryBundle.tradeStartTime,
      });

      const recommendationContext = { symbol, strategyType: strategy };
      const currentMode = summarizeMode({
        mode: 'currentBacktest',
        label: 'Current 1h backtest engine',
        result: currentBacktest,
        currentSummary: currentBacktest.summary,
        trades: currentBacktest.trades,
        events: {},
        recommendationContext,
      });
      const conservativeMode = summarizeMode({
        mode: 'conservativeOHLC',
        label: 'Conservative 1h OHLC management replay',
        result: conservativeSummary,
        currentSummary: currentBacktest.summary,
        trades: conservativeReplay.trades,
        events: conservativeReplay.events,
        recommendationContext,
      });
      const lowerMode = summarizeMode({
        mode: 'lowerTfReplay',
        label: 'M1/M5 intrabar management replay',
        result: lowerSummary,
        currentSummary: currentBacktest.summary,
        trades: lowerReplay.trades,
        events: lowerReplay.events,
        recommendationContext,
      });
      lowerMode.replayTimeframe = lowerBundle.timeframe || timeframe;

      const biasFlags = {
        lowerTfNetDegradationGt20: numeric(lowerMode.degradationPercent, 0) > 20,
        lowerTfTierDowngraded: tierRank(lowerMode.recommendationTier) < tierRank(currentMode.recommendationTier),
        lowerTfRobustDropGt20: Math.abs(numeric(lowerMode.differenceVsCurrentBacktest.robustScoreDelta, 0)) > 20
          && numeric(lowerMode.differenceVsCurrentBacktest.robustScoreDelta, 0) < 0,
        lowerTfMaxDdIncreaseGt5: numeric(lowerMode.differenceVsCurrentBacktest.maxDrawdownPercentDelta, 0) > 5,
        conservativeTierDowngraded: tierRank(conservativeMode.recommendationTier) < tierRank(currentMode.recommendationTier),
        conservativeNetDegradationGt20: numeric(conservativeMode.degradationPercent, 0) > 20,
        beExitsIncreasedLowerTf: lowerMode.exitCounts.beExits > currentMode.exitCounts.beExits,
        trailingExitsIncreasedLowerTf: lowerMode.exitCounts.trailingExits > currentMode.exitCounts.trailingExits,
      };

      results.push({
        strategy,
        symbol,
        timeframe,
        sourceOptimizerBucket: selectionRow.bucket,
        sourceOptimizerSummary: selectionRow.summary,
        fetchMeta: primaryBundle.fetchMeta,
        lowerReplayTimeframe: lowerBundle.timeframe,
        lowerTfAttempts: lowerBundle.attempts,
        modes: {
          currentBacktest: currentMode,
          conservativeOHLC: conservativeMode,
          lowerTfReplay: lowerMode,
        },
        biasFlags,
      });

      console.log(`[IntrabarBE] ${strategy} ${symbol}: current=${currentMode.recommendationTier} lower=${lowerMode.recommendationTier} lowerNet=${lowerMode.summary.netProfitMoney} degradation=${lowerMode.degradationPercent}`);
    }
  } finally {
    await mt5.disconnect().catch(() => {});
  }

  const report = {
    generatedAt: new Date().toISOString(),
    sourceOptimizerReport: selectionPath,
    runConfig: {
      from: selection.runConfig.from,
      to: selection.runConfig.to,
      initialBalance,
      lowerTfCandidates: LOWER_TF_CANDIDATES,
      method: 'Use current 1h entries from backtestEngine.simulate and replay only post-entry management.',
    },
    limitations: [
      'Replay keeps the original currentBacktest entry list fixed. If earlier exits would allow additional later signals, those extra entries are intentionally not added.',
      'Lower-timeframe OHLC still has unknown intra-bar path; replay uses conservative protective-stop-first ordering inside each lower candle.',
      'Max drawdown for replay modes is calculated from closed-trade equity points, while currentBacktest includes its native equity curve.',
    ],
    results,
  };

  const reportsDir = path.resolve(process.cwd(), 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const baseName = `intrabar-be-validation-${REPORT_DATE}`;
  const jsonPath = path.join(reportsDir, `${baseName}.json`);
  const mdPath = path.join(reportsDir, `${baseName}.md`);
  const csvPath = path.join(reportsDir, `${baseName}.csv`);
  fs.writeFileSync(jsonPath, JSON.stringify(jsonSafe(report), null, 2));
  fs.writeFileSync(mdPath, buildMarkdown(report));
  fs.writeFileSync(csvPath, buildCsv(report));

  console.log('\n[IntrabarBE] Complete');
  console.log(`Markdown: ${mdPath}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV: ${csvPath}`);
}

main().catch((error) => {
  console.error('[IntrabarBE] Fatal:', error.message);
  if (error.stack) console.error(error.stack);
  process.exitCode = 1;
});
