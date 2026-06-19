const fs = require('fs');
const path = require('path');

const mt5PaperService = require('../src/services/mt5Service').paper;
const { getSymbolCustomLogic } = require('../src/symbolCustom/registry');
const { runSymbolCustomBacktestSimulation } = require('../src/services/symbolCustomBacktestRunnerService');

const SYMBOL_CUSTOM_ID = '8TvnNqlIuKK5ABgi';
const SYMBOL = 'XAUUSD';
const LOGIC_NAME = 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1';
const INITIAL_BALANCE = 500;
const FETCH_LIMIT = 4000000;
const GRID_MODE = process.env.VOLUME_PROFILE_GRID_MODE || 'focused';
const REPORT_TAG = process.env.VOLUME_PROFILE_REPORT_TAG || 'live-gate-focused-grid';
const REPORT_DATE = process.env.VOLUME_PROFILE_REPORT_DATE || '2026-06-06';
const OUTPUT_PATH = path.resolve(__dirname, '..', 'reports', `xauusd-volume-profile-${REPORT_TAG}-${REPORT_DATE}.json`);
const PARTIAL_OUTPUT_PATH = path.resolve(__dirname, '..', 'reports', `xauusd-volume-profile-${REPORT_TAG}-partial-${REPORT_DATE}.json`);
const PROGRESS_PATH = path.resolve(__dirname, '..', 'reports', `xauusd-volume-profile-${REPORT_TAG}-progress.json`);

const WINDOWS = Object.freeze([
  { label: 'full_window', startDate: '2020-01-02', endDate: '2026-06-05' },
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
  {
    name: 'current_no03_plus_h06_07_h10_h17_18',
    patch: { restrictEntrySessionUtc: true, entrySessionRangesUtc: [[1, 3], [4, 5], [6, 8], [10, 11], [15, 19]] },
  },
  {
    name: 'current_no03_plus_h06_07_h10',
    patch: { restrictEntrySessionUtc: true, entrySessionRangesUtc: [[1, 3], [4, 5], [6, 8], [10, 11], [15, 17]] },
  },
  {
    name: 'include_h03_plus_h06_h10',
    patch: { restrictEntrySessionUtc: true, entrySessionRangesUtc: [[1, 5], [6, 7], [10, 11], [15, 17]] },
  },
  {
    name: 'wide_liquid',
    patch: { restrictEntrySessionUtc: true, entrySessionRangesUtc: [[0, 8], [13, 18], [20, 24]] },
  },
]);

const QUALITY_PROFILES = Object.freeze([
  { name: 'rvol1_65_body0_45_conf65_rr1_5', patch: { rvolContinuation: 1.65, bodyAtrThreshold: 0.45, minConfidence: 65, riskReward: 1.5 } },
  { name: 'rvol1_70_body0_45_conf65_rr1_6', patch: { rvolContinuation: 1.7, bodyAtrThreshold: 0.45, minConfidence: 65, riskReward: 1.6 } },
  { name: 'rvol1_75_body0_50_conf70_rr1_6', patch: { rvolContinuation: 1.75, bodyAtrThreshold: 0.5, minConfidence: 70, riskReward: 1.6 } },
]);

const RISK_PROFILES = Object.freeze([
  {
    name: 'db_risk',
    patch: {},
  },
  {
    name: 'roll2_2880',
    patch: { maxRollingConsecutiveLosses: 2, rollingLossCooldownMinutes: 2880 },
  },
]);

const SESSION_QUALITY_SESSION_SETS = Object.freeze([
  {
    name: 'recent_40_exclude_worst',
    patch: { restrictEntrySessionUtc: true, entrySessionRangesUtc: [[1, 8], [9, 12], [14, 20], [22, 23]] },
  },
  {
    name: 'recent_37_no_h22',
    patch: { restrictEntrySessionUtc: true, entrySessionRangesUtc: [[1, 8], [9, 12], [14, 20]] },
  },
  {
    name: 'recent_34_no_h09_h22',
    patch: { restrictEntrySessionUtc: true, entrySessionRangesUtc: [[1, 8], [10, 12], [14, 20]] },
  },
  {
    name: 'strict_plus_h03_h10_h11_h14_h19',
    patch: { restrictEntrySessionUtc: true, entrySessionRangesUtc: [[1, 5], [6, 8], [10, 12], [14, 20]] },
  },
  {
    name: 'strict_plus_h03_h10_h11_h14_h19_h22',
    patch: { restrictEntrySessionUtc: true, entrySessionRangesUtc: [[1, 5], [6, 8], [10, 12], [14, 20], [22, 23]] },
  },
]);

const SESSION_QUALITY_PROFILES = Object.freeze([
  { name: 'rvol1_65_body0_45_conf65_rr1_5', patch: { rvolContinuation: 1.65, bodyAtrThreshold: 0.45, minConfidence: 65, riskReward: 1.5 } },
  { name: 'rvol1_70_body0_45_conf65_rr1_6', patch: { rvolContinuation: 1.7, bodyAtrThreshold: 0.45, minConfidence: 65, riskReward: 1.6 } },
  { name: 'rvol1_65_body0_50_conf65_rr1_5', patch: { rvolContinuation: 1.65, bodyAtrThreshold: 0.5, minConfidence: 65, riskReward: 1.5 } },
  { name: 'rvol1_65_body0_45_conf70_rr1_5', patch: { rvolContinuation: 1.65, bodyAtrThreshold: 0.45, minConfidence: 70, riskReward: 1.5 } },
]);

