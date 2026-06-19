const fs = require('fs');
const path = require('path');

const mt5PaperService = require('../src/services/mt5Service').paper;
const { getSymbolCustomLogic } = require('../src/symbolCustom/registry');
const { runSymbolCustomBacktestSimulation } = require('../src/services/symbolCustomBacktestRunnerService');

const SYMBOL_CUSTOM_ID = 'B7mCDyegVqOgy7Ii';
const SYMBOL = 'USDJPY';
const LOGIC_NAME = 'USDJPY_JPY_MACRO_REVERSAL_V1';
const INITIAL_BALANCE = 500;
const FETCH_LIMIT = 1200000;
const OUTPUT_PATH = path.resolve(__dirname, '..', 'reports', 'usdjpy-rolling-loss-sample-grid-2026-06-05.json');
const PROGRESS_PATH = path.resolve(__dirname, '..', 'reports', 'usdjpy-rolling-loss-sample-grid-progress.json');
const PARTIAL_OUTPUT_PATH = path.resolve(__dirname, '..', 'reports', 'usdjpy-rolling-loss-sample-grid-partial-2026-06-05.json');

const WINDOWS = Object.freeze([
  { label: 'full_window', startDate: '2020-01-01', endDate: '2026-06-05' },
  { label: 'latest_two_years', startDate: '2024-06-03', endDate: '2026-06-05' },
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

const LIVE_GATES = Object.freeze({
  full_window: Object.freeze({
    minTrades: 200,
    minNetPnl: 0,
    minProfitFactor: 1.5,
    maxDrawdown: 20,
    maxConsecutiveLosses: 4,
  }),
  recent_window: Object.freeze({
    minTrades: 40,
    minNetPnl: 0,
    minProfitFactor: 1.3,
    maxDrawdown: 15,
    maxConsecutiveLosses: 4,
  }),
});

const HOUR_SETS = Object.freeze([
  { name: 'h23_16', allowedUtcHours: '23,16' },
  { name: 'h23_0_16', allowedUtcHours: '23,0,16' },
  { name: 'h23_0_12_16', allowedUtcHours: '23,0,12,16' },
  { name: 'h23_0_8_12_16', allowedUtcHours: '23,0,8,12,16' },
]);

const QUALITY_PROFILES = Object.freeze([
  { name: 'base', patch: { rsiOversold: 32, impulseAtrMultiplier: 2, tpAtrMultiplier: 2.2 } },
  { name: 'rsi34', patch: { rsiOversold: 34, impulseAtrMultiplier: 2, tpAtrMultiplier: 2.2 } },
  { name: 'impulse1_8_rsi34', patch: { rsiOversold: 34, impulseAtrMultiplier: 1.8, tpAtrMultiplier: 2.2 } },
]);

const ROLLING_PROFILES = Object.freeze([
  { name: 'roll_off', patch: { maxRollingConsecutiveLosses: 0, rollingLossCooldownBars: 0 } },
  { name: 'roll2_144', patch: { maxRollingConsecutiveLosses: 2, rollingLossCooldownBars: 144 } },
  { name: 'roll2_288', patch: { maxRollingConsecutiveLosses: 2, rollingLossCooldownBars: 288 } },
  { name: 'roll2_576', patch: { maxRollingConsecutiveLosses: 2, rollingLossCooldownBars: 576 } },
  { name: 'roll3_288', patch: { maxRollingConsecutiveLosses: 3, rollingLossCooldownBars: 288 } },
  { name: 'roll3_576', patch: { maxRollingConsecutiveLosses: 3, rollingLossCooldownBars: 576 } },
]);

function buildVariants() {
  const variants = [];
  for (const hourSet of HOUR_SETS) {
    for (const quality of QUALITY_PROFILES) {
      for (const rolling of ROLLING_PROFILES) {
        variants.push({
          name: `${hourSet.name}_${quality.name}_${rolling.name}`,
          patch: {
            maxDailyTrades: 4,
            enableBuy: true,
            enableSell: false,
            useHigherTrendFilter: true,
            higherTrendSmaPeriod: 50,
            higherTrendAtrPeriod: 14,
            minHigherTrendDistanceAtr: 0,
            useHigherDriftFilter: false,
            higherDriftLookbackBars: 72,
            minHigherDriftAtr: 0,
            allowedUtcHours: hourSet.allowedUtcHours,
            ...quality.patch,
            ...rolling.patch,
          },
        });
      }
    }
  }
  return variants;
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
  if (patch.message) console.log(`[USDJPY rolling grid] ${patch.message}`);
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

function compactSummary(simulation) {
  return {
    trades: simulation.summary.trades,
    wins: simulation.summary.wins,
    losses: simulation.summary.losses,
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
    maxConsecutiveLosses: simulation.summary.maxConsecutiveLosses,
    finalBalance: round(simulation.finalBalance ?? simulation.summary.finalBalance),
    rawSignals: simulation.summary.rawSignals,
    openedSignals: simulation.summary.openedSignals,
    rejectedSignals: simulation.summary.rejectedSignals,
    equityCurveHasBalance: simulation.equityCurve.some((point) => point.balance !== undefined),
    equityCurveHasEquity: simulation.equityCurve.some((point) => point.equity !== undefined),
  };
}

function evaluateGate(summary = {}, gate = {}) {
  const checks = [
    ['trades', toNumber(summary.trades, 0) >= gate.minTrades, toNumber(summary.trades, 0), gate.minTrades],
    ['netPnl', toNumber(summary.netPnl, -Infinity) >= gate.minNetPnl, toNumber(summary.netPnl, null), gate.minNetPnl],
    ['profitFactor', toNumber(summary.profitFactor, 0) >= gate.minProfitFactor, toNumber(summary.profitFactor, null), gate.minProfitFactor],
    ['maxDrawdown', toNumber(summary.maxDrawdown, Infinity) <= gate.maxDrawdown, toNumber(summary.maxDrawdown, null), gate.maxDrawdown],
    ['maxConsecutiveLosses', toNumber(summary.maxConsecutiveLosses, Infinity) <= gate.maxConsecutiveLosses, toNumber(summary.maxConsecutiveLosses, null), gate.maxConsecutiveLosses],
  ];
  return {
    passed: checks.every(([, passed]) => passed),
    checks: checks.map(([name, passed, actual, expected]) => ({ name, passed, actual, expected })),
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
    const summary = compactSummary(simulation);
    return {
      label: window.label,
      range: window,
      candleCounts: {
        setup: windowCandles.setup.length,
        entry: windowCandles.entry.length,
        higher: windowCandles.higher.length,
      },
      summary,
      gate: LIVE_GATES[window.label] ? evaluateGate(summary, LIVE_GATES[window.label]) : null,
    };
  } finally {
    console.log = originalLog;
  }
}

function getWindow(windows = [], label) {
  return windows.find((window) => window.label === label) || null;
}

function scoreVariant(windows = []) {
  const full = getWindow(windows, 'full_window')?.summary || {};
  const recent = getWindow(windows, 'recent_window')?.summary || {};
  const twoYear = getWindow(windows, 'latest_two_years')?.summary || {};
  return round(
    Math.min(toNumber(full.trades, 0), 260) * 0.9
    + Math.min(toNumber(recent.trades, 0), 60) * 1.5
    + toNumber(full.netPnl, -999) * 1.5
    + toNumber(twoYear.netPnl, -999) * 0.8
    + toNumber(recent.netPnl, -999)
    + toNumber(full.profitFactor, 0) * 45
    + toNumber(twoYear.profitFactor, 0) * 20
    + toNumber(recent.profitFactor, 0) * 15
    - Math.max(0, 1.5 - toNumber(full.profitFactor, 0)) * 120
    - Math.max(0, 1.3 - toNumber(recent.profitFactor, 0)) * 70
    - Math.max(0, toNumber(full.maxDrawdown, 999) - 20) * 4
    - Math.max(0, toNumber(recent.maxDrawdown, 999) - 15) * 4
    - Math.max(0, toNumber(full.maxConsecutiveLosses, 999) - 4) * 25
    - Math.max(0, toNumber(recent.maxConsecutiveLosses, 999) - 4) * 25
  );
}

function writePartialReport({ symbolCustom, fetched, results, completedCount, totalCount }) {
  const sortedResults = [...results].sort((left, right) => right.score - left.score);
  fs.writeFileSync(PARTIAL_OUTPUT_PATH, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    partial: true,
    completedCount,
    totalCount,
    symbolCustomId: SYMBOL_CUSTOM_ID,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName: LOGIC_NAME,
    symbol: SYMBOL,
    initialBalance: INITIAL_BALANCE,
    costModel: STRICT_COST_MODEL,
    liveGates: LIVE_GATES,
    timeframes: fetched.timeframes,
    candleCoverage: {
      setup: summarizeCandles(fetched.all.setup),
      entry: summarizeCandles(fetched.all.entry),
      higher: summarizeCandles(fetched.all.higher),
    },
    results: sortedResults,
  }, null, 2)}\n`);
}

async function main() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const symbolCustom = loadSymbolCustom();
  const logic = getSymbolCustomLogic(LOGIC_NAME);
  if (!logic) throw new Error(`SymbolCustom logic not registered: ${LOGIC_NAME}`);
  const variants = buildVariants();
  writeProgress({
    message: `Starting USDJPY rolling sample grid with ${variants.length} variants`,
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
    const fullWindow = WINDOWS.find((window) => window.label === 'full_window');
    const remainingWindows = WINDOWS.filter((window) => window.label !== 'full_window');
    windows.push(await runVariantWindow({ symbolCustom, logic, candles: fetched.all, variant, window: fullWindow }));
    const full = getWindow(windows, 'full_window');
    if (full?.gate?.passed) {
      for (const window of remainingWindows) {
        windows.push(await runVariantWindow({ symbolCustom, logic, candles: fetched.all, variant, window }));
      }
    }
    const recent = getWindow(windows, 'recent_window');
    results.push({
      name: variant.name,
      patch: variant.patch,
      score: scoreVariant(windows),
      fullGatePassed: Boolean(full?.gate?.passed),
      promotionGatePassed: Boolean(full?.gate?.passed && recent?.gate?.passed),
      skippedWindows: full?.gate?.passed ? [] : remainingWindows.map((window) => window.label),
      windows,
    });
    writePartialReport({
      symbolCustom,
      fetched,
      results,
      completedCount: index + 1,
      totalCount: variants.length,
    });
  }

  results.sort((left, right) => right.score - left.score);
  const report = {
    generatedAt: new Date().toISOString(),
    symbolCustomId: SYMBOL_CUSTOM_ID,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName: LOGIC_NAME,
    symbol: SYMBOL,
    logicVersion: require('../src/symbolCustom/logics/UsdjpyJpyMacroReversalV1').USDJPY_JPY_MACRO_REVERSAL_V1_VERSION,
    initialBalance: INITIAL_BALANCE,
    costModel: STRICT_COST_MODEL,
    liveGates: LIVE_GATES,
    timeframes: fetched.timeframes,
    candleCoverage: {
      setup: summarizeCandles(fetched.all.setup),
      entry: summarizeCandles(fetched.all.entry),
      higher: summarizeCandles(fetched.all.higher),
    },
    method: 'Read-only rolling-loss cooldown and sample-expansion grid for current USDJPY SymbolCustom. No DB mutation.',
    results,
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  writeProgress({ message: `Completed. Report: ${OUTPUT_PATH}`, status: 'completed', outputPath: OUTPUT_PATH });
  console.log(JSON.stringify({
    outputPath: OUTPUT_PATH,
    passed: results.filter((result) => result.promotionGatePassed).map((result) => result.name),
    best: results.slice(0, 12).map((result) => ({
      name: result.name,
      score: result.score,
      patch: result.patch,
      promotionGatePassed: result.promotionGatePassed,
      full: getWindow(result.windows, 'full_window')?.summary,
      latestTwoYears: getWindow(result.windows, 'latest_two_years')?.summary,
      recent: getWindow(result.windows, 'recent_window')?.summary,
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
