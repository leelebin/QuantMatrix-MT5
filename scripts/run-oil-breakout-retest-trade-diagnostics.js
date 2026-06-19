const fs = require('fs');
const path = require('path');

const mt5PaperService = require('../src/services/mt5Service').paper;
const SymbolCustom = require('../src/models/SymbolCustom');
const instruments = require('../src/config/instruments');
const { getSymbolCustomLogic } = require('../src/symbolCustom/registry');
const { runSymbolCustomBacktestSimulation } = require('../src/services/symbolCustomBacktestRunnerService');
const XbrusdOilBreakoutRetestV1 = require('../src/symbolCustom/logics/XbrusdOilBreakoutRetestV1');

const OUTPUT_DIR = path.resolve(__dirname, '..', 'reports');
const INITIAL_BALANCE = 500;
const DEFAULT_START_DATE = '2025-01-01';
const DEFAULT_END_DATE = '2026-06-05';
const TARGET_LOGICS = Object.freeze([
  'XBRUSD_OIL_BREAKOUT_RETEST_V1',
  'XBRUSD_OIL_LONG_RETEST_SESSION_V2',
  'XTIUSD_OIL_BREAKOUT_RETEST_V1',
]);
const DEFAULT_FETCH_LIMITS = Object.freeze({
  '5m': 250000,
  '1h': 40000,
  '4h': 15000,
});
const LOCAL_ARCHIVED_LOGICS = Object.freeze({
  XBRUSD_OIL_BREAKOUT_RETEST_V1: XbrusdOilBreakoutRetestV1,
});

function getArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function splitArg(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIndexList(value, fallback = [1]) {
  const values = splitArg(value)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
  return values.length ? values : fallback;
}

function parseBooleanArg(name) {
  const value = getArg(name);
  if (value == null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return undefined;
}

function parseNumberArg(name) {
  const value = getArg(name);
  if (value == null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function getTime(candle = {}) {
  return candle.time || candle.timestamp || candle.date || null;
}

function normalizeCandles(candles = []) {
  return (Array.isArray(candles) ? candles : [])
    .map((candle) => {
      const volume = Number(candle.volume);
      const tickVolume = Number(candle.tickVolume ?? candle.tick_volume);
      return {
        time: getTime(candle),
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
        volume: Number.isFinite(volume) && volume > 0
          ? volume
          : (Number.isFinite(tickVolume) ? tickVolume : 0),
        spread: candle.spread == null ? undefined : Number(candle.spread),
      };
    })
    .filter((candle) => candle.time
      && Number.isFinite(candle.open)
      && Number.isFinite(candle.high)
      && Number.isFinite(candle.low)
      && Number.isFinite(candle.close))
    .sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime());
}

function toDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function endExclusive(endDate) {
  const end = toDate(endDate);
  end.setUTCDate(end.getUTCDate() + 1);
  return end;
}

function shiftMonths(endDate, months) {
  const date = toDate(endDate);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}

function dateKey(value) {
  const date = value instanceof Date ? value : toDate(value);
  return date.toISOString().slice(0, 10);
}

function addMonths(dateValue, months) {
  const date = dateValue instanceof Date ? new Date(dateValue.getTime()) : toDate(dateValue);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date;
}

function compareDateKeys(left, right) {
  return Date.parse(`${left}T00:00:00.000Z`) - Date.parse(`${right}T00:00:00.000Z`);
}

function buildWindows({ startDate, endDate, recentMonths, segmentMode = 'default' }) {
  const windows = [
    { label: 'full_window', startDate, endDate },
    { label: 'recent_window', startDate: shiftMonths(endDate, recentMonths), endDate },
  ];

  if (segmentMode !== 'half-year') return windows;

  let cursor = toDate(startDate);
  const end = toDate(endDate);
  while (cursor < end) {
    const segmentStart = dateKey(cursor);
    const segmentEndDate = addMonths(cursor, 6);
    const segmentEnd = dateKey(segmentEndDate < end ? segmentEndDate : end);
    if (compareDateKeys(segmentEnd, segmentStart) <= 0) break;
    const half = new Date(`${segmentStart}T00:00:00.000Z`).getUTCMonth() < 6 ? 'H1' : 'H2';
    const year = new Date(`${segmentStart}T00:00:00.000Z`).getUTCFullYear();
    windows.push({
      label: `${year}_${half}`,
      startDate: segmentStart,
      endDate: segmentEnd,
    });
    cursor = segmentEndDate;
  }

  return windows;
}

function getEpoch(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function filterWindow(candles = [], window) {
  const start = Date.parse(`${window.startDate}T00:00:00.000Z`);
  const end = endExclusive(window.endDate).getTime();
  return candles.filter((candle) => {
    const time = Date.parse(getTime(candle));
    return Number.isFinite(time) && time >= start && time < end;
  });
}

function round(value, digits = 4) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
}

function getInstrument(symbol) {
  if (typeof instruments.getInstrument === 'function') return instruments.getInstrument(symbol);
  return instruments.instruments?.[symbol] || null;
}

function buildCostModel(symbol) {
  const instrument = getInstrument(symbol) || {};
  const pipSize = Number(instrument.pipSize);
  const spreadPips = Number(instrument.spread);
  const resolvedPipSize = Number.isFinite(pipSize) && pipSize > 0 ? pipSize : 0.01;
  const resolvedSpreadPips = Number.isFinite(spreadPips) && spreadPips >= 0 ? spreadPips : 0;
  return {
    spread: resolvedSpreadPips * resolvedPipSize,
    slippage: 0.2 * resolvedPipSize,
    commissionPerTrade: 0,
    source: 'instrument_spread_plus_0_2_pip_slippage',
    instrumentSpreadPips: resolvedSpreadPips,
    pipSize: resolvedPipSize,
  };
}

function resolveDiagnosticLogic(logicName) {
  const registered = getSymbolCustomLogic(logicName);
  if (registered) return registered;
  const LogicClass = LOCAL_ARCHIVED_LOGICS[logicName];
  return LogicClass ? new LogicClass() : null;
}

function resolveTimeframes(symbolCustom = {}) {
  const timeframes = symbolCustom.timeframes || {};
  const params = symbolCustom.parameters || {};
  return {
    setup: timeframes.setupTimeframe || params.setupTimeframe || '1h',
    entry: timeframes.entryTimeframe || params.entryTimeframe || '5m',
    higher: timeframes.higherTimeframe || params.higherTimeframe || '4h',
  };
}

function summarizeCandles(candles = []) {
  return {
    count: candles.length,
    first: candles[0]?.time || null,
    last: candles.at(-1)?.time || null,
  };
}

function compactSummary(simulation) {
  const summary = simulation.summary || {};
  return {
    trades: summary.trades,
    wins: summary.wins,
    losses: summary.losses,
    netPnl: round(summary.netPnl),
    profitFactor: round(summary.profitFactor),
    winRate: round(summary.winRate),
    avgR: round(summary.avgR),
    maxDrawdown: round(summary.maxDrawdown),
    maxConsecutiveLosses: summary.maxConsecutiveLosses,
    finalBalance: round(simulation.finalBalance ?? summary.finalBalance),
  };
}

function calculateMaxConsecutiveLosses(trades = []) {
  let max = 0;
  let current = 0;
  trades.forEach((trade) => {
    if (Number(trade.pnl) < 0) {
      current += 1;
      max = Math.max(max, current);
    } else if (Number(trade.pnl) > 0) {
      current = 0;
    }
  });
  return max;
}

function summarizeTrades(trades = []) {
  const wins = trades.filter((trade) => Number(trade.pnl) > 0);
  const losses = trades.filter((trade) => Number(trade.pnl) < 0);
  const grossWin = wins.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const grossLoss = losses.reduce((sum, trade) => sum + Math.abs(Number(trade.pnl || 0)), 0);
  const netPnl = trades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const rValues = trades.map((trade) => Number(trade.rMultiple)).filter(Number.isFinite);
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    netPnl: round(netPnl),
    grossWin: round(grossWin),
    grossLoss: round(grossLoss),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : (grossWin > 0 ? null : null),
    winRate: trades.length ? round(wins.length / trades.length) : null,
    avgR: rValues.length ? round(rValues.reduce((sum, value) => sum + value, 0) / rValues.length) : null,
    avgWin: wins.length ? round(grossWin / wins.length) : 0,
    avgLoss: losses.length ? round(grossLoss / losses.length) : 0,
    maxConsecutiveLosses: calculateMaxConsecutiveLosses(trades),
  };
}

function groupTrades(trades = [], keyFn) {
  const groups = new Map();
  trades.forEach((trade) => {
    const key = keyFn(trade);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  });
  return [...groups.entries()]
    .map(([key, group]) => ({ key, ...summarizeTrades(group) }))
    .sort((left, right) => {
      if (left.netPnl !== right.netPnl) return left.netPnl - right.netPnl;
      return right.trades - left.trades;
    });
}

function monthKey(time) {
  const epoch = getEpoch(time);
  if (epoch == null) return 'UNKNOWN';
  return new Date(epoch).toISOString().slice(0, 7);
}

function quarterKey(time) {
  const epoch = getEpoch(time);
  if (epoch == null) return 'UNKNOWN';
  const date = new Date(epoch);
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `${date.getUTCFullYear()}-Q${quarter}`;
}

function weekdayKey(time) {
  const epoch = getEpoch(time);
  if (epoch == null) return 'UNKNOWN';
  return String(new Date(epoch).getUTCDay());
}

function extractTradeFeature(trade = {}, path) {
  return path.split('.').reduce((value, part) => (value && value[part] !== undefined ? value[part] : undefined), trade);
}

function numericBucket(value, bucketSize, fallback = 'UNKNOWN') {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const start = Math.floor(number / bucketSize) * bucketSize;
  const end = start + bucketSize;
  return `${round(start, 2)}..${round(end, 2)}`;
}

function buildDiagnostics(trades = []) {
  return {
    summary: summarizeTrades(trades),
    bySide: groupTrades(trades, (trade) => trade.side || 'UNKNOWN'),
    byEntryHourUtc: groupTrades(trades, (trade) => String(trade.entryHourUtc ?? 'UNKNOWN')),
    byWeekdayUtc: groupTrades(trades, (trade) => weekdayKey(trade.entryTime)),
    byMonth: groupTrades(trades, (trade) => monthKey(trade.entryTime)),
    byQuarter: groupTrades(trades, (trade) => quarterKey(trade.entryTime)),
    byExitReason: groupTrades(trades, (trade) => trade.exitReason || 'UNKNOWN'),
    byHtfRegime: groupTrades(trades, (trade) => extractTradeFeature(trade, 'executionSignal.metadata.htfRegime') || 'UNKNOWN'),
    byBreakDistanceAtrBucket: groupTrades(
      trades,
      (trade) => numericBucket(extractTradeFeature(trade, 'executionSignal.metadata.breakDistanceAtr'), 0.25)
    ),
    worstMonths: groupTrades(trades, (trade) => monthKey(trade.entryTime)).slice(0, 8),
    worstHours: groupTrades(trades, (trade) => String(trade.entryHourUtc ?? 'UNKNOWN')).slice(0, 8),
  };
}

function buildCandidateParameters(symbolCustom = {}) {
  const base = {
    ...(symbolCustom.parameters || {}),
    maxDailyTrades: 0,
  };
  const allowedHours = [
    base.allowedUtcHours || '7,8,9,10,13,14,15,16,17,18',
    '13,14,15,16,17,18',
    '7,8,9,10',
  ];
  const candidates = [];
  for (const hours of allowedHours) {
    for (const requireHigherTrendAlignment of [false, true]) {
      for (const maxDailyLosses of [1, 2]) {
        for (const minConfidence of [0.55, 0.62, 0.68]) {
          candidates.push({
            ...base,
            allowedUtcHours: hours,
            requireHigherTrendAlignment,
            maxDailyLosses,
            minConfidence,
            maxDailyTrades: 0,
          });
        }
      }
    }
  }
  return candidates;
}

function buildCliParameterOverrides() {
  const overrides = {};
  const allowedHours = getArg('--allowed-hours');
  const blockedHours = getArg('--blocked-hours');
  const enableBuy = parseBooleanArg('--enable-buy');
  const enableSell = parseBooleanArg('--enable-sell');
  const requireHigherTrendAlignment = parseBooleanArg('--require-higher-trend-alignment');
  const minConfidence = parseNumberArg('--min-confidence');
  const maxDailyLosses = parseNumberArg('--max-daily-losses');
  const maxDailyTrades = parseNumberArg('--max-daily-trades');

  if (allowedHours != null) overrides.allowedUtcHours = allowedHours;
  if (blockedHours != null) overrides.blockedUtcHours = blockedHours;
  if (enableBuy !== undefined) overrides.enableBuy = enableBuy;
  if (enableSell !== undefined) overrides.enableSell = enableSell;
  if (requireHigherTrendAlignment !== undefined) overrides.requireHigherTrendAlignment = requireHigherTrendAlignment;
  if (minConfidence !== undefined) overrides.minConfidence = minConfidence;
  if (maxDailyLosses !== undefined) overrides.maxDailyLosses = maxDailyLosses;
  if (maxDailyTrades !== undefined) overrides.maxDailyTrades = maxDailyTrades;

  return overrides;
}

async function fetchCandles(symbol, timeframes, startDate, endDate) {
  const uniqueTimeframes = [...new Set(Object.values(timeframes))];
  const fetchStart = toDate(startDate);
  const fetchEnd = endExclusive(endDate);
  const byTimeframe = {};

  for (const timeframe of uniqueTimeframes) {
    const explicitLimit = Number(getArg('--fetch-limit'));
    const limit = Number.isFinite(explicitLimit) && explicitLimit > 0
      ? explicitLimit
      : (DEFAULT_FETCH_LIMITS[timeframe] || 250000);
    console.log(`[Oil diagnostics] Fetching ${symbol} ${timeframe} limit=${limit}`);
    byTimeframe[timeframe] = normalizeCandles(
      await mt5PaperService.getCandles(symbol, timeframe, fetchStart, limit, fetchEnd)
    );
    console.log(`[Oil diagnostics] Fetched ${byTimeframe[timeframe].length} ${symbol} ${timeframe}`);
  }

  return {
    setup: byTimeframe[timeframes.setup],
    entry: byTimeframe[timeframes.entry],
    higher: byTimeframe[timeframes.higher],
  };
}

async function runSimulationQuietly(payload) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await runSymbolCustomBacktestSimulation(payload);
  } finally {
    console.log = originalLog;
  }
}

