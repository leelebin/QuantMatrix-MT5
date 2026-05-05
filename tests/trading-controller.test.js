jest.mock('../src/services/mt5Service', () => ({
  isConnected: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(),
  getAccountInfo: jest.fn(),
  reloadConnectionEnvFromFile: jest.fn(),
  getPublicConnectionConfig: jest.fn(),
  getAccountConfigMatch: jest.fn(),
  ensureLiveTradingAllowed: jest.fn(),
  ensureLiveAccountReady: jest.fn(),
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

jest.mock('../src/services/liveTradingPermissionService', () => ({
  isAllowLiveTradingEnabled: jest.fn(),
  setAllowLiveTrading: jest.fn(),
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
const liveTradingPermissionService = require('../src/services/liveTradingPermissionService');
const positionMonitor = require('../src/services/positionMonitor');
const {
  buildSignalScanBucketStatus,
  listActiveAssignments,
} = require('../src/services/assignmentRuntimeService');
const Strategy = require('../src/models/Strategy');
const ExecutionAudit = require('../src/models/ExecutionAudit');
const { positionsDb, tradesDb } = require('../src/config/db');
const originalTradingEnabled = process.env.TRADING_ENABLED;
const originalAllowLiveTrading = process.env.ALLOW_LIVE_TRADING;

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

describe('tradingController.startTrading', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mt5Service.isConnected.mockReturnValue(true);
    mt5Service.connect.mockResolvedValue(true);
    mt5Service.disconnect.mockResolvedValue();
    mt5Service.reloadConnectionEnvFromFile.mockReturnValue({});
    mt5Service.getPublicConnectionConfig.mockReturnValue({
      scope: 'live',
      login: '123456',
      server: 'Broker-Real',
      pathConfigured: false,
      usesLegacy: false,
      env: {},
    });
    mt5Service.getAccountConfigMatch.mockReturnValue({
      matches: true,
      loginMatches: true,
      serverMatches: true,
      expected: { login: '123456', server: 'Broker-Real' },
      actual: { login: '123456', server: 'Broker-Real' },
    });
    mt5Service.getAccountInfo.mockResolvedValue({
      login: '123456',
      server: 'Broker-Real',
      tradeModeName: 'REAL',
      tradeAllowed: true,
      balance: 10000,
      equity: 10000,
      currency: 'USD',
    });
    mt5Service.getAccountModeName.mockReturnValue('REAL');
    mt5Service.ensureLiveAccountReady.mockImplementation(() => {});
    mt5Service.ensureLiveTradingAllowed.mockImplementation(() => {});
    liveTradingPermissionService.setAllowLiveTrading.mockResolvedValue({
      enabled: true,
      persisted: true,
      path: '.env',
    });
    liveTradingPermissionService.isAllowLiveTradingEnabled.mockReturnValue(true);
    strategyEngine.getStrategiesInfo.mockReturnValue([]);
    Strategy.initDefaults.mockResolvedValue();
    listActiveAssignments.mockResolvedValue([
      { symbol: 'XAUUSD', strategyType: 'TrendFollowing' },
    ]);
    buildSignalScanBucketStatus.mockReturnValue([{ cadenceMs: 60000, items: [] }]);
    positionMonitor.getStatus.mockReturnValue({ running: true });
  });

  afterEach(() => {
    if (originalTradingEnabled === undefined) {
      delete process.env.TRADING_ENABLED;
    } else {
      process.env.TRADING_ENABLED = originalTradingEnabled;
    }

    if (originalAllowLiveTrading === undefined) {
      delete process.env.ALLOW_LIVE_TRADING;
    } else {
      process.env.ALLOW_LIVE_TRADING = originalAllowLiveTrading;
    }
  });

  test('enables and persists live trading permission when start is explicitly confirmed', async () => {
    const req = {
      body: {
        allowLiveTrading: true,
        persistAllowLiveTrading: true,
      },
    };
    const res = createRes();

    await tradingController.startTrading(req, res);

    expect(res.statusCode).toBe(200);
    expect(mt5Service.ensureLiveAccountReady).toHaveBeenCalledWith(expect.objectContaining({
      tradeModeName: 'REAL',
      tradeAllowed: true,
    }));
    expect(liveTradingPermissionService.setAllowLiveTrading).toHaveBeenCalledWith(true, { persist: true });
    expect(mt5Service.ensureLiveTradingAllowed).toHaveBeenCalledWith(expect.objectContaining({
      tradeModeName: 'REAL',
    }));
    expect(process.env.TRADING_ENABLED).toBe('true');
    expect(res.payload).toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        liveTradingAllowed: true,
        allowLiveTradingPersisted: true,
        activeAssignments: 1,
      }),
    }));
  });

  test('does not change live trading permission without explicit confirmation', async () => {
    const res = createRes();

    await tradingController.startTrading({ body: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(liveTradingPermissionService.setAllowLiveTrading).not.toHaveBeenCalled();
    expect(mt5Service.ensureLiveAccountReady).not.toHaveBeenCalled();
    expect(mt5Service.ensureLiveTradingAllowed).toHaveBeenCalled();
  });

  test('does not persist live trading permission when the account is not ready for live trading', async () => {
    mt5Service.ensureLiveAccountReady.mockImplementation(() => {
      throw new Error('Live trading requires a REAL MT5 account. Current account mode: DEMO.');
    });

    const res = createRes();

    await tradingController.startTrading({ body: { allowLiveTrading: true } }, res);

    expect(res.statusCode).toBe(500);
    expect(res.payload).toEqual(expect.objectContaining({
      success: false,
      message: expect.stringContaining('REAL MT5 account'),
    }));
    expect(liveTradingPermissionService.setAllowLiveTrading).not.toHaveBeenCalled();
    expect(mt5Service.ensureLiveTradingAllowed).not.toHaveBeenCalled();
  });

  test('returns actionable diagnostics when live MT5 connect times out', async () => {
    const timeoutError = new Error('MT5 live connect timed out after 30s while connecting 44938841@Elev8-Real2.');
    timeoutError.code = 'MT5_CONNECT_TIMEOUT';
    timeoutError.method = 'connect';
    timeoutError.details = {
      scope: 'live',
      expectedAccount: {
        login: '44938841',
        server: 'Elev8-Real2',
      },
      config: {
        login: '44938841',
        server: 'Elev8-Real2',
        pathConfigured: false,
        path: null,
        usesLegacy: false,
        env: {
          login: 'MT5_LIVE_LOGIN',
          server: 'MT5_LIVE_SERVER',
          path: 'MT5_LIVE_PATH',
        },
      },
      peer: {
        scope: 'paper',
        connected: true,
        login: '230044684',
        server: 'Elev8-Demo2',
      },
      likelyReasons: [
        'MT5_LIVE_PATH is not configured, so MetaTrader5 may attach to the already-open/default terminal instead of the live terminal.',
      ],
    };
    mt5Service.isConnected.mockReturnValue(false);
    mt5Service.connect.mockRejectedValue(timeoutError);
    mt5Service.getPublicConnectionConfig.mockReturnValue({
      scope: 'live',
      login: '44938841',
      server: 'Elev8-Real2',
      pathConfigured: false,
      usesLegacy: false,
      env: {
        login: 'MT5_LIVE_LOGIN',
        server: 'MT5_LIVE_SERVER',
        path: 'MT5_LIVE_PATH',
      },
    });

    const res = createRes();

    await tradingController.startTrading({
      body: {
        allowLiveTrading: true,
        persistAllowLiveTrading: true,
      },
    }, res);

    expect(res.statusCode).toBe(500);
    expect(res.payload).toEqual(expect.objectContaining({
      success: false,
      message: expect.stringContaining('Live MT5 connection timed out'),
      data: expect.objectContaining({
        errorCode: 'MT5_CONNECT_TIMEOUT',
        method: 'connect',
        diagnostics: expect.objectContaining({
          config: expect.objectContaining({
            login: '44938841',
            server: 'Elev8-Real2',
            pathConfigured: false,
          }),
        }),
        nextSteps: expect.arrayContaining([
          expect.stringContaining('MT5_LIVE_PATH'),
          expect.stringContaining('separate terminal installs'),
        ]),
      }),
    }));
    expect(liveTradingPermissionService.setAllowLiveTrading).not.toHaveBeenCalled();
  });

  test('reconnects live MT5 when an existing connection points to a different account', async () => {
    mt5Service.isConnected
      .mockReturnValueOnce(true)
      .mockReturnValue(true);
    mt5Service.getAccountInfo
      .mockResolvedValueOnce({
        login: '230044684',
        server: 'Elev8-Demo2',
        tradeModeName: 'DEMO',
        tradeAllowed: true,
      })
      .mockResolvedValueOnce({
        login: '44938841',
        server: 'Elev8-Real2',
        tradeModeName: 'REAL',
        tradeAllowed: true,
        balance: 10000,
        equity: 10000,
        currency: 'USD',
      });
    mt5Service.getAccountConfigMatch
      .mockReturnValueOnce({
        matches: false,
        loginMatches: false,
        serverMatches: false,
        expected: { login: '44938841', server: 'Elev8-Real2' },
        actual: { login: '230044684', server: 'Elev8-Demo2' },
      })
      .mockReturnValue({
        matches: true,
        loginMatches: true,
        serverMatches: true,
        expected: { login: '44938841', server: 'Elev8-Real2' },
        actual: { login: '44938841', server: 'Elev8-Real2' },
      });
    mt5Service.getPublicConnectionConfig.mockReturnValue({
      scope: 'live',
      login: '44938841',
      server: 'Elev8-Real2',
      pathConfigured: true,
      usesLegacy: false,
      env: {},
    });

    const res = createRes();

    await tradingController.startTrading({
      body: {
        allowLiveTrading: true,
        persistAllowLiveTrading: true,
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(mt5Service.disconnect).toHaveBeenCalled();
    expect(mt5Service.connect).toHaveBeenCalled();
    expect(liveTradingPermissionService.setAllowLiveTrading).toHaveBeenCalledWith(true, { persist: true });
    expect(res.payload.data.reconnected).toBe(true);
    expect(res.payload.data.account.mode).toBe('REAL');
  });
});

describe('tradingController.getStatus', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    process.env.TRADING_ENABLED = 'true';
    mt5Service.isConnected.mockReturnValue(true);
    mt5Service.reloadConnectionEnvFromFile.mockReturnValue({});
    mt5Service.getPublicConnectionConfig.mockReturnValue({
      scope: 'live',
      login: '123456',
      server: 'Broker-Demo',
      pathConfigured: false,
      usesLegacy: false,
      env: {},
    });
    mt5Service.getAccountConfigMatch.mockReturnValue({
      matches: true,
      loginMatches: true,
      serverMatches: true,
      expected: { login: '123456', server: 'Broker-Demo' },
      actual: { login: '123456', server: 'Broker-Demo' },
    });
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
    expect(listActiveAssignments).toHaveBeenCalledWith({ activeProfile: null, scope: 'live' });
  });
});
