const fs = require('fs');
const path = require('path');

const mt5PaperService = require('../src/services/mt5Service').paper;
const { getSymbolCustomLogic } = require('../src/symbolCustom/registry');
const { runSymbolCustomBacktestSimulation } = require('../src/services/symbolCustomBacktestRunnerService');

const SYMBOL_CUSTOM_ID = 'z49Rm6XSLcS6h3PB';
const SYMBOL = 'XAUUSD';
const LOGIC_NAME = 'XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1';
const INITIAL_BALANCE = 500;
const FETCH_LIMIT = 700000;
const GRID_MODE = process.env.VOLUME_FLOW_GRID_MODE || 'risk';
const REPORT_TAG = process.env.VOLUME_FLOW_REPORT_TAG || 'risk-grid';
const REPORT_DATE = process.env.VOLUME_FLOW_REPORT_DATE || '2026-06-05';
const OUTPUT_PATH = path.resolve(__dirname, '..', 'reports', `xauusd-volume-flow-${REPORT_TAG}-${REPORT_DATE}.json`);
const PROGRESS_PATH = path.resolve(__dirname, '..', 'reports', `xauusd-volume-flow-${REPORT_TAG}-progress.json`);

const FULL_WINDOW = Object.freeze({ label: 'full_window', startDate: '2020-01-01', endDate: '2026-06-05' });
const SCREEN_WINDOWS = Object.freeze([
  { label: 'latest_year', startDate: '2025-06-05', endDate: '2026-06-05' },
  { label: 'recent_window', startDate: '2026-01-01', endDate: '2026-06-05' },
]);
const WINDOWS = Object.freeze([FULL_WINDOW, ...SCREEN_WINDOWS]);
const FINAL_TOP_N = 12;

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
  { name: 'h15_16_17', allowedUtcHours: '15,16,17' },
  { name: 'h15_16', allowedUtcHours: '15,16' },
  { name: 'h16_17', allowedUtcHours: '16,17' },
  { name: 'h15', allowedUtcHours: '15' },
  { name: 'h16', allowedUtcHours: '16' },
  { name: 'h17', allowedUtcHours: '17' },
]);

const SIDE_PROFILES = Object.freeze([
  { name: 'both', patch: { enableBuy: true, enableSell: true } },
  { name: 'buy', patch: { enableBuy: true, enableSell: false } },
  { name: 'sell', patch: { enableBuy: false, enableSell: true } },
]);

const QUALITY_PROFILES = Object.freeze([
  { name: 'q_current', patch: { rvolContinuation: 2.8, bodyAtrThreshold: 0.6, minConfidence: 0.6 } },
  { name: 'q_rvol3_2', patch: { rvolContinuation: 3.2, bodyAtrThreshold: 0.6, minConfidence: 0.6 } },
  { name: 'q_rvol3_2_body0_75', patch: { rvolContinuation: 3.2, bodyAtrThreshold: 0.75, minConfidence: 0.6 } },
]);

const RISK_PROFILES = Object.freeze([
  { name: 'risk_off', patch: { maxTradesPerDay: 0, maxConsecutiveLossesPerDay: 0, cooldownBarsAfterAnyExit: 0, cooldownBarsAfterSL: 0, maxRollingConsecutiveLosses: 0, rollingLossCooldownBars: 0 } },
  { name: 'daily1', patch: { maxTradesPerDay: 1, maxConsecutiveLossesPerDay: 0, cooldownBarsAfterAnyExit: 0, cooldownBarsAfterSL: 0, maxRollingConsecutiveLosses: 0, rollingLossCooldownBars: 0 } },
  { name: 'roll2_288', patch: { maxTradesPerDay: 0, maxConsecutiveLossesPerDay: 0, cooldownBarsAfterAnyExit: 0, cooldownBarsAfterSL: 0, maxRollingConsecutiveLosses: 2, rollingLossCooldownBars: 288 } },
  { name: 'daily1_roll2_288', patch: { maxTradesPerDay: 1, maxConsecutiveLossesPerDay: 0, cooldownBarsAfterAnyExit: 0, cooldownBarsAfterSL: 0, maxRollingConsecutiveLosses: 2, rollingLossCooldownBars: 288 } },
]);

const DEFAULT_EXIT_PROFILES = Object.freeze([
  { name: 'exit_db', patch: {} },
]);

const EXIT_RISK_SESSION_SETS = Object.freeze([
  { name: 'h15_16_17', allowedUtcHours: '15,16,17' },
  { name: 'h15_16', allowedUtcHours: '15,16' },
]);

