jest.mock('../src/services/backtestEngine', () => ({
  run: jest.fn(),
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
const mt5Service = require('../src/services/mt5Service');
const RiskProfile = require('../src/models/RiskProfile');
const Strategy = require('../src/models/Strategy');

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
      storedStrategyParameters: { ema_fast: 25, ema_slow: 60 },
      strategyParams: { ema_fast: 30 },
      breakevenConfig: expect.objectContaining({
        enabled: true,
        triggerAtrMultiple: 0.8,
        trailStartAtrMultiple: 1.5,
      }),
    }));
  });
});
