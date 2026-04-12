jest.mock('../src/config/db', () => ({
  positionsDb: {
    insert: jest.fn(),
    update: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
  },
  tradesDb: {
    insert: jest.fn(),
    update: jest.fn(),
    find: jest.fn(),
  },
  paperPositionsDb: {
    insert: jest.fn(),
    update: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
  },
  tradeLogDb: {
    insert: jest.fn(),
    update: jest.fn(),
    find: jest.fn(),
  },
  riskStateDb: {
    findOne: jest.fn(),
    update: jest.fn(),
  },
  executionAuditDb: {
    insert: jest.fn(),
    find: jest.fn(),
  },
}));

jest.mock('../src/services/mt5Service', () => ({
  getAccountInfo: jest.fn(),
  getAccountModeName: jest.fn(),
  ensureLiveTradingAllowed: jest.fn(),
  ensurePaperTradingAccount: jest.fn(),
  getPrice: jest.fn(),
  isOrderAllowed: jest.fn(),
  getPreflightMessage: jest.fn(),
  preflightOrder: jest.fn(),
  placeOrder: jest.fn(),
  closePosition: jest.fn(),
  getPositionDealSummary: jest.fn(),
  getPositions: jest.fn(),
  isConnected: jest.fn(),
}));

jest.mock('../src/services/riskManager', () => ({
  validateTrade: jest.fn(),
  recordLoss: jest.fn(),
  syncAccountState: jest.fn(),
}));

jest.mock('../src/services/websocketService', () => ({
  broadcast: jest.fn(),
}));

jest.mock('../src/services/notificationService', () => ({
  notifyTradeOpened: jest.fn(),
  notifyTradeClosed: jest.fn(),
}));

const { positionsDb, tradesDb, executionAuditDb } = require('../src/config/db');
const mt5Service = require('../src/services/mt5Service');
const riskManager = require('../src/services/riskManager');
const websocketService = require('../src/services/websocketService');
const notificationService = require('../src/services/notificationService');
const tradeExecutor = require('../src/services/tradeExecutor');
const positionMonitor = require('../src/services/positionMonitor');

