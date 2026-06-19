const fs = require('fs');
const path = require('path');

const SymbolCustom = require('../src/models/SymbolCustom');
const mt5PaperService = require('../src/services/mt5Service').paper;
const { getSymbolCustomLogic } = require('../src/symbolCustom/registry');
const { runSymbolCustomBacktestSimulation } = require('../src/services/symbolCustomBacktestRunnerService');
const { evaluateSymbolCustomBacktest } = require('../src/services/symbolCustomEvaluationService');

const SYMBOL_CUSTOM_ID = '8TvnNqlIuKK5ABgi';
const START_DATE = '2023-05-30';
const END_DATE = '2026-05-30';
const INITIAL_BALANCE = 500;
const FETCH_LIMIT = 2000000;
const REPORT_DIR = path.resolve(__dirname, '..', 'reports');
const PROGRESS_PATH = path.join(REPORT_DIR, 'xauusd-volume-profile-buy-only-ab-progress.json');
const RESULT_PATH = path.join(REPORT_DIR, 'xauusd-volume-profile-buy-only-ab-result.json');

const VARIANTS = [
  { name: 'baseline', parameters: {} },
  { name: 'buy_only', parameters: { allowSellSignals: false } },
  { name: 'buy_only_sep_0_10', parameters: { allowSellSignals: false, minTrendEmaSeparationAtr: 0.1 } },
  { name: 'buy_only_sep_0_20', parameters: { allowSellSignals: false, minTrendEmaSeparationAtr: 0.2 } },
  { name: 'buy_only_sep_0_30', parameters: { allowSellSignals: false, minTrendEmaSeparationAtr: 0.3 } },
  { name: 'buy_only_sep_0_40', parameters: { allowSellSignals: false, minTrendEmaSeparationAtr: 0.4 } },
  {
    name: 'buy_only_sep_0_20_roll_2_24h',
    parameters: {
      allowSellSignals: false,
      minTrendEmaSeparationAtr: 0.2,
      maxRollingConsecutiveLosses: 2,
      rollingLossCooldownMinutes: 1440,
    },
  },
  {
    name: 'buy_only_sep_0_20_roll_3_24h',
    parameters: {
      allowSellSignals: false,
      minTrendEmaSeparationAtr: 0.2,
      maxRollingConsecutiveLosses: 3,
      rollingLossCooldownMinutes: 1440,
    },
  },
  {
    name: 'buy_only_sep_0_30_roll_2_24h',
    parameters: {
      allowSellSignals: false,
      minTrendEmaSeparationAtr: 0.3,
      maxRollingConsecutiveLosses: 2,
      rollingLossCooldownMinutes: 1440,
    },
  },
  { name: 'buy_only_sep_0_50', parameters: { allowSellSignals: false, minTrendEmaSeparationAtr: 0.5 } },
  { name: 'buy_only_sep_0_60', parameters: { allowSellSignals: false, minTrendEmaSeparationAtr: 0.6 } },
  {
    name: 'buy_only_sep_0_40_roll_2_24h',
    parameters: {
      allowSellSignals: false,
      minTrendEmaSeparationAtr: 0.4,
      maxRollingConsecutiveLosses: 2,
      rollingLossCooldownMinutes: 1440,
    },
  },
  {
    name: 'buy_only_sep_0_40_roll_3_24h',
    parameters: {
      allowSellSignals: false,
      minTrendEmaSeparationAtr: 0.4,
      maxRollingConsecutiveLosses: 3,
      rollingLossCooldownMinutes: 1440,
    },
  },
  {
    name: 'buy_only_sep_0_50_roll_2_24h',
    parameters: {
      allowSellSignals: false,
      minTrendEmaSeparationAtr: 0.5,
      maxRollingConsecutiveLosses: 2,
      rollingLossCooldownMinutes: 1440,
    },
  },
];

fs.mkdirSync(REPORT_DIR, { recursive: true });

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, decimals = 4) {
  if (!Number.isFinite(Number(value))) return value == null ? null : value;
  return Number(Number(value).toFixed(decimals));
}

function getTradePnl(trade = {}) {
  return toNumber(trade.pnl ?? trade.profitLoss ?? trade.netPnl, 0);
}

