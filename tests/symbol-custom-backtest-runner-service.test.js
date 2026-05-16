const runner = require('../src/services/symbolCustomBacktestRunnerService');
const UsdjpyJpyMacroReversalV1 = require('../src/symbolCustom/logics/UsdjpyJpyMacroReversalV1');

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
    parameters: options.parameters || {},
    costModel: options.costModel || {},
    initialBalance: options.initialBalance || 1000,
    options: options.options || {},
  });
}

function usdjpyReversalCandles({ direction = 'down', count = 48, startHourUtc = 22 } = {}) {
  const candles = [];
  let previousClose = direction === 'down' ? 150 : 140;

  for (let index = 0; index < count; index += 1) {
    const time = new Date(Date.UTC(2026, 0, 1, startHourUtc, index * 5)).toISOString();
    const delta = direction === 'down' ? -0.16 : 0.16;
    const close = previousClose + delta;
    candles.push({
      time,
      open: previousClose,
      high: Math.max(previousClose, close) + 0.08,
      low: Math.min(previousClose, close) - 0.08,
      close,
      volume: 100 + index,
    });
    previousClose = close;
  }

  const last = candles[candles.length - 1];
  candles[candles.length - 1] = direction === 'down'
    ? {
      ...last,
      open: last.close - 0.08,
      low: last.close - 0.2,
      high: last.close + 0.08,
      close: last.close,
    }
    : {
      ...last,
      open: last.close + 0.08,
      low: last.close - 0.08,
      high: last.close + 0.2,
      close: last.close,
    };

  return candles;
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

  test('logic context includes closedTrades, currentUtcHour, todayClosedTrades, and barsSinceLastExit', async () => {
    const observed = [];
    const logic = {
      analyze: jest.fn(async (context) => {
        observed.push(context);
        if (context.currentIndex === 0) return { signal: 'BUY', sl: 95, tp: 110, reason: 'open' };
        return { signal: 'NONE' };
      }),
    };

    await runWithLogic(logic, [
      bar(0, { close: 100 }),
      bar(1, { high: 110, low: 99, close: 110 }),
      bar(2, { high: 111, low: 109, close: 110 }),
    ]);

    expect(observed[0]).toEqual(expect.objectContaining({
      lastClosedTrade: null,
      barsSinceLastExit: null,
    }));
    const afterExitContext = observed.find((context) => context.currentIndex === 2);
    expect(afterExitContext).toEqual(expect.objectContaining({
      currentUtcHour: 0,
      barsSinceLastExit: 1,
    }));
    expect(afterExitContext.closedTrades).toHaveLength(1);
    expect(afterExitContext.todayClosedTrades).toHaveLength(1);
    expect(afterExitContext.todayTrades).toHaveLength(1);
    expect(afterExitContext.lastClosedTrade).toEqual(expect.objectContaining({
      exitReason: 'TP',
      exitIndex: 1,
    }));
  });

  test('trade records include entryIndex, exitIndex, entryHourUtc, and entryDateUtc', async () => {
    const logic = {
      analyze: jest.fn(async (context) => (context.currentIndex === 0
        ? { signal: 'BUY', sl: 95, tp: 110, reason: 'indexed trade' }
        : { signal: 'NONE' })),
    };

    const result = await runWithLogic(logic, [
      bar(0, { close: 100 }),
      bar(1, { high: 110, low: 99, close: 110 }),
    ]);

    expect(result.trades[0]).toEqual(expect.objectContaining({
      entryIndex: 0,
      exitIndex: 1,
      entryHourUtc: 0,
      entryDateUtc: '2026-01-01',
    }));
  });

  test('USDJPY combined conservative cooldown guardrails produce at least one backtest trade', async () => {
    const logic = new UsdjpyJpyMacroReversalV1();
    const candles = usdjpyReversalCandles({ direction: 'down', startHourUtc: 22 });

    const result = await runWithLogic(logic, candles, {
      symbolCustom: {
        symbol: 'USDJPY',
        symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
        logicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
        riskConfig: { maxRiskPerTradePct: 1 },
      },
      initialBalance: 500,
      parameters: {
        allowedUtcHours: '23,0,1,7,8,9,10',
        cooldownBarsAfterAnyExit: 6,
        cooldownBarsAfterSL: 18,
        maxDailyLosses: 3,
        maxDailyTrades: 6,
        enableBuy: true,
        enableSell: true,
      },
    });

    expect(result.summary.trades).toBeGreaterThan(0);
    expect(result.trades[0]).toEqual(expect.objectContaining({
      symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      entryIndex: expect.any(Number),
      exitIndex: expect.any(Number),
      entryHourUtc: expect.any(Number),
      entryDateUtc: expect.any(String),
      exitReason: expect.any(String),
    }));
  });
});
