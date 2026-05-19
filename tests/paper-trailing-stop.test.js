jest.mock('../src/config/db', () => ({
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
  executionAuditDb: {
    insert: jest.fn(),
    find: jest.fn(),
  },
  riskProfilesDb: {
    find: jest.fn(),
    findOne: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    count: jest.fn(),
  },
  strategiesDb: {
    find: jest.fn(),
    findOne: jest.fn(),
    insert: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
  },
}));

jest.mock('../src/services/mt5Service', () => ({
  getPrice: jest.fn(),
  getCandles: jest.fn(),
  modifyPosition: jest.fn(),
  partialClosePosition: jest.fn(),
  closePosition: jest.fn(),
  getPositions: jest.fn(),
  getPositionDealSummary: jest.fn(),
  getAccountInfo: jest.fn(),
  getAccountModeName: jest.fn(),
  ensurePaperTradingAccount: jest.fn(),
  isConnected: jest.fn(),
  placeOrder: jest.fn(),
  preflightOrder: jest.fn(),
  isOrderAllowed: jest.fn(),
  getPreflightMessage: jest.fn(),
}));

jest.mock('../src/services/websocketService', () => ({
  broadcast: jest.fn(),
}));

jest.mock('../src/services/economicCalendarService', () => ({
  ensureCalendar: jest.fn(),
  isInBlackout: jest.fn(),
}));

jest.mock('../src/services/notificationService', () => ({
  notifyTradeOpened: jest.fn(),
  notifyTradeClosed: jest.fn(),
  notifySystem: jest.fn(),
}));

jest.mock('../src/services/riskManager', () => ({
  validateTrade: jest.fn(),
  recordLoss: jest.fn(),
  syncAccountState: jest.fn(),
}));

jest.mock('../src/services/strategyInstanceService', () => ({
  getStrategyInstance: jest.fn(),
}));

jest.mock('../src/services/strategyEngine', () => ({
  strategies: {
    Breakout: {
      evaluateExit: jest.fn(),
    },
  },
  getStrategiesInfo: jest.fn(),
  analyzeAll: jest.fn(),
}));

jest.mock('../src/models/TradeLog', () => ({
  logOpen: jest.fn(),
  logClose: jest.fn(),
  formatHoldingTime: jest.fn(() => '1h'),
}));

const { paperPositionsDb } = require('../src/config/db');
const mt5Service = require('../src/services/mt5Service');
const websocketService = require('../src/services/websocketService');
const economicCalendarService = require('../src/services/economicCalendarService');
const strategyEngine = require('../src/services/strategyEngine');
const { getStrategyInstance } = require('../src/services/strategyInstanceService');
const paperTradingService = require('../src/services/paperTradingService');

function buildCandles(count = 80, start = 1.1, step = 0.0002) {
  return Array.from({ length: count }, (_, index) => {
    const close = start + (index * step);
    return {
      time: new Date(Date.UTC(2026, 0, 1, index, 0, 0)).toISOString(),
      open: close - 0.0003,
      high: close + 0.0005,
      low: close - 0.0005,
      close,
      tickVolume: 100 + index,
      spread: 12,
      volume: 100 + index,
    };
  });
}

function buildExitPlan(overrides = {}) {
  return {
    breakeven: {
      enabled: true,
      triggerAtrMultiple: 0.8,
      includeSpreadCompensation: false,
      extraBufferPips: 0,
    },
    trailing: {
      enabled: false,
      startAtrMultiple: 1.5,
      distanceAtrMultiple: 1.0,
      mode: 'atr',
    },
    partials: [],
    timeExit: null,
    adaptiveEvaluator: null,
    ...overrides,
  };
}

