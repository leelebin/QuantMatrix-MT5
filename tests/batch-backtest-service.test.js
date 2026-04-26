jest.mock('../src/services/backtestEngine', () => ({
  run: jest.fn(),
  getResult: jest.fn(),
}));

jest.mock('../src/services/mt5Service', () => ({
  isConnected: jest.fn(),
  connect: jest.fn(),
  getCandles: jest.fn(),
}));

jest.mock('../src/services/strategyEngine', () => ({
  getStrategiesInfo: jest.fn(),
}));

jest.mock('../src/models/Strategy', () => ({
  initDefaults: jest.fn(),
  findAll: jest.fn(),
}));

jest.mock('../src/models/RiskProfile', () => ({
  getActive: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/services/strategyInstanceService', () => ({
  getStrategyInstance: jest.fn(),
}));

const mockJobs = new Map();
let mockJobCounter = 0;

jest.mock('../src/models/BatchBacktestJob', () => ({
  create: jest.fn(async (data) => {
    const job = { _id: `job-${++mockJobCounter}`, ...data };
    mockJobs.set(job._id, job);
    return job;
  }),
  findById: jest.fn(async (id) => mockJobs.get(id) || null),
  update: jest.fn(async (id, fields) => {
    const current = mockJobs.get(id);
    if (!current) return null;
    const next = { ...current, ...fields };
    mockJobs.set(id, next);
    return next;
  }),
  findAll: jest.fn(async () => Array.from(mockJobs.values()).reverse()),
  toSummary: jest.fn((job) => ({
    jobId: job._id,
    status: job.status,
    scope: job.scope,
    runModel: job.runModel,
    period: job.period,
    initialBalance: job.initialBalance,
    timeframeMode: job.timeframeMode,
    progress: job.progress || null,
    aggregate: job.aggregate || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
  })),
}));

jest.mock('../src/config/instruments', () => ({
  getAllSymbols: jest.fn(),
}));

jest.mock('../src/config/strategyExecution', () => ({
  getStrategyExecutionConfig: jest.fn(),
}));

const backtestEngine = require('../src/services/backtestEngine');
const mt5Service = require('../src/services/mt5Service');
const strategyEngine = require('../src/services/strategyEngine');
const Strategy = require('../src/models/Strategy');
const { getAllSymbols } = require('../src/config/instruments');
const { getStrategyExecutionConfig } = require('../src/config/strategyExecution');
const batchBacktestService = require('../src/services/batchBacktestService');
const { getStrategyInstance } = require('../src/services/strategyInstanceService');

