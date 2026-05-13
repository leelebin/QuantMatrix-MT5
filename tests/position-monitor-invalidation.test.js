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
  INSTRUMENT_CATEGORIES: { CRYPTO: 'crypto' },
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
const trailingStopService = require('../src/services/trailingStopService');
const { positionsDb } = require('../src/config/db');
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

  test('syncPositions records a non-crypto market stop once and skips stale snapshot writes', async () => {
    const now = new Date('2026-04-27T10:00:00.000Z');
    const staleTickTime = new Date(now.getTime() - (31 * 60 * 1000)).toISOString();
    const position = {
      _id: 'live-stale',
      symbol: 'EURUSD',
      type: 'BUY',
      currentSl: 1.099,
      currentTp: 1.11,
      currentPrice: 1.1025,
      unrealizedPl: 12,
      mt5PositionId: '9003',
    };

    mt5Service.isConnected.mockReturnValue(true);
    mt5Service.getPositions.mockResolvedValue([{
      id: '9003',
      stopLoss: 1.099,
      takeProfit: 1.11,
      currentPrice: 1.1025,
      profit: 12,
    }]);
    mt5Service.getPrice.mockResolvedValue({ bid: 1.1025, ask: 1.1027, time: staleTickTime });
    positionsDb.find
      .mockResolvedValueOnce([position])
      .mockResolvedValueOnce([{ ...position, marketStop: { active: true, reason: 'STALE_TICK' } }]);
    positionsDb.update.mockResolvedValue(1);

    await positionMonitor.syncPositions({ broadcast: false, now });

    expect(positionsDb.update).toHaveBeenCalledTimes(1);
    expect(positionsDb.update).toHaveBeenCalledWith(
      { _id: 'live-stale' },
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
    expect(positionsDb.update.mock.calls[0][1].$set.currentPrice).toBeUndefined();
  });

  test('syncPositions does not rewrite an active live market stop with the same reason', async () => {
    const now = new Date('2026-04-27T10:15:00.000Z');
    const position = {
      _id: 'live-stale-active',
      symbol: 'EURUSD',
      type: 'BUY',
      currentSl: 1.099,
      currentTp: 1.11,
      currentPrice: 1.1025,
      unrealizedPl: 12,
      mt5PositionId: '9004',
      marketStop: {
        active: true,
        startedAt: new Date('2026-04-27T10:00:00.000Z'),
        endedAt: null,
        reason: 'STALE_TICK',
      },
    };

    mt5Service.isConnected.mockReturnValue(true);
    mt5Service.getPositions.mockResolvedValue([{
      id: '9004',
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
    positionsDb.find
      .mockResolvedValueOnce([position])
      .mockResolvedValueOnce([position]);
    positionsDb.update.mockResolvedValue(1);

    await positionMonitor.syncPositions({ broadcast: false, now });

    expect(positionsDb.update).not.toHaveBeenCalled();
  });

  test('syncPositions closes live marketStop on fresh quotes and resumes snapshot updates', async () => {
    const now = new Date('2026-04-29T07:00:00.000Z');
    const position = {
      _id: 'live-reopen',
      symbol: 'EURUSD',
      type: 'BUY',
      currentSl: 1.099,
      currentTp: 1.11,
      currentPrice: 1.1025,
      unrealizedPl: 12,
      mt5PositionId: '9005',
      marketStop: {
        active: true,
        startedAt: new Date('2026-04-27T10:00:00.000Z'),
        endedAt: null,
        reason: 'STALE_TICK',
      },
    };

    mt5Service.isConnected.mockReturnValue(true);
    mt5Service.getPositions.mockResolvedValue([{
      id: '9005',
      stopLoss: 1.099,
      takeProfit: 1.11,
      currentPrice: 1.104,
      profit: 25,
    }]);
    mt5Service.getPrice.mockResolvedValue({ bid: 1.104, ask: 1.1042, time: now.toISOString() });
    positionsDb.find
      .mockResolvedValueOnce([position])
      .mockResolvedValueOnce([{ ...position, currentPrice: 1.104, unrealizedPl: 25 }]);
    positionsDb.update.mockResolvedValue(1);

    await positionMonitor.syncPositions({ broadcast: false, now });

    expect(positionsDb.update).toHaveBeenCalledTimes(2);
    expect(positionsDb.update).toHaveBeenNthCalledWith(
      1,
      { _id: 'live-reopen' },
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
    expect(positionsDb.update).toHaveBeenNthCalledWith(
      2,
      { _id: 'live-reopen' },
      {
        $set: expect.objectContaining({
          currentPrice: 1.104,
          unrealizedPl: 25,
        }),
      }
    );
  });

  test('syncPositions does not apply generic stale-tick marketStop to live crypto positions', async () => {
    const now = new Date('2026-04-27T10:00:00.000Z');
    const position = {
      _id: 'live-crypto',
      symbol: 'BTCUSD',
      type: 'BUY',
      currentSl: 68000,
      currentTp: 72000,
      currentPrice: 69900,
      unrealizedPl: 10,
      mt5PositionId: '9006',
    };

    getInstrument.mockReturnValue({ symbol: 'BTCUSD', category: 'crypto', pipSize: 1 });
    mt5Service.isConnected.mockReturnValue(true);
    mt5Service.getPositions.mockResolvedValue([{
      id: '9006',
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
    positionsDb.find
      .mockResolvedValueOnce([position])
      .mockResolvedValueOnce([{ ...position, currentPrice: 70000, unrealizedPl: 20 }]);
    positionsDb.update.mockResolvedValue(1);

    await positionMonitor.syncPositions({ broadcast: false, now });

    expect(positionsDb.update).toHaveBeenCalledTimes(1);
    expect(positionsDb.update).toHaveBeenCalledWith(
      { _id: 'live-crypto' },
      {
        $set: expect.objectContaining({
          currentPrice: 70000,
          unrealizedPl: 20,
        }),
      }
    );
    expect(positionsDb.update.mock.calls[0][1].$set.marketStop).toBeUndefined();
  });

  test('_runPositionManagement skips positions while live marketStop is active', async () => {
    const position = {
      _id: 'live-stop',
      symbol: 'EURUSD',
      type: 'BUY',
      entryPrice: 1.1,
      currentSl: 1.099,
      currentTp: 1.11,
      lotSize: 0.2,
      originalLotSize: 0.2,
      mt5PositionId: '9007',
      marketStop: {
        active: true,
        startedAt: new Date('2026-04-27T10:00:00.000Z'),
        reason: 'STALE_TICK',
      },
    };

    const updates = await positionMonitor._runPositionManagement(
      [position],
      [{
        key: positionMonitor._getPositionKey(position),
        position,
        dueLight: true,
        dueHeavy: true,
        scanReason: 'forced_sync',
      }],
      'light',
      new Date('2026-04-27T10:15:00.000Z'),
      { id: 'test', fingerprints: new Set() }
    );

    expect(updates).toEqual([]);
    expect(trailingStopService.processPositions).not.toHaveBeenCalled();
    expect(tradeManagementService.evaluatePosition).not.toHaveBeenCalled();
    expect(positionsDb.update).not.toHaveBeenCalled();
  });
});
