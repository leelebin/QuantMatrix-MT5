jest.mock('../src/services/mt5Service', () => ({
  isConnected: jest.fn(),
  connect: jest.fn(),
  getAccountInfo: jest.fn(),
  ensureLiveTradingAllowed: jest.fn(),
  ensurePaperTradingAccount: jest.fn(),
  getPrice: jest.fn(),
  getCandles: jest.fn(),
  preflightOrder: jest.fn(),
  isOrderAllowed: jest.fn(),
  getPreflightMessage: jest.fn(),
  placeOrder: jest.fn(),
  closePosition: jest.fn(),
  getAccountModeName: jest.fn(),
}));

jest.mock('../src/services/riskManager', () => ({
  validateTrade: jest.fn(),
  getRiskStatus: jest.fn(),
}));

jest.mock('../src/services/indicatorService', () => ({
  atr: jest.fn(),
}));

jest.mock('../src/services/websocketService', () => ({
  broadcast: jest.fn(),
  getClientCount: jest.fn(),
}));

jest.mock('../src/services/notificationService', () => ({
  notifyTradeOpened: jest.fn(),
}));

jest.mock('../src/services/strategyEngine', () => ({
  getStrategiesInfo: jest.fn(),
  getRecentSignals: jest.fn(),
}));

jest.mock('../src/services/tradeExecutor', () => ({
  executeTrade: jest.fn(),
  closePosition: jest.fn(),
}));

jest.mock('../src/services/positionMonitor', () => ({
  start: jest.fn(),
  stop: jest.fn(),
  syncNow: jest.fn(),
  getStatus: jest.fn(),
}));

jest.mock('../src/services/assignmentRuntimeService', () => ({
  CadenceScheduler: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    stop: jest.fn(),
    isRunning: jest.fn(() => false),
    getBucketStates: jest.fn(() => new Map()),
  })),
  buildAssignmentStats: jest.fn((assignments = []) => ({
    activeAssignments: assignments.length,
    activeSymbols: new Set(assignments.map((assignment) => assignment.symbol)).size,
  })),
  buildSignalScanBucketStatus: jest.fn(() => []),
  listActiveAssignments: jest.fn(),
}));

jest.mock('../src/models/Strategy', () => ({
  initDefaults: jest.fn(),
  findAll: jest.fn(),
}));

jest.mock('../src/models/ExecutionAudit', () => ({
  create: jest.fn(),
}));

jest.mock('../src/services/symbolResolver', () => ({
  getStatusReport: jest.fn(),
  getResolution: jest.fn(),
  clear: jest.fn(),
  discoverAll: jest.fn(),
}));

jest.mock('../src/config/db', () => ({
  positionsDb: {
    insert: jest.fn(),
  },
  tradesDb: {
    insert: jest.fn(),
  },
}));

const tradingController = require('../src/controllers/tradingController');
const mt5Service = require('../src/services/mt5Service');
const riskManager = require('../src/services/riskManager');
const strategyEngine = require('../src/services/strategyEngine');
const websocketService = require('../src/services/websocketService');
const notificationService = require('../src/services/notificationService');
const positionMonitor = require('../src/services/positionMonitor');
const {
  buildSignalScanBucketStatus,
  listActiveAssignments,
} = require('../src/services/assignmentRuntimeService');
const Strategy = require('../src/models/Strategy');
const ExecutionAudit = require('../src/models/ExecutionAudit');
const { positionsDb, tradesDb } = require('../src/config/db');
const originalTradingEnabled = process.env.TRADING_ENABLED;

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

