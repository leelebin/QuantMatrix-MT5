jest.mock('../src/models/Strategy', () => ({
  findByName: jest.fn(),
}));

jest.mock('../src/models/StrategyInstance', () => ({
  findByKey: jest.fn(),
  upsert: jest.fn(),
}));

jest.mock('../src/models/RiskProfile', () => ({
  getActive: jest.fn(),
}));

const Strategy = require('../src/models/Strategy');
const StrategyInstance = require('../src/models/StrategyInstance');
const { DEFAULT_NEWS_BLACKOUT_CONFIG } = require('../src/config/newsBlackout');
const RiskProfile = require('../src/models/RiskProfile');
const { DEFAULT_EXECUTION_POLICY } = require('../src/services/executionPolicyService');
const { getStrategyInstance } = require('../src/services/strategyInstanceService');

describe('strategy instance service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    RiskProfile.getActive.mockResolvedValue(null);
  });

  test('returns an existing instance merged into the effective runtime payload', async () => {
    Strategy.findByName.mockResolvedValue({
      name: 'Breakout',
      enabled: true,
      parameters: { lookback_period: 20 },
    });
    StrategyInstance.findByKey.mockResolvedValue({
      _id: 'Breakout:XAUUSD',
      strategyName: 'Breakout',
      symbol: 'XAUUSD',
      parameters: { lookback_period: 33 },
      enabled: false,
      newsBlackout: null,
      tradeManagement: null,
      executionPolicy: null,
    });

    const result = await getStrategyInstance('XAUUSD', 'Breakout');

    expect(StrategyInstance.upsert).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      _id: 'Breakout:XAUUSD',
      strategyName: 'Breakout',
      symbol: 'XAUUSD',
      parameters: expect.objectContaining({ lookback_period: 33 }),
      enabled: false,
      newsBlackout: DEFAULT_NEWS_BLACKOUT_CONFIG,
      executionPolicy: DEFAULT_EXECUTION_POLICY,
      source: 'instance',
      hasStoredInstance: true,
      storedParameters: { lookback_period: 33 },
      strategyDefaultParameters: { lookback_period: 20 },
    }));
  });

  test('returns strategy defaults when no stored instance exists', async () => {
    Strategy.findByName.mockResolvedValue({
      name: 'Breakout',
      enabled: true,
      parameters: { lookback_period: 20 },
    });
    StrategyInstance.findByKey.mockResolvedValue(null);

    const result = await getStrategyInstance('XAUUSD', 'Breakout');

    expect(StrategyInstance.upsert).not.toHaveBeenCalled();
    expect(result.source).toBe('strategy_default');
    expect(result.parameters).toEqual(expect.objectContaining({ lookback_period: 20 }));
    expect(result.enabled).toBe(true);
    expect(result.hasStoredInstance).toBe(false);
    expect(result.storedParameters).toEqual({});
    expect(result.executionPolicy).toEqual(DEFAULT_EXECUTION_POLICY);
  });
});
