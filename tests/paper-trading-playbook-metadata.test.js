const mockPaperMt5Service = {
  isConnected: jest.fn(),
  getAccountInfo: jest.fn(),
  getAccountModeName: jest.fn(),
  ensurePaperTradingAccount: jest.fn(),
  getPrice: jest.fn(),
  preflightOrder: jest.fn(),
  isOrderAllowed: jest.fn(),
  getPreflightMessage: jest.fn(),
  placeOrder: jest.fn(),
};

jest.mock('../src/services/mt5Service', () => ({
  getScopedService: jest.fn(() => mockPaperMt5Service),
}));

jest.mock('../src/config/db', () => ({
  paperPositionsDb: {
    insert: jest.fn(),
    update: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
    count: jest.fn(),
  },
  tradeLogDb: {
    insert: jest.fn(),
    update: jest.fn(),
    find: jest.fn(),
  },
}));

jest.mock('../src/models/ExecutionAudit', () => ({
  create: jest.fn(),
}));

jest.mock('../src/models/RiskProfile', () => ({
  getActive: jest.fn(),
}));

jest.mock('../src/models/Strategy', () => ({
  findByName: jest.fn(),
  initDefaults: jest.fn(),
}));

jest.mock('../src/services/riskManager', () => ({
  validateTrade: jest.fn(),
  recordLoss: jest.fn(),
}));

jest.mock('../src/services/websocketService', () => ({
  broadcast: jest.fn(),
}));

jest.mock('../src/services/notificationService', () => ({
  notifySystem: jest.fn(),
  notifyTradeOpened: jest.fn(),
  notifyTradeClosed: jest.fn(),
}));

jest.mock('../src/services/tradeNotificationService', () => ({
  notifyTradeOpened: jest.fn(),
}));

jest.mock('../src/services/strategyEngine', () => ({
  getStrategiesInfo: jest.fn(() => []),
  analyzeAll: jest.fn(),
}));

jest.mock('../src/services/breakevenService', () => ({
  resolveEffectiveBreakeven: jest.fn(() => ({ enabled: true, triggerAtrMultiple: 1 })),
  resolveEffectiveExitPlan: jest.fn(() => ({ breakeven: { enabled: true }, trailing: { enabled: false }, partials: [] })),
}));

jest.mock('../src/services/economicCalendarService', () => ({
  ensureCalendar: jest.fn(),
  isInBlackout: jest.fn(),
}));

jest.mock('../src/services/trailingStopService', () => ({
  createPositionManagementHooks: jest.fn(),
  processPositions: jest.fn(),
}));

jest.mock('../src/services/auditService', () => ({
  REASON: {},
  preflightRejected: jest.fn(),
  orderOpened: jest.fn(),
  orderFailed: jest.fn(),
  orderClosed: jest.fn(),
  positionManaged: jest.fn(),
}));

jest.mock('../src/services/strategyDailyStopService', () => ({
  recordTradeOutcome: jest.fn(),
  getActiveConfig: jest.fn(),
  resolveTradingDay: jest.fn(),
  getTodayStoppedStrategies: jest.fn(),
  getBlockedEntriesToday: jest.fn(),
}));

jest.mock('../src/services/strategyInstanceService', () => ({
  getStrategyInstance: jest.fn(),
}));

jest.mock('../src/services/assignmentRuntimeService', () => ({
  buildSignalScanBucketStatus: jest.fn(() => []),
  CadenceScheduler: jest.fn(),
  buildAssignmentStats: jest.fn(() => ({ activeAssignments: 0, activeSymbols: 0 })),
  getPositionCadenceProfile: jest.fn(() => ({ lightCadenceMs: 15000, heavyCadenceMs: 60000 })),
  getScanReason: jest.fn(() => 'cadence'),
  listActiveAssignments: jest.fn(() => []),
  resolveCategoryContext: jest.fn(() => ({ category: 'forex', rawCategory: 'forex_major', categoryFallback: false })),
  toIsoOrNull: jest.fn((value) => (value ? new Date(value).toISOString() : null)),
}));

const { paperPositionsDb, tradeLogDb } = require('../src/config/db');
const RiskProfile = require('../src/models/RiskProfile');
const Strategy = require('../src/models/Strategy');
const riskManager = require('../src/services/riskManager');
const tradeNotificationService = require('../src/services/tradeNotificationService');
const websocketService = require('../src/services/websocketService');
const paperTradingService = require('../src/services/paperTradingService');
const TradeLog = require('../src/models/TradeLog');

