jest.mock('../src/models/Strategy', () => ({
  findByName: jest.fn(),
}));

jest.mock('../src/models/StrategyInstance', () => ({
  findAll: jest.fn(),
  findByKey: jest.fn(),
  findByStrategyName: jest.fn(),
  upsert: jest.fn(),
}));

jest.mock('../src/services/strategyInstanceService', () => ({
  getStrategyInstance: jest.fn(),
}));

jest.mock('../src/services/strategyParametersLibraryService', () => ({
  listAssignedStrategyRiskStatuses: jest.fn(),
}));

const strategyInstanceController = require('../src/controllers/strategyInstanceController');
const StrategyInstance = require('../src/models/StrategyInstance');
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

describe('strategy instance controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('getStrategyInstanceByKey returns the effective runtime payload from the resolver', async () => {
    const effectivePayload = {
      _id: 'Breakout:XAUUSD',
      strategyName: 'Breakout',
      symbol: 'XAUUSD',
      parameters: { lookback_period: 20 },
      enabled: true,
      newsBlackout: {
        enabled: false,
        beforeMinutes: 15,
        afterMinutes: 15,
        impactLevels: ['High'],
      },
      source: 'instance',
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      updatedAt: new Date('2026-04-01T00:05:00.000Z'),
    };
    getStrategyInstance.mockResolvedValue(effectivePayload);

    const res = createRes();
    await strategyInstanceController.getStrategyInstanceByKey({
      params: { strategyName: 'Breakout', symbol: 'XAUUSD' },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      data: effectivePayload,
    });
  });
});