describe('MT5 mock integration flows', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    positionsDb.insert.mockResolvedValue({ _id: 'pos-db-1' });
    positionsDb.update.mockResolvedValue(1);
    positionsDb.findOne.mockResolvedValue(null);
    positionsDb.remove.mockResolvedValue(1);
    positionsDb.find.mockResolvedValue([]);
    positionsDb.count.mockResolvedValue(0);

    tradesDb.insert.mockResolvedValue({ _id: 'trade-db-1' });
    tradesDb.update.mockResolvedValue(1);
    tradesDb.find.mockResolvedValue([]);
    executionAuditDb.insert.mockImplementation(async (event) => ({ _id: `audit-${Date.now()}`, ...event }));
    executionAuditDb.find.mockResolvedValue([]);

    mt5Service.getAccountInfo.mockResolvedValue({
      balance: 10000,
      equity: 10000,
      isReal: true,
      tradeAllowed: true,
      tradeModeName: 'REAL',
    });
    mt5Service.getAccountModeName.mockImplementation((accountInfo = {}) => accountInfo.tradeModeName || 'UNKNOWN');
    mt5Service.ensureLiveTradingAllowed.mockImplementation(() => {});
    mt5Service.getPrice.mockResolvedValue({ ask: 1.1005, bid: 1.1003 });
    mt5Service.isOrderAllowed.mockImplementation((preflight = {}) => preflight.allowed === true);
    mt5Service.getPreflightMessage.mockImplementation((preflight = {}) => preflight.comment || 'MT5 order preflight rejected');
    mt5Service.preflightOrder.mockResolvedValue({
      allowed: true,
      retcode: 10009,
      retcodeName: 'DONE',
      comment: 'Done',
    });
    mt5Service.placeOrder.mockResolvedValue({
      positionId: '7001',
      orderId: '5001',
      dealId: '9001',
      price: 1.1007,
      entryDeal: {
        id: '9001',
        price: 1.10072,
        time: '2026-04-12T01:02:03.000Z',
        comment: 'QM|TrendFollowing|BUY|0.88',
        commission: -1.25,
        swap: 0,
        fee: -0.35,
      },
    });
    mt5Service.closePosition.mockResolvedValue({
      positionId: '7001',
      orderId: '5002',
      dealId: '9002',
      price: 1.1055,
      closeDeal: {
        id: '9002',
        price: 1.1055,
      },
    });
    mt5Service.getPositionDealSummary.mockResolvedValue(null);
    mt5Service.getPositions.mockResolvedValue([]);
    mt5Service.isConnected.mockReturnValue(true);

    riskManager.validateTrade.mockResolvedValue({
      allowed: true,
      reason: 'All risk checks passed',
      lotSize: 0.2,
    });
    riskManager.recordLoss.mockResolvedValue();
    riskManager.syncAccountState.mockResolvedValue({
      peakBalance: 10000,
      todayLoss: 0,
    });

    websocketService.broadcast.mockImplementation(() => {});
    notificationService.notifyTradeOpened.mockResolvedValue();
    notificationService.notifyTradeClosed.mockResolvedValue();
  });

  test('uses the broker fill price and entry deal metadata when opening a trade', async () => {
    const signal = {
      symbol: 'EURUSD',
      signal: 'BUY',
      confidence: 0.88,
      sl: 1.095,
      tp: 1.11,
      reason: 'Trend breakout',
      indicatorsSnapshot: { atr: 0.0021 },
      strategy: 'TrendFollowing',
    };

    const result = await tradeExecutor.executeTrade(signal);

    expect(result.success).toBe(true);
    expect(mt5Service.ensureLiveTradingAllowed).toHaveBeenCalled();
    expect(positionsDb.insert).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'EURUSD',
      entryPrice: 1.10072,
      mt5PositionId: '7001',
      mt5EntryDealId: '9001',
      mt5Comment: 'QM|TrendFollowing|BUY|0.88',
      comment: expect.stringContaining('Strategy=TrendFollowing'),
      openedAt: new Date('2026-04-12T01:02:03.000Z'),
    }));
    expect(tradesDb.insert).toHaveBeenCalledWith(expect.objectContaining({
      entryPrice: 1.10072,
      commission: -1.25,
      fee: -0.35,
      swap: 0,
      mt5PositionId: '7001',
      mt5EntryDealId: '9001',
      mt5Comment: 'QM|TrendFollowing|BUY|0.88',
      comment: expect.stringContaining('Reason=Trend breakout'),
    }));
  });

  test('reconciles close data from broker deals instead of current quote guesses', async () => {
    positionsDb.findOne.mockResolvedValue({
      _id: 'pos-db-1',
      symbol: 'EURUSD',
      type: 'BUY',
      entryPrice: 1.10072,
      lotSize: 0.2,
      mt5PositionId: '7001',
      strategy: 'TrendFollowing',
      openedAt: '2026-04-12T01:02:03.000Z',
    });
    mt5Service.getPositionDealSummary.mockResolvedValue({
      entryPrice: 1.10072,
      exitPrice: 1.1055,
      exitTime: '2026-04-12T04:05:06.000Z',
      exitReason: 'TP',
      commission: -1.6,
      swap: -0.1,
      fee: -0.2,
      realizedProfit: 223.1,
      exitDeals: [{ id: '9002' }],
      lastExitDeal: { id: '9002' },
    });

    const result = await tradeExecutor.closePosition('pos-db-1', 'MANUAL');

    expect(result.success).toBe(true);
    expect(mt5Service.getPositionDealSummary).toHaveBeenCalledWith(
      '7001',
      expect.any(Date),
      expect.any(Date)
    );
    expect(tradesDb.update).toHaveBeenCalledWith(
      { positionDbId: 'pos-db-1' },
      {
        $set: expect.objectContaining({
          exitPrice: 1.1055,
          exitReason: 'TP_HIT',
          profitLoss: 223.1,
          commission: -1.6,
          swap: -0.1,
          fee: -0.2,
          mt5CloseDealId: '9002',
        }),
      }
    );
    expect(riskManager.recordLoss).not.toHaveBeenCalled();
  });

  test('attributes external closes to SL_HIT from broker deal reason and records the realized loss', async () => {
    mt5Service.getPositionDealSummary.mockResolvedValue({
      entryPrice: 1.1,
      exitPrice: 1.098,
      exitTime: '2026-04-12T05:06:07.000Z',
      exitReason: 'SL',
      commission: -1.1,
      swap: 0,
      fee: -0.2,
      realizedProfit: -95.5,
      exitDeals: [{ id: '9003' }],
      lastExitDeal: { id: '9003' },
    });

    await positionMonitor._handleExternalClose({
      _id: 'pos-db-2',
      symbol: 'EURUSD',
      type: 'BUY',
      entryPrice: 1.1,
      lotSize: 0.1,
      mt5PositionId: '7002',
      strategy: 'TrendFollowing',
      openedAt: '2026-04-12T02:00:00.000Z',
    });

    expect(tradesDb.update).toHaveBeenCalledWith(
      { positionDbId: 'pos-db-2' },
      {
        $set: expect.objectContaining({
          exitReason: 'SL_HIT',
          profitLoss: -95.5,
          commission: -1.1,
          fee: -0.2,
          mt5CloseDealId: '9003',
        }),
      }
    );
    expect(riskManager.recordLoss).toHaveBeenCalledWith(
      95.5,
      new Date('2026-04-12T05:06:07.000Z')
    );
    expect(positionsDb.remove).toHaveBeenCalledWith({ _id: 'pos-db-2' });
  });

  test('blocks market-closed orders at preflight and records an execution audit entry', async () => {
    mt5Service.preflightOrder.mockResolvedValue({
      allowed: false,
      retcode: 10018,
      retcodeName: 'MARKET_CLOSED',
      comment: 'Market closed',
      symbolInfo: {
        tradeModeName: 'FULL',
      },
    });

    const result = await tradeExecutor.executeTrade({
      symbol: 'EURUSD',
      signal: 'BUY',
      confidence: 0.6,
      sl: 1.095,
      tp: 1.11,
      reason: 'Session test',
      indicatorsSnapshot: { atr: 0.002 },
      strategy: 'TrendFollowing',
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe('Market closed');
    expect(mt5Service.placeOrder).not.toHaveBeenCalled();
    expect(executionAuditDb.insert).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'live',
      stage: 'preflight',
      status: 'BLOCKED',
      code: 10018,
      codeName: 'MARKET_CLOSED',
      message: 'Market closed',
    }));
    expect(websocketService.broadcast).toHaveBeenCalledWith(
      'signals',
      'trade_rejected',
      expect.objectContaining({
        symbol: 'EURUSD',
        stage: 'preflight',
        code: 10018,
        codeName: 'MARKET_CLOSED',
      })
    );
  });
});