function createCandles(startIso, stepMinutes, count) {
  const startMs = new Date(startIso).getTime();
  const stepMs = stepMinutes * 60 * 1000;
  return Array.from({ length: count }, (_, index) => {
    const close = 1.1 + index * 0.0001;
    return {
      time: new Date(startMs + index * stepMs).toISOString(),
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

async function waitForJobCompletion(jobId, timeoutMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = mockJobs.get(jobId);
    if (job && (job.status === 'completed' || job.status === 'error')) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for batch job completion');
}

describe('batch backtest service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockJobs.clear();
    mockJobCounter = 0;
    batchBacktestService.activeJobId = null;

    mt5Service.isConnected.mockReturnValue(true);
    mt5Service.connect.mockResolvedValue(true);
    mt5Service.getCandles.mockResolvedValue(createCandles('2025-03-20T00:00:00.000Z', 60, 400));

    strategyEngine.getStrategiesInfo.mockReturnValue([
      { type: 'TrendFollowing', name: 'Trend Following', description: '', symbols: [] },
      { type: 'Momentum', name: 'Momentum', description: '', symbols: [] },
    ]);

    Strategy.initDefaults.mockResolvedValue();
    Strategy.findAll.mockResolvedValue([
      { name: 'TrendFollowing', enabled: true, symbols: ['EURUSD', 'USDJPY'], parameters: { ema_fast: 20 } },
      { name: 'Momentum', enabled: true, symbols: ['EURUSD', 'USDJPY'], parameters: { ema_period: 34 } },
    ]);
    getStrategyInstance.mockImplementation(async (symbol, strategyName) => ({
      parameters: { seed: `${strategyName}:${symbol}` },
      enabled: true,
      source: 'instance',
    }));

    getAllSymbols.mockReturnValue(['EURUSD', 'USDJPY']);
    getStrategyExecutionConfig.mockImplementation((symbol, strategy) => ({
      symbol,
      strategyType: strategy,
      timeframe: '1h',
      higherTimeframe: null,
      entryTimeframe: null,
      riskParams: { riskPercent: 0.01, slMultiplier: 1.5, tpMultiplier: 3 },
    }));

    backtestEngine.getResult.mockResolvedValue({ backtestId: 'detail-1', trades: [] });
    backtestEngine.run.mockImplementation(async ({ symbol, strategyType, batchJobId }) => ({
      backtestId: `${batchJobId}-${strategyType}-${symbol}`,
      summary: {
        totalTrades: 12,
        winRate: 0.58,
        profitFactor: 1.45,
        returnPercent: 6.2,
        maxDrawdownPercent: 4.1,
      },
      parameters: { testParam: 1 },
      parameterSource: { hasStoredParameters: true, hasRuntimeOverrides: false },
    }));
  });

  test('builds only enabled assigned combinations and reuses candle cache per symbol/timeframe', async () => {
    const job = await batchBacktestService.startJob({
      startDate: '2025-04-01',
      endDate: '2025-04-10',
      initialBalance: 10000,
      timeframeMode: 'strategy_default',
      runModel: 'independent',
    });

    const completedJob = await waitForJobCompletion(job._id);

    expect(completedJob.status).toBe('completed');
    expect(completedJob.results).toHaveLength(4);
    expect(mt5Service.getCandles).toHaveBeenCalledTimes(2);
    expect(completedJob.aggregate.totals.totalRuns).toBe(4);
    expect(completedJob.aggregate.totals.profitableRuns).toBe(4);
    expect(completedJob.scope).toEqual({
      symbols: ['EURUSD', 'USDJPY'],
      strategies: ['TrendFollowing', 'Momentum'],
      assignmentsBySymbol: {
        EURUSD: ['TrendFollowing', 'Momentum'],
        USDJPY: ['TrendFollowing', 'Momentum'],
      },
      eligibilityRule: 'enabled_assignments',
    });
  });

  test('continues processing when one combination fails and keeps later results', async () => {
    getAllSymbols.mockReturnValue(['EURUSD']);
    let callIndex = 0;
    backtestEngine.run.mockImplementation(async ({ symbol, strategyType, batchJobId }) => {
      callIndex += 1;
      if (callIndex === 1) {
        throw new Error('execution failed');
      }
      return {
        backtestId: `${batchJobId}-${strategyType}-${symbol}`,
        summary: {
          totalTrades: 8,
          winRate: 0.5,
          profitFactor: 1.2,
          returnPercent: 2.1,
          maxDrawdownPercent: 3.3,
        },
        parameters: { testParam: 2 },
        parameterSource: { hasStoredParameters: true, hasRuntimeOverrides: false },
      };
    });

    const job = await batchBacktestService.startJob({
      startDate: '2025-04-01',
      endDate: '2025-04-10',
      initialBalance: 10000,
      timeframeMode: 'strategy_default',
      runModel: 'independent',
    });

    const completedJob = await waitForJobCompletion(job._id);

    expect(completedJob.status).toBe('completed');
    expect(completedJob.results).toHaveLength(2);
    expect(completedJob.results[0].status).toBe('error');
    expect(completedJob.results[1].status).toBe('completed');
    expect(completedJob.progress.errorRuns).toBe(1);
    expect(completedJob.progress.completedRuns).toBe(1);
  });

  test('stores child summaries from the shared backtest engine output and exposes child detail lookup', async () => {
    getAllSymbols.mockReturnValue(['EURUSD']);
    strategyEngine.getStrategiesInfo.mockReturnValue([
      { type: 'TrendFollowing', name: 'Trend Following', description: '', symbols: [] },
    ]);
    Strategy.findAll.mockResolvedValue([
      { name: 'TrendFollowing', enabled: true, symbols: ['EURUSD'], parameters: { ema_fast: 21 } },
    ]);

    backtestEngine.run.mockResolvedValue({
      backtestId: 'child-123',
      summary: {
        totalTrades: 5,
        winRate: 0.6,
        profitFactor: 1.7,
        returnPercent: 5.2,
        maxDrawdownPercent: 2.4,
      },
      parameters: { ema_fast: 21 },
      parameterSource: { hasStoredParameters: true, hasRuntimeOverrides: false },
    });
    backtestEngine.getResult.mockResolvedValue({ backtestId: 'child-123', equityCurve: [{ equity: 10000 }, { equity: 10520 }] });

    const job = await batchBacktestService.startJob({
      startDate: '2025-04-01',
      endDate: '2025-04-10',
      initialBalance: 10000,
      timeframeMode: 'strategy_default',
      runModel: 'independent',
    });

    const completedJob = await waitForJobCompletion(job._id);
    const resultPayload = await batchBacktestService.getJobResults(job._id, { page: 1, pageSize: 10 });
    const childDetail = await batchBacktestService.getJobChildResult(job._id, 'child-123');

    expect(completedJob.results[0].summary).toEqual({
      totalTrades: 5,
      winRate: 0.6,
      profitFactor: 1.7,
      returnPercent: 5.2,
      maxDrawdownPercent: 2.4,
    });
    expect(resultPayload.items[0].summary).toEqual({
      totalTrades: 5,
      winRate: 0.6,
      profitFactor: 1.7,
      returnPercent: 5.2,
      maxDrawdownPercent: 2.4,
    });
    expect(childDetail).toEqual({ backtestId: 'child-123', equityCurve: [{ equity: 10000 }, { equity: 10520 }] });
  });

  test('rejects batch jobs when no enabled assignments are available', async () => {
    Strategy.findAll.mockResolvedValue([
      { name: 'TrendFollowing', enabled: false, symbols: ['EURUSD'], parameters: {} },
      { name: 'Momentum', enabled: true, symbols: [], parameters: {} },
    ]);
    getStrategyInstance.mockImplementation(async (symbol, strategyName) => ({
      parameters: {},
      enabled: strategyName !== 'TrendFollowing',
      source: 'instance',
    }));

    await expect(batchBacktestService.startJob({
      startDate: '2025-04-01',
      endDate: '2025-04-10',
      initialBalance: 10000,
      timeframeMode: 'strategy_default',
    })).rejects.toMatchObject({
      statusCode: 400,
      message: 'No enabled strategy assignments are available for batch backtest. Assign strategies to symbols in Strategies first.',
    });
  });
});
