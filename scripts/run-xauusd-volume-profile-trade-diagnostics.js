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
const OUTPUT_PATH = path.resolve(__dirname, '..', 'reports', 'xauusd-volume-profile-trade-diagnostics-2026-06-04.json');
const PROGRESS_PATH = path.resolve(__dirname, '..', 'reports', 'xauusd-volume-profile-trade-diagnostics-progress.json');

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

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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
  if (patch.message) console.log(`[VolumeProfile diagnostics] ${patch.message}`);
}

function getTradeTime(trade = {}) {
  return trade.entryTime || trade.openTime || trade.time || trade.exitTime || null;
}

function keyFromTrade(trade, type) {
  const date = new Date(getTradeTime(trade));
  if (!Number.isFinite(date.getTime())) return 'UNKNOWN';
  if (type === 'hour') return String(date.getUTCHours()).padStart(2, '0');
  if (type === 'dow') return String(date.getUTCDay());
  if (type === 'month') return date.toISOString().slice(0, 7);
  if (type === 'quarter') return `${date.getUTCFullYear()} Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
  if (type === 'session') {
    const hour = date.getUTCHours();
    if (hour >= 1 && hour < 5) return 'asia_01_05';
    if (hour >= 15 && hour < 18) return 'ny_15_18';
    return `other_${String(hour).padStart(2, '0')}`;
  }
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
    pnl: round(trade.pnl),
    rMultiple: round(trade.rMultiple),
    exitReason: trade.exitReason || 'UNKNOWN',
    entryReason: trade.entryReason || null,
    moduleName: trade.moduleName || 'UNKNOWN',
    confidence: round(trade.confidence),
    entryPrice: round(trade.entryPrice),
    exitPrice: round(trade.exitPrice),
    sl: round(trade.sl),
    tp: round(trade.tp),
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

async function runWindow({ symbolCustom, logic, candles, window }) {
  const windowCandles = {
    setup: filterWindow(candles.setup, window),
    entry: filterWindow(candles.entry, window),
    higher: filterWindow(candles.higher, window),
  };
  const parameters = { ...(symbolCustom.parameters || {}) };
  const originalLog = console.log;
  console.log = () => {};
  try {
    const simulation = await runSymbolCustomBacktestSimulation({
      symbolCustom,
      logic,
      logicName: LOGIC_NAME,
      candles: windowCandles,
      parameters,
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
        bySession: groupTrades(trades, 'session'),
        byHour: groupTrades(trades, 'hour'),
        byDow: groupTrades(trades, 'dow'),
        byMonth: groupTrades(trades, 'month'),
        byQuarter: groupTrades(trades, 'quarter'),
        byExitReason: groupTrades(trades, 'exitReason'),
        byModuleName: groupTrades(trades, 'moduleName'),
      },
      worstTrades: trades.slice().sort((left, right) => left.pnl - right.pnl).slice(0, 20),
      bestTrades: trades.slice().sort((left, right) => right.pnl - left.pnl).slice(0, 20),
      trades,
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

  writeProgress({ message: 'Starting XAUUSD VolumeProfile diagnostics', status: 'running' });
  const fetched = await fetchCandles(symbolCustom);
  const windows = [];
  for (const window of WINDOWS) {
    writeProgress({ message: `Running ${window.label}`, status: 'running' });
    windows.push(await runWindow({ symbolCustom, logic, candles: fetched.all, window }));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    symbolCustomId: SYMBOL_CUSTOM_ID,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName: LOGIC_NAME,
    symbol: SYMBOL,
    initialBalance: INITIAL_BALANCE,
    costModel: STRICT_COST_MODEL,
    parameters: symbolCustom.parameters || {},
    timeframes: fetched.timeframes,
    candleCoverage: {
      setup: summarizeCandles(fetched.all.setup),
      entry: summarizeCandles(fetched.all.entry),
      higher: summarizeCandles(fetched.all.higher),
    },
    method: 'Read-only strict-cost trade diagnostics for current XAUUSD VolumeProfile DB parameters. No DB mutation.',
    windows,
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  writeProgress({ message: `Completed. Report: ${OUTPUT_PATH}`, status: 'completed', outputPath: OUTPUT_PATH });
  console.log(JSON.stringify({
    outputPath: OUTPUT_PATH,
    windows: windows.map((window) => ({
      label: window.label,
      summary: window.summary,
      worstHours: window.breakdowns.byHour.slice(0, 8),
      bestHours: window.breakdowns.byHour.slice().sort((left, right) => right.netPnl - left.netPnl).slice(0, 8),
      sessions: window.breakdowns.bySession,
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