function getQuarterKey(value) {
  const date = value ? new Date(value) : null;
  if (!date || !Number.isFinite(date.getTime())) return 'UNKNOWN';
  return `${date.getUTCFullYear()} Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}

function summarizeCandles(candles = []) {
  return {
    count: candles.length,
    first: candles[0]?.time || null,
    last: candles.at(-1)?.time || null,
  };
}

function normalizeInjectedCandles(candles = []) {
  return candles.map((candle) => {
    const volume = Number(candle.volume);
    const tickVolume = Number(candle.tickVolume);
    return {
      ...candle,
      volume: Number.isFinite(volume) && volume > 0
        ? volume
        : (Number.isFinite(tickVolume) ? tickVolume : 0),
    };
  });
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
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(next, null, 2));
  console.log(`[BUY-only A/B] ${next.stage || 'Progress'} ${next.percent ?? '--'}% ${next.message || ''}`);
}

function buildQuarterBreakdown(trades = []) {
  const quarters = new Map();
  trades.forEach((trade) => {
    const key = getQuarterKey(trade.entryTime || trade.openTime || trade.time);
    if (!quarters.has(key)) {
      quarters.set(key, {
        quarter: key,
        trades: 0,
        wins: 0,
        losses: 0,
        netPnl: 0,
        grossWin: 0,
        grossLoss: 0,
      });
    }
    const row = quarters.get(key);
    const pnl = getTradePnl(trade);
    row.trades += 1;
    row.netPnl += pnl;
    if (pnl > 0) {
      row.wins += 1;
      row.grossWin += pnl;
    } else if (pnl < 0) {
      row.losses += 1;
      row.grossLoss += Math.abs(pnl);
    }
  });

  return [...quarters.values()].map((row) => ({
    ...row,
    netPnl: round(row.netPnl),
    profitFactor: row.grossLoss > 0 ? round(row.grossWin / row.grossLoss) : null,
    winRate: row.trades > 0 ? round(row.wins / row.trades) : null,
    heavyCostNetPnl: round(row.netPnl - row.trades),
  }));
}

function summarizeVariant({ variant, simulation, evaluation }) {
  const quarterBreakdown = buildQuarterBreakdown(simulation.trades);
  const positiveQuarters = quarterBreakdown.filter((row) => row.netPnl > 0).length;
  const heavyPositiveQuarters = quarterBreakdown.filter((row) => row.heavyCostNetPnl > 0).length;
  const negativeQuarters = quarterBreakdown.filter((row) => row.netPnl < 0).length;
  const worstQuarterNetPnl = quarterBreakdown.length
    ? Math.min(...quarterBreakdown.map((row) => row.netPnl))
    : 0;
  const mediumCost = evaluation.costSensitivity.mediumCost || {};
  const heavyCost = evaluation.costSensitivity.heavyCost || {};
  const summary = {
    ...simulation.summary,
    rejectedSignalDetails: undefined,
  };

  return {
    name: variant.name,
    parameterOverrides: variant.parameters,
    summary,
    costSensitivity: evaluation.costSensitivity,
    directionBreakdown: evaluation.directionBreakdown,
    consecutiveLossAnalysis: evaluation.consecutiveLossAnalysis,
    recommendation: evaluation.recommendation,
    quarterStats: {
      positiveQuarters,
      negativeQuarters,
      heavyPositiveQuarters,
      totalQuarters: quarterBreakdown.length,
      worstQuarterNetPnl: round(worstQuarterNetPnl),
    },
    quarterBreakdown,
    trades: simulation.trades,
    robustScore: round(
      toNumber(heavyCost.netPnlAfterCost, 0) * 4
      + toNumber(mediumCost.netPnlAfterCost, 0) * 2
      + heavyPositiveQuarters * 8
      + positiveQuarters * 4
      - toNumber(evaluation.consecutiveLossAnalysis.maxConsecutiveLosses, 0) * 3
      - Math.abs(Math.min(0, worstQuarterNetPnl)) * 0.5
    ),
  };
}

async function fetchPaperCandles() {
  const start = new Date(`${START_DATE}T00:00:00.000Z`);
  const endExclusive = new Date(`${END_DATE}T00:00:00.000Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  const candlesByTimeframe = {};

  for (const timeframe of ['1m', '5m', '15m']) {
    writeProgress({
      stage: `Loading ${timeframe} candles`,
      message: `Downloading ${timeframe} XAUUSD history from isolated paper/demo MT5`,
    });
    candlesByTimeframe[timeframe] = normalizeInjectedCandles(
      await mt5PaperService.getCandles('XAUUSD', timeframe, start, FETCH_LIMIT, endExclusive)
    );
    writeProgress({
      stage: `Loaded ${timeframe} candles`,
      message: `${timeframe}: ${candlesByTimeframe[timeframe].length} candles`,
      candleCoverage: {
        ...(fs.existsSync(PROGRESS_PATH)
          ? JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8')).candleCoverage
          : {}),
        [timeframe]: summarizeCandles(candlesByTimeframe[timeframe]),
      },
    });
  }

  return {
    entry: candlesByTimeframe['1m'],
    setup: candlesByTimeframe['5m'],
    higher: candlesByTimeframe['15m'],
  };
}

