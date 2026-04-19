jest.mock('../src/services/backtestEngine', () => ({
  run: jest.fn(),
  getResults: jest.fn(),
  getResult: jest.fn(),
  deleteResult: jest.fn(),
}));

jest.mock('../src/services/batchBacktestService', () => ({
  startJob: jest.fn(),
  getJob: jest.fn(),
  getJobs: jest.fn(),
  getJobResults: jest.fn(),
  getJobReport: jest.fn(),
  getJobChildResult: jest.fn(),
}));

jest.mock('../src/services/mt5Service', () => ({
  isConnected: jest.fn(),
  connect: jest.fn(),
  getCandles: jest.fn(),
}));

jest.mock('../src/services/websocketService', () => ({
  broadcast: jest.fn(),
}));

jest.mock('../src/models/Strategy', () => ({
  findByName: jest.fn(),
}));

jest.mock('../src/models/RiskProfile', () => ({
  getActive: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/services/strategyInstanceService', () => ({
  getStrategyInstance: jest.fn(),
}));

const backtestController = require('../src/controllers/backtestController');
const batchBacktestService = require('../src/services/batchBacktestService');

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

describe('batch backtest controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('runBatchBacktest starts a job and returns its summary', async () => {
    batchBacktestService.startJob.mockResolvedValue({ _id: 'job-1' });
    batchBacktestService.getJob.mockResolvedValue({
      jobId: 'job-1',
      status: 'queued',
      progress: { total: 10, current: 0, percent: 0 },
    });

    const req = {
      body: {
        startDate: '2025-04-01',
        endDate: '2025-04-10',
        initialBalance: 10000,
        timeframeMode: 'strategy_default',
      },
    };
    const res = createRes();

    await backtestController.runBatchBacktest(req, res);

    expect(res.statusCode).toBe(200);
    expect(batchBacktestService.startJob).toHaveBeenCalledWith(expect.objectContaining({
      startDate: '2025-04-01',
      endDate: '2025-04-10',
      initialBalance: 10000,
      timeframeMode: 'strategy_default',
    }), expect.any(Object));
    expect(res.payload).toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ jobId: 'job-1' }),
    }));
  });

  test('runBatchBacktest returns 400 when there are no eligible assignments', async () => {
    const error = new Error('No enabled strategy assignments are available for batch backtest. Assign strategies to symbols in Strategies first.');
    error.statusCode = 400;
    batchBacktestService.startJob.mockRejectedValue(error);

    const req = {
      body: {
        startDate: '2025-04-01',
        endDate: '2025-04-10',
        initialBalance: 10000,
        timeframeMode: 'strategy_default',
      },
    };
    const res = createRes();

    await backtestController.runBatchBacktest(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual({
      success: false,
      message: 'No enabled strategy assignments are available for batch backtest. Assign strategies to symbols in Strategies first.',
    });
  });

  test('getBatchJobResults returns paginated result data', async () => {
    batchBacktestService.getJobResults.mockResolvedValue({
      items: [{ symbol: 'EURUSD', strategy: 'TrendFollowing', status: 'completed' }],
      pagination: { page: 2, pageSize: 25, total: 60, totalPages: 3 },
      filters: { strategy: 'TrendFollowing', symbol: '', status: '', minTrades: 0 },
    });

    const req = {
      params: { id: 'job-1' },
      query: { page: '2', pageSize: '25', strategy: 'TrendFollowing' },
    };
    const res = createRes();

    await backtestController.getBatchJobResults(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.pagination).toEqual({ page: 2, pageSize: 25, total: 60, totalPages: 3 });
    expect(res.payload.data).toHaveLength(1);
  });

  test('getBatchJobReport returns the persisted report payload', async () => {
    batchBacktestService.getJobReport.mockResolvedValue({
      jobId: 'job-1',
      reportText: 'summary',
      reportMarkdown: '# summary',
    });

    const req = { params: { id: 'job-1' } };
    const res = createRes();

    await backtestController.getBatchJobReport(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      data: {
        jobId: 'job-1',
        reportText: 'summary',
        reportMarkdown: '# summary',
      },
    });
  });

  test('returns 404 when a batch job result set is missing', async () => {
    batchBacktestService.getJobResults.mockResolvedValue(null);

    const req = { params: { id: 'missing' }, query: {} };
    const res = createRes();

    await backtestController.getBatchJobResults(req, res);

    expect(res.statusCode).toBe(404);
    expect(res.payload).toEqual({
      success: false,
      message: 'Batch backtest job not found',
    });
  });
});
