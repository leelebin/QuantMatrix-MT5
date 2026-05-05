jest.mock('../src/config/db', () => ({
  backtestsDb: {
    insert: jest.fn(),
    find: jest.fn(() => ({
      sort: jest.fn(() => ({
        limit: jest.fn().mockResolvedValue([]),
      })),
    })),
    findOne: jest.fn(),
    remove: jest.fn(),
  },
}));

const backtestEngine = require('../src/services/backtestEngine');
const optimizerService = require('../src/services/optimizerService');

function makeCandles(count, start = 100) {
  return Array.from({ length: count }, (_, index) => {
    const close = start + (index * 0.01);
    return {
      time: new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
      open: close - 0.2,
      high: close + 0.3,
      low: close - 0.3,
      close,
    };
  });
}

function normalizeOptimizerRows(result) {
  return (result.allResults || [])
    .map((row) => ({
      parameters: row.parameters,
      summary: row.summary,
    }))
    .sort((a, b) => JSON.stringify(a.parameters).localeCompare(JSON.stringify(b.parameters)));
}

describe('optimizer/backtest consistency', () => {
  test('rolling history windows stay equivalent to slice-based windows', () => {
    const candles = makeCandles(12, 95);
    const fullIndicators = {
      atr: [1, 2, 3, 4, 5, 6, 7, 8],
      ema20: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
      meta: { stable: true },
    };

    const candleWindowState = backtestEngine._createRollingArrayWindowState(candles, 4);
    const preparedIndicators = backtestEngine._prepareIndicatorSeries(fullIndicators, candles.length);
    const indicatorWindowState = backtestEngine._createRollingIndicatorWindowState(preparedIndicators, 4);

    for (let cursor = 0; cursor < candles.length; cursor++) {
      const expectedStart = Math.max(0, cursor - 3);
      const expectedCandles = candles.slice(expectedStart, cursor + 1);
      const expectedIndicators = backtestEngine._sliceIndicatorWindow(
        fullIndicators,
        candles.length,
        expectedStart,
        cursor + 1
      );

      expect(backtestEngine._advanceRollingArrayWindowState(candleWindowState, cursor)).toEqual(expectedCandles);
      expect(backtestEngine._advanceRollingIndicatorWindowState(indicatorWindowState, cursor)).toEqual(expectedIndicators);
    }
  });

  test('optimizer filters single-combination formal backtest output below minimumTrades', async () => {
    const candles = makeCandles(270, 95);
    const initialBalance = 25000;
    const params = {
      lookback_period: 20,
      body_multiplier: 1.2,
      slMultiplier: 2,
      tpMultiplier: 5,
    };

    const simulation = await backtestEngine.simulate({
      symbol: 'XTIUSD',
      strategyType: 'Breakout',
      timeframe: '1h',
      candles,
      initialBalance,
      tradeStartTime: candles[250].time,
      tradeEndTime: candles[candles.length - 1].time,
      strategyParams: params,
    });
    expect(simulation.summary.totalTrades).toBeLessThan(5);

    const optimization = await optimizerService.run({
      symbol: 'XTIUSD',
      strategyType: 'Breakout',
      timeframe: '1h',
      candles,
      initialBalance,
      tradeStartTime: candles[250].time,
      tradeEndTime: candles[candles.length - 1].time,
      paramRanges: {
        lookback_period: { min: 20, max: 20, step: 1 },
        body_multiplier: { min: 1.2, max: 1.2, step: 0.1 },
        slMultiplier: { min: 2, max: 2, step: 0.1 },
        tpMultiplier: { min: 5, max: 5, step: 0.1 },
      },
      minimumTrades: 5,
    });

    expect(optimization.initialBalance).toBe(initialBalance);
    expect(optimization.minimumTrades).toBe(5);
    expect(optimization.minimumTradesWarning).toBe(true);
    expect(optimization.validResults).toBe(0);
    expect(optimization.bestResult).toBeNull();
  });

  test('parallel optimizer workers produce the same exact results as sequential mode', async () => {
    const candles = makeCandles(270, 95);
    const initialBalance = 25000;
    const sharedParams = {
      symbol: 'XTIUSD',
      strategyType: 'Breakout',
      timeframe: '1h',
      candles,
      initialBalance,
      tradeStartTime: candles[250].time,
      tradeEndTime: candles[candles.length - 1].time,
      minimumTrades: 5,
      paramRanges: {
        lookback_period: { min: 20, max: 29, step: 1 },
        body_multiplier: { min: 1.0, max: 2.0, step: 0.2 },
        slMultiplier: { min: 2, max: 2, step: 0.1 },
        tpMultiplier: { min: 5, max: 5, step: 0.1 },
      },
    };

    const sequential = await optimizerService.run({
      ...sharedParams,
      parallelWorkers: 1,
    });
    const parallel = await optimizerService.run({
      ...sharedParams,
      parallelWorkers: 2,
    });

    expect(sequential.totalCombinations).toBe(60);
    expect(parallel.totalCombinations).toBe(60);
    expect(sequential.initialBalance).toBe(initialBalance);
    expect(parallel.initialBalance).toBe(initialBalance);
    expect(parallel.workerCount).toBe(2);
    expect(normalizeOptimizerRows(parallel)).toEqual(normalizeOptimizerRows(sequential));
    expect(parallel.bestResult).toEqual(sequential.bestResult);
    expect(parallel.top10).toEqual(sequential.top10);
  });

  test('optimizer rejects oversized grids before they can exhaust memory', async () => {
    const candles = makeCandles(270, 95);

    await expect(optimizerService.run({
      symbol: 'XTIUSD',
      strategyType: 'Breakout',
      timeframe: '1h',
      candles,
      tradeStartTime: candles[250].time,
      tradeEndTime: candles[candles.length - 1].time,
      minimumTrades: 5,
      paramRanges: {
        lookback_period: { min: 1, max: 200, step: 1 },
        body_multiplier: { min: 1, max: 200, step: 1 },
        slMultiplier: { min: 1, max: 2, step: 0.01 },
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Optimizer grid too large'),
    });

    expect(optimizerService.getProgress()).toEqual({
      running: false,
      progress: null,
      stopRequested: false,
      workerCount: 1,
    });
  });

  test('optimizer can be stopped gracefully and returns partial results', async () => {
    const candles = makeCandles(270, 95);

    const optimization = await optimizerService.run({
      symbol: 'XTIUSD',
      strategyType: 'Breakout',
      timeframe: '1h',
      candles,
      tradeStartTime: candles[250].time,
      tradeEndTime: candles[candles.length - 1].time,
      minimumTrades: 5,
      paramRanges: {
        lookback_period: { min: 20, max: 21, step: 1 },
        body_multiplier: { min: 1.2, max: 1.2, step: 0.1 },
        slMultiplier: { min: 2, max: 2, step: 0.1 },
        tpMultiplier: { min: 5, max: 5, step: 0.1 },
      },
      onProgress: (progress) => {
        if (progress.current === 1) {
          optimizerService.requestStop();
        }
      },
    });

    expect(optimization.stopped).toBe(true);
    expect(optimization.status).toBe('stopped');
    expect(optimization.processedCombinations).toBe(1);
    expect(optimization.totalCombinations).toBe(2);
    expect(optimization.validResults).toBe(0);
    expect(optimization.bestResult).toBeNull();
  });
});
