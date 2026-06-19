const fs = require('fs');
const path = require('path');

const mt5PaperService = require('../src/services/mt5Service').paper;
const { getSymbolCustomLogic } = require('../src/symbolCustom/registry');
const { runSymbolCustomBacktestSimulation } = require('../src/services/symbolCustomBacktestRunnerService');

const SYMBOL_CUSTOM_ID = 'B7mCDyegVqOgy7Ii';
const SYMBOL = 'USDJPY';
const LOGIC_NAME = 'USDJPY_JPY_MACRO_REVERSAL_V1';
const INITIAL_BALANCE = 500;
const FETCH_LIMIT = 300000;
const OUTPUT_PATH = path.resolve(__dirname, '..', 'reports', 'usdjpy-macro-reversal-regime-filter-grid-2026-06-05.json');
const PROGRESS_PATH = path.resolve(__dirname, '..', 'reports', 'usdjpy-macro-reversal-regime-filter-grid-progress.json');

const WINDOWS = Object.freeze([
  { label: 'two_year_window', startDate: '2024-06-03', endDate: '2026-06-05' },
  { label: 'latest_year_window', startDate: '2025-06-03', endDate: '2026-06-05' },
  { label: 'recent_window', startDate: '2026-01-01', endDate: '2026-06-05' },
]);

const STRICT_COST_MODEL = Object.freeze({
  spread: 0.013,
  slippage: 0.002,
  commissionPerTrade: 0,
  source: 'instrument_average_spread_plus_0_2_pip_slippage',
  instrumentSpreadPips: 1.3,
  pipSize: 0.01,
});

const BASE_PATCH = Object.freeze({
  maxDailyTrades: 4,
  tpAtrMultiplier: 2.2,
  impulseAtrMultiplier: 2,
});

