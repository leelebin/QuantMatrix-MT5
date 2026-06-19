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
const OUTPUT_PATH = path.resolve(__dirname, '..', 'reports', 'xauusd-volume-profile-side-module-grid-2026-06-05.json');
const PROGRESS_PATH = path.resolve(__dirname, '..', 'reports', 'xauusd-volume-profile-side-module-grid-progress.json');

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

const SESSION_SETS = Object.freeze([
  { name: 'applied_no03_h1_2_4_15_16', patch: { restrictEntrySessionUtc: true, entrySessionRangesUtc: [[1, 3], [4, 5], [15, 17]] } },
  { name: 'include_h03', patch: { restrictEntrySessionUtc: true, entrySessionRangesUtc: [[1, 5], [15, 17]] } },
  { name: 'asia_london_ny', patch: { restrictEntrySessionUtc: true, entrySessionRangesUtc: [[1, 3], [4, 5], [8, 12], [13, 18]] } },
  { name: 'wide_liquid', patch: { restrictEntrySessionUtc: true, entrySessionRangesUtc: [[0, 8], [13, 18], [20, 24]] } },
  { name: 'all_hours', patch: { restrictEntrySessionUtc: false } },
]);

const MODULE_PROFILES = Object.freeze([
  {
    name: 'breakout_buy_only',
    patch: {
      enableBreakoutContinuation: true,
      enableExhaustionReversal: false,
      allowBuySignals: true,
      allowSellSignals: false,
    },
  },
  {
    name: 'breakout_buy_sell',
    patch: {
      enableBreakoutContinuation: true,
      enableExhaustionReversal: false,
      allowBuySignals: true,
      allowSellSignals: true,
    },
  },
  {
    name: 'breakout_sell_only',
    patch: {
      enableBreakoutContinuation: true,
      enableExhaustionReversal: false,
      allowBuySignals: false,
      allowSellSignals: true,
    },
  },
  {
    name: 'reversal_buy_sell',
    patch: {
      enableBreakoutContinuation: false,
      enableExhaustionReversal: true,
      allowBuySignals: true,
      allowSellSignals: true,
    },
  },
  {
    name: 'breakout_reversal_buy_sell',
    patch: {
      enableBreakoutContinuation: true,
      enableExhaustionReversal: true,
      allowBuySignals: true,
      allowSellSignals: true,
    },
  },
]);

const QUALITY_PROFILES = Object.freeze([
  { name: 'rvol1_65', patch: { rvolContinuation: 1.65 } },
  { name: 'rvol1_80', patch: { rvolContinuation: 1.8 } },
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

function buildVariants() {
  const variants = [];
  for (const sessionSet of SESSION_SETS) {
    for (const moduleProfile of MODULE_PROFILES) {
      for (const qualityProfile of QUALITY_PROFILES) {
        variants.push({
          name: `${sessionSet.name}_${moduleProfile.name}_${qualityProfile.name}`,
          patch: {
            ...sessionSet.patch,
            ...moduleProfile.patch,
            ...qualityProfile.patch,
          },
        });
      }
    }
  }
  return variants;
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
  if (patch.message) console.log(`[VolumeProfile side/module grid] ${patch.message}`);
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

function compactSummary(simulation) {
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
    rejectedSignalDetails: undefined,
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
      gate: evaluateGate(summary, LIVE_GATES[window.label]),
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
  const fullTrades = toNumber(full.trades, 0);
  const recentTrades = toNumber(recent.trades, 0);
  const fullPf = toNumber(full.profitFactor, 0);
  const recentPf = toNumber(recent.profitFactor, 0);
  const fullNet = toNumber(full.netPnl, -999);
  const recentNet = toNumber(recent.netPnl, -999);
  const fullDrawdown = toNumber(full.maxDrawdown, 999);
  const recentDrawdown = toNumber(recent.maxDrawdown, 999);
  const fullConsecutiveLosses = toNumber(full.maxConsecutiveLosses, 999);
  const recentConsecutiveLosses = toNumber(recent.maxConsecutiveLosses, 999);
  return round(
    Math.min(fullTrades, 260) * 1.1
    + Math.min(recentTrades, 60) * 1.4
    + fullNet * 1.5
    + recentNet
    + fullPf * 35
    + recentPf * 15
    - Math.max(0, 1.5 - fullPf) * 80
    - Math.max(0, 1.3 - recentPf) * 60
    - Math.max(0, fullDrawdown - 20) * 3
    - Math.max(0, recentDrawdown - 15) * 3
    - Math.max(0, fullConsecutiveLosses - 4) * 20
    - Math.max(0, recentConsecutiveLosses - 4) * 20
  );
}

async function main() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const symbolCustom = loadSymbolCustom();
  const logic = getSymbolCustomLogic(LOGIC_NAME);
  if (!logic) throw new Error(`SymbolCustom logic not registered: ${LOGIC_NAME}`);
  const variants = buildVariants();
  writeProgress({
    message: `Starting side/module grid with ${variants.length} variants`,
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
      windows.push(await runVariantWindow({
        symbolCustom,
        logic,
        candles: fetched.all,
        variant,
        window,
      }));
    }
    const full = getWindow(windows, 'full_window');
    const recent = getWindow(windows, 'recent_window');
    results.push({
      name: variant.name,
      patch: variant.patch,
      score: scoreVariant(windows),
      promotionGatePassed: Boolean(full?.gate?.passed && recent?.gate?.passed),
      windows,
    });
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
    liveGates: LIVE_GATES,
    timeframes: fetched.timeframes,
    candleCoverage: {
      setup: summarizeCandles(fetched.all.setup),
      entry: summarizeCandles(fetched.all.entry),
      higher: summarizeCandles(fetched.all.higher),
    },
    method: 'Read-only strict-cost side/module/session grid for XAUUSD VolumeProfile sample expansion. No DB mutation.',
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
