const runner = require('../src/services/symbolCustomBacktestRunnerService');

function bar(index, overrides = {}) {
  return {
    time: `2026-01-01T00:0${index}:00.000Z`,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    ...overrides,
  };
}

function buildSymbolCustom(overrides = {}) {
  return {
    _id: 'sc-runner',
    symbol: 'EURUSD',
    symbolCustomName: 'MOCK_SYMBOL_CUSTOM',
    logicName: 'MOCK_SYMBOL_CUSTOM',
    timeframes: { setupTimeframe: '15m', entryTimeframe: '5m', higherTimeframe: '1h' },
    parameters: {},
    riskConfig: { maxRiskPerTradePct: 1 },
    sessionFilter: {},
    newsFilter: {},
    beConfig: {},
    entryConfig: {},
    exitConfig: {},
    ...overrides,
  };
}

async function runWithLogic(logic, entryCandles, options = {}) {
  return runner.runSymbolCustomBacktestSimulation({
    symbolCustom: buildSymbolCustom(options.symbolCustom || {}),
    logic,
    logicName: 'MOCK_SYMBOL_CUSTOM',
    candles: {
      setup: entryCandles,
      entry: entryCandles,
      higher: entryCandles,
    },
    parameters: {},
    costModel: options.costModel || {},
    initialBalance: options.initialBalance || 1000,
    options: options.options || {},
  });
}

describe('symbolCustomBacktestRunnerService', () => {
  test('mock BUY hits TP and creates profitable trade', async () => {
    const logic = {
      analyze: jest.fn(async (context) => (context.currentIndex === 0
        ? { signal: 'BUY', sl: 95, tp: 110, reason: 'mock buy' }
        : { signal: 'NONE' })),
    };

    const result = await runWithLogic(logic, [
      bar(0, { close: 100 }),
      bar(1, { high: 110, low: 99, close: 109 }),
    ]);

    expect(result.status).toBe('completed');
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toEqual(expect.objectContaining({
      side: 'BUY',
      exitReason: 'TP',
      pnl: expect.any(Number),
      positionSizingMode: 'RISK_BASED',
    }));
    expect(result.trades[0].pnl).toBeGreaterThan(0);
    expect(result.summary.trades).toBe(1);
    expect(result.summary.netPnl).toBeGreaterThan(0);
  });

  test('mock BUY hits SL and records loss', async () => {
    const logic = {
      analyze: jest.fn(async (context) => (context.currentIndex === 0
        ? { signal: 'BUY', sl: 95, tp: 110, reason: 'mock buy' }
        : { signal: 'NONE' })),
    };

    const result = await runWithLogic(logic, [
      bar(0, { close: 100 }),
      bar(1, { high: 101, low: 95, close: 96 }),
    ]);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe('SL');
    expect(result.trades[0].pnl).toBeLessThan(0);
    expect(result.summary.netPnl).toBeLessThan(0);
  });

  test('mock SELL hits TP and creates profitable trade', async () => {
    const logic = {
      analyze: jest.fn(async (context) => (context.currentIndex === 0
        ? { signal: 'SELL', sl: 105, tp: 90, reason: 'mock sell' }
        : { signal: 'NONE' })),
    };

    const result = await runWithLogic(logic, [
      bar(0, { close: 100 }),
      bar(1, { high: 101, low: 90, close: 91 }),
    ]);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toEqual(expect.objectContaining({
      side: 'SELL',
      exitReason: 'TP',
    }));
    expect(result.trades[0].pnl).toBeGreaterThan(0);
  });

  test('same bar SL/TP ambiguity uses SL-first conservative rule', async () => {
    const logic = {
      analyze: jest.fn(async (context) => (context.currentIndex === 0
        ? { signal: 'BUY', sl: 95, tp: 110, reason: 'ambiguous setup' }
        : { signal: 'NONE' })),
    };

    const result = await runWithLogic(logic, [
      bar(0, { close: 100 }),
      bar(1, { high: 111, low: 94, close: 106 }),
    ]);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe('AMBIGUOUS_SL_TP_SAME_BAR_SL_FIRST');
    expect(result.trades[0].pnl).toBeLessThan(0);
  });

  test('CLOSE signal exits at current close', async () => {
    const logic = {
      analyze: jest.fn(async (context) => {
        if (context.currentIndex === 0) return { signal: 'BUY', sl: 95, tp: 110, reason: 'open' };
        if (context.currentIndex === 1) return { signal: 'CLOSE', reason: 'custom close' };
        return { signal: 'NONE' };
      }),
    };

    const result = await runWithLogic(logic, [
      bar(0, { close: 100 }),
      bar(1, { high: 104, low: 99, close: 104 }),
    ]);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe('CUSTOM_CLOSE');
    expect(result.trades[0].exitPrice).toBe(104);
  });

  test('open position is closed at end of backtest', async () => {
    const logic = {
      analyze: jest.fn(async (context) => (context.currentIndex === 0
        ? { signal: 'BUY', sl: 95, tp: 110, reason: 'hold to end' }
        : { signal: 'NONE' })),
    };

    const result = await runWithLogic(logic, [
      bar(0, { close: 100 }),
      bar(1, { high: 104, low: 99, close: 104 }),
    ]);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe('END_OF_BACKTEST');
    expect(result.trades[0].exitPrice).toBe(104);
  });

  test('summary metrics include profitFactor, winRate, avgR, drawdown, and max loss', async () => {
    const logic = {
      analyze: jest.fn(async (context) => {
        if (context.currentIndex === 0) return { signal: 'BUY', sl: 95, tp: 110, reason: 'winner' };
        if (context.currentIndex === 2) return { signal: 'BUY', sl: 95, tp: 110, reason: 'loser' };
        return { signal: 'NONE' };
      }),
    };

    const result = await runWithLogic(logic, [
      bar(0, { close: 100 }),
      bar(1, { high: 110, low: 99, close: 110 }),
      bar(2, { close: 100 }),
      bar(3, { high: 101, low: 95, close: 95 }),
    ]);

    expect(result.summary).toEqual(expect.objectContaining({
      trades: 2,
      wins: 1,
      losses: 1,
      profitFactor: expect.any(Number),
      winRate: 0.5,
      avgR: expect.any(Number),
      maxDrawdown: expect.any(Number),
      maxSingleLoss: expect.any(Number),
      rejectedSignals: 0,
    }));
    expect(result.summary.profitFactor).toBeGreaterThan(0);
    expect(result.summary.maxSingleLoss).toBeLessThan(0);
  });
});
