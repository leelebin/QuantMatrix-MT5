const fs = require('fs');
const path = require('path');

const mt5PaperService = require('../src/services/mt5Service').paper;
const SymbolCustom = require('../src/models/SymbolCustom');
const instruments = require('../src/config/instruments');
const { getSymbolCustomLogic } = require('../src/symbolCustom/registry');
const { runSymbolCustomBacktestSimulation } = require('../src/services/symbolCustomBacktestRunnerService');

const OUTPUT_DIR = path.resolve(__dirname, '..', 'reports');
const INITIAL_BALANCE = 500;
const DEFAULT_START_DATE = '2025-01-01';
const DEFAULT_END_DATE = '2026-06-05';
const TARGET_LOGICS = Object.freeze([
  'XTIUSD_OIL_BREAKOUT_RETEST_V1',
  'XBRUSD_OIL_LONG_RETEST_SESSION_V2',
]);
const DEFAULT_FETCH_LIMITS = Object.freeze({
  '5m': 250000,
  '1h': 40000,
  '4h': 15000,
});

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

function parseIndexSet(value) {
  const values = splitArg(value)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
  return values.length ? new Set(values) : null;
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
        spread: candle.spread == null ? undefined : Number(candle.spread),
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

function shiftMonths(endDate, months) {
  const date = toDate(endDate);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}

function filterWindow(candles = [], window) {
  const start = Date.parse(`${window.startDate}T00:00:00.000Z`);
  const end = endExclusive(window.endDate).getTime();
  return candles.filter((candle) => {
    const time = Date.parse(getTime(candle));
    return Number.isFinite(time) && time >= start && time < end;
  });
}

function round(value, digits = 4) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
}

function getInstrument(symbol) {
  if (typeof instruments.getInstrument === 'function') return instruments.getInstrument(symbol);
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
    setup: timeframes.setupTimeframe || params.setupTimeframe || '1h',
    entry: timeframes.entryTimeframe || params.entryTimeframe || '5m',
    higher: timeframes.higherTimeframe || params.higherTimeframe || '4h',
  };
}

function summarizeCandles(candles = []) {
  return {
    count: candles.length,
    first: candles[0]?.time || null,
    last: candles.at(-1)?.time || null,
  };
}

function compactSummary(simulation) {
  const summary = simulation.summary || {};
  return {
    trades: summary.trades,
    wins: summary.wins,
    losses: summary.losses,
    netPnl: round(summary.netPnl),
    profitFactor: round(summary.profitFactor),
    winRate: round(summary.winRate),
    avgR: round(summary.avgR),
    maxDrawdown: round(summary.maxDrawdown),
    maxConsecutiveLosses: summary.maxConsecutiveLosses,
    rawSignals: summary.rawSignals,
    openedSignals: summary.openedSignals,
    rejectedSignals: summary.rejectedSignals,
    finalBalance: round(simulation.finalBalance ?? summary.finalBalance),
  };
}

function scoreCandidate(results = []) {
  const full = results.find((row) => row.label === 'full_window')?.summary || {};
  const recent = results.find((row) => row.label === 'recent_window')?.summary || {};
  const fullNet = Number(full.netPnl) || 0;
  const recentNet = Number(recent.netPnl) || 0;
  const fullPf = Number(full.profitFactor) || 0;
  const recentPf = Number(recent.profitFactor) || 0;
  const fullTrades = Number(full.trades) || 0;
  const recentTrades = Number(recent.trades) || 0;
  const maxDrawdown = Number(full.maxDrawdown) || 0;
  const maxConsecutiveLosses = Number(full.maxConsecutiveLosses) || 0;
  return round(
    fullNet * 0.8
      + recentNet * 1.1
      + Math.min(fullTrades, 160) * 0.12
      + Math.min(recentTrades, 60) * 0.18
      + Math.max(0, fullPf - 1) * 25
      + Math.max(0, recentPf - 1) * 35
      - maxDrawdown * 0.55
      - maxConsecutiveLosses * 4,
    4
  );
}

function buildCandidateParameters(symbolCustom = {}) {
  const base = {
    ...(symbolCustom.parameters || {}),
    maxDailyTrades: 0,
  };
  const allowedHours = [
    base.allowedUtcHours || '7,8,9,10,13,14,15,16,17,18',
    '13,14,15,16,17,18',
    '7,8,9,10',
  ];
  const candidates = [];
  for (const hours of allowedHours) {
    for (const requireHigherTrendAlignment of [false, true]) {
      for (const maxDailyLosses of [1, 2]) {
        for (const minConfidence of [0.55, 0.62, 0.68]) {
          candidates.push({
            ...base,
            allowedUtcHours: hours,
            requireHigherTrendAlignment,
            maxDailyLosses,
            minConfidence,
            maxDailyTrades: 0,
          });
        }
      }
    }
  }
  return candidates;
}

async function fetchCandles(symbol, timeframes, startDate, endDate) {
  const uniqueTimeframes = [...new Set(Object.values(timeframes))];
  const fetchStart = toDate(startDate);
  const fetchEnd = endExclusive(endDate);
  const byTimeframe = {};

  for (const timeframe of uniqueTimeframes) {
    const explicitLimit = Number(getArg('--fetch-limit'));
    const limit = Number.isFinite(explicitLimit) && explicitLimit > 0
      ? explicitLimit
      : (DEFAULT_FETCH_LIMITS[timeframe] || 250000);
    console.log(`[Oil grid] Fetching ${symbol} ${timeframe} limit=${limit}`);
    byTimeframe[timeframe] = normalizeCandles(
      await mt5PaperService.getCandles(symbol, timeframe, fetchStart, limit, fetchEnd)
    );
    console.log(`[Oil grid] Fetched ${byTimeframe[timeframe].length} ${symbol} ${timeframe}`);
  }

  return {
    setup: byTimeframe[timeframes.setup],
    entry: byTimeframe[timeframes.entry],
    higher: byTimeframe[timeframes.higher],
  };
}

