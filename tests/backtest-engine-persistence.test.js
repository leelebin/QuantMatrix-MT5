jest.mock('../src/config/db', () => ({
  backtestsDb: {
    insert: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
  },
}));

const backtestEngine = require('../src/services/backtestEngine');
const { backtestsDb } = require('../src/config/db');

describe('backtest engine persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(backtestEngine, '_runSimulation').mockResolvedValue({
      symbol: 'EURUSD',
      strategy: 'TrendFollowing',
      timeframe: '1h',
      period: {
        start: '2026-04-01T00:00:00.000Z',
        end: '2026-04-05T00:00:00.000Z',
      },
      parameters: { ema_fast: 20, ema_slow: 50 },
      parameterPreset: 'default',
      parameterSource: {
        hasStoredParameters: true,
        hasRuntimeOverrides: false,
      },
      summary: {
        totalTrades: 3,
        netProfitMoney: 100,
      },
      trades: [],
      equityCurve: [],
      chartData: {
        symbol: 'EURUSD',
        strategy: 'TrendFollowing',
        candles: [{ time: '2026-04-01T00:00:00.000Z', open: 1, high: 1, low: 1, close: 1 }],
        panels: [],
        tradeEvents: [],
      },
      initialBalance: 10000,
      finalBalance: 10100,
      finalEquity: 10100,
    });
    backtestsDb.insert.mockResolvedValue({ _id: 'bt-1' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('run returns chartData but strips it from persisted single backtests', async () => {
    const result = await backtestEngine.run({ symbol: 'EURUSD', strategyType: 'TrendFollowing' });

    expect(backtestsDb.insert).toHaveBeenCalledWith(expect.objectContaining({
      initialBalance: 10000,
      isBatchChild: false,
    }));
    const persisted = backtestsDb.insert.mock.calls[0][0];
    expect(persisted.chartData).toBeUndefined();
    expect(result.chartData).toEqual(expect.objectContaining({
      symbol: 'EURUSD',
      strategy: 'TrendFollowing',
    }));
    expect(result.backtestId).toBe('bt-1');
  });

  test('run strips chartData for batch child backtests', async () => {
    await backtestEngine.run({
      symbol: 'EURUSD',
      strategyType: 'TrendFollowing',
      batchJobId: 'job-1',
    });

    const persisted = backtestsDb.insert.mock.calls[0][0];
    expect(persisted).toEqual(expect.objectContaining({
      batchJobId: 'job-1',
      isBatchChild: true,
    }));
    expect(persisted.chartData).toBeUndefined();
  });

  test('getResult backfills initialBalance and chartData for legacy records', async () => {
    backtestsDb.findOne.mockResolvedValue({
      _id: 'legacy-1',
      summary: { netProfitMoney: 250 },
      finalBalance: 10250,
    });

    const result = await backtestEngine.getResult('legacy-1');

    expect(result.initialBalance).toBe(10000);
    expect(result.chartData).toBeNull();
  });
});
