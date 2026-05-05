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

jest.mock('../src/services/strategyRuntimeMatrixService', () => ({
  getRuntimeMatrix: jest.fn(),
  updateRuntimeMatrix: jest.fn(),
}));

jest.mock('../src/models/RiskProfile', () => ({
  getActive: jest.fn(),
}));

const strategyInstanceController = require('../src/controllers/strategyInstanceController');
const Strategy = require('../src/models/Strategy');
const StrategyInstance = require('../src/models/StrategyInstance');
const RiskProfile = require('../src/models/RiskProfile');
const { getStrategyInstance } = require('../src/services/strategyInstanceService');
const {
  getRuntimeMatrix,
  updateRuntimeMatrix,
} = require('../src/services/strategyRuntimeMatrixService');

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
    RiskProfile.getActive.mockResolvedValue(null);
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

  test('upsertStrategyInstance accepts scoped enable fields without mapping them to legacy enabled', async () => {
    Strategy.findByName.mockResolvedValue({ name: 'Breakout' });
    getStrategyInstance.mockResolvedValue({
      _id: 'Breakout:XAUUSD',
      strategyName: 'Breakout',
      symbol: 'XAUUSD',
      paperEnabled: true,
      liveEnabled: true,
      enabledForScope: true,
    });

    const res = createRes();
    await strategyInstanceController.upsertStrategyInstance({
      params: { strategyName: 'Breakout', symbol: 'XAUUSD' },
      query: { scope: 'live' },
      body: { liveEnabled: true },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(StrategyInstance.upsert).toHaveBeenCalledWith('Breakout', 'XAUUSD', {
      liveEnabled: true,
    });
    expect(getStrategyInstance).toHaveBeenCalledWith('XAUUSD', 'Breakout', {
      activeProfile: null,
      scope: 'live',
    });
  });

  test('getRuntimeMatrix returns the scoped runtime matrix payload', async () => {
    getRuntimeMatrix.mockResolvedValue({
      scope: 'live',
      symbols: ['EURUSD'],
      enabledBySymbol: { EURUSD: ['Breakout'] },
    });

    const res = createRes();
    await strategyInstanceController.getRuntimeMatrix({
      query: { scope: 'live' },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(getRuntimeMatrix).toHaveBeenCalledWith({ scope: 'live' });
    expect(res.payload).toEqual({
      success: true,
      data: {
        scope: 'live',
        symbols: ['EURUSD'],
        enabledBySymbol: { EURUSD: ['Breakout'] },
      },
    });
  });

  test('runtime matrix writes remain allowed and pass scope/enabledBySymbol to the service', async () => {
    updateRuntimeMatrix.mockResolvedValue({
      scope: 'paper',
      changes: [
        {
          symbol: 'EURUSD',
          strategyName: 'Breakout',
          before: true,
          after: false,
        },
      ],
    });

    const res = createRes();
    await strategyInstanceController.updateRuntimeMatrix({
      body: {
        scope: 'paper',
        enabledBySymbol: {
          EURUSD: [],
        },
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.success).toBe(true);
    expect(res.payload.deprecated).toBeUndefined();
    expect(updateRuntimeMatrix).toHaveBeenCalledWith({
      scope: 'paper',
      enabledBySymbol: {
        EURUSD: [],
      },
    });
    expect(res.payload.data.changes).toHaveLength(1);
  });

  test('legacy enabled updates remain paper-only compatibility updates', async () => {
    Strategy.findByName.mockResolvedValue({ name: 'Breakout' });
    getStrategyInstance.mockResolvedValue({
      _id: 'Breakout:XAUUSD',
      strategyName: 'Breakout',
      symbol: 'XAUUSD',
      paperEnabled: false,
      liveEnabled: false,
    });

    const res = createRes();
    await strategyInstanceController.upsertStrategyInstance({
      params: { strategyName: 'Breakout', symbol: 'XAUUSD' },
      query: {},
      body: { enabled: false },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(StrategyInstance.upsert).toHaveBeenCalledWith('Breakout', 'XAUUSD', {
      enabled: false,
    });
  });
});
