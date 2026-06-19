const fs = require('fs');
const path = require('path');

const mt5PaperService = require('../src/services/mt5Service').paper;
const SymbolCustom = require('../src/models/SymbolCustom');
const instruments = require('../src/config/instruments');
const { PLACEHOLDER_SYMBOL_CUSTOM } = require('../src/symbolCustom/logics/PlaceholderSymbolCustom');
const { getSymbolCustomLogic } = require('../src/symbolCustom/registry');
const { runSymbolCustomBacktestSimulation } = require('../src/services/symbolCustomBacktestRunnerService');
const { DEFAULT_LIVE_PROMOTION_THRESHOLDS } = require('../src/services/symbolCustomLivePromotionService');

const INITIAL_BALANCE = 500;
const OUTPUT_DIR = path.resolve(__dirname, '..', 'reports');
const DEFAULT_END_DATE = '2026-06-05';
const DEFAULT_FULL_START_DATE = '2020-01-01';
const DEFAULT_RECENT_START_DATE = '2026-01-01';
const DEFAULT_FETCH_LIMITS = Object.freeze({
  '1m': 4000000,
  '5m': 1400000,
  '15m': 600000,
  '30m': 350000,
  '1h': 220000,
  '4h': 80000,
});
const candleCache = new Map();

function getArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function splitArg(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function resolveOutputPath() {
  const explicit = getArg('--out');
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit);
  }
  return path.join(OUTPUT_DIR, `symbol-custom-readiness-screen-${buildTimestamp()}.json`);
}

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
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

function toDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function endExclusive(endDate) {
  const end = toDate(endDate);
  end.setUTCDate(end.getUTCDate() + 1);
  return end;
}

