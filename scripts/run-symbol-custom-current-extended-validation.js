const fs = require('fs');
const path = require('path');

const mt5PaperService = require('../src/services/mt5Service').paper;
const { getSymbolCustomLogic } = require('../src/symbolCustom/registry');
const { runSymbolCustomBacktestSimulation } = require('../src/services/symbolCustomBacktestRunnerService');
const { DEFAULT_LIVE_PROMOTION_THRESHOLDS } = require('../src/services/symbolCustomLivePromotionService');

const INITIAL_BALANCE = 500;
const OUTPUT_DIR = path.resolve(__dirname, '..', 'reports');
const PROGRESS_PATH = path.join(OUTPUT_DIR, 'symbol-custom-current-extended-validation-progress.json');
const COMBINED_OUTPUT_PATH = path.join(OUTPUT_DIR, 'symbol-custom-current-extended-validation-2026-06-05.json');

const VALIDATION_TARGETS = Object.freeze([
  {
    symbolCustomId: 'B7mCDyegVqOgy7Ii',
    symbol: 'USDJPY',
    logicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
    fetchLimit: 1200000,
    outputPath: path.join(OUTPUT_DIR, 'usdjpy-current-extended-validation-2026-06-05.json'),
    windows: [
      { label: 'full_window', startDate: '2020-01-01', endDate: '2026-06-05' },
      { label: 'latest_two_years', startDate: '2024-06-03', endDate: '2026-06-05' },
      { label: 'latest_year', startDate: '2025-06-03', endDate: '2026-06-05' },
      { label: 'recent_window', startDate: '2026-01-01', endDate: '2026-06-05' },
    ],
    costModel: {
      spread: 0.013,
      slippage: 0.002,
      commissionPerTrade: 0,
      source: 'instrument_average_spread_plus_0_2_pip_slippage',
      instrumentSpreadPips: 1.3,
      pipSize: 0.01,
    },
  },
  {
    symbolCustomId: '8TvnNqlIuKK5ABgi',
    symbol: 'XAUUSD',
    logicName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
    fetchLimit: 4000000,
    outputPath: path.join(OUTPUT_DIR, 'xauusd-volume-profile-current-extended-validation-2026-06-05.json'),
    windows: [
      { label: 'full_window', startDate: '2020-01-01', endDate: '2026-06-05' },
      { label: 'latest_three_years', startDate: '2023-05-30', endDate: '2026-06-05' },
      { label: 'latest_year', startDate: '2025-06-01', endDate: '2026-06-05' },
      { label: 'recent_window', startDate: '2026-01-01', endDate: '2026-06-05' },
    ],
    costModel: {
      spread: 0.25,
      slippage: 0.002,
      commissionPerTrade: 0,
      source: 'instrument_average_spread_plus_0_2_pip_slippage',
      instrumentSpreadPips: 25,
      pipSize: 0.01,
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

function loadSymbolCustom(id) {
  const docs = parseJsonLineDb(path.resolve(__dirname, '..', 'data', 'trading', 'symbol_customs.db'));
  const symbolCustom = docs.get(id);
  if (!symbolCustom) throw new Error(`SymbolCustom not found: ${id}`);
  return symbolCustom;
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
  if (patch.message) console.log(`[Extended validation] ${patch.message}`);
}

function toNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function evaluateThresholds(results = []) {
  const checks = [];
  for (const [label, thresholds] of Object.entries(DEFAULT_LIVE_PROMOTION_THRESHOLDS)) {
    const result = results.find((row) => row.label === label);
    if (!result) {
      checks.push({ name: `${label} validation exists`, status: 'FAIL', message: `${label} missing.` });
      continue;
    }
    const summary = result.summary || {};
    const fields = [
      ['trades', '>=', thresholds.minTrades],
      ['netPnl', '>=', thresholds.minNetPnl],
      ['profitFactor', '>=', thresholds.minProfitFactor],
      ['maxDrawdown', '<=', thresholds.maxDrawdown],
      ['maxConsecutiveLosses', '<=', thresholds.maxConsecutiveLosses],
    ];
    checks.push({ name: `${label} validation exists`, status: 'PASS', message: `${label} present.` });
    for (const [field, operator, expected] of fields) {
      const actual = toNumber(summary[field]);
      const passed = operator === '>='
        ? actual != null && actual >= expected
        : actual != null && actual <= expected;
      checks.push({
        name: `${label} ${field} ${operator} ${expected}`,
        status: passed ? 'PASS' : 'FAIL',
        actual,
        expected,
      });
    }
    checks.push({
      name: `${label} equity and balance curve fields present`,
      status: summary.equityCurveHasBalance === true && summary.equityCurveHasEquity === true ? 'PASS' : 'FAIL',
      equityCurveHasBalance: summary.equityCurveHasBalance,
      equityCurveHasEquity: summary.equityCurveHasEquity,
    });
  }
  return {
    checks,
    summary: checks.reduce((acc, check) => {
      const key = String(check.status || '').toLowerCase();
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };
}

async function fetchCandles(target, symbolCustom) {
  const timeframes = symbolCustom.timeframes || {};
  const resolved = {
    setup: timeframes.setupTimeframe || '15m',
    entry: timeframes.entryTimeframe || '5m',
    higher: timeframes.higherTimeframe || '1h',
  };
  const fetchStart = new Date(`${target.windows[0].startDate}T00:00:00.000Z`);
  const fetchEnd = endExclusive(target.windows[0].endDate);
  const uniqueTimeframes = [...new Set(Object.values(resolved))];
  const byTimeframe = {};

  for (const timeframe of uniqueTimeframes) {
    writeProgress({ message: `Fetching ${target.symbol} ${timeframe}` });
    byTimeframe[timeframe] = normalizeCandles(
      await mt5PaperService.getCandles(target.symbol, timeframe, fetchStart, target.fetchLimit, fetchEnd)
    );
    writeProgress({ message: `Fetched ${byTimeframe[timeframe].length} ${target.symbol} ${timeframe} candles` });
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

async function runWindow({ target, symbolCustom, logic, candles, window }) {
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
      logicName: target.logicName,
      candles: windowCandles,
      parameters: symbolCustom.parameters || {},
      costModel: target.costModel,
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

async function runTarget(target, targetIndex, targetCount) {
  const symbolCustom = loadSymbolCustom(target.symbolCustomId);
  const logic = getSymbolCustomLogic(target.logicName);
  if (!logic) throw new Error(`SymbolCustom logic not registered: ${target.logicName}`);

  writeProgress({
    message: `Starting ${target.symbol} ${target.logicName} (${targetIndex}/${targetCount})`,
    status: 'running',
    target: target.logicName,
    targetIndex,
    targetCount,
  });
  const fetched = await fetchCandles(target, symbolCustom);
  const results = [];

  for (let index = 0; index < target.windows.length; index += 1) {
    const window = target.windows[index];
    writeProgress({
      message: `Testing ${target.logicName} ${window.label}`,
      status: 'running',
      target: target.logicName,
      windowIndex: index + 1,
      windowCount: target.windows.length,
    });
    const result = await runWindow({
      target,
      symbolCustom,
      logic,
      candles: fetched.all,
      window,
    });
    results.push(result);
    console.log(`[Extended validation] ${target.logicName} ${window.label}: trades=${result.summary.trades} net=${round(result.summary.netPnl, 2)} pf=${round(result.summary.profitFactor, 2)} dd=${round(result.summary.maxDrawdown, 2)} cl=${result.summary.maxConsecutiveLosses}`);
  }

  const thresholdEvaluation = evaluateThresholds(results);
  const report = {
    generatedAt: new Date().toISOString(),
    symbolCustomId: target.symbolCustomId,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName: target.logicName,
    symbol: target.symbol,
    status: symbolCustom.status,
    flags: {
      paperEnabled: symbolCustom.paperEnabled === true,
      liveEnabled: symbolCustom.liveEnabled === true,
      allowLive: symbolCustom.allowLive === true,
      isPrimaryLive: symbolCustom.isPrimaryLive === true,
    },
    initialBalance: INITIAL_BALANCE,
    costModel: target.costModel,
    timeframes: fetched.timeframes,
    candleCoverage: {
      setup: summarizeCandles(fetched.all.setup),
      entry: summarizeCandles(fetched.all.entry),
      higher: summarizeCandles(fetched.all.higher),
    },
    parameterSnapshot: symbolCustom.parameters || {},
    livePromotionThresholds: DEFAULT_LIVE_PROMOTION_THRESHOLDS,
    thresholdEvaluation,
    method: 'Read-only strict-cost extended validation of current DB SymbolCustom parameters. No DB mutation.',
    results,
  };

  fs.writeFileSync(target.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  writeProgress({
    message: `Starting current extended validation for ${VALIDATION_TARGETS.length} SymbolCustoms`,
    status: 'running',
    targetCount: VALIDATION_TARGETS.length,
  });

  await mt5PaperService.connect();
  const reports = [];
  for (let index = 0; index < VALIDATION_TARGETS.length; index += 1) {
    reports.push(await runTarget(VALIDATION_TARGETS[index], index + 1, VALIDATION_TARGETS.length));
  }

  const combined = {
    generatedAt: new Date().toISOString(),
    method: 'Combined current-parameter extended validation for paper-testing SymbolCustoms. No DB mutation.',
    reports: reports.map((report) => ({
      symbolCustomId: report.symbolCustomId,
      symbolCustomName: report.symbolCustomName,
      logicName: report.logicName,
      symbol: report.symbol,
      status: report.status,
      flags: report.flags,
      outputPath: VALIDATION_TARGETS.find((target) => target.symbolCustomId === report.symbolCustomId)?.outputPath || null,
      candleCoverage: report.candleCoverage,
      thresholdEvaluation: report.thresholdEvaluation,
      results: report.results,
    })),
  };
  fs.writeFileSync(COMBINED_OUTPUT_PATH, `${JSON.stringify(combined, null, 2)}\n`);
  writeProgress({ message: `Completed. Report: ${COMBINED_OUTPUT_PATH}`, status: 'completed', outputPath: COMBINED_OUTPUT_PATH });
  console.log(JSON.stringify({
    outputPath: COMBINED_OUTPUT_PATH,
    reports: combined.reports.map((report) => ({
      logicName: report.logicName,
      thresholdSummary: report.thresholdEvaluation.summary,
      windows: Object.fromEntries(report.results.map((result) => [result.label, {
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
    writeProgress({ status: 'failed', message: error.message, error: error.stack || error.message });
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mt5PaperService.disconnect();
  });
