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

jest.mock('../src/models/StrategyInstance', () => ({
  upsert: jest.fn(),
  findByStrategyName: jest.fn().mockResolvedValue([]),
}));

const strategyController = require('../src/controllers/strategyController');
const Strategy = require('../src/models/Strategy');
const RiskProfile = require('../src/models/RiskProfile');
const StrategyInstance = require('../src/models/StrategyInstance');
const originalAllowLegacyAssignmentWrite = process.env.ALLOW_LEGACY_ASSIGNMENT_WRITE;
const legacyDeprecatedMessage = 'This endpoint is deprecated. Use strategy runtime matrix / strategy instances instead.';
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

describe('strategy controller breakeven support', () => {
  let warnSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ALLOW_LEGACY_ASSIGNMENT_WRITE;
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    StrategyInstance.findByStrategyName.mockResolvedValue([]);
    StrategyInstance.upsert.mockResolvedValue({});
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

  afterEach(() => {
    warnSpy.mockRestore();
    if (originalAllowLegacyAssignmentWrite === undefined) {
      delete process.env.ALLOW_LEGACY_ASSIGNMENT_WRITE;
    } else {
      process.env.ALLOW_LEGACY_ASSIGNMENT_WRITE = originalAllowLegacyAssignmentWrite;
    }
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
    expect(res.payload.data[0]).not.toHaveProperty('resolvedParameters');
  });

  test('updateStrategy rejects runtime tradeManagement writes in favor of assignment instances', async () => {
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
            enabled: false,
            triggerAtrMultiple: 1.2,
          },
        },
      },
    };
    const res = createRes();

    await strategyController.updateStrategy(req, res);

    expect(Strategy.update).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.payload.message).toContain('/api/strategy-instances/:strategyName/:symbol');
  });

  test('updateStrategy rejects runtime parameter writes in favor of assignment instances', async () => {
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
        parameters: {
          ema_fast: 34,
        },
      },
    };
    const res = createRes();

    await strategyController.updateStrategy(req, res);

    expect(Strategy.update).not.toHaveBeenCalled();
    expect(StrategyInstance.upsert).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.payload.message).toContain('/api/strategy-instances/:strategyName/:symbol');
  });

  test('updateStrategy rejects legacy enabled writes in favor of assignment instances', async () => {
    Strategy.findById.mockResolvedValue({
      _id: 'strat-1',
      name: 'TrendFollowing',
      displayName: 'Trend Following',
      enabled: true,
      symbols: ['EURUSD'],
      parameters: { ema_fast: 20 },
      tradeManagement: null,
    });

    const req = {
      params: { id: 'strat-1' },
      body: {
        enabled: false,
      },
    };
    const res = createRes();

    await strategyController.updateStrategy(req, res);

    expect(Strategy.update).not.toHaveBeenCalled();
    expect(StrategyInstance.upsert).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.payload.message).toContain('/api/strategy-instances/:strategyName/:symbol');
  });

  test('updateStrategy rejects legacy symbol assignment writes by default', async () => {
    Strategy.findById.mockResolvedValue({
      _id: 'strat-1',
      name: 'TrendFollowing',
      displayName: 'Trend Following',
      enabled: true,
      symbols: ['EURUSD'],
      parameters: {},
      tradeManagement: null,
    });

    const updateRes = createRes();
    await strategyController.updateStrategy({
      params: { id: 'strat-1' },
      body: { symbols: ['EURUSD', 'GBPUSD'] },
    }, updateRes);

    expect(updateRes.statusCode).toBe(409);
    expect(updateRes.payload).toEqual({
      success: false,
      message: legacyDeprecatedMessage,
      deprecated: true,
    });
    expect(Strategy.update).not.toHaveBeenCalled();
    expect(StrategyInstance.upsert).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('updateStrategy allows confirmed legacy symbol assignment writes and seeds instances', async () => {
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
      symbols: ['EURUSD', 'GBPUSD'],
      parameters: {},
      tradeManagement: null,
    });

    const updateRes = createRes();
    await strategyController.updateStrategy({
      params: { id: 'strat-1' },
      body: {
        symbols: ['EURUSD', 'GBPUSD'],
        confirmLegacyAssignmentUpdate: true,
      },
    }, updateRes);

    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.payload).toEqual(expect.objectContaining({
      success: true,
      deprecated: true,
      warning: legacyWarning,
    }));
    expect(Strategy.update).toHaveBeenCalledWith('strat-1', {
      symbols: ['EURUSD', 'GBPUSD'],
    });
    expect(StrategyInstance.upsert).toHaveBeenCalledTimes(2);
    expect(StrategyInstance.upsert).toHaveBeenCalledWith('TrendFollowing', 'EURUSD', {});
    expect(StrategyInstance.upsert).toHaveBeenCalledWith('TrendFollowing', 'GBPUSD', {});
    expect(warnSpy).toHaveBeenCalledWith(legacyWarning);
  });

  test('toggleStrategy rejects legacy global toggles in favor of assignment instances', async () => {
    Strategy.findById.mockResolvedValue({
      _id: 'strat-1',
      name: 'TrendFollowing',
      displayName: 'Trend Following',
      enabled: true,
      symbols: ['EURUSD'],
      parameters: {},
      tradeManagement: null,
    });
    const toggleRes = createRes();
    await strategyController.toggleStrategy({ params: { id: 'strat-1' } }, toggleRes);

    expect(StrategyInstance.upsert).not.toHaveBeenCalled();
    expect(toggleRes.statusCode).toBe(409);
    expect(toggleRes.payload.message).toContain('/api/strategy-instances/:strategyName/:symbol');
  });
});
