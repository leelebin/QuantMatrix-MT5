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
const DEFAULT_FETCH_LIMITS = Object.freeze({
  '5m': 250000,
  '15m': 90000,
  '1h': 25000,
});
const TARGET_LOGICS = Object.freeze([
  'US30_INDEX_OPENING_RANGE_MOMENTUM_V1',
  'NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1',
]);

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

function sampleCandles(candles = [], stride = 1) {
  const safeStride = Math.max(1, Math.floor(Number(stride) || 1));
  if (safeStride <= 1) return candles;
  return candles.filter((_, index) => index % safeStride === 0);
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
    setup: timeframes.setupTimeframe || params.setupTimeframe || '15m',
    entry: timeframes.entryTimeframe || params.entryTimeframe || '5m',
    higher: timeframes.higherTimeframe || params.higherTimeframe || '1h',
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

function scoreCandidate(windows = []) {
  const full = windows.find((row) => row.label === 'full_window')?.summary || {};
  const recent = windows.find((row) => row.label === 'recent_window')?.summary || {};
  const fullTrades = Number(full.trades) || 0;
  const recentTrades = Number(recent.trades) || 0;
  const fullNet = Number(full.netPnl) || 0;
  const recentNet = Number(recent.netPnl) || 0;
  const fullPf = Number(full.profitFactor) || 0;
  const recentPf = Number(recent.profitFactor) || 0;
  const drawdownPenalty = Math.max(0, Number(full.maxDrawdown) || 0) * 0.15;
  return round(
    (fullNet * 0.7)
      + (recentNet * 1.2)
      + Math.min(fullTrades, 30) * 0.15
      + Math.min(recentTrades, 15) * 0.25
      + Math.max(0, fullPf - 1) * 2
      + Math.max(0, recentPf - 1) * 3
      - drawdownPenalty,
    4
  );
}

function buildCandidateParameters(symbolCustom = {}) {
  const base = {
    ...(symbolCustom.parameters || {}),
    enabled: true,
    maxDailyTrades: 0,
    maxDailyLosses: 0,
    maxConsecutiveLosses: 0,
  };
  const hours = [
    [],
    [12, 13, 14, 15, 16, 17, 18, 19],
    [13, 14, 15, 16, 17, 18],
  ];
  const variants = [];
  for (const allowedUtcHours of hours) {
    for (const minSignalScore of [55, 62, 70]) {
      for (const breakoutLookbackBars of [6, 10, 14]) {
        for (const minRelativeVolume of [0, 0.9, 1.1]) {
          variants.push({
            ...base,
            allowedUtcHours,
            minSignalScore,
            breakoutLookbackBars,
            minRelativeVolume,
            useVolumeFilter: minRelativeVolume > 0,
            breakoutBufferAtr: 0.03,
            maxPreBreakoutRangeAtr: 8,
            maxExtensionAtr: 8,
            maxAtrRatio: 4,
            maxAtrSpikeRatio: 5,
            spreadAtrMaxRatio: 0.2,
          });
        }
      }
    }
  }
  return variants;
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
    console.log(`[Index grid] Fetching ${symbol} ${timeframe} limit=${limit}`);
    byTimeframe[timeframe] = normalizeCandles(
      await mt5PaperService.getCandles(symbol, timeframe, fetchStart, limit, fetchEnd)
    );
    console.log(`[Index grid] Fetched ${byTimeframe[timeframe].length} ${symbol} ${timeframe}`);
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

async function runWindow({ symbolCustom, logic, logicName, candles, parameters, costModel, window, entryStride }) {
  const windowCandles = {
    setup: filterWindow(candles.setup, window),
    entry: sampleCandles(filterWindow(candles.entry, window), entryStride),
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

async function runTarget(symbolCustom, windows, maxCombos, entryStride, candidateIndexSet) {
  const logicName = symbolCustom.logicName || symbolCustom.registryLogicName || symbolCustom.symbolCustomName;
  const logic = getSymbolCustomLogic(logicName);
  if (!logic) {
    return { symbolCustomName: symbolCustom.symbolCustomName, logicName, skipped: true, skipReason: 'LOGIC_NOT_REGISTERED' };
  }

  const timeframes = resolveTimeframes(symbolCustom);
  const candles = await fetchCandles(symbolCustom.symbol, timeframes, windows[0].startDate, windows[0].endDate);
  const costModel = buildCostModel(symbolCustom.symbol);
  const allCandidateParameters = buildCandidateParameters(symbolCustom);
  const candidateParameters = allCandidateParameters
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
        entryStride,
      }));
    }
    const score = scoreCandidate(results);
    const candidate = {
      rankInput: index + 1,
      score,
      parameters: {
        allowedUtcHours: parameters.allowedUtcHours,
        minSignalScore: parameters.minSignalScore,
        breakoutLookbackBars: parameters.breakoutLookbackBars,
        minRelativeVolume: parameters.minRelativeVolume,
        useVolumeFilter: parameters.useVolumeFilter,
        breakoutBufferAtr: parameters.breakoutBufferAtr,
        maxPreBreakoutRangeAtr: parameters.maxPreBreakoutRangeAtr,
        maxExtensionAtr: parameters.maxExtensionAtr,
        maxAtrRatio: parameters.maxAtrRatio,
        maxAtrSpikeRatio: parameters.maxAtrSpikeRatio,
        spreadAtrMaxRatio: parameters.spreadAtrMaxRatio,
      },
      results,
    };
    candidates.push(candidate);
    const full = results.find((row) => row.label === 'full_window')?.summary || {};
    const recent = results.find((row) => row.label === 'recent_window')?.summary || {};
    console.log(`[Index grid] ${logicName} candidate=${rankInput} ${index + 1}/${candidateParameters.length} score=${score} full trades=${full.trades} net=${full.netPnl} pf=${full.profitFactor} recent trades=${recent.trades} net=${recent.netPnl} pf=${recent.profitFactor}`);
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
    entryStride,
    topCandidates: candidates.slice(0, 20),
  };
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const startDate = getArg('--start', DEFAULT_START_DATE);
  const endDate = getArg('--end', DEFAULT_END_DATE);
  const maxCombos = Math.max(1, Number(getArg('--max-combos', 81)) || 81);
  const entryStride = Math.max(1, Number(getArg('--entry-stride', 1)) || 1);
  const candidateIndexSet = parseIndexSet(getArg('--candidate-indices'));
  const names = new Set(splitArg(getArg('--names')));
  const outputPath = getArg('--out')
    ? path.resolve(process.cwd(), getArg('--out'))
    : path.join(OUTPUT_DIR, `index-opening-range-momentum-grid-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const windows = [
    { label: 'full_window', startDate, endDate },
    { label: 'recent_window', startDate: shiftMonths(endDate, 6), endDate },
  ];

  const symbolCustoms = (await SymbolCustom.findAll({}))
    .filter((record) => {
      const logicName = record.logicName || record.registryLogicName || record.symbolCustomName;
      if (!TARGET_LOGICS.includes(logicName)) return false;
      if (names.size > 0 && !names.has(record.symbolCustomName) && !names.has(logicName)) return false;
      return true;
    })
    .sort((left, right) => String(left.symbolCustomName).localeCompare(String(right.symbolCustomName)));

  console.log(`[Index grid] Selected ${symbolCustoms.length} SymbolCustoms`);
  await mt5PaperService.connect();

  const reports = [];
  for (const symbolCustom of symbolCustoms) {
    console.log(`[Index grid] Starting ${symbolCustom.symbolCustomName}`);
    reports.push(await runTarget(symbolCustom, windows, maxCombos, entryStride, candidateIndexSet));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    method: 'Read-only parameter grid for US30/NAS100 index opening-range momentum SymbolCustom drafts. DB and strategy flags are not mutated.',
    initialBalance: INITIAL_BALANCE,
    windows,
    maxCombos,
    entryStride,
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
