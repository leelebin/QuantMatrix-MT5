jest.mock('../src/config/db', () => ({
  positionsDb: {
    count: jest.fn(async () => 0),
    find: jest.fn(async () => []),
  },
  paperPositionsDb: {
    count: jest.fn(async () => 0),
    find: jest.fn(async () => []),
  },
  riskStateDb: {
    findOne: jest.fn(async () => null),
    update: jest.fn(async () => 1),
  },
}));

jest.mock('../src/models/RiskProfile', () => ({
  getActive: jest.fn(),
  toRuntimeSettings: jest.fn(),
}));

jest.mock('../src/services/auditService', () => ({
  REASON: {
    UNKNOWN_INSTRUMENT: 'UNKNOWN_INSTRUMENT',
    TRADING_DISABLED: 'TRADING_DISABLED',
    DAILY_LOSS_LIMIT: 'DAILY_LOSS_LIMIT',
    MAX_DRAWDOWN: 'MAX_DRAWDOWN',
    MAX_POSITIONS_REACHED: 'MAX_POSITIONS_REACHED',
    SYMBOL_EXPOSURE_LIMIT: 'SYMBOL_EXPOSURE_LIMIT',
    CATEGORY_EXPOSURE_LIMIT: 'CATEGORY_EXPOSURE_LIMIT',
    LOT_BELOW_MIN: 'LOT_BELOW_MIN',
    INVALID_SL: 'INVALID_SL',
    SL_TOO_CLOSE: 'SL_TOO_CLOSE',
  },
  riskRejected: jest.fn(),
}));

jest.mock('../src/services/mt5Service', () => ({
  isConnected: jest.fn(),
  getResolvedSymbolInfo: jest.fn(),
  calculateOrderProfit: jest.fn(),
}));

const RiskProfile = require('../src/models/RiskProfile');
const mt5Service = require('../src/services/mt5Service');
const riskManager = require('../src/services/riskManager');

describe('riskManager sizing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TRADING_ENABLED = 'true';
    RiskProfile.getActive.mockResolvedValue({
      name: 'Unit Test Profile',
      maxRiskPerTradePct: 5,
      maxDailyLossPct: 5,
      maxDrawdownPct: 10,
      maxConcurrentPositions: 5,
      maxPositionsPerSymbol: 2,
      allowAggressiveMinLot: false,
      isActive: true,
    });
    RiskProfile.toRuntimeSettings.mockReturnValue({
      profile: { name: 'Unit Test Profile' },
      maxRiskPerTrade: 0.05,
      maxDailyLoss: 0.05,
      maxDrawdown: 0.10,
      maxConcurrentPositions: 5,
      maxPositionsPerSymbol: 2,
      allowAggressiveMinLot: false,
    });
  });

  test('uses MT5 broker profit estimation for ETHUSD sizing', async () => {
    mt5Service.isConnected.mockReturnValue(true);
    mt5Service.getResolvedSymbolInfo.mockResolvedValue({
      volumeMin: 0.01,
      volumeStep: 0.01,
    });
    mt5Service.calculateOrderProfit.mockResolvedValue({
      profit: -131.1,
    });

    const result = await riskManager.validateTrade({
      symbol: 'ETHUSD',
      signal: 'BUY',
      confidence: 1,
      entryPrice: 2318.15,
      sl: 2305.04,
      tp: 2344.37,
      strategy: 'VolumeFlowHybrid',
      strategyParams: { riskPercent: 0.0075 },
    }, {
      balance: 10000,
      equity: 10000,
    });

    expect(result.allowed).toBe(true);
    expect(result.lotSize).toBe(0.57);
    expect(result.effectiveRiskPercent).toBeCloseTo(0.0075);
    expect(result.sizingMethod).toBe('broker_order_profit');
    expect(mt5Service.calculateOrderProfit).toHaveBeenCalledWith(
      'ETHUSD',
      'BUY',
      1.0,
      2318.15,
      2305.04
    );
  });

  test('respects strategy riskPercent when broker sizing is unavailable', async () => {
    mt5Service.isConnected.mockReturnValue(false);

    const result = await riskManager.validateTrade({
      symbol: 'XAUUSD',
      signal: 'BUY',
      confidence: 1,
      entryPrice: 100,
      sl: 99,
      tp: 102,
      strategy: 'VolumeFlowHybrid',
      strategyParams: { riskPercent: 0.0075 },
    }, {
      balance: 10000,
      equity: 10000,
    });

    expect(result.allowed).toBe(true);
    expect(result.lotSize).toBe(0.75);
    expect(result.effectiveRiskPercent).toBeCloseTo(0.0075);
    expect(result.sizingMethod).toBe('config_pip_value');
  });
});
