jest.mock('../src/services/auditService', () => ({
  REASON: {
    STRATEGY_DAILY_STOP_ACTIVE: 'STRATEGY_DAILY_STOP_ACTIVE',
    STRATEGY_DAILY_STOP_TRIGGERED: 'STRATEGY_DAILY_STOP_TRIGGERED',
    STRATEGY_DAILY_STOP_RESET: 'STRATEGY_DAILY_STOP_RESET',
    STRATEGY_DAILY_STOP_CLASSIFICATION: 'STRATEGY_DAILY_STOP_CLASSIFICATION',
  },
  riskRejected: jest.fn(),
  signalFiltered: jest.fn(),
  filtered: jest.fn(),
}));

jest.mock('../src/models/RiskProfile', () => {
  const DEFAULT = {
    enabled: true,
    consecutiveLossesToStop: 2,
    countBreakEvenAsLoss: false,
    countSmallLossAsLoss: false,
    smallLossThresholdR: -0.30,
    breakevenEpsilonR: 0.05,
    useRealizedPnLOnly: true,
    stopUntil: 'end_of_day',
    resetTimezone: 'Asia/Kuala_Lumpur',
    resetHour: 0,
    resetMinute: 0,
  };
  const activeConfigRef = { current: { ...DEFAULT } };
  return {
    _activeConfigRef: activeConfigRef,
    getActive: jest.fn(async () => ({ strategyDailyStop: activeConfigRef.current })),
    getStrategyDailyStop: jest.fn((profile) => ({ ...DEFAULT, ...(profile?.strategyDailyStop || {}) })),
    getDefaultStrategyDailyStop: jest.fn(() => ({ ...DEFAULT })),
  };
});

const service = require('../src/services/strategyDailyStopService');
const RiskProfileMock = require('../src/models/RiskProfile');
const { strategyDailyStopsDb } = require('../src/config/db');
const auditService = require('../src/services/auditService');

function defaultConfig(overrides = {}) {
  return {
    enabled: true,
    consecutiveLossesToStop: 2,
    countBreakEvenAsLoss: false,
    countSmallLossAsLoss: false,
    smallLossThresholdR: -0.30,
    breakevenEpsilonR: 0.05,
    useRealizedPnLOnly: true,
    stopUntil: 'end_of_day',
    resetTimezone: 'Asia/Kuala_Lumpur',
    resetHour: 0,
    resetMinute: 0,
    ...overrides,
  };
}

async function cleanDb() {
  const all = await strategyDailyStopsDb.find({});
  for (const doc of all) {
    await strategyDailyStopsDb.remove({ _id: doc._id }, {});
  }
}

