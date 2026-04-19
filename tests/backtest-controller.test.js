jest.mock('../src/services/backtestEngine', () => ({
  run: jest.fn(),
}));

jest.mock('../src/services/strategyEngine', () => ({
  getStrategiesInfo: jest.fn(),
}));

jest.mock('../src/services/batchBacktestService', () => ({
  startJob: jest.fn(),
  getJob: jest.fn(),
  getJobs: jest.fn(),
  getJobResults: jest.fn(),
  getJobReport: jest.fn(),
  getJobChildResult: jest.fn(),
}));

jest.mock('../src/models/Strategy', () => ({
  findByName: jest.fn(),
}));

jest.mock('../src/models/RiskProfile', () => ({
  getActive: jest.fn(),
}));

jest.mock('../src/services/strategyInstanceService', () => ({
  getStrategyInstance: jest.fn(),
}));

jest.mock('../src/services/mt5Service', () => ({
  isConnected: jest.fn(),
  connect: jest.fn(),
  getCandles: jest.fn(),
}));

jest.mock('../src/services/websocketService', () => ({
  broadcast: jest.fn(),
}));

const backtestController = require('../src/controllers/backtestController');
const backtestEngine = require('../src/services/backtestEngine');
const strategyEngine = require('../src/services/strategyEngine');
const mt5Service = require('../src/services/mt5Service');
const RiskProfile = require('../src/models/RiskProfile');
const Strategy = require('../src/models/Strategy');
const { getStrategyInstance } = require('../src/services/strategyInstanceService');

function createRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    },
  };
}

function createCandles(startIso, stepMinutes, count) {
  const startMs = new Date(startIso).getTime();
  const stepMs = stepMinutes * 60 * 1000;

  return Array.from({ length: count }, (_, index) => {
    const close = 1.08 + (index * 0.0001);
    return {
      time: new Date(startMs + (index * stepMs)).toISOString(),
      open: close - 0.0002,
      high: close + 0.0003,
      low: close - 0.0003,
      close,
      tickVolume: 100 + index,
      spread: 12,
      volume: 100 + index,
    };
  });
}

