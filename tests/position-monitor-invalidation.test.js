jest.mock('../src/services/mt5Service', () => ({
  isConnected: jest.fn(),
  getPositions: jest.fn(),
  getPrice: jest.fn(),
  getCandles: jest.fn(),
  modifyPosition: jest.fn(),
  partialClosePosition: jest.fn(),
  closePosition: jest.fn(),
}));

jest.mock('../src/services/trailingStopService', () => ({
  createPositionManagementHooks: jest.fn(() => ({})),
  processPositions: jest.fn(async () => []),
}));

jest.mock('../src/services/riskManager', () => ({
  recordLoss: jest.fn(),
}));

jest.mock('../src/services/websocketService', () => ({
  broadcast: jest.fn(),
}));

jest.mock('../src/services/notificationService', () => ({
  notifyTradeClosed: jest.fn(),
}));

jest.mock('../src/services/breakevenService', () => ({
  getPositionExitPlan: jest.fn(() => null),
}));

jest.mock('../src/services/economicCalendarService', () => ({
  ensureCalendar: jest.fn(),
  isInBlackout: jest.fn(() => ({ blocked: false })),
}));

jest.mock('../src/config/db', () => ({
  positionsDb: {
    find: jest.fn(async () => []),
    update: jest.fn(async () => 1),
    remove: jest.fn(async () => 1),
  },
  tradesDb: {
    update: jest.fn(async () => 1),
  },
}));

jest.mock('../src/utils/mt5Reconciliation', () => ({
  buildClosedTradeSnapshot: jest.fn(),
}));

jest.mock('../src/services/auditService', () => ({
  orderClosed: jest.fn(),
  positionManaged: jest.fn(),
  REASON: {
    BREAKEVEN_SET: 'BREAKEVEN_SET',
    TRAILING_UPDATED: 'TRAILING_UPDATED',
    PARTIAL_CLOSE: 'PARTIAL_CLOSE',
    PARTIAL_TP: 'PARTIAL_TP',
    TIME_EXIT: 'TIME_EXIT',
  },
}));

jest.mock('../src/services/strategyInstanceService', () => ({
  getStrategyInstance: jest.fn(),
}));

jest.mock('../src/config/instruments', () => ({
  getInstrument: jest.fn(),
}));

jest.mock('../src/models/RiskProfile', () => ({
  getActive: jest.fn(),
}));

jest.mock('../src/services/indicatorService', () => ({
  ema: jest.fn(),
}));

jest.mock('../src/services/strategyEngine', () => ({
  analyzeSymbol: jest.fn(),
}));

jest.mock('../src/services/tradeManagementService', () => ({
  evaluatePosition: jest.fn(async () => []),
}));

jest.mock('../src/services/tradeManagementConfig', () => ({
  resolveTradeManagementPolicy: jest.fn(() => ({ allowMoveToBreakeven: false })),
}));

jest.mock('../src/config/strategyExecution', () => ({
  getStrategyExecutionConfig: jest.fn(),
}));

jest.mock('../src/services/assignmentRuntimeService', () => ({
  getPositionCadenceProfile: jest.fn(() => ({ lightCadenceMs: 15000, heavyCadenceMs: 60000 })),
  getScanReason: jest.fn(() => 'scheduled'),
  resolveCategoryContext: jest.fn(() => ({ category: 'forex', rawCategory: 'forex', categoryFallback: false })),
  toIsoOrNull: jest.fn((value) => (value ? new Date(value).toISOString() : null)),
}));

const mt5Service = require('../src/services/mt5Service');
const { getStrategyInstance } = require('../src/services/strategyInstanceService');
const { getInstrument } = require('../src/config/instruments');
const RiskProfile = require('../src/models/RiskProfile');
const indicatorService = require('../src/services/indicatorService');
const strategyEngine = require('../src/services/strategyEngine');
const tradeManagementService = require('../src/services/tradeManagementService');
const { getStrategyExecutionConfig } = require('../src/config/strategyExecution');
const positionMonitor = require('../src/services/positionMonitor');

function createCandles(count = 251) {
  const start = new Date('2026-04-27T00:00:00.000Z').getTime();
  return Array.from({ length: count }, (_, index) => ({
    time: new Date(start + index * 60 * 60 * 1000).toISOString(),
    open: 1.1,
    high: 1.101,
    low: 1.099,
    close: index === count - 1 ? 1.095 : 1.1,
  }));
}

describe('positionMonitor heavy invalidation probe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mt5Service.getPrice.mockResolvedValue({ bid: 1.095, ask: 1.096, last: 1.0955 });
    mt5Service.getCandles.mockResolvedValue(createCandles());
    getStrategyInstance.mockResolvedValue({
      enabled: true,
      parameters: { ema_fast: 20 },
      source: 'instance',
    });
    getInstrument.mockReturnValue({ symbol: 'EURUSD', category: 'forex', pipSize: 0.0001 });
    RiskProfile.getActive.mockResolvedValue(null);
    indicatorService.ema.mockReturnValue(new Array(251).fill(1.102));
    getStrategyExecutionConfig.mockReturnValue({
      symbol: 'EURUSD',
      strategyType: 'TrendFollowing',
      timeframe: '1h',
      higherTimeframe: null,
      entryTimeframe: null,
    });
  });

  test('passes strategy-derived opposingSignal into trade management invalidation context', async () => {
    const candles = createCandles();
    mt5Service.getCandles.mockResolvedValue(candles);
    strategyEngine.analyzeSymbol.mockReturnValue({
      signal: 'SELL',
      setupActive: false,
      status: 'TRIGGERED',
      reason: 'opposite setup',
    });

    const position = {
      _id: 'pos-1',
      mt5PositionId: '123',
      symbol: 'EURUSD',
      strategy: 'TrendFollowing',
      type: 'BUY',
      entryPrice: 1.1,
      initialSl: 1.098,
      currentSl: 1.098,
      lotSize: 0.1,
      timeframe: '1h',
    };
    const contexts = [{
      key: positionMonitor._getPositionKey(position),
      position,
      category: 'forex',
      categoryFallback: false,
      state: 'normal',
      scanReason: 'scheduled',
    }];

    await positionMonitor._runTradeManagementEvaluation(
      [position],
      contexts,
      'heavy',
      new Date('2026-04-28T00:00:00.000Z')
    );

    expect(strategyEngine.analyzeSymbol).toHaveBeenCalledWith(
      'EURUSD',
      'TrendFollowing',
      candles,
      null,
      null,
      expect.objectContaining({
        recordSignal: false,
        scanMode: 'monitor',
        scanReason: 'invalidation_probe',
      })
    );
    expect(tradeManagementService.evaluatePosition).toHaveBeenCalledWith(expect.objectContaining({
      invalidationContext: expect.objectContaining({
        opposingSignal: true,
        opposingSignalDetails: expect.objectContaining({
          signal: 'SELL',
          status: 'TRIGGERED',
        }),
        indicators: expect.objectContaining({
          ema50: expect.any(Array),
        }),
      }),
    }));
  });
});
