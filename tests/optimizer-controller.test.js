jest.mock('../src/services/optimizerService', () => ({
  running: false,
  getDefaultRanges: jest.fn(),
  requestStop: jest.fn(),
  run: jest.fn(),
}));

jest.mock('../src/models/Strategy', () => ({
  findByName: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/models/OptimizerRun', () => ({
  createFromResult: jest.fn(),
  findAll: jest.fn(),
  findById: jest.fn(),
  findLatestBestResult: jest.fn(),
}));

jest.mock('../src/models/RiskProfile', () => ({
  getActive: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/services/mt5Service', () => ({
  isConnected: jest.fn(),
  connect: jest.fn(),
  getCandles: jest.fn(),
}));

jest.mock('../src/services/websocketService', () => ({
  broadcast: jest.fn(),
}));

jest.mock('../src/services/notificationService', () => ({
  notifyOptimizerComplete: jest.fn(),
}));

jest.mock('../src/config/strategyExecution', () => ({
  FORCED_TIMEFRAME_OPTIONS: ['1m', '5m', '15m', '1h', '4h'],
  getForcedTimeframeExecutionConfig: jest.fn(),
  getStrategyExecutionConfig: jest.fn(),
  isValidForcedTimeframe: jest.fn(),
}));

const optimizerController = require('../src/controllers/optimizerController');
const optimizerService = require('../src/services/optimizerService');
const OptimizerRun = require('../src/models/OptimizerRun');
const Strategy = require('../src/models/Strategy');
const mt5Service = require('../src/services/mt5Service');
const websocketService = require('../src/services/websocketService');
const notificationService = require('../src/services/notificationService');
const {
  getForcedTimeframeExecutionConfig,
  getStrategyExecutionConfig,
  isValidForcedTimeframe,
} = require('../src/config/strategyExecution');

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

