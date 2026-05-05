const mockPaperMt5Service = {
  isConnected: jest.fn(),
  getAccountInfo: jest.fn(),
  buildRuntimeIdentityStatus: jest.fn(),
  getPublicConnectionConfig: jest.fn(),
};

jest.mock('../src/services/mt5Service', () => ({
  getScopedService: jest.fn(() => mockPaperMt5Service),
}));

jest.mock('../src/config/db', () => ({
  paperPositionsDb: {
    find: jest.fn(),
  },
}));

jest.mock('../src/models/TradeLog', () => ({
  findToday: jest.fn(),
  getStats: jest.fn(),
  formatHoldingTime: jest.fn(() => '1m'),
}));

jest.mock('../src/models/Strategy', () => ({
  initDefaults: jest.fn(),
}));

jest.mock('../src/models/ExecutionAudit', () => ({
  create: jest.fn(),
}));

jest.mock('../src/models/RiskProfile', () => ({}));

jest.mock('../src/services/strategyEngine', () => ({
  getStrategiesInfo: jest.fn(() => []),
  analyzeAll: jest.fn(),
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

jest.mock('../src/services/trailingStopService', () => ({}));
jest.mock('../src/services/breakevenService', () => ({}));
jest.mock('../src/services/economicCalendarService', () => ({}));
jest.mock('../src/services/auditService', () => ({}));

jest.mock('../src/services/strategyInstanceService', () => ({
  getStrategyInstance: jest.fn(),
}));

jest.mock('../src/services/strategyDailyStopService', () => ({
  getActiveConfig: jest.fn(),
  resolveTradingDay: jest.fn(),
  getTodayStoppedStrategies: jest.fn(),
  getBlockedEntriesToday: jest.fn(),
}));

jest.mock('../src/services/assignmentRuntimeService', () => ({
  buildSignalScanBucketStatus: jest.fn(() => []),
  CadenceScheduler: jest.fn(),
  buildAssignmentStats: jest.fn((assignments = []) => ({
    activeAssignments: assignments.length,
    activeSymbols: new Set(assignments.map((assignment) => assignment.symbol)).size,
  })),
  getPositionCadenceProfile: jest.fn(),
  getScanReason: jest.fn(),
  listActiveAssignments: jest.fn(),
  resolveCategoryContext: jest.fn(),
  toIsoOrNull: jest.fn((value) => (value ? new Date(value).toISOString() : null)),
}));

const paperTradingService = require('../src/services/paperTradingService');
const { paperPositionsDb } = require('../src/config/db');
const TradeLog = require('../src/models/TradeLog');
const Strategy = require('../src/models/Strategy');
const strategyDailyStopService = require('../src/services/strategyDailyStopService');
const {
  listActiveAssignments,
} = require('../src/services/assignmentRuntimeService');

const originalPaperTradingEnabled = process.env.PAPER_TRADING_ENABLED;

function buildIdentity(overrides = {}) {
  return {
    scope: 'paper',
    connected: true,
    mt5Path: 'C:\\MT5-Paper\\terminal64.exe',
    account: {
      login: '222222',
      server: 'Broker-Demo',
      tradeModeName: 'DEMO',
      mode: 'DEMO',
      isReal: false,
      isDemo: true,
      balance: 25000,
      equity: 24900,
      currency: 'USD',
    },
    validation: {
      ok: true,
      warnings: [],
      errors: [],
    },
    ...overrides,
  };
}

describe('paperTradingService.getStatus runtime identity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PAPER_TRADING_ENABLED = 'false';
    paperTradingService.running = false;
    paperTradingService.startedAt = null;
    paperTradingService.scheduler = null;

    paperPositionsDb.find.mockResolvedValue([]);
    TradeLog.findToday.mockResolvedValue([]);
    TradeLog.getStats.mockResolvedValue({ totalTrades: 0, winRate: 0, totalProfit: 0 });
    Strategy.initDefaults.mockResolvedValue();
    listActiveAssignments.mockResolvedValue([]);
    strategyDailyStopService.getActiveConfig.mockResolvedValue({ enabled: true });
    strategyDailyStopService.resolveTradingDay.mockReturnValue({
      tradingDay: '2026-05-05',
      resetAt: '2026-05-06T00:00:00.000Z',
    });
    strategyDailyStopService.getTodayStoppedStrategies.mockResolvedValue([]);
    strategyDailyStopService.getBlockedEntriesToday.mockReturnValue(0);
    mockPaperMt5Service.getPublicConnectionConfig.mockReturnValue({
      scope: 'paper',
      login: '222222',
      server: 'Broker-Demo',
      pathConfigured: true,
    });
  });

  afterEach(() => {
    if (originalPaperTradingEnabled === undefined) {
      delete process.env.PAPER_TRADING_ENABLED;
    } else {
      process.env.PAPER_TRADING_ENABLED = originalPaperTradingEnabled;
    }
  });

  test('includes paper account identity when connected', async () => {
    const identity = buildIdentity();
    mockPaperMt5Service.isConnected.mockReturnValue(true);
    mockPaperMt5Service.getAccountInfo.mockResolvedValue(identity.account);
    mockPaperMt5Service.buildRuntimeIdentityStatus.mockImplementation((accountInfo = null) => (
      accountInfo ? identity : buildIdentity({ account: null })
    ));

    const status = await paperTradingService.getStatus();

    expect(status).toEqual(expect.objectContaining({
      scope: 'paper',
      enabled: false,
      running: false,
      connected: true,
      mt5Path: 'C:\\MT5-Paper\\terminal64.exe',
      account: expect.objectContaining({
        login: '222222',
        server: 'Broker-Demo',
        tradeModeName: 'DEMO',
        isDemo: true,
        balance: 25000,
        equity: 24900,
        currency: 'USD',
      }),
      validation: expect.objectContaining({ ok: true, errors: [] }),
      message: null,
    }));
  });

  test('returns safe payload when paper runtime is not configured or connected', async () => {
    mockPaperMt5Service.isConnected.mockReturnValue(false);
    mockPaperMt5Service.getPublicConnectionConfig.mockReturnValue({
      scope: 'paper',
      login: null,
      server: null,
      pathConfigured: false,
    });
    mockPaperMt5Service.buildRuntimeIdentityStatus.mockReturnValue({
      scope: 'paper',
      connected: false,
      mt5Path: null,
      account: null,
      validation: { ok: false, warnings: [], errors: [] },
    });

    const status = await paperTradingService.getStatus();

    expect(status).toEqual(expect.objectContaining({
      scope: 'paper',
      connected: false,
      mt5Path: null,
      account: null,
      validation: { ok: false, warnings: [], errors: [] },
      message: 'Paper runtime not configured or not connected.',
    }));
    expect(mockPaperMt5Service.getAccountInfo).not.toHaveBeenCalled();
  });

  test('surfaces validation error when paper runtime is connected to REAL account', async () => {
    const identity = buildIdentity({
      account: {
        login: '999999',
        server: 'Broker-Real',
        tradeModeName: 'REAL',
        mode: 'REAL',
        isReal: true,
        isDemo: false,
        balance: 50000,
        equity: 50000,
        currency: 'USD',
      },
      validation: {
        ok: false,
        warnings: [],
        errors: ['Paper MT5 runtime must not use a REAL account.'],
      },
    });
    mockPaperMt5Service.isConnected.mockReturnValue(true);
    mockPaperMt5Service.getAccountInfo.mockResolvedValue(identity.account);
    mockPaperMt5Service.buildRuntimeIdentityStatus.mockImplementation((accountInfo = null) => (
      accountInfo ? identity : buildIdentity({ account: null })
    ));

    const status = await paperTradingService.getStatus();

    expect(status).toEqual(expect.objectContaining({
      scope: 'paper',
      connected: true,
      account: expect.objectContaining({
        login: '999999',
        tradeModeName: 'REAL',
        isReal: true,
      }),
      validation: expect.objectContaining({
        ok: false,
        errors: ['Paper MT5 runtime must not use a REAL account.'],
      }),
      message: 'Paper runtime is connected to REAL account. Paper trading is blocked.',
    }));
  });
});