const VARIANTS = Object.freeze([
  { name: 'current_db', patch: {} },
  {
    name: 'h23_16_trend50_0',
    patch: {
      ...BASE_PATCH,
      allowedUtcHours: '23,16',
      useHigherTrendFilter: true,
      higherTrendSmaPeriod: 50,
      minHigherTrendDistanceAtr: 0,
    },
  },
  {
    name: 'h23_16_trend50_1',
    patch: {
      ...BASE_PATCH,
      allowedUtcHours: '23,16',
      useHigherTrendFilter: true,
      higherTrendSmaPeriod: 50,
      minHigherTrendDistanceAtr: 1,
    },
  },
  {
    name: 'h0_16_trend50_1',
    patch: {
      ...BASE_PATCH,
      allowedUtcHours: '0,16',
      useHigherTrendFilter: true,
      higherTrendSmaPeriod: 50,
      minHigherTrendDistanceAtr: 1,
    },
  },
  {
    name: 'h0_16_trend50_1_drift72_0',
    patch: {
      ...BASE_PATCH,
      allowedUtcHours: '0,16',
      useHigherTrendFilter: true,
      higherTrendSmaPeriod: 50,
      minHigherTrendDistanceAtr: 1,
      useHigherDriftFilter: true,
      higherDriftLookbackBars: 72,
      minHigherDriftAtr: 0,
    },
  },
  {
    name: 'h0_16_trend50_1_drift72_2',
    patch: {
      ...BASE_PATCH,
      allowedUtcHours: '0,16',
      useHigherTrendFilter: true,
      higherTrendSmaPeriod: 50,
      minHigherTrendDistanceAtr: 1,
      useHigherDriftFilter: true,
      higherDriftLookbackBars: 72,
      minHigherDriftAtr: 2,
    },
  },
  {
    name: 'h23_0_16_trend50_1',
    patch: {
      ...BASE_PATCH,
      allowedUtcHours: '23,0,16',
      useHigherTrendFilter: true,
      higherTrendSmaPeriod: 50,
      minHigherTrendDistanceAtr: 1,
    },
  },
  {
    name: 'h23_0_16_trend50_1_drift72_0',
    patch: {
      ...BASE_PATCH,
      allowedUtcHours: '23,0,16',
      useHigherTrendFilter: true,
      higherTrendSmaPeriod: 50,
      minHigherTrendDistanceAtr: 1,
      useHigherDriftFilter: true,
      higherDriftLookbackBars: 72,
      minHigherDriftAtr: 0,
    },
  },
  {
    name: 'h23_0_16_trend50_1_drift72_2',
    patch: {
      ...BASE_PATCH,
      allowedUtcHours: '23,0,16',
      useHigherTrendFilter: true,
      higherTrendSmaPeriod: 50,
      minHigherTrendDistanceAtr: 1,
      useHigherDriftFilter: true,
      higherDriftLookbackBars: 72,
      minHigherDriftAtr: 2,
    },
  },
  {
    name: 'h23_16_trend200_0_drift72_2',
    patch: {
      ...BASE_PATCH,
      allowedUtcHours: '23,16',
      useHigherTrendFilter: true,
      higherTrendSmaPeriod: 200,
      minHigherTrendDistanceAtr: 0,
      useHigherDriftFilter: true,
      higherDriftLookbackBars: 72,
      minHigherDriftAtr: 2,
    },
  },
  {
    name: 'h23_16_trend200_2_drift72_2',
    patch: {
      ...BASE_PATCH,
      allowedUtcHours: '23,16',
      useHigherTrendFilter: true,
      higherTrendSmaPeriod: 200,
      minHigherTrendDistanceAtr: 2,
      useHigherDriftFilter: true,
      higherDriftLookbackBars: 72,
      minHigherDriftAtr: 2,
    },
  },
  {
    name: 'h23_16_trend200_3',
    patch: {
      ...BASE_PATCH,
      allowedUtcHours: '23,16',
      useHigherTrendFilter: true,
      higherTrendSmaPeriod: 200,
      minHigherTrendDistanceAtr: 3,
    },
  },
  {
    name: 'h23_trend50_minus2',
    patch: {
      ...BASE_PATCH,
      allowedUtcHours: '23',
      useHigherTrendFilter: true,
      higherTrendSmaPeriod: 50,
      minHigherTrendDistanceAtr: -2,
    },
  },
  {
    name: 'h23_16_trend100_1',
    patch: {
      ...BASE_PATCH,
      allowedUtcHours: '23,16',
      useHigherTrendFilter: true,
      higherTrendSmaPeriod: 100,
      minHigherTrendDistanceAtr: 1,
    },
  },
  {
    name: 'h23_16_trend100_1_drift72_0',
    patch: {
      ...BASE_PATCH,
      allowedUtcHours: '23,16',
      useHigherTrendFilter: true,
      higherTrendSmaPeriod: 100,
      minHigherTrendDistanceAtr: 1,
      useHigherDriftFilter: true,
      higherDriftLookbackBars: 72,
      minHigherDriftAtr: 0,
    },
  },
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
  const next = {
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(PROGRESS_PATH, `${JSON.stringify(next, null, 2)}\n`);
  if (patch.message) console.log(`[USDJPY regime grid] ${patch.message}`);
}

async function fetchCandles(symbolCustom) {
  const timeframes = symbolCustom.timeframes || {};
  const resolved = {
    setup: timeframes.setupTimeframe || '15m',
    entry: timeframes.entryTimeframe || '5m',
    higher: timeframes.higherTimeframe || '1h',
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
      summary: compactSummary(simulation),
    };
  } finally {
    console.log = originalLog;
  }
}

function scoreVariant(windows = []) {
  const twoYear = windows.find((window) => window.label === 'two_year_window')?.summary || {};
  const latest = windows.find((window) => window.label === 'latest_year_window')?.summary || {};
  const recent = windows.find((window) => window.label === 'recent_window')?.summary || {};
  const twoNet = toNumber(twoYear.netPnl, -999);
  const latestNet = toNumber(latest.netPnl, -999);
  const recentNet = toNumber(recent.netPnl, -999);
  const twoPf = toNumber(twoYear.profitFactor, 0);
  const latestPf = toNumber(latest.profitFactor, 0);
  const recentPf = toNumber(recent.profitFactor, 0);
  const twoTrades = toNumber(twoYear.trades, 0);
  const latestTrades = toNumber(latest.trades, 0);
  const recentTrades = toNumber(recent.trades, 0);
  const twoDd = toNumber(twoYear.maxDrawdown, 999);
  const twoCl = toNumber(twoYear.maxConsecutiveLosses, 999);
  const recentCl = toNumber(recent.maxConsecutiveLosses, 999);
  return round(
    twoNet * 2
    + latestNet
    + recentNet * 0.7
    + twoPf * 45
    + latestPf * 20
    + recentPf * 12
    + Math.min(twoTrades, 200) * 0.3
    + Math.min(latestTrades, 80) * 0.15
    + Math.min(recentTrades, 40) * 0.15
    - Math.max(0, 1.5 - twoPf) * 70
    - Math.max(0, 1.3 - recentPf) * 35
    - Math.max(0, twoDd - 20) * 1.8
    - Math.max(0, twoCl - 4) * 15
    - Math.max(0, recentCl - 4) * 8
  );
}

async function main() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const symbolCustom = loadSymbolCustom();
  const logic = getSymbolCustomLogic(LOGIC_NAME);
  if (!logic) throw new Error(`SymbolCustom logic not registered: ${LOGIC_NAME}`);

  writeProgress({
    status: 'running',
    message: `Starting USDJPY regime filter grid with ${VARIANTS.length} variants`,
    candidateCount: VARIANTS.length,
  });
  const fetched = await fetchCandles(symbolCustom);
  const results = [];

  for (let index = 0; index < VARIANTS.length; index += 1) {
    const variant = VARIANTS[index];
    writeProgress({
      status: 'running',
      message: `Testing ${index + 1}/${VARIANTS.length}: ${variant.name}`,
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
    const twoYear = windows.find((row) => row.label === 'two_year_window')?.summary || {};
    const recent = windows.find((row) => row.label === 'recent_window')?.summary || {};
    console.log(`[USDJPY regime grid] ${variant.name}: 2y net=${round(twoYear.netPnl, 2)} pf=${round(twoYear.profitFactor, 2)} trades=${twoYear.trades} dd=${round(twoYear.maxDrawdown, 2)} cl=${twoYear.maxConsecutiveLosses}; recent net=${round(recent.netPnl, 2)} pf=${round(recent.profitFactor, 2)} trades=${recent.trades}`);
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
    method: 'Read-only validation of optional higher-timeframe regime filters for USDJPY. No DB mutation.',
    results,
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  writeProgress({ status: 'completed', message: `Completed. Report: ${OUTPUT_PATH}`, outputPath: OUTPUT_PATH });
  console.log(JSON.stringify({
    outputPath: OUTPUT_PATH,
    best: results.slice(0, 12).map((result) => ({
      name: result.name,
      score: result.score,
      patch: result.patch,
      twoYear: result.windows.find((row) => row.label === 'two_year_window')?.summary,
      latestYear: result.windows.find((row) => row.label === 'latest_year_window')?.summary,
      recent: result.windows.find((row) => row.label === 'recent_window')?.summary,
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
