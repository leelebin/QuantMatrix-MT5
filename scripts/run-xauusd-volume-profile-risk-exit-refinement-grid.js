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
const OUTPUT_PATH = path.resolve(__dirname, '..', 'reports', 'xauusd-volume-profile-risk-exit-refinement-grid-2026-06-05.json');
const PROGRESS_PATH = path.resolve(__dirname, '..', 'reports', 'xauusd-volume-profile-risk-exit-refinement-grid-progress.json');

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

const SESSION_SETS = Object.freeze([
  { name: 'applied_asia_no3_ny_no17', ranges: [[1, 3], [4, 5], [15, 17]] },
  { name: 'applied_asia_no3_ny', ranges: [[1, 3], [4, 5], [15, 18]] },
  { name: 'asia12_ny_no17', ranges: [[1, 3], [15, 17]] },
  { name: 'current_no17', ranges: [[1, 5], [15, 17]] },
]);

const PROFILES = Object.freeze([
  { name: 'base', patch: {} },
  { name: 'rvol1_65', patch: { rvolContinuation: 1.65 } },
  { name: 'rvol1_70', patch: { rvolContinuation: 1.7 } },
  { name: 'rvol1_75', patch: { rvolContinuation: 1.75 } },
  { name: 'rvol1_80', patch: { rvolContinuation: 1.8 } },
  { name: 'rr1_40', patch: { riskReward: 1.4 } },
  { name: 'rr1_60', patch: { riskReward: 1.6 } },
  { name: 'rr1_70', patch: { riskReward: 1.7 } },
  { name: 'hold20', patch: { maxHoldingMinutes: 20 } },
  { name: 'hold45', patch: { maxHoldingMinutes: 45 } },
  { name: 'body0_55', patch: { bodyAtrThreshold: 0.55 } },
  { name: 'trend0_50', patch: { minTrendEmaSeparationAtr: 0.5 } },
  { name: 'cooldown2880', patch: { rollingLossCooldownMinutes: 2880 } },
  { name: 'rvol1_70_rr1_60', patch: { rvolContinuation: 1.7, riskReward: 1.6 } },
  { name: 'rvol1_70_hold20', patch: { rvolContinuation: 1.7, maxHoldingMinutes: 20 } },
  { name: 'rvol1_70_cooldown2880', patch: { rvolContinuation: 1.7, rollingLossCooldownMinutes: 2880 } },
]);

function buildVariants() {
  const variants = [];
  for (const sessionSet of SESSION_SETS) {
    for (const profile of PROFILES) {
      variants.push({
        name: `${sessionSet.name}_${profile.name}`,
        patch: {
          restrictEntrySessionUtc: true,
          entrySessionRangesUtc: sessionSet.ranges,
          ...profile.patch,
        },
      });
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
  if (patch.message) console.log(`[VolumeProfile risk/exit grid] ${patch.message}`);
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

function getWindowSummary(windows = [], label) {
  return windows.find((window) => window.label === label)?.summary || {};
}

function assessCandidate(windows = []) {
  const full = getWindowSummary(windows, 'full_window');
  const recent = getWindowSummary(windows, 'recent_window');
  const fullTrades = toNumber(full.trades, 0);
  const recentTrades = toNumber(recent.trades, 0);
  const fullPf = toNumber(full.profitFactor, 0);
  const recentPf = toNumber(recent.profitFactor, 0);
  const fullNet = toNumber(full.netPnl, -999);
  const recentNet = toNumber(recent.netPnl, -999);
  const fullDd = toNumber(full.maxDrawdown, 999);
  const fullCl = toNumber(full.maxConsecutiveLosses, 999);
  const recentCl = toNumber(recent.maxConsecutiveLosses, 999);

  return {
    paperCandidate: fullTrades >= 70
      && recentTrades >= 8
      && fullNet > 0
      && recentNet > 0
      && fullPf >= 1.5
      && recentPf >= 1.2
      && fullDd <= 16
      && fullCl <= 4
      && recentCl <= 3,
    stillThinForLive: fullTrades < 200 || recentTrades < 30,
  };
}

function scoreVariant(windows = []) {
  const full = getWindowSummary(windows, 'full_window');
  const recent = getWindowSummary(windows, 'recent_window');
  const fullNet = toNumber(full.netPnl, -999);
  const recentNet = toNumber(recent.netPnl, -999);
  const fullPf = toNumber(full.profitFactor, 0);
  const recentPf = toNumber(recent.profitFactor, 0);
  const fullTrades = toNumber(full.trades, 0);
  const recentTrades = toNumber(recent.trades, 0);
  const fullDd = toNumber(full.maxDrawdown, 999);
  const fullCl = toNumber(full.maxConsecutiveLosses, 999);
  const recentCl = toNumber(recent.maxConsecutiveLosses, 999);

  return round(
    (fullNet * 2.4)
    + (recentNet * 1.2)
    + Math.min(fullTrades, 140) * 0.5
    + Math.min(recentTrades, 25) * 0.8
    + fullPf * 36
    + recentPf * 8
    - Math.max(0, 1.5 - fullPf) * 90
    - Math.max(0, 1.2 - recentPf) * 40
    - Math.max(0, 80 - fullTrades) * 0.35
    - Math.max(0, 10 - recentTrades) * 1.4
    - Math.max(0, fullDd - 16) * 2
    - Math.max(0, fullCl - 4) * 20
    - Math.max(0, recentCl - 3) * 10
  );
}

async function main() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const symbolCustom = loadSymbolCustom();
  const logic = getSymbolCustomLogic(LOGIC_NAME);
  if (!logic) throw new Error(`SymbolCustom logic not registered: ${LOGIC_NAME}`);

  const variants = buildVariants();
  writeProgress({
    message: `Starting XAUUSD VolumeProfile risk/exit refinement grid with ${variants.length} variants`,
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
    const result = {
      name: variant.name,
      patch: variant.patch,
      parameters: {
        ...(symbolCustom.parameters || {}),
        ...variant.patch,
      },
      score: scoreVariant(windows),
      assessment: assessCandidate(windows),
      windows,
    };
    results.push(result);
    const full = getWindowSummary(windows, 'full_window');
    const recent = getWindowSummary(windows, 'recent_window');
    console.log(`[VolumeProfile risk/exit grid] ${variant.name}: full net=${round(full.netPnl, 2)} pf=${round(full.profitFactor, 2)} trades=${full.trades} dd=${round(full.maxDrawdown, 2)} cl=${full.maxConsecutiveLosses}; recent net=${round(recent.netPnl, 2)} pf=${round(recent.profitFactor, 2)} trades=${recent.trades} cl=${recent.maxConsecutiveLosses}`);
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
    currentDbParameterSnapshot: symbolCustom.parameters || {},
    method: 'Read-only strict-cost refinement of XAUUSD VolumeProfile risk, exit and signal-quality filters. No DB mutation.',
    results,
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  writeProgress({ message: `Completed. Report: ${OUTPUT_PATH}`, status: 'completed', outputPath: OUTPUT_PATH });
  console.log(JSON.stringify({
    outputPath: OUTPUT_PATH,
    best: results.slice(0, 12).map((result) => ({
      name: result.name,
      score: result.score,
      assessment: result.assessment,
      patch: result.patch,
      full: getWindowSummary(result.windows, 'full_window'),
      recent: getWindowSummary(result.windows, 'recent_window'),
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
