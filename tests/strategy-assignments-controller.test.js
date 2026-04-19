jest.mock('../src/models/Strategy', () => ({
  initDefaults: jest.fn(),
  findAll: jest.fn(),
  update: jest.fn(),
}));

jest.mock('../src/services/strategyEngine', () => ({
  getStrategiesInfo: jest.fn(() => []),
}));

jest.mock('../src/models/RiskProfile', () => ({
  getActive: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/models/StrategyInstance', () => ({
  upsert: jest.fn(),
  findByStrategyName: jest.fn().mockResolvedValue([]),
}));

const strategyController = require('../src/controllers/strategyController');
const Strategy = require('../src/models/Strategy');
const StrategyInstance = require('../src/models/StrategyInstance');

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

describe('strategy assignments controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    StrategyInstance.findByStrategyName.mockResolvedValue([]);
    StrategyInstance.upsert.mockResolvedValue({});
  });

  test('getAssignments returns a full symbol-strategy matrix', async () => {
    Strategy.findAll.mockResolvedValue([
      {
        _id: 'trend-1',
        name: 'TrendFollowing',
        displayName: 'Trend Following',
        enabled: true,
        symbols: ['EURUSD', 'GBPUSD'],
      },
      {
        _id: 'mean-1',
        name: 'MeanReversion',
        displayName: 'Mean Reversion',
        enabled: false,
        symbols: ['EURUSD'],
      },
    ]);

    const res = createRes();
    await strategyController.getAssignments({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        symbols: expect.arrayContaining(['EURUSD', 'XAUUSD']),
        strategies: expect.arrayContaining([
          expect.objectContaining({ id: 'trend-1', name: 'TrendFollowing', enabled: true }),
          expect.objectContaining({ id: 'mean-1', name: 'MeanReversion', enabled: false }),
        ]),
        assignmentsBySymbol: expect.objectContaining({
          EURUSD: ['TrendFollowing', 'MeanReversion'],
          GBPUSD: ['TrendFollowing'],
        }),
        assignmentsByStrategy: expect.objectContaining({
          TrendFollowing: ['EURUSD', 'GBPUSD'],
          MeanReversion: ['EURUSD'],
        }),
      }),
    }));
  });

  test('updateAssignments rewrites strategy symbols from assignmentsBySymbol', async () => {
    const existingStrategies = [
      {
        _id: 'trend-1',
        name: 'TrendFollowing',
        displayName: 'Trend Following',
        enabled: true,
        symbols: ['GBPUSD'],
      },
      {
        _id: 'mean-1',
        name: 'MeanReversion',
        displayName: 'Mean Reversion',
        enabled: true,
        symbols: [],
      },
    ];
    const updatedStrategies = [
      {
        _id: 'trend-1',
        name: 'TrendFollowing',
        displayName: 'Trend Following',
        enabled: true,
        symbols: ['EURUSD'],
      },
      {
        _id: 'mean-1',
        name: 'MeanReversion',
        displayName: 'Mean Reversion',
        enabled: true,
        symbols: ['EURUSD'],
      },
    ];

    Strategy.findAll
      .mockResolvedValueOnce(existingStrategies)
      .mockResolvedValueOnce(updatedStrategies);
    Strategy.update.mockResolvedValue({});

    const req = {
      body: {
        assignmentsBySymbol: {
          EURUSD: ['TrendFollowing', 'MeanReversion'],
        },
      },
    };
    const res = createRes();

    await strategyController.updateAssignments(req, res);

    expect(Strategy.update).toHaveBeenCalledWith('trend-1', { symbols: ['EURUSD'] });
    expect(Strategy.update).toHaveBeenCalledWith('mean-1', { symbols: ['EURUSD'] });
    expect(res.statusCode).toBe(200);
    expect(res.payload.data.assignmentsBySymbol.EURUSD).toEqual(['TrendFollowing', 'MeanReversion']);
  });

  test('updateAssignments rejects invalid symbols', async () => {
    Strategy.findAll.mockResolvedValue([
      {
        _id: 'trend-1',
        name: 'TrendFollowing',
        displayName: 'Trend Following',
        enabled: true,
        symbols: ['EURUSD'],
      },
    ]);

    const req = {
      body: {
        assignmentsBySymbol: {
          ZZZZZZ: ['TrendFollowing'],
        },
      },
    };
    const res = createRes();

    await strategyController.updateAssignments(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual(expect.objectContaining({
      success: false,
      message: 'Invalid symbol: ZZZZZZ',
    }));
  });
});