describe('paperTradingService playbook metadata persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(paperTradingService, 'syncMonitorNow').mockResolvedValue();

    paperPositionsDb.insert.mockResolvedValue({ _id: 'paper-pos-1' });
    paperPositionsDb.find.mockResolvedValue([]);
    paperPositionsDb.update.mockResolvedValue(1);
    tradeLogDb.insert.mockResolvedValue({ _id: 'paper-trade-1' });
    tradeLogDb.update.mockResolvedValue(1);

    mockPaperMt5Service.isConnected.mockReturnValue(true);
    mockPaperMt5Service.getAccountInfo.mockResolvedValue({
      login: '222222',
      balance: 10000,
      equity: 10000,
      isDemo: true,
      tradeModeName: 'DEMO',
    });
    mockPaperMt5Service.ensurePaperTradingAccount.mockImplementation(() => {});
    mockPaperMt5Service.getPrice.mockResolvedValue({ ask: 2289.9, bid: 2289.6 });
    mockPaperMt5Service.preflightOrder.mockResolvedValue({
      allowed: true,
      retcode: 10009,
      retcodeName: 'DONE',
      comment: 'Done',
    });
    mockPaperMt5Service.isOrderAllowed.mockImplementation((preflight = {}) => preflight.allowed === true);
    mockPaperMt5Service.getPreflightMessage.mockReturnValue('Rejected');
    mockPaperMt5Service.placeOrder.mockResolvedValue({
      positionId: 'paper-7001',
      orderId: 'paper-5001',
      dealId: 'paper-9001',
      price: 2289.92,
      retcode: 10009,
      entryDeal: {
        id: 'paper-9001',
        price: 2289.92,
        time: '2026-05-10T01:02:03.000Z',
        comment: 'PT|Breakout|BUY|0.91',
        commission: -1.25,
        swap: 0,
        fee: -0.35,
      },
    });

    riskManager.validateTrade.mockResolvedValue({
      allowed: true,
      reason: 'All risk checks passed',
      lotSize: 0.2,
      plannedRiskAmount: 100,
    });
    RiskProfile.getActive.mockResolvedValue({ _id: 'profile-paper', tradeManagement: null });
    Strategy.findByName.mockResolvedValue({ name: 'Breakout', tradeManagement: null });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('paper position and trade log records store setup and symbol playbook metadata', async () => {
    const signal = {
      symbol: 'XAUUSD',
      signal: 'BUY',
      setupType: 'event_breakout',
      playbook: {
        role: 'growth_engine',
        category: 'metals',
        allowedSetups: ['event_breakout', 'trend_pullback'],
        preferredEntryStyle: 'pullback_after_breakout',
        riskWeight: 1,
        beStyle: 'medium_loose',
        liveBias: 'allowed_observe',
      },
      confidence: 0.91,
      rawConfidence: 0.91,
      sl: 2280.5,
      tp: 2298.5,
      reason: 'Breakout confirmed',
      indicatorsSnapshot: { atr: 3.2 },
      strategy: 'Breakout',
    };

    await paperTradingService._executePaperTrade(signal);

    const expectedMetadata = {
      setupType: 'event_breakout',
      playbookRole: 'growth_engine',
      preferredEntryStyle: 'pullback_after_breakout',
      beStyle: 'medium_loose',
      riskWeight: 1,
      liveBias: 'allowed_observe',
      symbolPlaybookSnapshot: signal.playbook,
    };

    expect(mockPaperMt5Service.placeOrder).toHaveBeenCalledWith(
      'XAUUSD',
      'BUY',
      0.2,
      2280.5,
      2298.5,
      expect.any(String)
    );
    expect(paperPositionsDb.insert).toHaveBeenCalledWith(expect.objectContaining(expectedMetadata));
    expect(tradeLogDb.insert).toHaveBeenCalledWith(expect.objectContaining(expectedMetadata));
    expect(websocketService.broadcast).toHaveBeenCalledWith(
      'positions',
      'paper_position_update',
      expect.objectContaining({
        action: 'opened',
        position: expect.objectContaining({ _id: 'paper-pos-1' }),
      })
    );
  });

  test('paper trade open without playbook metadata does not throw and stores null-compatible fields', async () => {
    await expect(paperTradingService._executePaperTrade({
      symbol: 'EURUSD',
      signal: 'BUY',
      confidence: 0.88,
      sl: 1.095,
      tp: 1.11,
      reason: 'Trend breakout',
      indicatorsSnapshot: { atr: 0.0021 },
      strategy: 'TrendFollowing',
    })).resolves.toBeUndefined();

    const expectedMetadata = {
      setupType: null,
      playbookRole: null,
      preferredEntryStyle: null,
      beStyle: null,
      riskWeight: null,
      liveBias: null,
      symbolPlaybookSnapshot: null,
    };

    expect(paperPositionsDb.insert).toHaveBeenCalledWith(expect.objectContaining(expectedMetadata));
    expect(tradeLogDb.insert).toHaveBeenCalledWith(expect.objectContaining(expectedMetadata));
  });

  test('paper open notification is still sent immediately when the monitor sync fails', async () => {
    paperTradingService.syncMonitorNow.mockRejectedValue(new Error('MT5 positions lagged after open'));

    await expect(paperTradingService._executePaperTrade({
      symbol: 'EURUSD',
      signal: 'BUY',
      confidence: 0.88,
      sl: 1.095,
      tp: 1.11,
      reason: 'Trend breakout',
      indicatorsSnapshot: { atr: 0.0021 },
      strategy: 'TrendFollowing',
    })).resolves.toBeUndefined();

    expect(paperPositionsDb.insert).toHaveBeenCalled();
    expect(tradeNotificationService.notifyTradeOpened).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'paper',
      _id: 'paper-pos-1',
    }), { immediate: true });
  });

  test('legacy trade log records without playbook metadata remain readable', async () => {
    const legacyTrade = {
      _id: 'legacy-paper-trade',
      symbol: 'EURUSD',
      type: 'BUY',
      status: 'CLOSED',
      openedAt: new Date('2026-05-09T00:00:00.000Z'),
    };
    const limit = jest.fn().mockResolvedValue([legacyTrade]);
    const sort = jest.fn(() => ({ limit }));
    tradeLogDb.find.mockReturnValue({ sort });

    await expect(TradeLog.findAll({}, 10)).resolves.toEqual([legacyTrade]);
    expect(tradeLogDb.find).toHaveBeenCalledWith({});
    expect(sort).toHaveBeenCalledWith({ openedAt: -1 });
    expect(limit).toHaveBeenCalledWith(10);
  });
});
