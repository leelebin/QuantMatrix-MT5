jest.mock('../src/models/Strategy', () => ({
  initDefaults: jest.fn(),
  findAll: jest.fn(),
  update: jest.fn(),
  resetToDefaults: jest.fn(),
}));

jest.mock('../src/models/StrategyInstance', () => ({
  upsert: jest.fn().mockResolvedValue({}),
  findByKey: jest.fn().mockResolvedValue(null),
  findByStrategyName: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/services/strategyEngine', () => ({
  getStrategiesInfo: jest.fn(() => []),
}));

jest.mock('../src/models/RiskProfile', () => ({
  getActive: jest.fn().mockResolvedValue(null),
}));

const strategyController = require('../src/controllers/strategyController');
const Strategy = require('../src/models/Strategy');
const StrategyInstance = require('../src/models/StrategyInstance');
const originalAllowLegacyAssignmentWrite = process.env.ALLOW_LEGACY_ASSIGNMENT_WRITE;
const legacyWarning = 'Legacy assignment write used. This may affect live and paper assignment universe.';

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
  let warnSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ALLOW_LEGACY_ASSIGNMENT_WRITE;
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    StrategyInstance.findByKey.mockResolvedValue(null);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (originalAllowLegacyAssignmentWrite === undefined) {
      delete process.env.ALLOW_LEGACY_ASSIGNMENT_WRITE;
    } else {
      process.env.ALLOW_LEGACY_ASSIGNMENT_WRITE = originalAllowLegacyAssignmentWrite;
    }
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

  test('updateAssignments rejects legacy writes by default before changing Strategy.symbols', async () => {
    const res = createRes();

    await strategyController.updateAssignments({
      body: {
        assignmentsBySymbol: {
          EURUSD: ['TrendFollowing'],
        },
      },
    }, res);

    expect(res.statusCode).toBe(409);
    expect(res.payload).toEqual({
      success: false,
      message: 'This endpoint is deprecated. Use strategy runtime matrix / strategy instances instead.',
      deprecated: true,
    });
    expect(Strategy.update).not.toHaveBeenCalled();
    expect(Strategy.initDefaults).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('updateAssignments allows confirmed legacy writes and returns deprecated warning', async () => {
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
        confirmLegacyAssignmentUpdate: true,
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
    expect(res.payload).toEqual(expect.objectContaining({
      success: true,
      deprecated: true,
      warning: legacyWarning,
    }));
    expect(res.payload.data.assignmentsBySymbol.EURUSD).toEqual(['TrendFollowing', 'MeanReversion']);
    expect(warnSpy).toHaveBeenCalledWith(legacyWarning);
  });

  test('updateAssignments in live scope seeds new instances as live-only', async () => {
    const existingStrategies = [
      {
        _id: 'trend-1',
        name: 'TrendFollowing',
        displayName: 'Trend Following',
        enabled: true,
        symbols: [],
      },
    ];

    Strategy.findAll
      .mockResolvedValueOnce(existingStrategies)
      .mockResolvedValueOnce([
        {
          ...existingStrategies[0],
          symbols: ['EURUSD'],
        },
      ]);
    Strategy.update.mockResolvedValue({});
    StrategyInstance.findByKey.mockResolvedValue(null);

    const res = createRes();
    await strategyController.updateAssignments({
      body: {
        confirmLegacyAssignmentUpdate: true,
        scope: 'live',
        assignmentsBySymbol: {
          EURUSD: ['TrendFollowing'],
        },
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(StrategyInstance.upsert).toHaveBeenCalledWith('TrendFollowing', 'EURUSD', {
      paperEnabled: false,
      liveEnabled: true,
    });
    expect(res.payload).toEqual(expect.objectContaining({
      deprecated: true,
      warning: legacyWarning,
    }));
  });

  test('updateAssignments allows legacy writes when ALLOW_LEGACY_ASSIGNMENT_WRITE is true', async () => {
    process.env.ALLOW_LEGACY_ASSIGNMENT_WRITE = 'true';
    const existingStrategies = [
      {
        _id: 'trend-1',
        name: 'TrendFollowing',
        displayName: 'Trend Following',
        enabled: true,
        symbols: [],
      },
    ];
    Strategy.findAll
      .mockResolvedValueOnce(existingStrategies)
      .mockResolvedValueOnce([{ ...existingStrategies[0], symbols: ['EURUSD'] }]);
    Strategy.update.mockResolvedValue({});

    const res = createRes();
    await strategyController.updateAssignments({
      body: {
        assignmentsBySymbol: {
          EURUSD: ['TrendFollowing'],
        },
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(Strategy.update).toHaveBeenCalledWith('trend-1', { symbols: ['EURUSD'] });
    expect(res.payload).toEqual(expect.objectContaining({
      success: true,
      deprecated: true,
      warning: legacyWarning,
    }));
    expect(warnSpy).toHaveBeenCalledWith(legacyWarning);
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
        confirmLegacyAssignmentUpdate: true,
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