const EXIT_RISK_SIDE_PROFILES = Object.freeze([
  { name: 'both', patch: { enableBuy: true, enableSell: true } },
  { name: 'buy', patch: { enableBuy: true, enableSell: false } },
]);

const EXIT_RISK_QUALITY_PROFILES = Object.freeze([
  { name: 'q_current', patch: { rvolContinuation: 2.8, bodyAtrThreshold: 0.6, minConfidence: 0.6 } },
  { name: 'q_body0_75', patch: { rvolContinuation: 2.8, bodyAtrThreshold: 0.75, minConfidence: 0.6 } },
  { name: 'q_rvol3_0', patch: { rvolContinuation: 3.0, bodyAtrThreshold: 0.6, minConfidence: 0.6 } },
]);

const EXIT_RISK_EXIT_PROFILES = Object.freeze([
  { name: 'sl2_tp5', patch: { slAtrMultiplier: 2.0, tpAtrMultiplier: 5.0 } },
  { name: 'sl2_tp3_5', patch: { slAtrMultiplier: 2.0, tpAtrMultiplier: 3.5 } },
  { name: 'sl1_5_tp3', patch: { slAtrMultiplier: 1.5, tpAtrMultiplier: 3.0 } },
  { name: 'sl1_2_tp2_4', patch: { slAtrMultiplier: 1.2, tpAtrMultiplier: 2.4 } },
]);

const EXIT_RISK_RISK_PROFILES = Object.freeze([
  { name: 'risk_off', patch: { maxTradesPerDay: 0, maxConsecutiveLossesPerDay: 0, cooldownBarsAfterAnyExit: 0, cooldownBarsAfterSL: 0, maxRollingConsecutiveLosses: 0, rollingLossCooldownBars: 0 } },
  { name: 'sl_cd24', patch: { maxTradesPerDay: 0, maxConsecutiveLossesPerDay: 0, cooldownBarsAfterAnyExit: 0, cooldownBarsAfterSL: 24, maxRollingConsecutiveLosses: 0, rollingLossCooldownBars: 0 } },
  { name: 'roll2_288', patch: { maxTradesPerDay: 0, maxConsecutiveLossesPerDay: 0, cooldownBarsAfterAnyExit: 0, cooldownBarsAfterSL: 0, maxRollingConsecutiveLosses: 2, rollingLossCooldownBars: 288 } },
  { name: 'day_loss1', patch: { maxTradesPerDay: 0, maxConsecutiveLossesPerDay: 1, cooldownBarsAfterAnyExit: 0, cooldownBarsAfterSL: 0, maxRollingConsecutiveLosses: 0, rollingLossCooldownBars: 0 } },
]);