describe('paperTradingService trailing-stop runtime', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mt5Service.isConnected.mockReturnValue(true);
    mt5Service.getPrice.mockResolvedValue({ bid: 1.1025, ask: 1.1027 });
    mt5Service.getCandles.mockResolvedValue(buildCandles());
    mt5Service.modifyPosition.mockResolvedValue(true);
    mt5Service.partialClosePosition.mockResolvedValue({ success: true });
    economicCalendarService.ensureCalendar.mockResolvedValue([]);
    economicCalendarService.isInBlackout.mockReturnValue({ blocked: false });
    getStrategyInstance.mockResolvedValue({
      enabled: true,
      source: 'default',
      parameters: {},
      newsBlackout: { enabled: true, beforeMinutes: 40, afterMinutes: 20, impactLevels: ['High'] },
    });
  });

  test('_runTrailingStops applies adaptive exits, partial closes, and state writeback', async () => {
    const position = {
      _id: 'paper-1',
      symbol: 'EURUSD',
      type: 'BUY',
      entryPrice: 1.1,
      currentSl: 1.099,
      currentTp: 1.11,
      lotSize: 0.5,
      originalLotSize: 0.5,
      mt5PositionId: '7001',
      strategy: 'Breakout',
      atrAtEntry: 0.001,
      exitPlan: buildExitPlan({
        partials: [{ atProfitAtr: 1.0, closeFraction: 0.4, label: 'tp1' }],
        adaptiveEvaluator: 'Breakout',
      }),
      partialsExecutedIndices: [],
      maxFavourablePrice: 1.1,
      openedAt: '2026-04-12T02:00:00.000Z',
    };

    strategyEngine.strategies.Breakout.evaluateExit.mockReturnValue({
      trailing: {
        enabled: true,
        startAtrMultiple: 1.0,
        distanceAtrMultiple: 0.5,
        mode: 'atr',
      },
    });

    paperPositionsDb.find
      .mockResolvedValueOnce([position])
      .mockResolvedValueOnce([{ ...position, lotSize: 0.3, partialsExecutedIndices: [0] }]);
    paperPositionsDb.update.mockResolvedValue(1);

    await paperTradingService._runTrailingStops();

    expect(strategyEngine.strategies.Breakout.evaluateExit).toHaveBeenCalled();
    expect(mt5Service.partialClosePosition).toHaveBeenCalledWith('7001', 0.2);
    expect(mt5Service.modifyPosition).toHaveBeenCalledWith('7001', expect.any(Number), 1.11);
    expect(paperPositionsDb.update).toHaveBeenCalledWith(
      { _id: 'paper-1' },
      {
        $set: expect.objectContaining({
          partialsExecutedIndices: [0],
          lotSize: 0.3,
        }),
      }
    );
    expect(paperPositionsDb.update).toHaveBeenCalledWith(
      { _id: 'paper-1' },
      {
        $set: expect.objectContaining({
          currentSl: expect.any(Number),
        }),
      }
    );
    expect(websocketService.broadcast).toHaveBeenCalledWith(
      'positions',
      'paper_positions_sync',
      expect.any(Array)
    );
  });

  test('_runTrailingStops closes expired paper positions through the local close flow', async () => {
    const position = {
      _id: 'paper-2',
      symbol: 'EURUSD',
      type: 'BUY',
      entryPrice: 1.1,
      currentSl: 1.099,
      currentTp: 1.11,
      lotSize: 0.2,
      originalLotSize: 0.2,
      mt5PositionId: '7002',
      strategy: null,
      atrAtEntry: 0.001,
      exitPlan: buildExitPlan({
        timeExit: { maxHoldMinutes: 5, reason: 'TEST_TIMEOUT' },
      }),
      partialsExecutedIndices: [],
      maxFavourablePrice: 1.1,
      openedAt: '2026-04-12T00:00:00.000Z',
    };

    const closeSpy = jest.spyOn(paperTradingService, 'closePosition').mockResolvedValue({ success: true });
    paperPositionsDb.find
      .mockResolvedValueOnce([position])
      .mockResolvedValueOnce([]);
    paperPositionsDb.update.mockResolvedValue(1);

    await paperTradingService._runTrailingStops();

    expect(closeSpy).toHaveBeenCalledWith('paper-2', 'TEST_TIMEOUT');
    expect(websocketService.broadcast).toHaveBeenCalledWith(
      'positions',
      'paper_positions_sync',
      []
    );
  });

  test('_buildPositionContexts prioritizes news > just opened > protected and only treats partials as protected after non-negative stop', async () => {
    const now = new Date('2026-04-24T00:10:00.000Z');
    economicCalendarService.isInBlackout.mockImplementation((symbol) => ({
      blocked: symbol === 'XAUUSD',
      event: symbol === 'XAUUSD'
        ? { title: 'US GDP', impact: 'High', currency: 'USD', time: '2026-04-24T00:30:00.000Z' }
        : null,
    }));

    const contexts = await paperTradingService._buildPositionContexts([
      {
        _id: 'p-news',
        symbol: 'XAUUSD',
        strategy: 'Breakout',
        type: 'BUY',
        entryPrice: 3300,
        currentSl: 3295,
        openedAt: '2026-04-24T00:08:00.000Z',
      },
      {
        _id: 'p-open',
        symbol: 'EURUSD',
        strategy: 'Breakout',
        type: 'BUY',
        entryPrice: 1.1,
        currentSl: 1.1002,
        openedAt: '2026-04-24T00:08:30.000Z',
        partialsExecutedIndices: [0],
        exitPlan: buildExitPlan({
          breakeven: {
            enabled: true,
            triggerAtrMultiple: 0.8,
            includeSpreadCompensation: false,
            extraBufferPips: 0,
          },
        }),
      },
      {
        _id: 'p-partial-negative',
        symbol: 'EURUSD',
        strategy: 'Breakout',
        type: 'BUY',
        entryPrice: 1.1,
        currentSl: 1.0995,
        openedAt: '2026-04-23T23:30:00.000Z',
        partialsExecutedIndices: [0],
        exitPlan: buildExitPlan({
          breakeven: {
            enabled: true,
            triggerAtrMultiple: 0.8,
            includeSpreadCompensation: false,
            extraBufferPips: 0,
          },
        }),
      },
      {
        _id: 'p-protected',
        symbol: 'EURUSD',
        strategy: 'Breakout',
        type: 'BUY',
        entryPrice: 1.1,
        currentSl: 1.1003,
        openedAt: '2026-04-23T23:30:00.000Z',
        partialsExecutedIndices: [0],
        exitPlan: buildExitPlan({
          breakeven: {
            enabled: true,
            triggerAtrMultiple: 0.8,
            includeSpreadCompensation: false,
            extraBufferPips: 0,
          },
        }),
      },
    ], now);

    const byId = Object.fromEntries(contexts.map((context) => [context.position._id, context]));
    expect(byId['p-news']).toEqual(expect.objectContaining({
      state: 'news_fast_mode',
      scanReason: 'news_fast_mode',
      category: 'metals',
    }));
    expect(byId['p-open']).toEqual(expect.objectContaining({
      state: 'just_opened',
      scanReason: 'just_opened',
    }));
    expect(byId['p-partial-negative']).toEqual(expect.objectContaining({
      state: 'normal',
      scanReason: 'cadence',
    }));
    expect(byId['p-protected']).toEqual(expect.objectContaining({
      state: 'protected',
      scanReason: 'protected',
    }));
  });

  test('_syncPaperPositions records a non-crypto market stop once and skips stale snapshot writes', async () => {
    const now = new Date('2026-04-27T10:00:00.000Z');
    const staleTickTime = new Date(now.getTime() - (31 * 60 * 1000)).toISOString();
    const position = {
      _id: 'paper-stale',
      symbol: 'EURUSD',
      type: 'BUY',
      currentSl: 1.099,
      currentTp: 1.11,
      currentPrice: 1.1025,
      unrealizedPl: 12,
      mt5PositionId: '7003',
    };

    mt5Service.getPositions.mockResolvedValue([{
      id: '7003',
      stopLoss: 1.099,
      takeProfit: 1.11,
      currentPrice: 1.1025,
      profit: 12,
    }]);
    mt5Service.getPrice.mockResolvedValue({ bid: 1.1025, ask: 1.1027, time: staleTickTime });
    paperPositionsDb.find
      .mockResolvedValueOnce([position])
      .mockResolvedValueOnce([{ ...position, marketStop: { active: true, reason: 'STALE_TICK' } }]);
    paperPositionsDb.update.mockResolvedValue(1);

    await paperTradingService._syncPaperPositions({ broadcast: false, now });

    expect(paperPositionsDb.update).toHaveBeenCalledTimes(1);
    expect(paperPositionsDb.update).toHaveBeenCalledWith(
      { _id: 'paper-stale' },
      {
        $set: {
          marketStop: expect.objectContaining({
            active: true,
            startedAt: now,
            endedAt: null,
            reason: 'STALE_TICK',
          }),
        },
      }
    );
    expect(paperPositionsDb.update.mock.calls[0][1].$set.currentPrice).toBeUndefined();
  });

  test('_syncPaperPositions keeps just-opened paper positions when MT5 positions have not caught up yet', async () => {
    const now = new Date('2026-05-11T03:00:00.000Z');
    const position = {
      _id: 'paper-new',
      symbol: 'EURUSD',
      type: 'BUY',
      lotSize: 0.2,
      mt5PositionId: 'temporary-order-id',
      openedAt: new Date(now.getTime() - 30 * 1000),
      currentSl: 1.099,
      currentTp: 1.11,
      currentPrice: 1.1025,
    };

    mt5Service.getPositions.mockResolvedValue([]);
    paperPositionsDb.find
      .mockResolvedValueOnce([position])
      .mockResolvedValueOnce([position]);
    paperPositionsDb.remove.mockResolvedValue(1);

    await paperTradingService._syncPaperPositions({ broadcast: false, now });

    expect(paperPositionsDb.remove).not.toHaveBeenCalled();
    expect(paperPositionsDb.update).not.toHaveBeenCalled();
  });

  test('_syncPaperPositions can match a just-opened paper position by broker comment and correct mt5PositionId', async () => {
    const now = new Date('2026-05-11T03:00:30.000Z');
    const position = {
      _id: 'paper-comment-match',
      symbol: 'EURUSD',
      type: 'BUY',
      lotSize: 0.2,
      mt5PositionId: 'order-5001',
      mt5Comment: 'PT|Breakout|BUY|0.91',
      openedAt: new Date(now.getTime() - 45 * 1000),
      currentSl: 1.099,
      currentTp: 1.11,
      currentPrice: 1.1025,
      unrealizedPl: 0,
    };

    mt5Service.getPositions.mockResolvedValue([{
      id: 'position-7001',
      symbol: 'EURUSD',
      type: 'BUY',
      volume: 0.2,
      comment: 'PT|Breakout|BUY|0.91',
      stopLoss: 1.099,
      takeProfit: 1.11,
      currentPrice: 1.103,
      profit: 15,
    }]);
    mt5Service.getPrice.mockResolvedValue({ bid: 1.103, ask: 1.1032, time: now.toISOString() });
    paperPositionsDb.find
      .mockResolvedValueOnce([position])
      .mockResolvedValueOnce([{ ...position, mt5PositionId: 'position-7001', currentPrice: 1.103 }]);
    paperPositionsDb.update.mockResolvedValue(1);

    await paperTradingService._syncPaperPositions({ broadcast: false, now });

    expect(paperPositionsDb.remove).not.toHaveBeenCalled();
    expect(paperPositionsDb.update).toHaveBeenCalledWith(
      { _id: 'paper-comment-match' },
      {
        $set: expect.objectContaining({
          mt5PositionId: 'position-7001',
          mt5PositionIdCorrectionSource: 'mt5_position_match',
          currentPrice: 1.103,
          unrealizedPl: 15,
        }),
      }
    );
  });

  test('_syncPaperPositions adopts orphan MT5 paper positions with PT broker comments', async () => {
    const now = new Date('2026-05-11T03:01:00.000Z');
    const adopted = {
      _id: 'adopted-paper-pos',
      symbol: 'EURUSD',
      type: 'BUY',
      mt5PositionId: 'position-8001',
      status: 'OPEN',
    };

    mt5Service.getPositions.mockResolvedValue([{
      id: 'position-8001',
      symbol: 'EURUSD',
      type: 'BUY',
      volume: 0.2,
      comment: 'PT|Breakout|BUY|0.91',
      openPrice: 1.101,
      stopLoss: 1.099,
      takeProfit: 1.11,
      currentPrice: 1.103,
      profit: 15,
      time: Math.floor(new Date('2026-05-11T03:00:00.000Z').getTime() / 1000),
    }]);
    mt5Service.getPrice.mockResolvedValue({ bid: 1.103, ask: 1.1032, time: now.toISOString() });
    paperPositionsDb.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([adopted]);
    paperPositionsDb.insert.mockResolvedValue(adopted);
    paperPositionsDb.update.mockResolvedValue(1);

    await paperTradingService._syncPaperPositions({ broadcast: false, now });

    expect(paperPositionsDb.insert).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'EURUSD',
      type: 'BUY',
      mt5PositionId: 'position-8001',
      mt5Comment: 'PT|Breakout|BUY|0.91',
      strategy: 'Breakout',
      status: 'OPEN',
      syncSource: 'mt5_orphan_adoption',
    }));
  });

  test('_syncPaperPositions does not rewrite an active market stop with the same reason', async () => {
    const now = new Date('2026-04-27T10:15:00.000Z');
    const startedAt = new Date('2026-04-27T10:00:00.000Z');
    const position = {
      _id: 'paper-stale-active',
      symbol: 'EURUSD',
      type: 'BUY',
      currentSl: 1.099,
      currentTp: 1.11,
      currentPrice: 1.1025,
      unrealizedPl: 12,
      mt5PositionId: '7004',
      marketStop: {
        active: true,
        startedAt,
        endedAt: null,
        reason: 'STALE_TICK',
      },
    };

    mt5Service.getPositions.mockResolvedValue([{
      id: '7004',
      stopLoss: 1.099,
      takeProfit: 1.11,
      currentPrice: 1.1025,
      profit: 12,
    }]);
    mt5Service.getPrice.mockResolvedValue({
      bid: 1.1025,
      ask: 1.1027,
      time: new Date(now.getTime() - (45 * 60 * 1000)).toISOString(),
    });
    paperPositionsDb.find
      .mockResolvedValueOnce([position])
      .mockResolvedValueOnce([position]);
    paperPositionsDb.update.mockResolvedValue(1);

    await paperTradingService._syncPaperPositions({ broadcast: false, now });

    expect(paperPositionsDb.update).not.toHaveBeenCalled();
  });

  test('_syncPaperPositions closes marketStop on fresh quotes and resumes position snapshot updates', async () => {
    const now = new Date('2026-04-29T07:00:00.000Z');
    const position = {
      _id: 'paper-reopen',
      symbol: 'EURUSD',
      type: 'BUY',
      currentSl: 1.099,
      currentTp: 1.11,
      currentPrice: 1.1025,
      unrealizedPl: 12,
      mt5PositionId: '7005',
      marketStop: {
        active: true,
        startedAt: new Date('2026-04-27T10:00:00.000Z'),
        endedAt: null,
        reason: 'STALE_TICK',
      },
    };

    mt5Service.getPositions.mockResolvedValue([{
      id: '7005',
      stopLoss: 1.099,
      takeProfit: 1.11,
      currentPrice: 1.104,
      profit: 25,
    }]);
    mt5Service.getPrice.mockResolvedValue({ bid: 1.104, ask: 1.1042, time: now.toISOString() });
    paperPositionsDb.find
      .mockResolvedValueOnce([position])
      .mockResolvedValueOnce([{ ...position, currentPrice: 1.104, unrealizedPl: 25 }]);
    paperPositionsDb.update.mockResolvedValue(1);

    await paperTradingService._syncPaperPositions({ broadcast: false, now });

    expect(paperPositionsDb.update).toHaveBeenCalledTimes(2);
    expect(paperPositionsDb.update).toHaveBeenNthCalledWith(
      1,
      { _id: 'paper-reopen' },
      {
        $set: {
          marketStop: expect.objectContaining({
            active: false,
            endedAt: now,
            resolvedAt: now,
            resolvedReason: 'MARKET_OPEN',
          }),
        },
      }
    );
    expect(paperPositionsDb.update).toHaveBeenNthCalledWith(
      2,
      { _id: 'paper-reopen' },
      {
        $set: expect.objectContaining({
          currentPrice: 1.104,
          unrealizedPl: 25,
        }),
      }
    );
  });

  test('_syncPaperPositions does not apply generic stale-tick marketStop to crypto positions', async () => {
    const now = new Date('2026-04-27T10:00:00.000Z');
    const position = {
      _id: 'paper-crypto',
      symbol: 'BTCUSD',
      type: 'BUY',
      currentSl: 68000,
      currentTp: 72000,
      currentPrice: 69900,
      unrealizedPl: 10,
      mt5PositionId: '7006',
    };

    mt5Service.getPositions.mockResolvedValue([{
      id: '7006',
      stopLoss: 68000,
      takeProfit: 72000,
      currentPrice: 70000,
      profit: 20,
    }]);
    mt5Service.getPrice.mockResolvedValue({
      bid: 70000,
      ask: 70005,
      time: new Date(now.getTime() - (8 * 60 * 60 * 1000)).toISOString(),
    });
    paperPositionsDb.find
      .mockResolvedValueOnce([position])
      .mockResolvedValueOnce([{ ...position, currentPrice: 70000, unrealizedPl: 20 }]);
    paperPositionsDb.update.mockResolvedValue(1);

    await paperTradingService._syncPaperPositions({ broadcast: false, now });

    expect(paperPositionsDb.update).toHaveBeenCalledTimes(1);
    expect(paperPositionsDb.update).toHaveBeenCalledWith(
      { _id: 'paper-crypto' },
      {
        $set: expect.objectContaining({
          currentPrice: 70000,
          unrealizedPl: 20,
        }),
      }
    );
    expect(paperPositionsDb.update.mock.calls[0][1].$set.marketStop).toBeUndefined();
  });

  test('_runTrailingStops skips positions while marketStop is active', async () => {
    const position = {
      _id: 'paper-stop',
      symbol: 'EURUSD',
      type: 'BUY',
      entryPrice: 1.1,
      currentSl: 1.099,
      currentTp: 1.11,
      lotSize: 0.2,
      originalLotSize: 0.2,
      mt5PositionId: '7007',
      marketStop: {
        active: true,
        startedAt: new Date('2026-04-27T10:00:00.000Z'),
        reason: 'STALE_TICK',
      },
    };

    const updates = await paperTradingService._runTrailingStops(
      [position],
      [{
        key: 'paper-stop',
        position,
        dueLight: true,
        dueHeavy: true,
        scanReason: 'forced_sync',
      }],
      'light',
      new Date('2026-04-27T10:15:00.000Z')
    );

    expect(updates).toEqual([]);
    expect(mt5Service.getPrice).not.toHaveBeenCalled();
    expect(paperPositionsDb.update).not.toHaveBeenCalled();
  });
});