describe('tradingController.testOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mt5Service.isConnected.mockReturnValue(true);
    mt5Service.getAccountInfo.mockResolvedValue({
      login: '123456',
      server: 'Broker-Demo',
      tradeModeName: 'REAL',
      tradeAllowed: true,
      balance: 10000,
      equity: 10000,
    });
    mt5Service.getAccountModeName.mockImplementation((account) => account?.tradeModeName || 'UNKNOWN');
    mt5Service.ensureLiveTradingAllowed.mockImplementation(() => {});
    mt5Service.ensurePaperTradingAccount.mockImplementation(() => {});
    mt5Service.getPrice.mockResolvedValue({ ask: 1.1005, bid: 1.1003 });
    mt5Service.getCandles.mockResolvedValue([]);
    mt5Service.preflightOrder.mockResolvedValue({
      allowed: true,
      comment: 'Done',
      retcode: 10009,
      retcodeName: 'DONE',
    });
    mt5Service.isOrderAllowed.mockReturnValue(true);
    mt5Service.getPreflightMessage.mockReturnValue('Done');
    mt5Service.placeOrder.mockResolvedValue({
      positionId: '7001',
      orderId: '5001',
      dealId: '9001',
      price: 1.1007,
      entryDeal: {
        id: '9001',
        price: 1.10072,
        time: '2026-04-20T10:00:00.000Z',
        comment: 'QM|ManualDebug|BUY|1.00',
        commission: -1.2,
        swap: 0,
        fee: -0.3,
      },
    });

    positionsDb.insert.mockImplementation(async (doc) => ({ _id: 'pos-1', ...doc }));
    tradesDb.insert.mockImplementation(async (doc) => ({ _id: 'trade-1', ...doc }));
    ExecutionAudit.create.mockResolvedValue({ _id: 'audit-1' });
    notificationService.notifyTradeOpened.mockResolvedValue();
  });

  test('opens a manual debug order with custom lot size and stores it locally', async () => {
    const req = {
      body: {
        symbol: 'EURUSD',
        type: 'BUY',
        volume: 0.12,
        autoClose: false,
      },
    };
    const res = createRes();

    await tradingController.testOrder(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual(expect.objectContaining({
      success: true,
      message: 'Debug order opened: BUY 0.12 EURUSD',
    }));
    expect(riskManager.validateTrade).not.toHaveBeenCalled();
    expect(mt5Service.preflightOrder).toHaveBeenCalledWith(
      'EURUSD',
      'BUY',
      0.12,
      expect.any(Number),
      expect.any(Number),
      expect.any(String)
    );
    expect(positionsDb.insert).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'EURUSD',
      type: 'BUY',
      lotSize: 0.12,
      originalLotSize: 0.12,
      mt5PositionId: '7001',
      strategy: 'ManualDebug',
      status: 'OPEN',
    }));
    expect(tradesDb.insert).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'EURUSD',
      lotSize: 0.12,
      mt5PositionId: '7001',
      status: 'OPEN',
    }));
    expect(notificationService.notifyTradeOpened).toHaveBeenCalled();
    expect(websocketService.broadcast).toHaveBeenCalled();
    expect(ExecutionAudit.create).toHaveBeenCalled();
  });

  test('allows debug orders on demo accounts without the live trading lock', async () => {
    mt5Service.getAccountInfo.mockResolvedValue({
      login: '222222',
      server: 'Broker-Demo',
      tradeModeName: 'DEMO',
      isDemo: true,
      tradeAllowed: true,
      balance: 10000,
      equity: 10000,
    });

    const req = {
      body: {
        symbol: 'XAUUSD',
        type: 'SELL',
        volume: 0.01,
        autoClose: false,
      },
    };
    const res = createRes();

    await tradingController.testOrder(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual(expect.objectContaining({
      success: true,
      message: 'Debug order opened: SELL 0.01 XAUUSD',
      data: expect.objectContaining({
        accountMode: 'DEMO',
        executionScope: 'paper',
      }),
    }));
    expect(mt5Service.ensurePaperTradingAccount).toHaveBeenCalled();
    expect(mt5Service.ensureLiveTradingAllowed).not.toHaveBeenCalled();
  });

  test('rejects a manual lot size below the symbol minimum', async () => {
    const req = {
      body: {
        symbol: 'US30',
        type: 'BUY',
        volume: 0.001,
        autoClose: false,
      },
    };
    const res = createRes();

    await tradingController.testOrder(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual(expect.objectContaining({
      success: false,
      message: 'Lot size must be at least 0.01 for US30.',
    }));
    expect(mt5Service.preflightOrder).not.toHaveBeenCalled();
    expect(mt5Service.placeOrder).not.toHaveBeenCalled();
    expect(positionsDb.insert).not.toHaveBeenCalled();
  });
});

describe('tradingController.getStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    process.env.TRADING_ENABLED = 'true';
    mt5Service.isConnected.mockReturnValue(true);
    mt5Service.getAccountInfo.mockResolvedValue({
      login: '123456',
      server: 'Broker-Demo',
      tradeModeName: 'DEMO',
      tradeAllowed: true,
    });
    mt5Service.getAccountModeName.mockReturnValue('DEMO');
    riskManager.getRiskStatus.mockResolvedValue({
      balance: 10000,
      equity: 9950,
      openPositions: 2,
    });
    websocketService.getClientCount.mockReturnValue(3);
    positionMonitor.getStatus.mockReturnValue({
      running: true,
      lightCadenceMs: 15000,
      heavyCadenceMs: 60000,
    });
    strategyEngine.getStrategiesInfo.mockReturnValue([]);
    strategyEngine.getRecentSignals.mockReturnValue([{ symbol: 'XAUUSD', strategy: 'TrendFollowing' }]);
    buildSignalScanBucketStatus.mockReturnValue([{ cadenceMs: 15000, items: [] }]);
    listActiveAssignments.mockResolvedValue([
      { symbol: 'XAUUSD', strategyType: 'TrendFollowing' },
      { symbol: 'EURUSD', strategyType: 'Momentum' },
    ]);
    Strategy.initDefaults.mockResolvedValue();
    Strategy.findAll.mockResolvedValue([
      { enabled: true, symbols: ['XAUUSD', 'XAUUSD', 'EURUSD'] },
      { enabled: false, symbols: ['BTCUSD'] },
      { enabled: true, symbols: null },
    ]);
  });

  afterEach(() => {
    if (originalTradingEnabled === undefined) {
      delete process.env.TRADING_ENABLED;
    } else {
      process.env.TRADING_ENABLED = originalTradingEnabled;
    }
  });

  test('returns websocket client count in trading status payload', async () => {
    const res = createRes();

    await tradingController.getStatus({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        wsClients: 3,
        tradingEnabled: true,
        activeAssignments: 2,
        activeSymbols: 2,
        signalScanBuckets: [{ cadenceMs: 15000, items: [] }],
        scanBuckets: [{ cadenceMs: 15000, items: [] }],
        positionMonitor: expect.objectContaining({ running: true, lightCadenceMs: 15000, heavyCadenceMs: 60000 }),
        monitor: expect.objectContaining({ running: true }),
        recentSignals: [{ symbol: 'XAUUSD', strategy: 'TrendFollowing' }],
      }),
    }));
    expect(websocketService.getClientCount).toHaveBeenCalled();
    expect(riskManager.getRiskStatus).toHaveBeenCalled();
  });
});
