jest.mock('../src/models/Strategy', () => ({
  initDefaults: jest.fn(),
  findAll: jest.fn(),
  findById: jest.fn(),
  update: jest.fn(),
  toggleEnabled: jest.fn(),
}));

jest.mock('../src/services/strategyEngine', () => ({
  getStrategiesInfo: jest.fn(() => []),
  getRecentSignals: jest.fn(() => []),
}));

jest.mock('../src/models/RiskProfile', () => ({
  getActive: jest.fn().mockResolvedValue(null),
}));

const strategyController = require('../src/controllers/strategyController');
const Strategy = require('../src/models/Strategy');
const RiskProfile = require('../src/models/RiskProfile');

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

describe('strategy controller breakeven support', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    RiskProfile.getActive.mockResolvedValue({
      _id: 'risk-1',
      name: 'Aggressive Default',
      tradeManagement: {
        breakeven: {
          enabled: true,
          triggerAtrMultiple: 0.9,
          includeSpreadCompensation: true,
          extraBufferPips: 0,
          trailStartAtrMultiple: 1.6,
          trailDistanceAtrMultiple: 1.1,
        },
      },
    });
  });

  test('getStrategies returns effective breakeven merged from active profile and strategy override', async () => {
    Strategy.findAll.mockResolvedValue([
      {
        _id: 'strat-1',
        name: 'TrendFollowing',
        displayName: 'Trend Following',
        enabled: true,
        symbols: ['EURUSD'],
        parameters: {},
        tradeManagement: {
          breakevenOverride: {
            enabled: false,
            extraBufferPips: 2,
          },
        },
      },
    ]);

    const res = createRes();
    await strategyController.getStrategies({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual(expect.objectContaining({
      success: true,
      data: [
        expect.objectContaining({
          _id: 'strat-1',
          effectiveBreakeven: {
            enabled: false,
            triggerAtrMultiple: 0.9,
            includeSpreadCompensation: true,
            extraBufferPips: 2,
            trailStartAtrMultiple: 1.6,
            trailDistanceAtrMultiple: 1.1,
          },
        }),
      ],
    }));
  });

  test('updateStrategy persists sparse breakeven override and returns effective config', async () => {
    Strategy.findById.mockResolvedValue({
      _id: 'strat-1',
      name: 'TrendFollowing',
      displayName: 'Trend Following',
      enabled: true,
      symbols: ['EURUSD'],
      parameters: {},
      tradeManagement: null,
    });
    Strategy.update.mockResolvedValue({
      _id: 'strat-1',
      name: 'TrendFollowing',
      displayName: 'Trend Following',
      enabled: true,
      symbols: ['EURUSD'],
      parameters: {},
      tradeManagement: {
        breakevenOverride: {
          enabled: false,
          triggerAtrMultiple: 1.2,
        },
      },
    });

    const req = {
      params: { id: 'strat-1' },
      body: {
        tradeManagement: {
          breakevenOverride: {
            enabled: false,
            triggerAtrMultiple: 1.2,
          },
        },
      },
    };
    const res = createRes();

    await strategyController.updateStrategy(req, res);

    expect(Strategy.update).toHaveBeenCalledWith('strat-1', {
      tradeManagement: {
        breakevenOverride: {
          enabled: false,
          triggerAtrMultiple: 1.2,
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload.data.effectiveBreakeven).toEqual({
      enabled: false,
      triggerAtrMultiple: 1.2,
      includeSpreadCompensation: true,
      extraBufferPips: 0,
      trailStartAtrMultiple: 1.6,
      trailDistanceAtrMultiple: 1.1,
    });
  });

  test('updateStrategy rejects invalid breakeven override values', async () => {
    Strategy.findById.mockResolvedValue({
      _id: 'strat-1',
      name: 'TrendFollowing',
      displayName: 'Trend Following',
      enabled: true,
      symbols: ['EURUSD'],
      parameters: {},
      tradeManagement: null,
    });

    const req = {
      params: { id: 'strat-1' },
      body: {
        tradeManagement: {
          breakevenOverride: {
            triggerAtrMultiple: 1.4,
            trailStartAtrMultiple: 1.2,
          },
        },
      },
    };
    const res = createRes();

    await strategyController.updateStrategy(req, res);

    expect(Strategy.update).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual(expect.objectContaining({
      success: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          field: 'tradeManagement.breakeven.trailStartAtrMultiple',
        }),
      ]),
    }));
  });
});