describe('backtest controller', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-13T00:00:00.000Z'));
    jest.clearAllMocks();
    mt5Service.isConnected.mockReturnValue(true);
    RiskProfile.getActive.mockResolvedValue(null);
    Strategy.findByName.mockResolvedValue({
      name: 'TrendFollowing',
      parameters: { ema_fast: 25, ema_slow: 60 },
    });
    getStrategyInstance.mockImplementation(async (symbol, strategyName) => ({
      parameters: { seed: `${strategyName}:${symbol}` },
      enabled: true,
      source: 'instance',
    }));
    backtestEngine.run.mockResolvedValue({
      summary: { totalTrades: 1, winRate: 0.5, profitFactor: 1.2 },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('runBacktest fetches candles with an explicit end date and forwards stored parameters', async () => {
    const hourlyCandles = createCandles('2026-03-21T14:00:00.000Z', 60, 360);
    const entryCandles = createCandles('2026-03-31T09:00:00.000Z', 15, 1400);

    mt5Service.getCandles
      .mockResolvedValueOnce(hourlyCandles)
      .mockResolvedValueOnce(entryCandles);

    const req = {
      body: {
        symbol: 'EURUSD',
        strategyType: 'TrendFollowing',
        timeframe: '1h',
        startDate: '2026-04-01',
        endDate: '2026-04-05',
        initialBalance: 10000,
        strategyParams: { ema_fast: 30 },
      },
    };
    const res = createRes();

    await backtestController.runBacktest(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual(expect.objectContaining({ success: true }));

    expect(mt5Service.getCandles).toHaveBeenNthCalledWith(
      1,
      'EURUSD',
      '1h',
      expect.any(Date),
      expect.any(Number),
      expect.any(Date)
    );
    expect(mt5Service.getCandles).toHaveBeenNthCalledWith(
      2,
      'EURUSD',
      '15m',
      expect.any(Date),
      expect.any(Number),
      expect.any(Date)
    );

    const primaryFetchArgs = mt5Service.getCandles.mock.calls[0];
    expect(primaryFetchArgs[2].toISOString()).toBe('2026-03-21T14:00:00.000Z');
    expect(primaryFetchArgs[4].toISOString()).toBe('2026-04-06T00:00:00.000Z');

    expect(backtestEngine.run).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'EURUSD',
      strategyType: 'TrendFollowing',
      timeframe: '1h',
      tradeStartTime: '2026-04-01T00:00:00.000Z',
      tradeEndTime: '2026-04-05T13:00:00.000Z',
      storedStrategyParameters: { seed: 'TrendFollowing:EURUSD' },
      strategyParams: { ema_fast: 30 },
      breakevenConfig: expect.objectContaining({
        enabled: true,
        triggerAtrMultiple: 0.8,
        trailStartAtrMultiple: 1.5,
      }),
    }));
  });

  describe('runAllStrategies', () => {
    beforeEach(() => {
      strategyEngine.getStrategiesInfo.mockReturnValue([
        { type: 'TrendFollowing', name: 'TrendFollowing' },
        { type: 'MeanReversion', name: 'MeanReversion' },
      ]);
      Strategy.findByName.mockImplementation(async (name) => ({
        name,
        parameters: { seed: name },
      }));
    });

    test('returns one result per registered strategy and reuses shared candle fetches', async () => {
      const hourlyCandles = createCandles('2026-03-21T14:00:00.000Z', 60, 360);
      const entryCandles = createCandles('2026-03-31T09:00:00.000Z', 15, 1400);

      mt5Service.getCandles.mockImplementation(async (sym, tf) => {
        if (tf === '1h') return hourlyCandles;
        if (tf === '15m') return entryCandles;
        return [];
      });

      backtestEngine.run.mockImplementation(async ({ strategyType }) => ({
        _id: `bt-${strategyType}`,
        summary: { totalTrades: 3, winRate: 0.6, profitFactor: 1.4, netProfitMoney: 120, returnPercent: 1.2 },
      }));

      const req = {
        body: {
          symbol: 'EURUSD',
          startDate: '2026-04-01',
          endDate: '2026-04-05',
          initialBalance: 5000,
        },
      };
      const res = createRes();

      await backtestController.runAllStrategies(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.success).toBe(true);
      expect(res.payload.data.symbol).toBe('EURUSD');
      expect(res.payload.data.results).toHaveLength(2);
      expect(res.payload.data.results[0]).toEqual(expect.objectContaining({
        strategyType: 'TrendFollowing',
        backtestId: 'bt-TrendFollowing',
        timeframe: '1h',
        summary: expect.objectContaining({ totalTrades: 3 }),
      }));
      expect(res.payload.data.results[1]).toEqual(expect.objectContaining({
        strategyType: 'MeanReversion',
        backtestId: 'bt-MeanReversion',
      }));

      // TrendFollowing fetches 1h + 15m; MeanReversion only 1h (shared with TF → cached).
      const fetchedTfs = mt5Service.getCandles.mock.calls.map((c) => c[1]).sort();
      expect(fetchedTfs).toEqual(['15m', '1h']);

      expect(backtestEngine.run).toHaveBeenCalledTimes(2);
      expect(backtestEngine.run).toHaveBeenNthCalledWith(1, expect.objectContaining({
        strategyType: 'TrendFollowing',
        storedStrategyParameters: { seed: 'TrendFollowing:EURUSD' },
        strategyParams: null,
        initialBalance: 5000,
      }));
      expect(backtestEngine.run).toHaveBeenNthCalledWith(2, expect.objectContaining({
        strategyType: 'MeanReversion',
        storedStrategyParameters: { seed: 'MeanReversion:EURUSD' },
        strategyParams: null,
        initialBalance: 5000,
      }));
    });

    test('isolates per-strategy failures so the rest still run', async () => {
      const hourlyCandles = createCandles('2026-03-21T14:00:00.000Z', 60, 360);
      const entryCandles = createCandles('2026-03-31T09:00:00.000Z', 15, 1400);

      mt5Service.getCandles.mockImplementation(async (sym, tf) => {
        if (tf === '1h') return hourlyCandles;
        if (tf === '15m') return entryCandles;
        return [];
      });

      backtestEngine.run.mockImplementation(async ({ strategyType }) => {
        if (strategyType === 'TrendFollowing') {
          throw new Error('boom');
        }
        return {
          _id: `bt-${strategyType}`,
          summary: { totalTrades: 1, winRate: 1, profitFactor: 2, netProfitMoney: 10, returnPercent: 0.1 },
        };
      });

      const req = {
        body: {
          symbol: 'EURUSD',
          startDate: '2026-04-01',
          endDate: '2026-04-05',
        },
      };
      const res = createRes();

      await backtestController.runAllStrategies(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.data.results[0]).toEqual(expect.objectContaining({
        strategyType: 'TrendFollowing',
        error: 'boom',
      }));
      expect(res.payload.data.results[0].summary).toBeUndefined();
      expect(res.payload.data.results[1]).toEqual(expect.objectContaining({
        strategyType: 'MeanReversion',
        summary: expect.objectContaining({ totalTrades: 1 }),
      }));
    });

    test('rejects an invalid symbol without fetching candles', async () => {
      const req = {
        body: {
          symbol: 'ZZZZZZ',
          startDate: '2026-04-01',
          endDate: '2026-04-05',
        },
      };
      const res = createRes();

      await backtestController.runAllStrategies(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.payload.success).toBe(false);
      expect(res.payload.message).toMatch(/Invalid symbol: ZZZZZZ/);
      expect(mt5Service.getCandles).not.toHaveBeenCalled();
      expect(backtestEngine.run).not.toHaveBeenCalled();
    });

    test('reports an insufficient-data error for one strategy without aborting the rest', async () => {
      // VolumeFlowHybrid uses 5m (plus 15m + 1m); MeanReversion uses 1h only.
      // Starve the 5m stream so VolumeFlowHybrid fails while MeanReversion
      // still succeeds on its independent 1h fetch.
      const hourlyCandles = createCandles('2026-03-21T14:00:00.000Z', 60, 360);
      mt5Service.getCandles.mockImplementation(async (sym, tf) => {
        if (tf === '1h') return hourlyCandles;
        if (tf === '5m') return createCandles('2026-03-31T09:00:00.000Z', 5, 10);
        if (tf === '15m') return createCandles('2026-03-31T09:00:00.000Z', 15, 400);
        if (tf === '1m') return createCandles('2026-03-31T09:00:00.000Z', 1, 4000);
        return [];
      });

      backtestEngine.run.mockImplementation(async ({ strategyType }) => ({
        _id: `bt-${strategyType}`,
        summary: { totalTrades: 2, winRate: 0.5, profitFactor: 1, netProfitMoney: 0, returnPercent: 0 },
      }));

      strategyEngine.getStrategiesInfo.mockReturnValue([
        { type: 'VolumeFlowHybrid', name: 'VolumeFlowHybrid' },
        { type: 'MeanReversion', name: 'MeanReversion' },
      ]);

      const req = {
        body: {
          symbol: 'EURUSD',
          startDate: '2026-04-01',
          endDate: '2026-04-05',
        },
      };
      const res = createRes();

      await backtestController.runAllStrategies(req, res);

      expect(res.statusCode).toBe(200);
      const vfh = res.payload.data.results.find((r) => r.strategyType === 'VolumeFlowHybrid');
      const mr = res.payload.data.results.find((r) => r.strategyType === 'MeanReversion');
      expect(vfh.error).toMatch(/Insufficient historical data/);
      expect(mr.summary).toBeTruthy();
    });
  });
});
