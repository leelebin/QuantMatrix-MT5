const fs = require('fs');
const path = require('path');

const mt5PaperService = require('../src/services/mt5Service').paper;
const { getSymbolCustomLogic } = require('../src/symbolCustom/registry');
const { runSymbolCustomBacktestSimulation } = require('../src/services/symbolCustomBacktestRunnerService');

const SYMBOL_CUSTOM_ID = '8TvnNqlIuKK5ABgi';
const SYMBOL = 'XAUUSD';
const LOGIC_NAME = 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1';
const INITIAL_BALANCE = 500;
const FETCH_LIMIT = 2000000;
const OUTPUT_PATH = path.resolve(__dirname, '..', 'reports', 'xauusd-volume-profile-sample-expansion-diagnostics-2026-06-05.json');
const PROGRESS_PATH = path.resolve(__dirname, '..', 'reports', 'xauusd-volume-profile-sample-expansion-diagnostics-progress.json');

const WINDOWS = Object.freeze([
  { label: 'full_window', startDate: '2023-05-30', endDate: '2026-05-30' },
  { label: 'recent_window', startDate: '2026-01-01', endDate: '2026-06-04' },
]);

const STRICT_COST_MODEL = Object.freeze({
  spread: 0.25,
  slippage: 0.002,
  commissionPerTrade: 0,
  source: 'instrument_average_spread_plus_0_2_pip_slippage',
  instrumentSpreadPips: 25,
  pipSize: 0.01,
});

function buildVariants(symbolCustom) {
  const current = symbolCustom.parameters || {};
  return [
    { name: 'current_db', patch: {} },
    {
      name: 'include_h03_buy_only',
      patch: {
        restrictEntrySessionUtc: true,
        entrySessionRangesUtc: [[1, 5], [15, 17]],
        enableBreakoutContinuation: true,
        enableExhaustionReversal: false,
        allowBuySignals: true,
        allowSellSignals: false,
        rvolContinuation: 1.65,
      },
    },
    {
      name: 'include_h03_buy_sell',
      patch: {
        restrictEntrySessionUtc: true,
        entrySessionRangesUtc: [[1, 5], [15, 17]],
        enableBreakoutContinuation: true,
        enableExhaustionReversal: false,
        allowBuySignals: true,
        allowSellSignals: true,
        rvolContinuation: 1.65,
      },
    },
    {
      name: 'wide_liquid_buy_only',
      patch: {
        restrictEntrySessionUtc: true,
        entrySessionRangesUtc: [[0, 8], [13, 18], [20, 24]],
        enableBreakoutContinuation: true,
        enableExhaustionReversal: false,
        allowBuySignals: true,
        allowSellSignals: false,
        rvolContinuation: 1.65,
      },
    },
    {
      name: 'all_hours_buy_only',
      patch: {
        restrictEntrySessionUtc: false,
        enableBreakoutContinuation: true,
        enableExhaustionReversal: false,
        allowBuySignals: true,
        allowSellSignals: false,
        rvolContinuation: 1.65,
      },
    },
    {
      name: 'all_hours_buy_sell',
      patch: {
        restrictEntrySessionUtc: false,
        enableBreakoutContinuation: true,
        enableExhaustionReversal: false,
        allowBuySignals: true,
        allowSellSignals: true,
        rvolContinuation: 1.65,
      },
    },
  ].map((variant) => ({
    ...variant,
    parameters: {
      ...current,
      ...variant.patch,
    },
  }));
}

function parseJsonLineDb(filePath) {
  const docs = new Map();
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const doc = JSON.parse(line);
    if (doc._deleted) docs.delete(doc._id);
    else docs.set(doc._id, doc);
  }
  return docs;
}

function loadSymbolCustom() {
  const docs = parseJsonLineDb(path.resolve(__dirname, '..', 'data', 'trading', 'symbol_customs.db'));
  const symbolCustom = docs.get(SYMBOL_CUSTOM_ID);
  if (!symbolCustom) throw new Error(`SymbolCustom not found: ${SYMBOL_CUSTOM_ID}`);
  return symbolCustom;
}

function round(value, digits = 4) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
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
      };
    })
    .filter((candle) => candle.time
      && Number.isFinite(candle.open)
      && Number.isFinite(candle.high)
      && Number.isFinite(candle.low)
      && Number.isFinite(candle.close))
    .sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime());
}