describe('optimizer controller', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-04-13T00:00:00.000Z'));
    jest.clearAllMocks();

    optimizerService.running = false;
    optimizerService.requestStop.mockReturnValue({
      accepted: true,
      running: true,
      progress: { current: 3, total: 10, percent: 30 },
      message: 'Stop requested. Optimizer will halt after the current combination finishes.',
    });
    mt5Service.isConnected.mockReturnValue(true);
    mt5Service.connect.mockResolvedValue(true);
    Strategy.findByName.mockResolvedValue({
      name: 'TrendFollowing',
      parameters: { ema_fast: 25, ema_slow: 60 },
    });
    getStrategyExecutionConfig.mockImplementation((symbol, strategyType) => ({
      symbol,
      strategyType,
      timeframe: '1h',
      higherTimeframe: null,
      entryTimeframe: null,
    }));
    getForcedTimeframeExecutionConfig.mockImplementation((symbol, strategyType, timeframe) => ({
      symbol,
      strategyType,
      timeframe,
      higherTimeframe: null,
      entryTimeframe: null,
    }));
    isValidForcedTimeframe.mockReturnValue(true);
    optimizerService.run.mockResolvedValue({
      symbol: 'EURUSD',
      strategy: 'TrendFollowing',
      timeframe: '1h',
      initialBalance: 10000,
      totalCombinations: 1,
      validResults: 1,
      optimizeFor: 'profitFactor',
      bestResult: {
        parameters: { ema_fast: 25 },
        summary: { totalTrades: 1, profitFactor: 1.1 },
      },
      top10: [],
      allResults: [],
    });
    OptimizerRun.createFromResult.mockResolvedValue({ _id: 'opt-history-1' });
    OptimizerRun.findAll.mockResolvedValue([]);
    OptimizerRun.findById.mockResolvedValue(null);
    OptimizerRun.findLatestBestResult.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('runOptimizer returns 409 when the optimizer is already running', async () => {
    optimizerService.running = true;

    const req = {
      body: {
        symbol: 'EURUSD',
        strategyType: 'TrendFollowing',
      },
    };
    const res = createRes();

    await optimizerController.runOptimizer(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.payload).toEqual(expect.objectContaining({
      success: false,
      message: 'Optimizer is already running',
    }));
  });

  test('runOptimizer uses strategy execution timeframes for VolumeFlowHybrid and forwards them to the optimizer service', async () => {
    const primaryCandles = createCandles('2026-03-31T00:00:00.000Z', 5, 700);
    const higherCandles = createCandles('2026-03-20T00:00:00.000Z', 15, 700);
    const entryCandles = createCandles('2026-03-31T00:00:00.000Z', 1, 4000);

    Strategy.findByName.mockResolvedValue({
      name: 'VolumeFlowHybrid',
      parameters: { rvol_continuation: 1.8 },
    });
    getStrategyExecutionConfig.mockReturnValue({
      symbol: 'XAUUSD',
      strategyType: 'VolumeFlowHybrid',
      timeframe: '5m',
      higherTimeframe: '15m',
      entryTimeframe: '1m',
    });
    mt5Service.getCandles
      .mockResolvedValueOnce(primaryCandles)
      .mockResolvedValueOnce(higherCandles)
      .mockResolvedValueOnce(entryCandles);
    optimizerService.run.mockResolvedValue({
      symbol: 'XAUUSD',
      strategy: 'VolumeFlowHybrid',
      timeframe: '5m',
      initialBalance: 25000,
      totalCombinations: 1,
      validResults: 1,
      optimizeFor: 'profitFactor',
      bestResult: {
        parameters: { rvol_continuation: 1.8 },
        summary: { totalTrades: 1, profitFactor: 1.1 },
      },
      top10: [],
      allResults: [],
    });

    const req = {
      body: {
        symbol: 'XAUUSD',
        strategyType: 'VolumeFlowHybrid',
        startDate: '2026-04-01',
        endDate: '2026-04-05',
        initialBalance: 25000,
      },
    };
    const res = createRes();

    await optimizerController.runOptimizer(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        initialBalance: 25000,
      }),
    }));
    expect(mt5Service.getCandles).toHaveBeenNthCalledWith(
      1,
      'XAUUSD',
      '5m',
      expect.any(Date),
      expect.any(Number),
      expect.any(Date)
    );
    expect(mt5Service.getCandles).toHaveBeenNthCalledWith(
      2,
      'XAUUSD',
      '15m',
      expect.any(Date),
      expect.any(Number),
      expect.any(Date)
    );
    expect(mt5Service.getCandles).toHaveBeenNthCalledWith(
      3,
      'XAUUSD',
      '1m',
      expect.any(Date),
      expect.any(Number),
      expect.any(Date)
    );
    expect(optimizerService.run).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'XAUUSD',
      strategyType: 'VolumeFlowHybrid',
      timeframe: '5m',
      initialBalance: 25000,
      higherTfCandles: expect.any(Array),
      lowerTfCandles: expect.any(Array),
      storedStrategyParameters: expect.objectContaining({ rvol_continuation: 1.8 }),
      executionPolicy: expect.any(Object),
    }));
    expect(OptimizerRun.createFromResult).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'XAUUSD',
        strategy: 'VolumeFlowHybrid',
        initialBalance: 25000,
      }),
      expect.objectContaining({
        period: expect.objectContaining({
          start: expect.any(String),
          end: expect.any(String),
        }),
      })
    );
  });

  test('runOptimizer rejects invalid forced timeframes before fetching candles', async () => {
    isValidForcedTimeframe.mockReturnValue(false);

    const req = {
      body: {
        symbol: 'EURUSD',
        strategyType: 'TrendFollowing',
        timeframe: '2h',
      },
    };
    const res = createRes();

    await optimizerController.runOptimizer(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual(expect.objectContaining({
      success: false,
      message: expect.stringContaining('Invalid timeframe: 2h'),
    }));
    expect(mt5Service.getCandles).not.toHaveBeenCalled();
    expect(optimizerService.run).not.toHaveBeenCalled();
  });

  test('runOptimizer rejects invalid initial balances before starting the optimization', async () => {
    const req = {
      body: {
        symbol: 'EURUSD',
        strategyType: 'TrendFollowing',
        initialBalance: 0,
      },
    };
    const res = createRes();

    await optimizerController.runOptimizer(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual({
      success: false,
      message: 'initialBalance must be a positive number',
    });
    expect(mt5Service.getCandles).not.toHaveBeenCalled();
    expect(optimizerService.run).not.toHaveBeenCalled();
  });

  test('runOptimizer rejects invalid optimizeFor values before fetching candles', async () => {
    const req = {
      body: {
        symbol: 'EURUSD',
        strategyType: 'TrendFollowing',
        optimizeFor: 'unknown',
      },
    };
    const res = createRes();

    await optimizerController.runOptimizer(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual(expect.objectContaining({
      success: false,
      message: expect.stringContaining('Invalid optimizeFor: unknown'),
    }));
    expect(mt5Service.getCandles).not.toHaveBeenCalled();
    expect(optimizerService.run).not.toHaveBeenCalled();
  });

  test.each([
    [0],
    ['abc'],
    [1000],
  ])('runOptimizer rejects invalid minimumTrades=%p before fetching candles', async (minimumTrades) => {
    const req = {
      body: {
        symbol: 'EURUSD',
        strategyType: 'TrendFollowing',
        minimumTrades,
      },
    };
    const res = createRes();

    await optimizerController.runOptimizer(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual(expect.objectContaining({
      success: false,
      message: expect.stringContaining('minimumTrades'),
    }));
    expect(mt5Service.getCandles).not.toHaveBeenCalled();
    expect(optimizerService.run).not.toHaveBeenCalled();
  });

  test('runOptimizer keeps the legacy request body working with default minimumTrades', async () => {
    const primaryCandles = createCandles('2026-03-01T00:00:00.000Z', 60, 900);
    mt5Service.getCandles.mockResolvedValue(primaryCandles);
    optimizerService.getDefaultRanges.mockReturnValue({
      ema_fast: { min: 20, max: 20, step: 1 },
    });

    const req = {
      body: {
        symbol: 'EURUSD',
        strategyType: 'TrendFollowing',
        startDate: '2026-04-01',
        endDate: '2026-04-05',
      },
    };
    const res = createRes();

    await optimizerController.runOptimizer(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        optimizeFor: 'profitFactor',
        minimumTrades: 30,
      }),
    }));
    expect(optimizerService.run).toHaveBeenCalledWith(expect.objectContaining({
      optimizeFor: 'profitFactor',
      minimumTrades: 30,
    }));
  });

  test('runOptimizer accepts new backend optimizeFor values', async () => {
    const primaryCandles = createCandles('2026-03-01T00:00:00.000Z', 60, 900);
    mt5Service.getCandles.mockResolvedValue(primaryCandles);
    optimizerService.getDefaultRanges.mockReturnValue({
      ema_fast: { min: 20, max: 20, step: 1 },
    });

    const req = {
      body: {
        symbol: 'EURUSD',
        strategyType: 'TrendFollowing',
        startDate: '2026-04-01',
        endDate: '2026-04-05',
        optimizeFor: 'robustScore',
      },
    };
    const res = createRes();

    await optimizerController.runOptimizer(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        optimizeFor: 'robustScore',
      }),
    }));
    expect(optimizerService.run).toHaveBeenCalledWith(expect.objectContaining({
      optimizeFor: 'robustScore',
    }));
  });

  test('runOptimizer accepts and normalizes legal costModel input', async () => {
    const primaryCandles = createCandles('2026-03-01T00:00:00.000Z', 60, 900);
    mt5Service.getCandles.mockResolvedValue(primaryCandles);
    optimizerService.getDefaultRanges.mockReturnValue({
      ema_fast: { min: 20, max: 20, step: 1 },
    });

    const req = {
      body: {
        symbol: 'EURUSD',
        strategyType: 'TrendFollowing',
        startDate: '2026-04-01',
        endDate: '2026-04-05',
        costModel: {
          spreadPips: '1.2',
          slippagePips: 0.4,
          commissionPerLot: '7',
          commissionPerSide: true,
          swapLongPerLotPerDay: '-2.5',
          swapShortPerLotPerDay: 1.25,
          fixedFeePerTrade: '0.5',
        },
      },
    };
    const res = createRes();

    await optimizerController.runOptimizer(req, res);

    const expectedCostModel = {
      spreadPips: 1.2,
      slippagePips: 0.4,
      commissionPerLot: 7,
      commissionPerSide: true,
      swapLongPerLotPerDay: -2.5,
      swapShortPerLotPerDay: 1.25,
      fixedFeePerTrade: 0.5,
    };
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        costModelUsed: expectedCostModel,
      }),
    }));
    expect(optimizerService.run).toHaveBeenCalledWith(expect.objectContaining({
      costModel: expectedCostModel,
    }));
  });

  test.each([
    ['not-an-object'],
    [{ commissionPerLot: 'abc' }],
    [{ commissionPerSide: 'true' }],
    [{ unsupportedFee: 1 }],
  ])('runOptimizer rejects invalid costModel=%p before fetching candles', async (costModel) => {
    const req = {
      body: {
        symbol: 'EURUSD',
        strategyType: 'TrendFollowing',
        costModel,
      },
    };
    const res = createRes();

    await optimizerController.runOptimizer(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual(expect.objectContaining({
      success: false,
      message: expect.stringContaining('costModel'),
    }));
    expect(mt5Service.getCandles).not.toHaveBeenCalled();
    expect(optimizerService.run).not.toHaveBeenCalled();
  });

  test('stopOptimizer requests a graceful stop and broadcasts the stop request', () => {
    const req = {};
    const res = createRes();

    optimizerController.stopOptimizer(req, res);

    expect(optimizerService.requestStop).toHaveBeenCalledTimes(1);
    expect(websocketService.broadcast).toHaveBeenCalledWith(
      'status',
      'optimizer_stop_requested',
      expect.objectContaining({
        accepted: true,
        running: true,
      })
    );
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual(expect.objectContaining({
      success: true,
      message: expect.stringContaining('Stop requested'),
    }));
  });

  test('getHistory returns stored optimizer runs', async () => {
    const req = { query: { limit: '20' } };
    const res = createRes();
    OptimizerRun.findAll.mockResolvedValue([
      {
        historyId: 'opt-history-1',
        symbol: 'XAUUSD',
        strategy: 'VolumeFlowHybrid',
        initialBalance: 25000,
      },
    ]);

    await optimizerController.getHistory(req, res);

    expect(OptimizerRun.findAll).toHaveBeenCalledWith(20);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      data: [
        {
          historyId: 'opt-history-1',
          symbol: 'XAUUSD',
          strategy: 'VolumeFlowHybrid',
          initialBalance: 25000,
        },
      ],
    });
  });

  test('getHistoryDetail returns a specific optimizer history record', async () => {
    const req = { params: { id: 'opt-history-1' } };
    const res = createRes();
    OptimizerRun.findById.mockResolvedValue({
      _id: 'opt-history-1',
      symbol: 'XAUUSD',
      strategy: 'VolumeFlowHybrid',
      initialBalance: 15000,
      bestResult: { parameters: { rvol_continuation: 1.8 } },
    });

    await optimizerController.getHistoryDetail(req, res);

    expect(OptimizerRun.findById).toHaveBeenCalledWith('opt-history-1');
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      data: {
        _id: 'opt-history-1',
        symbol: 'XAUUSD',
        strategy: 'VolumeFlowHybrid',
        initialBalance: 15000,
        bestResult: { parameters: { rvol_continuation: 1.8 } },
      },
    });
  });

  test('getHistoryDetail returns 404 when the optimizer history record is missing', async () => {
    const req = { params: { id: 'missing-history' } };
    const res = createRes();
    OptimizerRun.findById.mockResolvedValue(null);

    await optimizerController.getHistoryDetail(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.payload).toEqual({
      success: false,
      message: 'Optimizer history record not found',
    });
  });

  test('getLatestBestResult returns the latest stored optimizer best result', async () => {
    const req = { query: { symbol: 'XAUUSD', strategy: 'VolumeFlowHybrid' } };
    const res = createRes();
    OptimizerRun.findLatestBestResult.mockResolvedValue({
      _id: 'opt-history-1',
      symbol: 'XAUUSD',
      strategy: 'VolumeFlowHybrid',
      timeframe: '5m',
      initialBalance: 12000,
      optimizeFor: 'profitFactor',
      completedAt: '2026-04-12T12:00:00.000Z',
      bestResult: { parameters: { rvol_continuation: 1.8 } },
    });

    await optimizerController.getLatestBestResult(req, res);

    expect(OptimizerRun.findLatestBestResult).toHaveBeenCalledWith('XAUUSD', 'VolumeFlowHybrid');
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      data: {
        historyId: 'opt-history-1',
        symbol: 'XAUUSD',
        strategy: 'VolumeFlowHybrid',
        timeframe: '5m',
        initialBalance: 12000,
        optimizeFor: 'profitFactor',
        completedAt: '2026-04-12T12:00:00.000Z',
        createdAt: null,
        bestResult: { parameters: { rvol_continuation: 1.8 } },
      },
    });
  });

  test('getLatestBestResult returns 404 when no best result exists', async () => {
    const req = { query: { symbol: 'EURUSD', strategy: 'TrendFollowing' } };
    const res = createRes();
    OptimizerRun.findLatestBestResult.mockResolvedValue(null);

    await optimizerController.getLatestBestResult(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.payload).toEqual({
      success: false,
      message: 'No optimizer best result found for EURUSD / TrendFollowing',
    });
  });

});
