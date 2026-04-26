jest.mock('../src/config/db', () => ({
  backtestsDb: {
    insert: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
  },
}));

const backtestEngine = require('../src/services/backtestEngine');

function makeCandles(count, start = 1.1) {
  return Array.from({ length: count }, (_, index) => {
    const base = start + (index * 0.0001);
    return {
      time: new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
      open: Number(base.toFixed(5)),
      high: Number((base + 0.0003).toFixed(5)),
      low: Number((base - 0.0003).toFixed(5)),
      close: Number((base + 0.00005).toFixed(5)),
      volume: 100,
      tickVolume: 100,
    };
  });
}

describe('backtest equity curve integrity', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('forced END_OF_DATA close appends the realized final equity point', async () => {
    const candles = makeCandles(270, 1.1);
    candles[260] = {
      ...candles[260],
      open: 1.11,
      high: 1.1103,
      low: 1.0997,
      close: 1.1,
    };
    candles[candles.length - 1] = {
      ...candles[candles.length - 1],
      open: 1.139,
      high: 1.1404,
      low: 1.1388,
      close: 1.14,
    };

    jest.spyOn(backtestEngine, '_createStrategy').mockReturnValue({
      analyze: jest.fn(() => ({
        signal: 'BUY',
        confidence: 1,
        sl: 0,
        tp: 10,
        reason: 'Test setup',
      })),
    });
    jest.spyOn(backtestEngine, '_buildIndicators').mockReturnValue({});

    const result = await backtestEngine.simulate({
      symbol: 'EURUSD',
      strategyType: 'Momentum',
      timeframe: '1h',
      candles,
      initialBalance: 10000,
      tradeStartTime: candles[250].time,
      tradeEndTime: candles[candles.length - 1].time,
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe('END_OF_DATA');
    expect(result.finalEquity).toBe(result.finalBalance);
    expect(result.equityCurve[result.equityCurve.length - 1]).toEqual({
      time: candles[candles.length - 1].time,
      equity: result.finalBalance,
    });
  });

  test('summary max drawdown follows mark-to-market equity curve points', () => {
    const summary = backtestEngine._generateSummary(
      [{
        profitPips: 25,
        profitLoss: 100,
        entryTime: '2026-01-01T00:00:00.000Z',
        exitTime: '2026-01-01T06:00:00.000Z',
      }],
      10000,
      10100,
      [
        { time: '2026-01-01T00:00:00.000Z', equity: 10000 },
        { time: '2026-01-01T03:00:00.000Z', equity: 9500 },
        { time: '2026-01-01T06:00:00.000Z', equity: 10100 },
      ]
    );

    expect(summary.maxDrawdownPercent).toBe(5);
  });
});