function shiftYears(endDate, years) {
  const date = toDate(endDate);
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function buildWindows({ fullStartDate, endDate }) {
  return [
    { label: 'full_window', startDate: fullStartDate, endDate },
    { label: 'latest_three_years', startDate: shiftYears(endDate, 3), endDate },
    { label: 'latest_year', startDate: shiftYears(endDate, 1), endDate },
    { label: 'recent_window', startDate: DEFAULT_RECENT_START_DATE, endDate },
  ];
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

function round(value, digits = 4) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
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

function getInstrument(symbol) {
  if (typeof instruments.getInstrument === 'function') {
    return instruments.getInstrument(symbol);
  }
  return instruments.instruments?.[symbol] || null;
}

function buildCostModel(symbol) {
  const instrument = getInstrument(symbol) || {};
  const pipSize = Number(instrument.pipSize);
  const spreadPips = Number(instrument.spread);
  const resolvedPipSize = Number.isFinite(pipSize) && pipSize > 0 ? pipSize : 0.01;
  const resolvedSpreadPips = Number.isFinite(spreadPips) && spreadPips >= 0 ? spreadPips : 0;
  return {
    spread: resolvedSpreadPips * resolvedPipSize,
    slippage: 0.2 * resolvedPipSize,
    commissionPerTrade: 0,
    source: 'instrument_spread_plus_0_2_pip_slippage',
    instrumentSpreadPips: resolvedSpreadPips,
    pipSize: resolvedPipSize,
  };
}

function resolveTimeframes(symbolCustom = {}) {
  const timeframes = symbolCustom.timeframes || {};
  const params = symbolCustom.parameters || {};
  return {
    setup: timeframes.setupTimeframe || params.setupTimeframe || '15m',
    entry: timeframes.entryTimeframe || params.entryTimeframe || '5m',
    higher: timeframes.higherTimeframe || params.higherTimeframe || '1h',
  };
}

function getFetchLimit(timeframe) {
  const explicit = Number(getArg('--fetch-limit'));
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return DEFAULT_FETCH_LIMITS[timeframe] || 500000;
}

async function fetchCandles(symbol, timeframes, fullStartDate, endDate) {
  const uniqueTimeframes = [...new Set(Object.values(timeframes))];
  const fetchStart = toDate(fullStartDate);
  const fetchEnd = endExclusive(endDate);
  const byTimeframe = {};

  for (const timeframe of uniqueTimeframes) {
    const cacheKey = [symbol, timeframe, fullStartDate, endDate, getFetchLimit(timeframe)].join('|');
    if (candleCache.has(cacheKey)) {
      byTimeframe[timeframe] = candleCache.get(cacheKey);
      console.log(`[Readiness screen] Reusing ${byTimeframe[timeframe].length} ${symbol} ${timeframe} candles`);
      continue;
    }

    console.log(`[Readiness screen] Fetching ${symbol} ${timeframe}`);
    byTimeframe[timeframe] = normalizeCandles(
      await mt5PaperService.getCandles(symbol, timeframe, fetchStart, getFetchLimit(timeframe), fetchEnd)
    );
    candleCache.set(cacheKey, byTimeframe[timeframe]);
    console.log(`[Readiness screen] Fetched ${byTimeframe[timeframe].length} ${symbol} ${timeframe} candles`);
  }

  return {
    setup: byTimeframe[timeframes.setup],
    entry: byTimeframe[timeframes.entry],
    higher: byTimeframe[timeframes.higher],
  };
}

function toNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function evaluateGate(summary = {}, thresholds = {}) {
  const checks = [
    ['trades', '>=', thresholds.minTrades],
    ['netPnl', '>=', thresholds.minNetPnl],
    ['profitFactor', '>=', thresholds.minProfitFactor],
    ['maxDrawdown', '<=', thresholds.maxDrawdown],
    ['maxConsecutiveLosses', '<=', thresholds.maxConsecutiveLosses],
  ].map(([field, operator, expected]) => {
    const actual = toNumber(summary[field]);
    const passed = operator === '>='
      ? actual != null && actual >= expected
      : actual != null && actual <= expected;
    return { name: field, passed, actual, operator, expected };
  });

  checks.push({
    name: 'equity_balance_curve',
    passed: summary.equityCurveHasBalance === true && summary.equityCurveHasEquity === true,
    equityCurveHasBalance: summary.equityCurveHasBalance,
    equityCurveHasEquity: summary.equityCurveHasEquity,
  });

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
}

function evaluateThresholds(results = []) {
  const gates = {};
  for (const [label, thresholds] of Object.entries(DEFAULT_LIVE_PROMOTION_THRESHOLDS)) {
    const result = results.find((row) => row.label === label);
    gates[label] = result
      ? evaluateGate(result.summary, thresholds)
      : { passed: false, checks: [{ name: `${label}_exists`, passed: false }] };
  }
  return {
    passed: Object.values(gates).every((gate) => gate.passed),
    gates,
  };
}

async function runWindow({ symbolCustom, logic, logicName, candles, parameters, costModel, window }) {
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
      logicName,
      candles: windowCandles,
      parameters,
      costModel,
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

function resolveScreenParameters(symbolCustom = {}) {
  const parameters = cloneValue(symbolCustom.parameters || {});
  const wasDisabled = parameters.enabled === false;
  if (wasDisabled) parameters.enabled = true;
  return {
    parameters,
    overrides: wasDisabled ? { enabled: true } : {},
  };
}

async function runTarget(symbolCustom, windows) {
  const logicName = symbolCustom.logicName || symbolCustom.registryLogicName || symbolCustom.symbolCustomName;
  const logic = getSymbolCustomLogic(logicName);
  if (!logic) {
    return {
      symbolCustomId: symbolCustom._id,
      symbolCustomName: symbolCustom.symbolCustomName,
      logicName,
      symbol: symbolCustom.symbol,
      skipped: true,
      skipReason: 'LOGIC_NOT_REGISTERED',
    };
  }

  const timeframes = resolveTimeframes(symbolCustom);
  const costModel = buildCostModel(symbolCustom.symbol);
  const candles = await fetchCandles(symbolCustom.symbol, timeframes, windows[0].startDate, windows[0].endDate);
  const { parameters, overrides } = resolveScreenParameters(symbolCustom);
  const results = [];

  for (const window of windows) {
    const result = await runWindow({
      symbolCustom,
      logic,
      logicName,
      candles,
      parameters,
      costModel,
      window,
    });
    results.push(result);
    console.log(`[Readiness screen] ${logicName} ${window.label}: trades=${result.summary.trades} net=${round(result.summary.netPnl, 2)} pf=${round(result.summary.profitFactor, 2)} dd=${round(result.summary.maxDrawdown, 2)} cl=${result.summary.maxConsecutiveLosses}`);
  }

  return {
    symbolCustomId: symbolCustom._id,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName,
    symbol: symbolCustom.symbol,
    status: symbolCustom.status,
    flags: {
      paperEnabled: symbolCustom.paperEnabled === true,
      liveEnabled: symbolCustom.liveEnabled === true,
      allowLive: symbolCustom.allowLive === true,
      isPrimaryLive: symbolCustom.isPrimaryLive === true,
    },
    screenParameterOverrides: overrides,
    timeframes,
    costModel,
    candleCoverage: {
      setup: summarizeCandles(candles.setup),
      entry: summarizeCandles(candles.entry),
      higher: summarizeCandles(candles.higher),
    },
    thresholdEvaluation: evaluateThresholds(results),
    results,
  };
}

function selectTargets(symbolCustoms = []) {
  const names = new Set(splitArg(getArg('--names')));
  const symbols = new Set(splitArg(getArg('--symbols')).map((symbol) => symbol.toUpperCase()));
  return symbolCustoms.filter((record) => {
    const logicName = record.logicName || record.registryLogicName || record.symbolCustomName;
    if (logicName === PLACEHOLDER_SYMBOL_CUSTOM) return false;
    if (names.size > 0 && !names.has(record.symbolCustomName) && !names.has(logicName)) return false;
    if (symbols.size > 0 && !symbols.has(String(record.symbol || '').toUpperCase())) return false;
    return true;
  });
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const endDate = getArg('--end', DEFAULT_END_DATE);
  const fullStartDate = getArg('--start', DEFAULT_FULL_START_DATE);
  const windows = buildWindows({ fullStartDate, endDate });
  const outputPath = resolveOutputPath();
  const symbolCustoms = selectTargets(await SymbolCustom.findAll({}));

  console.log(`[Readiness screen] Selected ${symbolCustoms.length} SymbolCustoms`);
  await mt5PaperService.connect();

  const reports = [];
  for (const symbolCustom of symbolCustoms) {
    console.log(`[Readiness screen] Starting ${symbolCustom.symbolCustomName}`);
    reports.push(await runTarget(symbolCustom, windows));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    method: 'Read-only strict-cost screen for existing non-placeholder SymbolCustom records. Disabled parameter sets are simulated with parameters.enabled=true only for screening; DB is not mutated.',
    initialBalance: INITIAL_BALANCE,
    windows,
    livePromotionThresholds: DEFAULT_LIVE_PROMOTION_THRESHOLDS,
    reports,
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    outputPath,
    reports: reports.map((row) => ({
      symbolCustomName: row.symbolCustomName,
      logicName: row.logicName,
      passed: row.thresholdEvaluation?.passed === true,
      overrides: row.screenParameterOverrides,
      windows: Object.fromEntries((row.results || []).map((result) => [result.label, {
        trades: result.summary.trades,
        netPnl: result.summary.netPnl,
        profitFactor: result.summary.profitFactor,
        maxDrawdown: result.summary.maxDrawdown,
        maxConsecutiveLosses: result.summary.maxConsecutiveLosses,
      }])),
    })),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mt5PaperService.disconnect();
  });
