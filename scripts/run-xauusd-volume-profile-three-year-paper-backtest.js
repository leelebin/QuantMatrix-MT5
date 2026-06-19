const fs = require('fs');
const path = require('path');

const mt5PaperService = require('../src/services/mt5Service').paper;
const symbolCustomBacktestService = require('../src/services/symbolCustomBacktestService');
const symbolCustomBacktestProgressService = require('../src/services/symbolCustomBacktestProgressService');
const symbolCustomEvaluationService = require('../src/services/symbolCustomEvaluationService');

const SYMBOL_CUSTOM_ID = '8TvnNqlIuKK5ABgi';
const START_DATE = '2023-05-30';
const END_DATE = '2026-05-30';
const INITIAL_BALANCE = 500;
const FETCH_LIMIT = 2000000;
const RUN_ID = `xauusd-volume-profile-paper-3y-${Date.now()}`;
const REPORT_DIR = path.resolve(__dirname, '..', 'reports');
const PROGRESS_PATH = path.join(REPORT_DIR, 'xauusd-volume-profile-3y-paper-progress.json');
const RESULT_PATH = path.join(REPORT_DIR, 'xauusd-volume-profile-3y-paper-result.json');

fs.mkdirSync(REPORT_DIR, { recursive: true });

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
    runId: RUN_ID,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(next, null, 2));
  console.log(`[3Y Backtest] ${next.stage || 'Progress'} ${next.percent ?? '--'}% ${next.message || ''}`);
}

function hookRunnerProgress() {
  const originalStartRun = symbolCustomBacktestProgressService.startRun;
  const originalUpdateRun = symbolCustomBacktestProgressService.updateRun;
  const originalCompleteRun = symbolCustomBacktestProgressService.completeRun;
  const originalFailRun = symbolCustomBacktestProgressService.failRun;

  symbolCustomBacktestProgressService.startRun = (runId, metadata = {}) => {
    const result = originalStartRun(runId, metadata);
    writeProgress({ status: 'running', ...metadata });
    return result;
  };
  symbolCustomBacktestProgressService.updateRun = (runId, patch = {}) => {
    const result = originalUpdateRun(runId, patch);
    writeProgress({ status: 'running', ...patch });
    return result;
  };
  symbolCustomBacktestProgressService.completeRun = (runId, patch = {}) => {
    const result = originalCompleteRun(runId, patch);
    writeProgress({ status: 'completed', percent: 100, ...patch });
    return result;
  };
  symbolCustomBacktestProgressService.failRun = (runId, error, patch = {}) => {
    const result = originalFailRun(runId, error, patch);
    writeProgress({
      status: 'failed',
      ...patch,
      error: error?.message || String(error || 'Backtest failed'),
    });
    return result;
  };
}

async function fetchPaperCandles() {
  const start = new Date(`${START_DATE}T00:00:00.000Z`);
  const endExclusive = new Date(`${END_DATE}T00:00:00.000Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);

  const candlesByTimeframe = {};
  for (const timeframe of ['1m', '5m', '15m']) {
    writeProgress({
      status: 'running',
      stage: `Loading ${timeframe} candles`,
      message: `Downloading ${timeframe} XAUUSD history from isolated paper/demo MT5`,
    });
    const rawCandles = await mt5PaperService.getCandles(
      'XAUUSD',
      timeframe,
      start,
      FETCH_LIMIT,
      endExclusive
    );
    candlesByTimeframe[timeframe] = normalizeInjectedCandles(rawCandles);
    writeProgress({
      status: 'running',
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

async function main() {
  hookRunnerProgress();
  if (fs.existsSync(PROGRESS_PATH)) fs.unlinkSync(PROGRESS_PATH);
  writeProgress({
    status: 'running',
    stage: 'Connecting paper MT5',
    percent: 0,
    message: 'Connecting isolated Elev8 demo terminal for three-year research backtest',
    startDate: START_DATE,
    endDate: END_DATE,
    dataSource: 'paper/demo MT5 feed',
  });

  await mt5PaperService.connect();
  const candles = await fetchPaperCandles();
  writeProgress({
    status: 'running',
    stage: 'Starting simulation',
    percent: 3,
    message: `${candles.entry.length} M1 candles ready for SymbolCustom simulation`,
    candleCoverage: {
      '1m': summarizeCandles(candles.entry),
      '5m': summarizeCandles(candles.setup),
      '15m': summarizeCandles(candles.higher),
    },
  });

  const backtest = await symbolCustomBacktestService.runSymbolCustomBacktest({
    symbolCustomId: SYMBOL_CUSTOM_ID,
    startDate: START_DATE,
    endDate: END_DATE,
    initialBalance: INITIAL_BALANCE,
    candles,
    costModel: {
      spread: 0,
      commissionPerTrade: 0,
      slippage: 0,
    },
    options: {
      useHistoricalCandles: false,
    },
    progressRunId: RUN_ID,
  });
  const evaluation = symbolCustomEvaluationService.evaluateSymbolCustomBacktest(backtest);
  const report = {
    generatedAt: new Date().toISOString(),
    dataSource: 'paper/demo MT5 feed',
    note: 'Live MT5 was not restarted because an open live position was detected.',
    requestedRange: {
      startDate: START_DATE,
      endDate: END_DATE,
    },
    candleCoverage: {
      '1m': summarizeCandles(candles.entry),
      '5m': summarizeCandles(candles.setup),
      '15m': summarizeCandles(candles.higher),
    },
    backtest,
    evaluation,
  };
  fs.writeFileSync(RESULT_PATH, JSON.stringify(report, null, 2));
  writeProgress({
    status: 'completed',
    stage: 'Completed',
    percent: 100,
    message: `Saved three-year result to ${RESULT_PATH}`,
    backtestId: backtest._id,
    summary: backtest.summary,
    resultPath: RESULT_PATH,
  });
}

main()
  .catch((error) => {
    writeProgress({
      status: 'failed',
      stage: 'Failed',
      message: error.message,
      error: error.stack || error.message,
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await mt5PaperService.disconnect();
  });