async function runSimulationQuietly(payload) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return await runSymbolCustomBacktestSimulation(payload);
  } finally {
    console.log = originalLog;
  }
}

async function runWindow({ symbolCustom, logic, logicName, candles, parameters, costModel, window }) {
  const windowCandles = {
    setup: filterWindow(candles.setup, window),
    entry: filterWindow(candles.entry, window),
    higher: filterWindow(candles.higher, window),
  };
  const simulation = await runSimulationQuietly({
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
}

async function runTarget(symbolCustom, windows, maxCombos, candidateIndexSet) {
  const logicName = symbolCustom.logicName || symbolCustom.registryLogicName || symbolCustom.symbolCustomName;
  const logic = getSymbolCustomLogic(logicName);
  if (!logic) {
    return { symbolCustomName: symbolCustom.symbolCustomName, logicName, skipped: true, skipReason: 'LOGIC_NOT_REGISTERED' };
  }

  const timeframes = resolveTimeframes(symbolCustom);
  const candles = await fetchCandles(symbolCustom.symbol, timeframes, windows[0].startDate, windows[0].endDate);
  const costModel = buildCostModel(symbolCustom.symbol);
  const candidateParameters = buildCandidateParameters(symbolCustom)
    .map((parameters, index) => ({ parameters, index: index + 1 }))
    .filter((candidate) => {
      if (candidateIndexSet) return candidateIndexSet.has(candidate.index);
      return candidate.index <= maxCombos;
    });
  const candidates = [];

  for (let index = 0; index < candidateParameters.length; index += 1) {
    const { parameters, index: rankInput } = candidateParameters[index];
    const results = [];
    for (const window of windows) {
      results.push(await runWindow({
        symbolCustom,
        logic,
        logicName,
        candles,
        parameters,
        costModel,
        window,
      }));
    }
    const score = scoreCandidate(results);
    const candidate = {
      rankInput,
      score,
      parameters: {
        allowedUtcHours: parameters.allowedUtcHours,
        requireHigherTrendAlignment: parameters.requireHigherTrendAlignment,
        maxDailyLosses: parameters.maxDailyLosses,
        minConfidence: parameters.minConfidence,
      },
      results,
    };
    candidates.push(candidate);
    const full = results.find((row) => row.label === 'full_window')?.summary || {};
    const recent = results.find((row) => row.label === 'recent_window')?.summary || {};
    console.log(`[Oil grid] ${logicName} candidate=${rankInput} ${index + 1}/${candidateParameters.length} score=${score} full trades=${full.trades} net=${full.netPnl} pf=${full.profitFactor} dd=${full.maxDrawdown} cl=${full.maxConsecutiveLosses} recent net=${recent.netPnl} pf=${recent.profitFactor}`);
  }

  candidates.sort((left, right) => right.score - left.score);
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
    timeframes,
    costModel,
    candleCoverage: {
      setup: summarizeCandles(candles.setup),
      entry: summarizeCandles(candles.entry),
      higher: summarizeCandles(candles.higher),
    },
    candidateCount: candidates.length,
    topCandidates: candidates.slice(0, 20),
  };
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const startDate = getArg('--start', DEFAULT_START_DATE);
  const endDate = getArg('--end', DEFAULT_END_DATE);
  const maxCombos = Math.max(1, Number(getArg('--max-combos', 36)) || 36);
  const symbols = new Set(splitArg(getArg('--symbols')).map((symbol) => symbol.toUpperCase()));
  const candidateIndexSet = parseIndexSet(getArg('--candidate-indices'));
  const outputPath = getArg('--out')
    ? path.resolve(process.cwd(), getArg('--out'))
    : path.join(OUTPUT_DIR, `oil-breakout-retest-grid-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const windows = [
    { label: 'full_window', startDate, endDate },
    { label: 'recent_window', startDate: shiftMonths(endDate, 6), endDate },
  ];

  const symbolCustoms = (await SymbolCustom.findAll({}))
    .filter((record) => {
      const logicName = record.logicName || record.registryLogicName || record.symbolCustomName;
      if (!TARGET_LOGICS.includes(logicName)) return false;
      if (symbols.size > 0 && !symbols.has(String(record.symbol || '').toUpperCase())) return false;
      return true;
    })
    .sort((left, right) => String(left.symbolCustomName).localeCompare(String(right.symbolCustomName)));

  console.log(`[Oil grid] Selected ${symbolCustoms.length} SymbolCustoms`);
  await mt5PaperService.connect();

  const reports = [];
  for (const symbolCustom of symbolCustoms) {
    console.log(`[Oil grid] Starting ${symbolCustom.symbolCustomName}`);
    reports.push(await runTarget(symbolCustom, windows, maxCombos, candidateIndexSet));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    method: 'Read-only parameter grid for oil breakout-retest SymbolCustom drafts. DB and strategy flags are not mutated.',
    initialBalance: INITIAL_BALANCE,
    windows,
    maxCombos,
    candidateIndices: candidateIndexSet ? [...candidateIndexSet] : null,
    reports,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    outputPath,
    reports: reports.map((row) => ({
      symbolCustomName: row.symbolCustomName,
      top: (row.topCandidates || []).slice(0, 5).map((candidate) => ({
        score: candidate.score,
        parameters: candidate.parameters,
        windows: Object.fromEntries(candidate.results.map((result) => [result.label, result.summary])),
      })),
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