const SESSION_QUALITY_RISK_PROFILES = Object.freeze([
  {
    name: 'roll2_2880',
    patch: { maxRollingConsecutiveLosses: 2, rollingLossCooldownMinutes: 2880 },
  },
]);

function resolveGridConfig() {
  if (GRID_MODE === 'session_quality') {
    return {
      sessionSets: SESSION_QUALITY_SESSION_SETS,
      qualityProfiles: SESSION_QUALITY_PROFILES,
      riskProfiles: SESSION_QUALITY_RISK_PROFILES,
    };
  }

  return {
    sessionSets: SESSION_SETS,
    qualityProfiles: QUALITY_PROFILES,
    riskProfiles: RISK_PROFILES,
  };
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

function buildVariants() {
  const { sessionSets, qualityProfiles, riskProfiles } = resolveGridConfig();
  const variants = [];
  for (const sessionSet of sessionSets) {
    for (const qualityProfile of qualityProfiles) {
      for (const riskProfile of riskProfiles) {
        variants.push({
          name: `${sessionSet.name}_${qualityProfile.name}_${riskProfile.name}`,
          patch: {
            ...sessionSet.patch,
            enableBreakoutContinuation: true,
            enableExhaustionReversal: false,
            allowBuySignals: true,
            allowSellSignals: false,
            ...qualityProfile.patch,
            ...riskProfile.patch,
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
  if (patch.message) console.log(`[VolumeProfile ${GRID_MODE} grid] ${patch.message}`);
}

async function fetchCandles(symbolCustom) {
  const timeframes = symbolCustom.timeframes || {};
  const resolved = {
    setup: timeframes.setupTimeframe || '5m',
    entry: timeframes.entryTimeframe || '1m',
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
    ['equityCurveHasBalance', summary.equityCurveHasBalance === true, summary.equityCurveHasBalance, true],
    ['equityCurveHasEquity', summary.equityCurveHasEquity === true, summary.equityCurveHasEquity, true],
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

function gapPenalty(summary = {}, gate = {}) {
  return (
    Math.max(0, gate.minTrades - toNumber(summary.trades, 0)) * 3
    + Math.max(0, gate.minProfitFactor - toNumber(summary.profitFactor, 0)) * 500
    + Math.max(0, toNumber(summary.maxDrawdown, Infinity) - gate.maxDrawdown) * 12
    + Math.max(0, toNumber(summary.maxConsecutiveLosses, Infinity) - gate.maxConsecutiveLosses) * 80
    + Math.max(0, gate.minNetPnl - toNumber(summary.netPnl, -Infinity)) * 8
  );
}

function scoreVariant(windows = []) {
  const full = getWindow(windows, 'full_window')?.summary || {};
  const recent = getWindow(windows, 'recent_window')?.summary || {};
  return round(
    Math.min(toNumber(full.trades, 0), 240) * 2
    + Math.min(toNumber(recent.trades, 0), 60) * 4
    + toNumber(full.netPnl, -999) * 1.5
    + toNumber(recent.netPnl, -999)
    + toNumber(full.profitFactor, 0) * 100
    + toNumber(recent.profitFactor, 0) * 35
    - gapPenalty(full, LIVE_GATES.full_window)
    - gapPenalty(recent, LIVE_GATES.recent_window)
  );
}

function buildReport({ symbolCustom, fetched, results, partial }) {
  return {
    generatedAt: new Date().toISOString(),
    partial: Boolean(partial),
    symbolCustomId: SYMBOL_CUSTOM_ID,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName: LOGIC_NAME,
    symbol: SYMBOL,
    initialBalance: INITIAL_BALANCE,
    costModel: STRICT_COST_MODEL,
    liveGates: LIVE_GATES,
    gridMode: GRID_MODE,
    timeframes: fetched.timeframes,
    candleCoverage: {
      setup: summarizeCandles(fetched.all.setup),
      entry: summarizeCandles(fetched.all.entry),
      higher: summarizeCandles(fetched.all.higher),
    },
    method: `Read-only ${GRID_MODE} full+recent live gate grid for XAUUSD VolumeProfile. No DB mutation, no live scan.`,
    results,
  };
}

async function main() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const symbolCustom = loadSymbolCustom();
  const logic = getSymbolCustomLogic(LOGIC_NAME);
  if (!logic) throw new Error(`SymbolCustom logic not registered: ${LOGIC_NAME}`);
  const variants = buildVariants();
  writeProgress({
    message: `Starting ${GRID_MODE} live-gate grid with ${variants.length} variants`,
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
    const full = getWindow(windows, 'full_window');
    const recent = getWindow(windows, 'recent_window');
    results.push({
      name: variant.name,
      patch: variant.patch,
      score: scoreVariant(windows),
      promotionGatePassed: Boolean(full?.gate?.passed && recent?.gate?.passed),
      windows,
    });
    results.sort((left, right) => right.score - left.score);
    fs.writeFileSync(
      PARTIAL_OUTPUT_PATH,
      `${JSON.stringify(buildReport({ symbolCustom, fetched, results, partial: true }), null, 2)}\n`
    );
  }

  results.sort((left, right) => right.score - left.score);
  const report = buildReport({ symbolCustom, fetched, results, partial: false });
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
      fullGate: getWindow(result.windows, 'full_window')?.gate,
      recentGate: getWindow(result.windows, 'recent_window')?.gate,
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