async function runVariant({ symbolCustom, logic, candles, variant, index }) {
  const parameters = {
    ...symbolCustom.parameters,
    ...variant.parameters,
  };
  let lastPercent = -1;
  const originalLog = console.log;
  console.log = () => {};
  let simulation;
  try {
    simulation = await runSymbolCustomBacktestSimulation({
      symbolCustom,
      logic,
      logicName: symbolCustom.logicName,
      candles,
      parameters,
      costModel: {
        spread: 0,
        commissionPerTrade: 0,
        slippage: 0,
      },
      initialBalance: INITIAL_BALANCE,
      options: {},
      onProgress: (progress) => {
        const percent = Math.floor(toNumber(progress.percent, 0));
        if (percent === lastPercent || (percent % 5 !== 0 && percent < 92)) return;
        lastPercent = percent;
        const overallPercent = 5 + Math.floor(((index + (percent / 100)) / VARIANTS.length) * 94);
        const previous = fs.existsSync(PROGRESS_PATH)
          ? JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'))
          : {};
        fs.writeFileSync(PROGRESS_PATH, JSON.stringify({
          ...previous,
          stage: `Testing ${variant.name}`,
          status: 'running',
          percent: Math.min(99, overallPercent),
          candidateIndex: index + 1,
          candidateCount: VARIANTS.length,
          candidateProgress: progress,
          updatedAt: new Date().toISOString(),
        }, null, 2));
      },
    });
  } finally {
    console.log = originalLog;
  }

  const backtest = {
    ...simulation,
    symbol: symbolCustom.symbol,
    symbolCustomName: symbolCustom.symbolCustomName,
    startDate: START_DATE,
    endDate: END_DATE,
  };
  return summarizeVariant({
    variant,
    simulation,
    evaluation: evaluateSymbolCustomBacktest(backtest),
  });
}

async function main() {
  if (fs.existsSync(PROGRESS_PATH)) fs.unlinkSync(PROGRESS_PATH);
  writeProgress({
    stage: 'Connecting paper MT5',
    status: 'running',
    percent: 0,
    message: 'Connecting isolated Elev8 demo terminal for BUY-only A/B research',
    startDate: START_DATE,
    endDate: END_DATE,
  });

  const symbolCustom = await SymbolCustom.findById(SYMBOL_CUSTOM_ID);
  if (!symbolCustom) throw new Error(`SymbolCustom not found: ${SYMBOL_CUSTOM_ID}`);
  const logic = getSymbolCustomLogic(symbolCustom.logicName);
  if (!logic) throw new Error(`SymbolCustom logic not registered: ${symbolCustom.logicName}`);

  await mt5PaperService.connect();
  const candles = await fetchPaperCandles();
  const candleCoverage = {
    '1m': summarizeCandles(candles.entry),
    '5m': summarizeCandles(candles.setup),
    '15m': summarizeCandles(candles.higher),
  };
  writeProgress({
    stage: 'Starting A/B simulation',
    status: 'running',
    percent: 5,
    message: `${candles.entry.length} M1 candles ready; testing ${VARIANTS.length} variants`,
    candleCoverage,
  });

  const variants = [];
  for (let index = 0; index < VARIANTS.length; index += 1) {
    const variant = VARIANTS[index];
    writeProgress({
      stage: `Testing ${variant.name}`,
      status: 'running',
      percent: 5 + Math.floor((index / VARIANTS.length) * 94),
      candidateIndex: index + 1,
      candidateCount: VARIANTS.length,
      message: `Running candidate ${index + 1}/${VARIANTS.length}: ${variant.name}`,
    });
    const result = await runVariant({ symbolCustom, logic, candles, variant, index });
    variants.push(result);
    console.log(
      `[BUY-only A/B] ${variant.name}: trades=${result.summary.trades}`
      + ` net=${round(result.summary.netPnl, 2)}`
      + ` medium=${round(result.costSensitivity.mediumCost.netPnlAfterCost, 2)}`
      + ` heavy=${round(result.costSensitivity.heavyCost.netPnlAfterCost, 2)}`
      + ` score=${result.robustScore}`
    );
  }

  variants.sort((left, right) => right.robustScore - left.robustScore);
  const report = {
    generatedAt: new Date().toISOString(),
    dataSource: 'paper/demo MT5 feed',
    note: 'Research-only A/B. This script does not update SymbolCustom parameters or paper/live settings.',
    requestedRange: { startDate: START_DATE, endDate: END_DATE },
    candleCoverage,
    bestCandidate: variants[0],
    ranking: variants,
  };
  fs.writeFileSync(RESULT_PATH, JSON.stringify(report, null, 2));
  writeProgress({
    stage: 'Completed',
    status: 'completed',
    percent: 100,
    message: `Best candidate: ${variants[0].name}`,
    bestCandidate: {
      name: variants[0].name,
      parameterOverrides: variants[0].parameterOverrides,
      summary: variants[0].summary,
      costSensitivity: variants[0].costSensitivity,
      quarterStats: variants[0].quarterStats,
      robustScore: variants[0].robustScore,
    },
    resultPath: RESULT_PATH,
  });
}

main()
  .catch((error) => {
    writeProgress({
      stage: 'Failed',
      status: 'failed',
      message: error.message,
      error: error.stack || error.message,
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await mt5PaperService.disconnect();
  });