function resolveGridConfig() {
  if (GRID_MODE === 'exit_risk') {
    return {
      sessionSets: EXIT_RISK_SESSION_SETS,
      sideProfiles: EXIT_RISK_SIDE_PROFILES,
      qualityProfiles: EXIT_RISK_QUALITY_PROFILES,
      exitProfiles: EXIT_RISK_EXIT_PROFILES,
      riskProfiles: EXIT_RISK_RISK_PROFILES,
    };
  }

  return {
    sessionSets: SESSION_SETS,
    sideProfiles: SIDE_PROFILES,
    qualityProfiles: QUALITY_PROFILES,
    exitProfiles: DEFAULT_EXIT_PROFILES,
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
  if (patch.message) console.log(`[VolumeFlow ${GRID_MODE} grid] ${patch.message}`);
}

async function fetchCandles(symbolCustom) {
  const timeframes = symbolCustom.timeframes || {};
  const resolved = {
    setup: timeframes.setupTimeframe || '5m',
    entry: timeframes.entryTimeframe || '5m',
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
    maxDrawdown: round(simulation.summary.maxDrawdown),
    maxSingleLoss: round(simulation.summary.maxSingleLoss),
    maxWin: round(simulation.summary.maxWin),
    maxConsecutiveLosses: simulation.summary.maxConsecutiveLosses,
    finalBalance: round(simulation.finalBalance),
    rawSignals: simulation.summary.rawSignals,
    openedSignals: simulation.summary.openedSignals,
    rejectedSignals: simulation.summary.rejectedSignals,
    equityCurveHasBalance: simulation.equityCurve.some((point) => point.balance !== undefined),
    equityCurveHasEquity: simulation.equityCurve.some((point) => point.equity !== undefined),
  };
}

function evaluateGate(summary = {}, gate = {}) {
  const checks = [
    ['trades', '>=', gate.minTrades],
    ['netPnl', '>=', gate.minNetPnl],
    ['profitFactor', '>=', gate.minProfitFactor],
    ['maxDrawdown', '<=', gate.maxDrawdown],
    ['maxConsecutiveLosses', '<=', gate.maxConsecutiveLosses],
  ].map(([field, operator, expected]) => {
    const actual = toNumber(summary[field], null);
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

  return { passed: checks.every((check) => check.passed), checks };
}

function evaluateLiveGates(windows = {}) {
  const gates = {};
  for (const [label, gate] of Object.entries(LIVE_GATES)) {
    gates[label] = windows[label]
      ? evaluateGate(windows[label].summary, gate)
      : { passed: false, checks: [{ name: `${label}_exists`, passed: false }] };
  }
  return {
    passed: Object.values(gates).every((gate) => gate.passed),
    gates,
  };
}

function scoreResult(result) {
  const full = result.windows.full_window?.summary || result.windows.latest_year?.summary || {};
  const recent = result.windows.recent_window?.summary || {};
  const gates = result.liveGate?.gates || {};
  const passedChecks = Object.values(gates)
    .flatMap((gate) => gate.checks || [])
    .filter((check) => check.passed).length;
  return round(
    (result.liveGate?.passed ? 10000 : 0)
    + passedChecks * 150
    + toNumber(full.netPnl, 0)
    + toNumber(recent.netPnl, 0) * 2
    + toNumber(full.profitFactor, 0) * 120
    + toNumber(recent.profitFactor, 0) * 80
    - Math.max(0, toNumber(full.maxDrawdown, 999) - 20) * 2
    - Math.max(0, toNumber(recent.maxDrawdown, 999) - 15) * 4
    - Math.max(0, toNumber(full.maxConsecutiveLosses, 99) - 4) * 40
    - Math.max(0, toNumber(recent.maxConsecutiveLosses, 99) - 4) * 50
  );
}

function buildVariants() {
  const {
    sessionSets,
    sideProfiles,
    qualityProfiles,
    exitProfiles,
    riskProfiles,
  } = resolveGridConfig();
  const seen = new Set();
  const variants = [];
  for (const session of sessionSets) {
    for (const side of sideProfiles) {
      for (const quality of qualityProfiles) {
        for (const exit of exitProfiles) {
          for (const risk of riskProfiles) {
            const name = `${session.name}_${side.name}_${quality.name}_${exit.name}_${risk.name}`;
            const patch = {
              allowedUtcHours: session.allowedUtcHours,
              ...side.patch,
              ...quality.patch,
              ...exit.patch,
              ...risk.patch,
            };
            const key = JSON.stringify(patch);
            if (seen.has(key)) continue;
            seen.add(key);
            variants.push({ name, patch });
          }
        }
      }
    }
  }
  return variants;
}

async function simulateVariant({ symbolCustom, logic, candlesByWindow, variant, windowsToRun = WINDOWS }) {
  const parameters = {
    ...(symbolCustom.parameters || {}),
    ...variant.patch,
  };
  const windows = {};
  for (const window of windowsToRun) {
    const simulation = await runSymbolCustomBacktestSimulation({
      symbolCustom,
      logic,
      logicName: LOGIC_NAME,
      candles: candlesByWindow[window.label],
      parameters,
      costModel: STRICT_COST_MODEL,
      initialBalance: INITIAL_BALANCE,
      options: { riskPerTradePct: 1 },
    });
    windows[window.label] = {
      range: window,
      summary: compactSummary(simulation),
    };
  }

  const liveGate = evaluateLiveGates(windows);
  const result = {
    name: variant.name,
    patch: variant.patch,
    windows,
    liveGate,
  };
  result.score = scoreResult(result);
  return result;
}

async function main() {
  const startedAt = new Date().toISOString();
  const symbolCustom = loadSymbolCustom();
  const logic = getSymbolCustomLogic(LOGIC_NAME);
  if (!logic) throw new Error(`Logic not registered: ${LOGIC_NAME}`);

  const fetched = await fetchCandles(symbolCustom);
  const candlesByWindow = {};
  for (const window of WINDOWS) {
    candlesByWindow[window.label] = {
      setup: filterWindow(fetched.all.setup, window),
      entry: filterWindow(fetched.all.entry, window),
      higher: filterWindow(fetched.all.higher, window),
    };
  }

  const variants = buildVariants();
  const screenResults = [];
  writeProgress({
    startedAt,
    totalVariants: variants.length,
    completedVariants: 0,
    stage: 'screen',
    message: `Screening ${variants.length} VolumeFlow variants on latest/recent windows`,
  });

  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index];
    const result = await simulateVariant({
      symbolCustom,
      logic,
      candlesByWindow,
      variant,
      windowsToRun: SCREEN_WINDOWS,
    });
    screenResults.push(result);
    if ((index + 1) % 10 === 0 || result.liveGate.passed || index === variants.length - 1) {
      const best = [...screenResults].sort((left, right) => right.score - left.score)[0];
      writeProgress({
        stage: 'screen',
        completedVariants: index + 1,
        bestName: best.name,
        bestScore: best.score,
        bestPassed: best.liveGate.passed,
        message: `Completed ${index + 1}/${variants.length}; best=${best.name}`,
      });
      fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify({
        generatedAt: new Date().toISOString(),
        partial: true,
        stage: 'screen',
        symbolCustomId: SYMBOL_CUSTOM_ID,
        symbolCustomName: symbolCustom.symbolCustomName,
        logicName: LOGIC_NAME,
        symbol: SYMBOL,
        initialBalance: INITIAL_BALANCE,
        costModel: STRICT_COST_MODEL,
        liveGates: LIVE_GATES,
        timeframes: fetched.timeframes,
        candleCoverage: Object.fromEntries(Object.entries(candlesByWindow).map(([label, candles]) => [label, {
          setup: summarizeCandles(candles.setup),
          entry: summarizeCandles(candles.entry),
          higher: summarizeCandles(candles.higher),
        }])),
        gridMode: GRID_MODE,
        screenResults: [...screenResults].sort((left, right) => right.score - left.score).slice(0, 30),
      }, null, 2)}\n`);
    }
  }

  const screenSorted = [...screenResults].sort((left, right) => right.score - left.score);
  const finalists = screenSorted.slice(0, FINAL_TOP_N);
  const finalResults = [];
  writeProgress({
    stage: 'full_validate',
    completedFinalists: 0,
    totalFinalists: finalists.length,
    message: `Full-window validating top ${finalists.length} VolumeFlow variants`,
  });

  for (let index = 0; index < finalists.length; index += 1) {
    const finalist = finalists[index];
    const fullResult = await simulateVariant({
      symbolCustom,
      logic,
      candlesByWindow,
      variant: { name: finalist.name, patch: finalist.patch },
      windowsToRun: [FULL_WINDOW],
    });
    const combined = {
      ...finalist,
      windows: {
        ...fullResult.windows,
        ...finalist.windows,
      },
    };
    combined.liveGate = evaluateLiveGates(combined.windows);
    combined.score = scoreResult(combined);
    finalResults.push(combined);
    writeProgress({
      stage: 'full_validate',
      completedFinalists: index + 1,
      totalFinalists: finalists.length,
      message: `Full-window validated ${index + 1}/${finalists.length}; ${combined.name}`,
    });
  }

  const sorted = [...finalResults].sort((left, right) => right.score - left.score);
  const output = {
    generatedAt: new Date().toISOString(),
    partial: false,
    symbolCustomId: SYMBOL_CUSTOM_ID,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName: LOGIC_NAME,
    symbol: SYMBOL,
    initialBalance: INITIAL_BALANCE,
    costModel: STRICT_COST_MODEL,
    liveGates: LIVE_GATES,
    timeframes: fetched.timeframes,
    gridMode: GRID_MODE,
    candleCoverage: Object.fromEntries(Object.entries(candlesByWindow).map(([label, candles]) => [label, {
      setup: summarizeCandles(candles.setup),
      entry: summarizeCandles(candles.entry),
      higher: summarizeCandles(candles.higher),
    }])),
    passedCount: sorted.filter((result) => result.liveGate.passed).length,
    screenTotal: screenResults.length,
    finalValidatedCount: sorted.length,
    screenResultsTop: screenSorted.slice(0, 30),
    results: sorted,
  };

  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  writeProgress({
    completedVariants: variants.length,
    completedFinalists: sorted.length,
    passedCount: output.passedCount,
    done: true,
    message: `Done. passed=${output.passedCount}; best=${sorted[0]?.name || 'none'}`,
  });
  console.log(JSON.stringify({
    outputPath: OUTPUT_PATH,
    passedCount: output.passedCount,
    best: sorted[0] ? {
      name: sorted[0].name,
      score: sorted[0].score,
      liveGatePassed: sorted[0].liveGate.passed,
      full: sorted[0].windows.full_window.summary,
      recent: sorted[0].windows.recent_window.summary,
      patch: sorted[0].patch,
    } : null,
  }, null, 2));
}

main()
  .catch((error) => {
    writeProgress({ error: error.message, done: true });
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mt5PaperService.disconnect();
  });