describe('strategyDailyStopService', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    RiskProfileMock._activeConfigRef.current = defaultConfig();
    service._resetInMemoryCountersForTests();
    await cleanDb();
  });

  describe('classify', () => {
    test('win when tradeR greater than breakeven epsilon', () => {
      expect(service.classify(0.5, defaultConfig())).toBe('win');
    });

    test('breakeven when absolute tradeR within epsilon', () => {
      expect(service.classify(0.02, defaultConfig())).toBe('breakeven');
      expect(service.classify(-0.04, defaultConfig())).toBe('breakeven');
    });

    test('small_loss when tradeR between small-loss floor and negative epsilon', () => {
      expect(service.classify(-0.20, defaultConfig())).toBe('small_loss');
    });

    test('loss when tradeR below small-loss floor', () => {
      expect(service.classify(-1.0, defaultConfig())).toBe('loss');
    });
  });

  describe('computeTradeR fallback chain', () => {
    test('prefers explicit tradeR', () => {
      expect(service.computeTradeR({ tradeR: -0.75, profitLoss: 999, plannedRiskAmount: 10 })).toBe(-0.75);
    });

    test('falls back to realizedRMultiple when tradeR missing', () => {
      expect(service.computeTradeR({ realizedRMultiple: -1.2 })).toBe(-1.2);
    });

    test('computes from profitLoss / plannedRiskAmount when both R values missing', () => {
      expect(service.computeTradeR({ profitLoss: -50, plannedRiskAmount: 100 })).toBe(-0.5);
    });
  });

  describe('recordTradeOutcome + isEntryBlocked', () => {
    const baseTrade = {
      strategy: 'TrendFollowing',
      symbol: 'EURUSD',
      timeframe: '1h',
    };

    test('N consecutive losses on the same key trigger a stop for that key', async () => {
      const cfg = defaultConfig();
      const now = new Date('2026-04-25T06:00:00.000Z');

      const first = await service.recordTradeOutcome({
        ...baseTrade, tradeR: -1.0, closedAt: now,
      }, cfg);
      expect(first.classification).toBe('loss');
      expect(first.consecutiveLossCount).toBe(1);
      expect(first.triggered).toBe(false);

      const blockedBefore = await service.isEntryBlocked({ ...baseTrade, now }, cfg);
      expect(blockedBefore.blocked).toBe(false);

      const second = await service.recordTradeOutcome({
        ...baseTrade, tradeR: -1.1, closedAt: now,
      }, cfg);
      expect(second.classification).toBe('loss');
      expect(second.consecutiveLossCount).toBe(2);
      expect(second.triggered).toBe(true);

      const blockedAfter = await service.isEntryBlocked({ ...baseTrade, now }, cfg);
      expect(blockedAfter.blocked).toBe(true);
      expect(blockedAfter.record?.stopReason).toBe('CONSECUTIVE_LOSSES');
      expect(blockedAfter.record?.consecutiveLossCountAtStop).toBe(2);
    });

    test('different keys are independent', async () => {
      const cfg = defaultConfig();
      const now = new Date('2026-04-25T06:00:00.000Z');

      await service.recordTradeOutcome({ ...baseTrade, tradeR: -1.0, closedAt: now }, cfg);
      await service.recordTradeOutcome({ ...baseTrade, tradeR: -1.1, closedAt: now }, cfg);

      const blockedSame = await service.isEntryBlocked({ ...baseTrade, now }, cfg);
      const blockedOtherSymbol = await service.isEntryBlocked({ ...baseTrade, symbol: 'USDJPY', now }, cfg);
      const blockedOtherStrategy = await service.isEntryBlocked({ ...baseTrade, strategy: 'Momentum', now }, cfg);
      const blockedOtherTimeframe = await service.isEntryBlocked({ ...baseTrade, timeframe: '4h', now }, cfg);

      expect(blockedSame.blocked).toBe(true);
      expect(blockedOtherSymbol.blocked).toBe(false);
      expect(blockedOtherStrategy.blocked).toBe(false);
      expect(blockedOtherTimeframe.blocked).toBe(false);
    });

    test('a win resets the consecutive-loss streak', async () => {
      const cfg = defaultConfig();
      const now = new Date('2026-04-25T06:00:00.000Z');

      await service.recordTradeOutcome({ ...baseTrade, tradeR: -1.0, closedAt: now }, cfg);
      const reset = await service.recordTradeOutcome({ ...baseTrade, tradeR: 2.0, closedAt: now }, cfg);
      expect(reset.classification).toBe('win');
      expect(reset.consecutiveLossCount).toBe(0);

      const blocked = await service.isEntryBlocked({ ...baseTrade, now }, cfg);
      expect(blocked.blocked).toBe(false);
    });

    test('breakeven does not count as a loss by default', async () => {
      const cfg = defaultConfig();
      const now = new Date('2026-04-25T06:00:00.000Z');

      const be = await service.recordTradeOutcome({ ...baseTrade, tradeR: 0.02, closedAt: now }, cfg);
      expect(be.classification).toBe('breakeven');
      expect(be.consecutiveLossCount).toBe(0);
    });

    test('breakeven counts as loss when countBreakEvenAsLoss is true', async () => {
      const cfg = defaultConfig({ countBreakEvenAsLoss: true });
      const now = new Date('2026-04-25T06:00:00.000Z');

      const be = await service.recordTradeOutcome({ ...baseTrade, tradeR: -0.04, closedAt: now }, cfg);
      expect(be.classification).toBe('breakeven');
      expect(be.consecutiveLossCount).toBe(1);
    });

    test('small_loss does not count as loss by default', async () => {
      const cfg = defaultConfig();
      const now = new Date('2026-04-25T06:00:00.000Z');

      const sl = await service.recordTradeOutcome({ ...baseTrade, tradeR: -0.15, closedAt: now }, cfg);
      expect(sl.classification).toBe('small_loss');
      expect(sl.consecutiveLossCount).toBe(0);
    });

    test('small_loss counts when countSmallLossAsLoss is true', async () => {
      const cfg = defaultConfig({ countSmallLossAsLoss: true });
      const now = new Date('2026-04-25T06:00:00.000Z');

      const sl = await service.recordTradeOutcome({ ...baseTrade, tradeR: -0.15, closedAt: now }, cfg);
      expect(sl.consecutiveLossCount).toBe(1);
    });

    test('entry is unblocked automatically after the reset boundary (next day)', async () => {
      const cfg = defaultConfig();
      const todayKL = new Date('2026-04-25T06:00:00.000Z');
      const nextDayKL = new Date('2026-04-26T06:00:00.000Z');

      await service.recordTradeOutcome({ ...baseTrade, tradeR: -1.0, closedAt: todayKL }, cfg);
      await service.recordTradeOutcome({ ...baseTrade, tradeR: -1.1, closedAt: todayKL }, cfg);

      const blockedToday = await service.isEntryBlocked({ ...baseTrade, now: todayKL }, cfg);
      const blockedTomorrow = await service.isEntryBlocked({ ...baseTrade, now: nextDayKL }, cfg);

      expect(blockedToday.blocked).toBe(true);
      expect(blockedTomorrow.blocked).toBe(false);
    });

    test('stop record is persisted to the DB so restart recovery can read it', async () => {
      const cfg = defaultConfig();
      const now = new Date('2026-04-25T06:00:00.000Z');

      await service.recordTradeOutcome({ ...baseTrade, tradeR: -1.0, closedAt: now }, cfg);
      await service.recordTradeOutcome({ ...baseTrade, tradeR: -1.1, closedAt: now }, cfg);

      // Wipe the in-memory blocked-entry counter (as a fresh process would
      // start with); the persisted DB doc must still drive the gate.
      service._resetInMemoryCountersForTests();

      const docs = await strategyDailyStopsDb.find({});
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({
        stopped: true,
        stopReason: 'CONSECUTIVE_LOSSES',
        consecutiveLossCountAtStop: 2,
        scope: 'live',
        key: 'live:TrendFollowing:EURUSD:1h',
      });

      const gate = await service.isEntryBlocked({ ...baseTrade, now }, cfg);
      expect(gate.blocked).toBe(true);
      expect(gate.record?.consecutiveLossCountAtStop).toBe(2);
    });

    test('manualReset clears the record and unblocks the key', async () => {
      const cfg = defaultConfig();
      const now = new Date('2026-04-25T06:00:00.000Z');

      await service.recordTradeOutcome({ ...baseTrade, tradeR: -1.0, closedAt: now }, cfg);
      await service.recordTradeOutcome({ ...baseTrade, tradeR: -1.1, closedAt: now }, cfg);

      const blockedBefore = await service.isEntryBlocked({ ...baseTrade, now }, cfg);
      expect(blockedBefore.blocked).toBe(true);

      const reset = await service.manualReset({ ...baseTrade, now, actor: 'debug-user' });
      expect(reset.cleared).toBe(true);

      const blockedAfter = await service.isEntryBlocked({ ...baseTrade, now }, cfg);
      expect(blockedAfter.blocked).toBe(false);
    });

    test('recordBlockedEntry increments counter and counts per trading day', () => {
      const tradingDay = '2026-04-25';
      service.recordBlockedEntry({ ...baseTrade, tradingDay });
      service.recordBlockedEntry({ ...baseTrade, tradingDay });
      service.recordBlockedEntry({ ...baseTrade, scope: 'paper', tradingDay });
      expect(service.getBlockedEntriesToday(tradingDay)).toBe(2);
      expect(service.getBlockedEntriesToday(tradingDay, 'paper')).toBe(1);

      // New trading day resets the counter
      service.recordBlockedEntry({ ...baseTrade, tradingDay: '2026-04-26' });
      expect(service.getBlockedEntriesToday('2026-04-26')).toBe(1);
      expect(service.getBlockedEntriesToday('2026-04-26', 'paper')).toBe(0);
      expect(service.getBlockedEntriesToday('2026-04-25')).toBe(0);
    });

    test('getTodayStoppedStrategies returns stopped keys for the current trading day', async () => {
      const cfg = defaultConfig();
      const now = new Date('2026-04-25T06:00:00.000Z');

      await service.recordTradeOutcome({ ...baseTrade, tradeR: -1.0, closedAt: now }, cfg);
      await service.recordTradeOutcome({ ...baseTrade, tradeR: -1.1, closedAt: now }, cfg);
      await service.recordTradeOutcome({ ...baseTrade, symbol: 'USDJPY', tradeR: -0.1, closedAt: now }, cfg);

      const stopped = await service.getTodayStoppedStrategies({ now }, cfg);
      expect(stopped).toHaveLength(1);
      expect(stopped[0]).toMatchObject({
        scope: 'live',
        strategy: 'TrendFollowing',
        symbol: 'EURUSD',
        timeframe: '1h',
        stopped: true,
        stopReason: 'CONSECUTIVE_LOSSES',
      });
    });

    test('paper consecutive losses block paper but not live', async () => {
      const cfg = defaultConfig();
      const now = new Date('2026-04-25T06:00:00.000Z');
      const trade = {
        strategy: 'Breakout',
        symbol: 'XAUUSD',
        timeframe: '15m',
      };

      await service.recordTradeOutcome({ ...trade, scope: 'paper', tradeR: -1.0, closedAt: now }, cfg);
      const second = await service.recordTradeOutcome({ ...trade, scope: 'paper', tradeR: -1.2, closedAt: now }, cfg);

      expect(second.record).toMatchObject({
        scope: 'paper',
        key: 'paper:Breakout:XAUUSD:15m',
        stopped: true,
      });
      expect((await service.isEntryBlocked({ ...trade, scope: 'paper', now }, cfg)).blocked).toBe(true);
      expect((await service.isEntryBlocked({ ...trade, scope: 'live', now }, cfg)).blocked).toBe(false);
    });

    test('live consecutive losses block live but not paper', async () => {
      const cfg = defaultConfig();
      const now = new Date('2026-04-25T06:00:00.000Z');
      const trade = {
        strategy: 'Breakout',
        symbol: 'XAUUSD',
        timeframe: '15m',
      };

      await service.recordTradeOutcome({ ...trade, scope: 'live', tradeR: -1.0, closedAt: now }, cfg);
      await service.recordTradeOutcome({ ...trade, scope: 'live', tradeR: -1.2, closedAt: now }, cfg);

      expect((await service.isEntryBlocked({ ...trade, scope: 'live', now }, cfg)).blocked).toBe(true);
      expect((await service.isEntryBlocked({ ...trade, scope: 'paper', now }, cfg)).blocked).toBe(false);
    });

    test('manualReset paper does not affect live and manualReset live does not affect paper', async () => {
      const cfg = defaultConfig();
      const now = new Date('2026-04-25T06:00:00.000Z');
      const trade = {
        strategy: 'Breakout',
        symbol: 'XAUUSD',
        timeframe: '15m',
      };

      await service.recordTradeOutcome({ ...trade, scope: 'paper', tradeR: -1.0, closedAt: now }, cfg);
      await service.recordTradeOutcome({ ...trade, scope: 'paper', tradeR: -1.2, closedAt: now }, cfg);
      await service.recordTradeOutcome({ ...trade, scope: 'live', tradeR: -1.0, closedAt: now }, cfg);
      await service.recordTradeOutcome({ ...trade, scope: 'live', tradeR: -1.2, closedAt: now }, cfg);

      const resetPaper = await service.manualReset({ ...trade, scope: 'paper', now, actor: 'debug-user' });
      expect(resetPaper).toMatchObject({
        cleared: true,
        scope: 'paper',
        key: 'paper:Breakout:XAUUSD:15m',
      });
      expect((await service.isEntryBlocked({ ...trade, scope: 'paper', now }, cfg)).blocked).toBe(false);
      expect((await service.isEntryBlocked({ ...trade, scope: 'live', now }, cfg)).blocked).toBe(true);

      const resetLive = await service.manualReset({ ...trade, scope: 'live', now, actor: 'debug-user' });
      expect(resetLive).toMatchObject({
        cleared: true,
        scope: 'live',
        key: 'live:Breakout:XAUUSD:15m',
      });
      expect((await service.isEntryBlocked({ ...trade, scope: 'live', now }, cfg)).blocked).toBe(false);
    });

    test('missing scope remains backwards-compatible and defaults to live', async () => {
      const cfg = defaultConfig();
      const now = new Date('2026-04-25T06:00:00.000Z');
      const trade = {
        strategy: 'Breakout',
        symbol: 'XAUUSD',
        timeframe: '15m',
      };

      expect(service.buildKey(trade.strategy, trade.symbol, trade.timeframe)).toBe('live:Breakout:XAUUSD:15m');

      await service.recordTradeOutcome({ ...trade, tradeR: -1.0, closedAt: now }, cfg);
      await service.recordTradeOutcome({ ...trade, tradeR: -1.2, closedAt: now }, cfg);

      expect((await service.isEntryBlocked({ ...trade, now }, cfg)).blocked).toBe(true);
      expect((await service.isEntryBlocked({ ...trade, scope: 'paper', now }, cfg)).blocked).toBe(false);
    });

    test('three-in-a-row threshold', async () => {
      const cfg = defaultConfig({ consecutiveLossesToStop: 3 });
      const now = new Date('2026-04-25T06:00:00.000Z');

      await service.recordTradeOutcome({ ...baseTrade, tradeR: -1.0, closedAt: now }, cfg);
      await service.recordTradeOutcome({ ...baseTrade, tradeR: -1.0, closedAt: now }, cfg);
      const g1 = await service.isEntryBlocked({ ...baseTrade, now }, cfg);
      expect(g1.blocked).toBe(false);

      const third = await service.recordTradeOutcome({ ...baseTrade, tradeR: -1.0, closedAt: now }, cfg);
      expect(third.triggered).toBe(true);
      const g2 = await service.isEntryBlocked({ ...baseTrade, now }, cfg);
      expect(g2.blocked).toBe(true);
    });

    test('disabled config → isEntryBlocked never blocks and recordTradeOutcome is no-op', async () => {
      const cfg = defaultConfig({ enabled: false });
      const now = new Date('2026-04-25T06:00:00.000Z');

      const out1 = await service.recordTradeOutcome({ ...baseTrade, tradeR: -1.0, closedAt: now }, cfg);
      const out2 = await service.recordTradeOutcome({ ...baseTrade, tradeR: -1.0, closedAt: now }, cfg);
      expect(out1).toBeNull();
      expect(out2).toBeNull();

      const gate = await service.isEntryBlocked({ ...baseTrade, now }, cfg);
      expect(gate.blocked).toBe(false);
    });
  });

  describe('resolveTradingDay (Asia/Kuala_Lumpur)', () => {
    test('a UTC timestamp just after midnight KL stays in the same tradingDay as evening KL', () => {
      const cfg = defaultConfig();
      // 2026-04-25 16:00 UTC == 2026-04-26 00:00 KL (+08:00)
      const atMidnight = new Date('2026-04-25T16:00:00.000Z');
      // 2026-04-25 15:59 UTC == 2026-04-25 23:59 KL
      const justBefore = new Date('2026-04-25T15:59:00.000Z');

      const d1 = service.resolveTradingDay(justBefore, cfg);
      const d2 = service.resolveTradingDay(atMidnight, cfg);
      expect(d1.tradingDay).toBe('2026-04-25');
      expect(d2.tradingDay).toBe('2026-04-26');
    });
  });
});