async function runDiagnosticWindow({ symbolCustom, logic, logicName, candles, parameters, costModel, window }) {
  const windowCandles = {
    setup: filterWindow(candles.setup, window),
    entry: filterWindow(candles.entry, window),
    higher: filterWindow(candles.higher, window),
  };
  const simulation = await runSimulationQuietly({
    symbolCustom,
    logic,
    logicName,
    candles: windowCandles,
    parameters,
    costModel,
    initialBalance: INITIAL_BALANCE,
    options: {},
  });
  return {
    label: window.label,
    range: window,
    candleCounts: {
      setup: windowCandles.setup.length,
      entry: windowCandles.entry.length,
      higher: windowCandles.higher.length,
    },
    summary: compactSummary(simulation),
    diagnostics: buildDiagnostics(simulation.trades || []),
  };
}

async function runTarget(symbolCustom, windows, candidateIndices, parameterOverrides = {}) {
  const logicName = symbolCustom.logicName || symbolCustom.registryLogicName || symbolCustom.symbolCustomName;
  const logic = resolveDiagnosticLogic(logicName);
  if (!logic) {
    return { symbolCustomName: symbolCustom.symbolCustomName, logicName, skipped: true, skipReason: 'LOGIC_NOT_REGISTERED' };
  }

  const timeframes = resolveTimeframes(symbolCustom);
  const candles = await fetchCandles(symbolCustom.symbol, timeframes, windows[0].startDate, windows[0].endDate);
  const costModel = buildCostModel(symbolCustom.symbol);
  const allCandidateParameters = buildCandidateParameters(symbolCustom);
  const candidateReports = [];

  for (const candidateIndex of candidateIndices) {
    const baseParameters = allCandidateParameters[candidateIndex - 1];
    if (!baseParameters) {
      candidateReports.push({ candidateIndex, skipped: true, skipReason: 'CANDIDATE_INDEX_OUT_OF_RANGE' });
      continue;
    }
    const parameters = {
      ...baseParameters,
      ...parameterOverrides,
    };

    const results = [];
    for (const window of windows) {
      results.push(await runDiagnosticWindow({
        symbolCustom,
        logic,
        logicName,
        candles,
        parameters,
        costModel,
        window,
      }));
    }
    candidateReports.push({
      candidateIndex,
      parameters: {
        allowedUtcHours: parameters.allowedUtcHours,
        requireHigherTrendAlignment: parameters.requireHigherTrendAlignment,
        maxDailyLosses: parameters.maxDailyLosses,
        minConfidence: parameters.minConfidence,
      },
      results,
    });
  }

  return {
    symbolCustomId: symbolCustom._id,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName,
    symbol: symbolCustom.symbol,
    status: symbolCustom.status,
    flags: {
      paperEnabled: symbolCustom.paperEnabled === true,
      liveEnabled: symbolCustom.liveEnabled === true,
      allowLive: symbolCustom.allowLive === true,
      isPrimaryLive: symbolCustom.isPrimaryLive === true,
    },
    timeframes,
    costModel,
    candleCoverage: {
      setup: summarizeCandles(candles.setup),
      entry: summarizeCandles(candles.entry),
      higher: summarizeCandles(candles.higher),
    },
    candidates: candidateReports,
  };
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const startDate = getArg('--start', DEFAULT_START_DATE);
  const endDate = getArg('--end', DEFAULT_END_DATE);
  const recentMonths = Math.max(1, Number(getArg('--recent-months', 6)) || 6);
  const symbols = new Set(splitArg(getArg('--symbols')).map((symbol) => symbol.toUpperCase()));
  const names = new Set(splitArg(getArg('--names')));
  const candidateIndices = parseIndexList(getArg('--candidate-indices'), [1]);
  const parameterOverrides = buildCliParameterOverrides();
  const segmentMode = String(getArg('--segment-mode', 'default') || 'default').trim().toLowerCase();
  const outputPath = getArg('--out')
    ? path.resolve(process.cwd(), getArg('--out'))
    : path.join(OUTPUT_DIR, `oil-breakout-retest-trade-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const windows = buildWindows({ startDate, endDate, recentMonths, segmentMode });

  const symbolCustoms = (await SymbolCustom.findAll({}))
    .filter((record) => {
      const logicName = record.logicName || record.registryLogicName || record.symbolCustomName;
      if (!TARGET_LOGICS.includes(logicName)) return false;
      if (symbols.size > 0 && !symbols.has(String(record.symbol || '').toUpperCase())) return false;
      if (names.size > 0 && !names.has(record.symbolCustomName) && !names.has(logicName)) return false;
      return true;
    })
    .sort((left, right) => String(left.symbolCustomName).localeCompare(String(right.symbolCustomName)));

  console.log(`[Oil diagnostics] Selected ${symbolCustoms.length} SymbolCustoms`);
  await mt5PaperService.connect();

  const reports = [];
  for (const symbolCustom of symbolCustoms) {
    console.log(`[Oil diagnostics] Starting ${symbolCustom.symbolCustomName}`);
    reports.push(await runTarget(symbolCustom, windows, candidateIndices, parameterOverrides));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    method: 'Read-only trade diagnostics for oil breakout-retest SymbolCustom candidates. DB and strategy flags are not mutated.',
    initialBalance: INITIAL_BALANCE,
    windows,
    candidateIndices,
    parameterOverrides,
    segmentMode,
    reports,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    outputPath,
    reports: reports.map((row) => ({
      symbolCustomName: row.symbolCustomName,
      skipped: row.skipped === true,
      skipReason: row.skipReason || null,
      candidates: (row.candidates || []).map((candidate) => ({
        candidateIndex: candidate.candidateIndex,
        parameters: candidate.parameters,
        windows: Object.fromEntries((candidate.results || []).map((result) => [
          result.label,
          {
            summary: result.summary,
            worstHours: result.diagnostics.worstHours,
            worstMonths: result.diagnostics.worstMonths.slice(0, 5),
            bySide: result.diagnostics.bySide,
          },
        ])),
      })),
    })),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mt5PaperService.disconnect();
  });
