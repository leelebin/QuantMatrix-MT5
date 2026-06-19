const fs = require('fs');
const path = require('path');

const mt5PaperService = require('../src/services/mt5Service').paper;
const { getSymbolCustomLogic } = require('../src/symbolCustom/registry');
const { runSymbolCustomBacktestSimulation } = require('../src/services/symbolCustomBacktestRunnerService');

const SYMBOL_CUSTOM_ID = 'z49Rm6XSLcS6h3PB';
const SYMBOL = 'XAUUSD';
const LOGIC_NAME = 'XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1';
const INITIAL_BALANCE = 500;
const FETCH_LIMIT = 700000;
const REPORT_DATE = process.env.VOLUME_FLOW_REPORT_DATE || '2026-06-06';
const OUTPUT_PATH = path.resolve(__dirname, '..', 'reports', `xauusd-volume-flow-trade-diagnostics-${REPORT_DATE}.json`);
const PROGRESS_PATH = path.resolve(__dirname, '..', 'reports', 'xauusd-volume-flow-trade-diagnostics-progress.json');

const WINDOWS = Object.freeze([
  { label: 'full_window', startDate: '2020-01-01', endDate: '2026-06-05' },
  { label: 'latest_year', startDate: '2025-06-05', endDate: '2026-06-05' },
  { label: 'recent_window', startDate: '2026-01-01', endDate: '2026-06-05' },
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
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time));
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
  if (patch.message) console.log(`[VolumeFlow diagnostics] ${patch.message}`);
}

function getTradeTime(trade = {}) {
  return trade.entryTime || trade.openTime || trade.time || trade.exitTime || null;
}

function toUtcHour(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.getUTCHours() : null;
}