function endExclusive(endDate) {
  const end = new Date(`${endDate}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return end;
}

function filterWindow(candles = [], window) {
  const start = Date.parse(`${window.startDate}T00:00:00.000Z`);
  const end = endExclusive(window.endDate).getTime();
  return candles.filter((candle) => {
    const time = Date.parse(getTime(candle));
    return Number.isFinite(time) && time >= start && time < end;
  });
}

function summarizeCandles(candles = []) {
  return {
    count: candles.length,
    first: candles[0]?.time || null,
    last: candles.at(-1)?.time || null,
  };
}

function writeProgress(patch = {}) {
  const previous = fs.existsSync(PROGRESS_PATH)
    ? JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'))
    : {};
  const next = {
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(PROGRESS_PATH, `${JSON.stringify(next, null, 2)}\n`);
  if (patch.message) console.log(`[VolumeProfile sample diagnostics] ${patch.message}`);
}

function getTradeTime(trade = {}) {
  return trade.entryTime || trade.openTime || trade.time || trade.exitTime || null;
}

function keyFromTrade(trade, type) {
  const date = new Date(getTradeTime(trade));
  if (!Number.isFinite(date.getTime())) return 'UNKNOWN';
  const hour = String(date.getUTCHours()).padStart(2, '0');
  if (type === 'hour') return hour;
  if (type === 'sideHour') return `${trade.side || 'UNKNOWN'}_${hour}`;
  if (type === 'dow') return String(date.getUTCDay());
  if (type === 'month') return date.toISOString().slice(0, 7);
  if (type === 'year') return date.toISOString().slice(0, 4);
  if (type === 'side') return trade.side || 'UNKNOWN';
  return 'UNKNOWN';
}

function summarizeRows(rows = []) {
  const trades = rows.length;
  const wins = rows.filter((row) => row.pnl > 0).length;
  const losses = rows.filter((row) => row.pnl < 0).length;
  const netPnl = rows.reduce((sum, row) => sum + row.pnl, 0);
  const grossWin = rows.filter((row) => row.pnl > 0).reduce((sum, row) => sum + row.pnl, 0);
  const grossLoss = Math.abs(rows.filter((row) => row.pnl < 0).reduce((sum, row) => sum + row.pnl, 0));
  return {
    trades,
    wins,
    losses,
    netPnl: round(netPnl),
    grossWin: round(grossWin),
    grossLoss: round(grossLoss),
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : (grossWin > 0 ? null : 0),
    winRate: trades > 0 ? round(wins / trades) : 0,
    avgPnl: trades > 0 ? round(netPnl / trades) : 0,
    maxSingleLoss: rows.length ? round(Math.min(...rows.map((row) => row.pnl))) : 0,
    maxWin: rows.length ? round(Math.max(...rows.map((row) => row.pnl))) : 0,
  };
}

function groupTrades(rows = [], type) {
  const groups = new Map();
  rows.forEach((row) => {
    const key = type === 'exitReason'
      ? row.exitReason
      : type === 'moduleName'
        ? row.moduleName
        : keyFromTrade(row, type);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return [...groups.entries()]
    .map(([key, groupRows]) => ({ key, ...summarizeRows(groupRows) }))
    .sort((left, right) => {
      if (left.netPnl !== right.netPnl) return left.netPnl - right.netPnl;
      return left.key.localeCompare(right.key);
    });
}

function maxConsecutiveLosses(rows = []) {
  let current = 0;
  let max = 0;
  rows
    .slice()
    .sort((left, right) => Date.parse(left.exitTime || left.entryTime) - Date.parse(right.exitTime || right.entryTime))
    .forEach((row) => {
      if (row.pnl < 0) {
        current += 1;
        max = Math.max(max, current);
      } else {
        current = 0;
      }
    });
  return max;
}

function compactTrade(trade = {}) {
  return {
    entryTime: trade.entryTime || null,
    exitTime: trade.exitTime || null,
    side: trade.side || null,
    entryHourUtc: trade.entryHourUtc,
    pnl: round(trade.pnl),
    rMultiple: round(trade.rMultiple),
    exitReason: trade.exitReason || 'UNKNOWN',
    moduleName: trade.moduleName || 'UNKNOWN',
    confidence: round(trade.confidence),
  };
}

function compactSummary(simulation) {
  return {
    ...simulation.summary,
    netPnl: round(simulation.summary.netPnl),
    grossWin: round(simulation.summary.grossWin),
    grossLoss: round(simulation.summary.grossLoss),
    profitFactor: round(simulation.summary.profitFactor),
    winRate: round(simulation.summary.winRate),
    avgR: round(simulation.summary.avgR),
    maxDrawdown: round(simulation.summary.maxDrawdown),
    maxSingleLoss: round(simulation.summary.maxSingleLoss),
    maxWin: round(simulation.summary.maxWin),
    finalBalance: round(simulation.finalBalance ?? simulation.summary.finalBalance),
    rejectedSignalDetails: undefined,
    equityCurveHasBalance: simulation.equityCurve.some((point) => point.balance !== undefined),
    equityCurveHasEquity: simulation.equityCurve.some((point) => point.equity !== undefined),
  };
}

async function fetchCandles(symbolCustom) {
  const timeframes = symbolCustom.timeframes || {};
  const resolved = {
    setup: timeframes.setupTimeframe || '5m',
    entry: timeframes.entryTimeframe || '1m',
    higher: timeframes.higherTimeframe || '15m',
  };
  const fetchStart = new Date(`${WINDOWS[0].startDate}T00:00:00.000Z`);
  const fetchEnd = endExclusive(WINDOWS.at(-1).endDate);
  const uniqueTimeframes = [...new Set(Object.values(resolved))];
  const byTimeframe = {};

  await mt5PaperService.connect();
  for (const timeframe of uniqueTimeframes) {
    writeProgress({ message: `Fetching ${SYMBOL} ${timeframe}` });
    byTimeframe[timeframe] = normalizeCandles(
      await mt5PaperService.getCandles(SYMBOL, timeframe, fetchStart, FETCH_LIMIT, fetchEnd)
    );
    writeProgress({ message: `Fetched ${byTimeframe[timeframe].length} ${timeframe} candles` });
  }

  return {
    all: {
      setup: byTimeframe[resolved.setup],
      entry: byTimeframe[resolved.entry],
      higher: byTimeframe[resolved.higher],
    },
    timeframes: resolved,
  };
}

async function runVariantWindow({ symbolCustom, logic, candles, variant, window }) {
  const windowCandles = {
    setup: filterWindow(candles.setup, window),
    entry: filterWindow(candles.entry, window),
    higher: filterWindow(candles.higher, window),
  };
  const originalLog = console.log;
  console.log = () => {};
  try {
    const simulation = await runSymbolCustomBacktestSimulation({
      symbolCustom,
      logic,
      logicName: LOGIC_NAME,
      candles: windowCandles,
      parameters: variant.parameters,
      costModel: STRICT_COST_MODEL,
      initialBalance: INITIAL_BALANCE,
      options: {},
    });
    const trades = simulation.trades.map(compactTrade);
    return {
      label: window.label,
      range: window,
      candleCounts: {
        setup: windowCandles.setup.length,
        entry: windowCandles.entry.length,
        higher: windowCandles.higher.length,
      },
      summary: {
        ...compactSummary(simulation),
        maxConsecutiveLossesFromTrades: maxConsecutiveLosses(trades),
      },
      breakdowns: {
        bySide: groupTrades(trades, 'side'),
        bySideHour: groupTrades(trades, 'sideHour'),
        byHour: groupTrades(trades, 'hour'),
        byDow: groupTrades(trades, 'dow'),
        byMonth: groupTrades(trades, 'month'),
        byYear: groupTrades(trades, 'year'),
        byExitReason: groupTrades(trades, 'exitReason'),
        byModuleName: groupTrades(trades, 'moduleName'),
      },
      worstTrades: trades.slice().sort((left, right) => left.pnl - right.pnl).slice(0, 20),
      bestTrades: trades.slice().sort((left, right) => right.pnl - left.pnl).slice(0, 20),
    };
  } finally {
    console.log = originalLog;
  }
}

async function main() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const symbolCustom = loadSymbolCustom();
  const logic = getSymbolCustomLogic(LOGIC_NAME);
  if (!logic) throw new Error(`SymbolCustom logic not registered: ${LOGIC_NAME}`);
  const variants = buildVariants(symbolCustom);

  writeProgress({
    message: `Starting sample expansion diagnostics with ${variants.length} variants`,
    status: 'running',
    candidateCount: variants.length,
  });
  const fetched = await fetchCandles(symbolCustom);
  const results = [];

  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index];
    writeProgress({
      message: `Testing ${index + 1}/${variants.length}: ${variant.name}`,
      status: 'running',
      candidateIndex: index + 1,
      candidateCount: variants.length,
    });
    const windows = [];
    for (const window of WINDOWS) {
      windows.push(await runVariantWindow({ symbolCustom, logic, candles: fetched.all, variant, window }));
    }
    results.push({
      name: variant.name,
      patch: variant.patch,
      windows,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    symbolCustomId: SYMBOL_CUSTOM_ID,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName: LOGIC_NAME,
    symbol: SYMBOL,
    initialBalance: INITIAL_BALANCE,
    costModel: STRICT_COST_MODEL,
    timeframes: fetched.timeframes,
    candleCoverage: {
      setup: summarizeCandles(fetched.all.setup),
      entry: summarizeCandles(fetched.all.entry),
      higher: summarizeCandles(fetched.all.higher),
    },
    method: 'Read-only diagnostics for XAUUSD VolumeProfile sample expansion candidates. No DB mutation.',
    results,
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  writeProgress({ message: `Completed. Report: ${OUTPUT_PATH}`, status: 'completed', outputPath: OUTPUT_PATH });
  console.log(JSON.stringify({
    outputPath: OUTPUT_PATH,
    results: results.map((result) => ({
      name: result.name,
      windows: result.windows.map((window) => ({
        label: window.label,
        summary: window.summary,
        worstHours: window.breakdowns.byHour.slice(0, 8),
        bestHours: window.breakdowns.byHour.slice().sort((left, right) => right.netPnl - left.netPnl).slice(0, 8),
        side: window.breakdowns.bySide,
      })),
    })),
  }, null, 2));
}

main()
  .catch((error) => {
    writeProgress({ status: 'failed', message: error.message, error: error.stack || error.message });
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mt5PaperService.disconnect();
  });
