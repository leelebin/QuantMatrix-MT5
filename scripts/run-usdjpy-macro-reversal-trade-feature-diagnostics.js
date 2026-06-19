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
const START_DATE = '2024-06-03';
const END_DATE = '2026-06-05';
const OUTPUT_PATH = path.resolve(__dirname, '..', 'reports', 'usdjpy-macro-reversal-trade-feature-diagnostics-2026-06-05.json');
const PROGRESS_PATH = path.resolve(__dirname, '..', 'reports', 'usdjpy-macro-reversal-trade-feature-diagnostics-progress.json');

const STRICT_COST_MODEL = Object.freeze({
  spread: 0.013,
  slippage: 0.002,
  commissionPerTrade: 0,
  source: 'instrument_average_spread_plus_0_2_pip_slippage',
  instrumentSpreadPips: 1.3,
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

function toNumber(value, fallback = null) {
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
  if (patch.message) console.log(`[USDJPY feature diagnostics] ${patch.message}`);
}

async function fetchCandles(symbolCustom) {
  const timeframes = symbolCustom.timeframes || {};
  const resolved = {
    setup: timeframes.setupTimeframe || '15m',
    entry: timeframes.entryTimeframe || '5m',
    higher: timeframes.higherTimeframe || '1h',
  };
  const start = new Date(`${START_DATE}T00:00:00.000Z`);
  const end = endExclusive(END_DATE);
  const uniqueTimeframes = [...new Set(Object.values(resolved))];
  const byTimeframe = {};

  await mt5PaperService.connect();
  for (const timeframe of uniqueTimeframes) {
    writeProgress({ message: `Fetching ${SYMBOL} ${timeframe}` });
    byTimeframe[timeframe] = normalizeCandles(
      await mt5PaperService.getCandles(SYMBOL, timeframe, start, FETCH_LIMIT, end)
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

function closeValues(candles = []) {
  return candles.map((candle) => Number(candle.close)).filter(Number.isFinite);
}

function sma(values = [], period = 20) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

function atr(candles = [], period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const ranges = [];
  for (let index = candles.length - period; index < candles.length; index += 1) {
    const current = candles[index];
    const previous = candles[index - 1];
    if (!current || !previous) return null;
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

function historyUpTo(candles = [], time) {
  const epoch = Date.parse(time);
  return candles.filter((candle) => {
    const candleEpoch = Date.parse(candle.time);
    return Number.isFinite(candleEpoch) && candleEpoch <= epoch;
  });
}

function bucketNumber(value, cuts = []) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'unknown';
  for (const cut of cuts) {
    if (number < cut) return `<${cut}`;
  }
  return `>=${cuts[cuts.length - 1]}`;
}

function monthKey(time) {
  const date = new Date(time);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 7) : 'unknown';
}

function windowKey(time) {
  const epoch = Date.parse(time);
  if (!Number.isFinite(epoch)) return 'unknown';
  if (epoch < Date.parse('2025-06-03T00:00:00.000Z')) return 'first_year_holdout';
  if (epoch >= Date.parse('2026-01-01T00:00:00.000Z')) return 'recent_window';
  return 'latest_year_pre_recent';
}

function addToBucket(map, key, trade) {
  if (!map[key]) {
    map[key] = {
      key,
      trades: 0,
      wins: 0,
      losses: 0,
      netPnl: 0,
      grossWin: 0,
      grossLoss: 0,
      profitFactor: null,
      winRate: null,
    };
  }
  const bucket = map[key];
  const pnl = toNumber(trade.pnl, 0);
  bucket.trades += 1;
  bucket.netPnl += pnl;
  if (pnl > 0) {
    bucket.wins += 1;
    bucket.grossWin += pnl;
  } else if (pnl < 0) {
    bucket.losses += 1;
    bucket.grossLoss += Math.abs(pnl);
  }
  bucket.profitFactor = bucket.grossLoss > 0 ? bucket.grossWin / bucket.grossLoss : (bucket.grossWin > 0 ? null : null);
  bucket.winRate = bucket.trades > 0 ? bucket.wins / bucket.trades : null;
}

function finalizeBuckets(map) {
  return Object.values(map)
    .map((bucket) => ({
      ...bucket,
      netPnl: round(bucket.netPnl),
      grossWin: round(bucket.grossWin),
      grossLoss: round(bucket.grossLoss),
      profitFactor: round(bucket.profitFactor),
      winRate: round(bucket.winRate),
    }))
    .sort((left, right) => right.trades - left.trades || left.netPnl - right.netPnl);
}

function featureForTrade(trade, candles) {
  const entryTime = trade.entryTime;
  const entryHistory = historyUpTo(candles.entry, entryTime);
  const setupHistory = historyUpTo(candles.setup, entryTime);
  const higherHistory = historyUpTo(candles.higher, entryTime);
  const entryCloses = closeValues(entryHistory);
  const setupCloses = closeValues(setupHistory);
  const higherCloses = closeValues(higherHistory);
  const higherClose = higherCloses.at(-1);
  const higherSma20 = sma(higherCloses, 20);
  const higherSma50 = sma(higherCloses, 50);
  const higherSma100 = sma(higherCloses, 100);
  const higherSma200 = sma(higherCloses, 200);
  const higherAtr14 = atr(higherHistory, 14);
  const setupSma50 = sma(setupCloses, 50);
  const entrySma50 = sma(entryCloses, 50);
  const entryClose = entryCloses.at(-1);
  const momentum24 = higherCloses.length > 24 ? higherClose - higherCloses[higherCloses.length - 25] : null;
  const momentum72 = higherCloses.length > 72 ? higherClose - higherCloses[higherCloses.length - 73] : null;
  const metadata = trade.executionSignal?.metadata || {};
  const tradeAtr = toNumber(metadata.atr, null);
  const recentMove = toNumber(metadata.recentMove, null);

  return {
    entryTime,
    month: monthKey(entryTime),
    window: windowKey(entryTime),
    hour: trade.entryHourUtc,
    pnl: round(trade.pnl),
    rMultiple: round(trade.rMultiple),
    exitReason: trade.exitReason,
    confidence: round(trade.confidence),
    rsi: round(metadata.rsi),
    atr: round(tradeAtr),
    recentMove: round(recentMove),
    impulseAtrRatio: Number.isFinite(recentMove) && Number.isFinite(tradeAtr) && tradeAtr > 0
      ? round(Math.abs(recentMove) / tradeAtr)
      : null,
    higherClose: round(higherClose),
    higherSma20: round(higherSma20),
    higherSma50: round(higherSma50),
    higherSma100: round(higherSma100),
    higherSma200: round(higherSma200),
    higherAtr14: round(higherAtr14),
    higherCloseVsSma50Atr: Number.isFinite(higherClose) && Number.isFinite(higherSma50) && Number.isFinite(higherAtr14) && higherAtr14 > 0
      ? round((higherClose - higherSma50) / higherAtr14)
      : null,
    higherCloseVsSma100Atr: Number.isFinite(higherClose) && Number.isFinite(higherSma100) && Number.isFinite(higherAtr14) && higherAtr14 > 0
      ? round((higherClose - higherSma100) / higherAtr14)
      : null,
    higherCloseVsSma200Atr: Number.isFinite(higherClose) && Number.isFinite(higherSma200) && Number.isFinite(higherAtr14) && higherAtr14 > 0
      ? round((higherClose - higherSma200) / higherAtr14)
      : null,
    higherMomentum24Atr: Number.isFinite(momentum24) && Number.isFinite(higherAtr14) && higherAtr14 > 0
      ? round(momentum24 / higherAtr14)
      : null,
    higherMomentum72Atr: Number.isFinite(momentum72) && Number.isFinite(higherAtr14) && higherAtr14 > 0
      ? round(momentum72 / higherAtr14)
      : null,
    setupCloseVsSma50: Number.isFinite(entryClose) && Number.isFinite(setupSma50) ? round(entryClose - setupSma50) : null,
    entryCloseVsSma50: Number.isFinite(entryClose) && Number.isFinite(entrySma50) ? round(entryClose - entrySma50) : null,
  };
}

function summarizeFeatures(features = []) {
  const bucketMaps = {
    byWindow: {},
    byMonth: {},
    byHour: {},
    byExitReason: {},
    byRsi: {},
    byImpulseAtrRatio: {},
    byHigherCloseVsSma50Atr: {},
    byHigherCloseVsSma100Atr: {},
    byHigherCloseVsSma200Atr: {},
    byHigherMomentum24Atr: {},
    byHigherMomentum72Atr: {},
  };

  for (const feature of features) {
    addToBucket(bucketMaps.byWindow, feature.window, feature);
    addToBucket(bucketMaps.byMonth, feature.month, feature);
    addToBucket(bucketMaps.byHour, String(feature.hour), feature);
    addToBucket(bucketMaps.byExitReason, feature.exitReason || 'unknown', feature);
    addToBucket(bucketMaps.byRsi, bucketNumber(feature.rsi, [20, 24, 28, 32]), feature);
    addToBucket(bucketMaps.byImpulseAtrRatio, bucketNumber(feature.impulseAtrRatio, [2, 2.5, 3, 3.5, 4]), feature);
    addToBucket(bucketMaps.byHigherCloseVsSma50Atr, bucketNumber(feature.higherCloseVsSma50Atr, [-5, -2, 0, 2, 5]), feature);
    addToBucket(bucketMaps.byHigherCloseVsSma100Atr, bucketNumber(feature.higherCloseVsSma100Atr, [-5, -2, 0, 2, 5]), feature);
    addToBucket(bucketMaps.byHigherCloseVsSma200Atr, bucketNumber(feature.higherCloseVsSma200Atr, [-5, -2, 0, 2, 5]), feature);
    addToBucket(bucketMaps.byHigherMomentum24Atr, bucketNumber(feature.higherMomentum24Atr, [-4, -2, 0, 2, 4]), feature);
    addToBucket(bucketMaps.byHigherMomentum72Atr, bucketNumber(feature.higherMomentum72Atr, [-8, -4, 0, 4, 8]), feature);
  }

  return Object.fromEntries(
    Object.entries(bucketMaps).map(([key, value]) => [key, finalizeBuckets(value)])
  );
}

async function main() {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const symbolCustom = loadSymbolCustom();
  const logic = getSymbolCustomLogic(LOGIC_NAME);
  if (!logic) throw new Error(`SymbolCustom logic not registered: ${LOGIC_NAME}`);
  const parameters = symbolCustom.parameters || {};

  writeProgress({ status: 'running', message: 'Starting USDJPY feature diagnostics' });
  const fetched = await fetchCandles(symbolCustom);
  writeProgress({ status: 'running', message: 'Running current-parameter two-year simulation' });
  const originalLog = console.log;
  console.log = () => {};
  let simulation;
  try {
    simulation = await runSymbolCustomBacktestSimulation({
      symbolCustom,
      logic,
      logicName: LOGIC_NAME,
      candles: fetched.all,
      parameters,
      costModel: STRICT_COST_MODEL,
      initialBalance: INITIAL_BALANCE,
      options: {},
    });
  } finally {
    console.log = originalLog;
  }

  writeProgress({ status: 'running', message: `Augmenting ${simulation.trades.length} trades with features` });
  const features = simulation.trades.map((trade) => featureForTrade(trade, fetched.all));
  const report = {
    generatedAt: new Date().toISOString(),
    symbolCustomId: SYMBOL_CUSTOM_ID,
    symbol: SYMBOL,
    logicName: LOGIC_NAME,
    range: { startDate: START_DATE, endDate: END_DATE },
    costModel: STRICT_COST_MODEL,
    parameters,
    timeframes: fetched.timeframes,
    candleCoverage: {
      setup: summarizeCandles(fetched.all.setup),
      entry: summarizeCandles(fetched.all.entry),
      higher: summarizeCandles(fetched.all.higher),
    },
    summary: simulation.summary,
    featureSummary: summarizeFeatures(features),
    features,
  };
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  writeProgress({ status: 'completed', message: `Completed. Report: ${OUTPUT_PATH}`, outputPath: OUTPUT_PATH });
  console.log(JSON.stringify({
    outputPath: OUTPUT_PATH,
    summary: simulation.summary,
    topBuckets: {
      byWindow: report.featureSummary.byWindow,
      byHour: report.featureSummary.byHour,
      byHigherCloseVsSma200Atr: report.featureSummary.byHigherCloseVsSma200Atr,
      byHigherMomentum72Atr: report.featureSummary.byHigherMomentum72Atr,
    },
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