function keyFromTrade(trade = {}, type) {
  const time = getTradeTime(trade);
  const date = new Date(time);
  const metadata = trade.metadata || trade.executionSignal?.metadata || {};
  if (type === 'side') return trade.side || 'UNKNOWN';
  if (type === 'exitReason') return trade.exitReason || 'UNKNOWN';
  if (type === 'hour') {
    const hour = Number.isInteger(metadata.currentUtcHour) ? metadata.currentUtcHour : toUtcHour(time);
    return Number.isInteger(hour) ? String(hour).padStart(2, '0') : 'UNKNOWN';
  }
  if (type === 'sideHour') {
    const hour = Number.isInteger(metadata.currentUtcHour) ? metadata.currentUtcHour : toUtcHour(time);
    return `${trade.side || 'UNKNOWN'}_${Number.isInteger(hour) ? String(hour).padStart(2, '0') : 'UNKNOWN'}`;
  }
  if (!Number.isFinite(date.getTime())) return 'UNKNOWN';
  if (type === 'year') return date.toISOString().slice(0, 4);
  if (type === 'month') return date.toISOString().slice(0, 7);
  if (type === 'quarter') return `${date.getUTCFullYear()} Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
  if (type === 'confidenceBucket') {
    const confidence = Number(trade.confidence ?? metadata.confidence);
    if (!Number.isFinite(confidence)) return 'UNKNOWN';
    return `${Math.floor(confidence * 10) / 10}-${Math.floor(confidence * 10) / 10 + 0.1}`;
  }
  if (type === 'rvolBucket') {
    const rvol = Number(metadata.rvol);
    if (!Number.isFinite(rvol)) return 'UNKNOWN';
    return `${Math.floor(rvol * 2) / 2}-${Math.floor(rvol * 2) / 2 + 0.5}`;
  }
  if (type === 'bodyAtrBucket') {
    const bodyAtr = Number(metadata.bodyAtr);
    if (!Number.isFinite(bodyAtr)) return 'UNKNOWN';
    return `${Math.floor(bodyAtr * 2) / 2}-${Math.floor(bodyAtr * 2) / 2 + 0.5}`;
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
    const key = keyFromTrade(row, type);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return [...groups.entries()]
    .map(([key, groupRows]) => ({ key, ...summarizeRows(groupRows) }))
    .sort((left, right) => {
      if (left.netPnl !== right.netPnl) return left.netPnl - right.netPnl;
      return String(left.key).localeCompare(String(right.key));
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
  const metadata = trade.metadata || trade.executionSignal?.metadata || {};
  return {
    entryTime: trade.entryTime || null,
    exitTime: trade.exitTime || null,
    side: trade.side || null,
    pnl: round(trade.pnl),
    rMultiple: round(trade.rMultiple),
    exitReason: trade.exitReason || 'UNKNOWN',
    confidence: round(trade.confidence ?? metadata.confidence),
    currentUtcHour: Number.isInteger(metadata.currentUtcHour) ? metadata.currentUtcHour : toUtcHour(getTradeTime(trade)),
    rvol: round(metadata.rvol),
    bodyAtr: round(metadata.bodyAtr),
    atr: round(metadata.atr),
    spreadAtr: round(metadata.spreadAtr),
    entryPrice: round(trade.entryPrice),
    exitPrice: round(trade.exitPrice),
    sl: round(trade.sl),
    tp: round(trade.tp),
  };
}

function compactSummary(simulation, trades = []) {
  return {
    ...simulation.summary,
    netPnl: round(simulation.summary.netPnl),
    grossWin: round(simulation.summary.grossWin),
    grossLoss: round(simulation.summary.grossLoss),
    profitFactor: round(simulation.summary.profitFactor),
    winRate: round(simulation.summary.winRate),
    avgR: round(simulation.summary.avgR),
    avgWin: round(simulation.summary.avgWin),
    avgLoss: round(simulation.summary.avgLoss),
    maxDrawdown: round(simulation.summary.maxDrawdown),
    maxSingleLoss: round(simulation.summary.maxSingleLoss),
    maxWin: round(simulation.summary.maxWin),
    finalBalance: round(simulation.finalBalance ?? simulation.summary.finalBalance),
    equityCurveHasBalance: simulation.equityCurve.some((point) => point.balance !== undefined),
    equityCurveHasEquity: simulation.equityCurve.some((point) => point.equity !== undefined),
    maxConsecutiveLossesFromTrades: maxConsecutiveLosses(trades),
    rejectedSignalDetails: undefined,
  };
}

function buildVariants() {
  const variants = [
    { name: 'current_db', patch: {} },
    { name: 'current_buy_only', patch: { enableBuy: true, enableSell: false } },
    { name: 'current_sell_only', patch: { enableBuy: false, enableSell: true } },
    { name: 'ny_all_buy', patch: { allowedUtcHours: '13,14,15,16,17,18,19,20,21', enableBuy: true, enableSell: false } },
    { name: 'ny_all_sell', patch: { allowedUtcHours: '13,14,15,16,17,18,19,20,21', enableBuy: false, enableSell: true } },
    { name: 'ny_all_both', patch: { allowedUtcHours: '13,14,15,16,17,18,19,20,21', enableBuy: true, enableSell: true } },
    { name: 'h16_17_buy_q_rvol3_2_body0_75', patch: { allowedUtcHours: '16,17', enableBuy: true, enableSell: false, rvolContinuation: 3.2, bodyAtrThreshold: 0.75, minConfidence: 0.6 } },
    { name: 'h15_16_17_buy_q_rvol3_2_body0_75', patch: { allowedUtcHours: '15,16,17', enableBuy: true, enableSell: false, rvolContinuation: 3.2, bodyAtrThreshold: 0.75, minConfidence: 0.6 } },
  ];
  for (let hour = 13; hour <= 21; hour += 1) {
    variants.push({ name: `h${hour}_buy`, patch: { allowedUtcHours: String(hour), enableBuy: true, enableSell: false } });
    variants.push({ name: `h${hour}_sell`, patch: { allowedUtcHours: String(hour), enableBuy: false, enableSell: true } });
  }
  return variants;
}

async function fetchCandles(symbolCustom) {
  const timeframes = symbolCustom.timeframes || {};
  const resolved = {
    setup: timeframes.setupTimeframe || '5m',
    entry: timeframes.entryTimeframe || '5m',
    higher: timeframes.higherTimeframe || '15m',
  };
  const fetchStart = new Date(`${WINDOWS[0].startDate}T00:00:00.000Z`);
  const fetchEnd = endExclusive(WINDOWS[0].endDate);
  const uniqueTimeframes = [...new Set(Object.values(resolved))];
  const byTimeframe = {};

  await mt5PaperService.connect();
  for (const timeframe of uniqueTimeframes) {
    writeProgress({ message: `Fetching ${SYMBOL} ${timeframe}` });
    byTimeframe[timeframe] = normalizeCandles(
      await mt5PaperService.getCandles(SYMBOL, timeframe, fetchStart, FETCH_LIMIT, fetchEnd)
    );
    writeProgress({ message: `Fetched ${byTimeframe[timeframe].length} ${SYMBOL} ${timeframe} candles` });
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

async function runWindow({ symbolCustom, logic, candles, variant, window }) {
  const windowCandles = {
    setup: filterWindow(candles.setup, window),
    entry: filterWindow(candles.entry, window),
    higher: filterWindow(candles.higher, window),
  };
  const parameters = {
    ...(symbolCustom.parameters || {}),
    ...variant.patch,
  };
  const simulation = await runSymbolCustomBacktestSimulation({
    symbolCustom,
    logic,
    logicName: LOGIC_NAME,
    candles: windowCandles,
    parameters,
    costModel: STRICT_COST_MODEL,
    initialBalance: INITIAL_BALANCE,
    options: { riskPerTradePct: 1 },
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
    summary: compactSummary(simulation, trades),
    breakdowns: {
      byHour: groupTrades(trades, 'hour'),
      bySideHour: groupTrades(trades, 'sideHour'),
      bySide: groupTrades(trades, 'side'),
      byYear: groupTrades(trades, 'year'),
      byMonth: groupTrades(trades, 'month'),
      byQuarter: groupTrades(trades, 'quarter'),
      byExitReason: groupTrades(trades, 'exitReason'),
      byConfidence: groupTrades(trades, 'confidenceBucket'),
      byRvol: groupTrades(trades, 'rvolBucket'),
      byBodyAtr: groupTrades(trades, 'bodyAtrBucket'),
    },
    worstTrades: trades.slice().sort((left, right) => left.pnl - right.pnl).slice(0, 20),
    bestTrades: trades.slice().sort((left, right) => right.pnl - left.pnl).slice(0, 20),
    trades,
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const symbolCustom = loadSymbolCustom();
  const logic = getSymbolCustomLogic(LOGIC_NAME);
  if (!logic) throw new Error(`SymbolCustom logic not registered: ${LOGIC_NAME}`);

  const variants = buildVariants();
  writeProgress({
    status: 'running',
    message: `Starting XAUUSD VolumeFlow diagnostics for ${variants.length} variants`,
    variantCount: variants.length,
  });

  const fetched = await fetchCandles(symbolCustom);
  const results = [];
  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index];
    writeProgress({
      status: 'running',
      message: `Testing ${index + 1}/${variants.length}: ${variant.name}`,
      variantIndex: index + 1,
      variantCount: variants.length,
    });
    const windows = [];
    for (const window of WINDOWS) {
      windows.push(await runWindow({ symbolCustom, logic, candles: fetched.all, variant, window }));
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
    parameters: symbolCustom.parameters || {},
    timeframes: fetched.timeframes,
    candleCoverage: {
      setup: summarizeCandles(fetched.all.setup),
      entry: summarizeCandles(fetched.all.entry),
      higher: summarizeCandles(fetched.all.higher),
    },
    method: 'Read-only strict-cost trade diagnostics for XAUUSD VolumeFlow. No DB mutation, no live scan.',
    results,
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  writeProgress({
    status: 'completed',
    message: `Completed. Report: ${OUTPUT_PATH}`,
    outputPath: OUTPUT_PATH,
  });
  console.log(JSON.stringify({
    outputPath: OUTPUT_PATH,
    results: results.map((result) => ({
      name: result.name,
      full: result.windows.find((window) => window.label === 'full_window')?.summary,
      recent: result.windows.find((window) => window.label === 'recent_window')?.summary,
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
