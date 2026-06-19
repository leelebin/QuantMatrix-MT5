const fs = require('fs');
const path = require('path');

const mt5PaperService = require('../src/services/mt5Service').paper;
const { getSymbolCustomLogic } = require('../src/symbolCustom/registry');
const { runSymbolCustomBacktestSimulation } = require('../src/services/symbolCustomBacktestRunnerService');

const SYMBOL_CUSTOM_ID = 'B7mCDyegVqOgy7Ii';
const SYMBOL = 'USDJPY';
const LOGIC_NAME = 'USDJPY_JPY_MACRO_REVERSAL_V1';
const INITIAL_BALANCE = 500;
const FETCH_LIMIT = 250000;
const OUTPUT_PATH = path.resolve(__dirname, '..', 'reports', 'usdjpy-macro-reversal-hour-filter-grid-2026-06-04.json');
const PROGRESS_PATH = path.resolve(__dirname, '..', 'reports', 'usdjpy-macro-reversal-hour-filter-grid-progress.json');

const WINDOWS = Object.freeze([
  { label: 'full_window', startDate: '2025-06-03', endDate: '2026-06-03' },
  { label: 'recent_window', startDate: '2026-01-01', endDate: '2026-06-04' },
]);

const STRICT_COST_MODEL = Object.freeze({
  spread: 0.013,
  slippage: 0.002,
  commissionPerTrade: 0,
  source: 'instrument_average_spread_plus_0_2_pip_slippage',
  instrumentSpreadPips: 1.3,
  pipSize: 0.01,
});

const VARIANTS = Object.freeze([
  { name: 'current_23_0_1_7_8_9_10', patch: {} },
  { name: 'hours_23_0', patch: { allowedUtcHours: '23,0', maxDailyTrades: 3 } },
  { name: 'hours_23_0_daily2', patch: { allowedUtcHours: '23,0', maxDailyTrades: 2 } },
  { name: 'hours_23_0_sl_cooldown24', patch: { allowedUtcHours: '23,0', maxDailyTrades: 3, cooldownBarsAfterSL: 24 } },
  { name: 'hours_23_0_rr2_0', patch: { allowedUtcHours: '23,0', maxDailyTrades: 3, tpAtrMultiplier: 2.0 } },
  { name: 'hours_23_0_rr1_6', patch: { allowedUtcHours: '23,0', maxDailyTrades: 3, tpAtrMultiplier: 1.6 } },
  { name: 'hours_23_0_10', patch: { allowedUtcHours: '23,0,10', maxDailyTrades: 4 } },
  { name: 'hours_23_10', patch: { allowedUtcHours: '23,10', maxDailyTrades: 3 } },
  { name: 'hours_23_0_impulse2_0', patch: { allowedUtcHours: '23,0', maxDailyTrades: 3, impulseAtrMultiplier: 2.0 } },
  { name: 'hours_23_0_lookback42', patch: { allowedUtcHours: '23,0', maxDailyTrades: 3, lookbackBars: 42 } },
]);

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
    .map((candle) => ({
      time: getTime(candle),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume ?? candle.tickVolume ?? candle.tick_volume ?? 0),
    }))
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
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify({
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  }, null, 2));
  if (patch.message) console.log(`[USDJPY grid] ${patch.message}`);
}

async function fetchCandles(symbolCustom) {
  const timeframes = symbolCustom.timeframes || {};
  const resolved = {
    setup: timeframes.setupTimeframe || '15m',
    entry: timeframes.entryTimeframe || '5m',
    higher: timeframes.higherTimeframe || '1h',
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
  const parameters = {
    ...(symbolCustom.parameters || {}),
    ...variant.patch,
  };
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
    return {
      label: window.label,
      range: window,
      candleCounts: {
        setup: windowCandles.setup.length,
        entry: windowCandles.entry.length,
        higher: windowCandles.higher.length,
      },
      summary: {
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
        equityCurveHasBalance: simulation.equityCurve.some((point) => point.balance !== undefined),
        equityCurveHasEquity: simulation.equityCurve.some((point) => point.equity !== undefined),
      },
    };
  } finally {
    console.log = originalLog;
  }
}

function scoreVariant(windows = []) {
  const full = windows.find((window) => window.label === 'full_window')?.summary || {};
  const recent = windows.find((window) => window.label === 'recent_window')?.summary || {};
  const fullNet = toNumber(full.netPnl, -999);
  const recentNet = toNumber(recent.netPnl, -999);
  const fullPf = toNumber(full.profitFactor, 0);
  const recentPf = toNumber(recent.profitFactor, 0);
  const fullDd = toNumber(full.maxDrawdown, 999);
  const fullCl = toNumber(full.maxConsecutiveLosses, 999);
  return round(
    (fullNet * 2)
    + recentNet
    + (fullPf * 20)
    + (recentPf * 10)
    - Math.max(0, fullDd - 20)
    - Math.max(0, fullCl - 4) * 5
  );
}

async function main() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const symbolCustom = loadSymbolCustom();
  const logic = getSymbolCustomLogic(LOGIC_NAME);
  if (!logic) throw new Error(`SymbolCustom logic not registered: ${LOGIC_NAME}`);

  writeProgress({ message: 'Starting USDJPY hour filter grid', status: 'running' });
  const fetched = await fetchCandles(symbolCustom);
  const results = [];

  for (let index = 0; index < VARIANTS.length; index += 1) {
    const variant = VARIANTS[index];
    writeProgress({
      message: `Testing ${index + 1}/${VARIANTS.length}: ${variant.name}`,
      status: 'running',
      candidateIndex: index + 1,
      candidateCount: VARIANTS.length,
    });
    const windows = [];
    for (const window of WINDOWS) {
      windows.push(await runVariantWindow({
        symbolCustom,
        logic,
        candles: fetched.all,
        variant,
        window,
      }));
    }
    const result = {
      name: variant.name,
      patch: variant.patch,
      parameters: {
        ...(symbolCustom.parameters || {}),
        ...variant.patch,
      },
      score: scoreVariant(windows),
      windows,
    };
    results.push(result);
    const full = windows.find((row) => row.label === 'full_window')?.summary || {};
    const recent = windows.find((row) => row.label === 'recent_window')?.summary || {};
    console.log(`[USDJPY grid] ${variant.name}: full net=${round(full.netPnl, 2)} pf=${round(full.profitFactor, 2)} trades=${full.trades}; recent net=${round(recent.netPnl, 2)} pf=${round(recent.profitFactor, 2)} trades=${recent.trades}`);
  }

  results.sort((left, right) => right.score - left.score);
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
    method: 'Read-only rerun of USDJPY macro reversal with focused UTC-hour and risk variants. No DB mutation.',
    results,
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  writeProgress({ message: `Completed. Report: ${OUTPUT_PATH}`, status: 'completed', outputPath: OUTPUT_PATH });
  console.log(JSON.stringify({
    outputPath: OUTPUT_PATH,
    best: results.slice(0, 5).map((result) => ({
      name: result.name,
      score: result.score,
      patch: result.patch,
      full: result.windows.find((row) => row.label === 'full_window')?.summary,
      recent: result.windows.find((row) => row.label === 'recent_window')?.summary,
    })),
  }, null, 2));
}

main().catch((error) => {
  writeProgress({ status: 'failed', message: error.message });
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
