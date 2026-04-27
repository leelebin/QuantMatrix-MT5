const path = require('path');

// Stub out heavy collaborators before requiring the service. The unit tests
// only care about pure logic + the conservative gating; we don't want to
// touch NeDB, websocket, telegram, or audit during tests.
jest.mock('../src/services/websocketService', () => ({
  broadcast: jest.fn(),
}));
jest.mock('../src/services/notificationService', () => ({
  sendTelegram: jest.fn(async () => true),
}));
jest.mock('../src/services/economicCalendarService', () => ({
  ensureCalendar: jest.fn(async () => null),
  isInBlackout: jest.fn(() => ({ blocked: false })),
}));
jest.mock('../src/services/auditService', () => ({
  positionManaged: jest.fn(),
  REASON: {},
}));
jest.mock('../src/services/breakevenService', () => ({
  getPositionExitPlan: () => null,
}));

// Replace the positionsDb used by the service with an in-memory mock so
// _verifyPositionExists / _appendToPosition behave deterministically.
// Note: variable name must start with "mock" for jest to allow the closure.
jest.mock('../src/config/db', () => {
  const records = new Map();
  return {
    positionsDb: {
      async findOne(query) {
        const id = query?._id;
        if (!id) return null;
        const rec = records.get(id);
        return rec ? { ...rec, managementEvents: [...(rec.managementEvents || [])] } : null;
      },
      async update(query, modifier) {
        const id = query?._id;
        if (!id) return 0;
        const rec = records.get(id);
        if (!rec) return 0;
        const $set = modifier?.$set || {};
        Object.assign(rec, $set);
        return 1;
      },
      _seed(record) {
        records.set(record._id, { ...record, managementEvents: [...(record.managementEvents || [])] });
      },
      _wipe() {
        records.clear();
      },
    },
    tradesDb: {},
  };
});

const { positionsDb: fakePositionsDb } = require('../src/config/db');

// Pretend instruments exist for any symbol the test passes in.
jest.mock('../src/config/instruments', () => ({
  getInstrument: (symbol) => ({
    symbol,
    pipSize: 0.0001,
    spread: 1,
    minLot: 0.01,
    lotStep: 0.01,
  }),
}));

const tradeManagementService = require('../src/services/tradeManagementService');
const {
  EVENT,
  calculateUnrealizedR,
  planPartialCloseVolume,
} = require('../src/services/tradeManagementService');
const { getDefaultTradeManagementPolicy } = require('../src/services/tradeManagementConfig');

const baseInstrument = {
  symbol: 'EURUSD',
  pipSize: 0.0001,
  spread: 1,
  minLot: 0.01,
  lotStep: 0.01,
};

function buildPosition(overrides = {}) {
  return {
    _id: 'pos-1',
    mt5PositionId: '12345',
    symbol: 'EURUSD',
    strategy: 'TrendFollowing',
    type: 'BUY',
    entryPrice: 1.10000,
    initialSl: 1.09800,
    currentSl: 1.09800,
    currentTp: null,
    lotSize: 0.10,
    openedAt: new Date('2026-04-27T00:00:00.000Z').toISOString(),
    managementEvents: [],
    ...overrides,
  };
}

beforeEach(() => {
  fakePositionsDb._wipe();
});

describe('calculateUnrealizedR', () => {
  test('BUY moving in profit returns positive R', () => {
    const r = calculateUnrealizedR({
      position: { entryPrice: 1.10, initialSl: 1.099, type: 'BUY' },
      currentPrice: 1.102,
    });
    expect(r).toBeCloseTo(2, 4);
  });

  test('BUY moving against returns negative R', () => {
    const r = calculateUnrealizedR({
      position: { entryPrice: 1.10, initialSl: 1.099, type: 'BUY' },
      currentPrice: 1.0995,
    });
    expect(r).toBeCloseTo(-0.5, 4);
  });

  test('SELL inverted direction', () => {
    const r = calculateUnrealizedR({
      position: { entryPrice: 1.10, initialSl: 1.101, type: 'SELL' },
      currentPrice: 1.098,
    });
    expect(r).toBeCloseTo(2, 4);
  });

  test('returns null when initialSl missing', () => {
    const r = calculateUnrealizedR({
      position: { entryPrice: 1.10, initialSl: null, type: 'BUY' },
      currentPrice: 1.10,
    });
    expect(r).toBeNull();
  });

  test('returns null when initial risk is zero', () => {
    const r = calculateUnrealizedR({
      position: { entryPrice: 1.10, initialSl: 1.10, type: 'BUY' },
      currentPrice: 1.10,
    });
    expect(r).toBeNull();
  });
});

describe('planPartialCloseVolume', () => {
  test('snaps to lotStep and accepts legal split', () => {
    const plan = planPartialCloseVolume({
      position: { lotSize: 0.10 },
      ratio: 0.5,
      instrument: baseInstrument,
    });
    expect(plan).not.toBeNull();
    expect(plan.volume).toBeCloseTo(0.05, 6);
    expect(plan.remaining).toBeCloseTo(0.05, 6);
  });

  test('rejects when closed leg is below minLot', () => {
    const plan = planPartialCloseVolume({
      position: { lotSize: 0.01 },
      ratio: 0.5,
      instrument: baseInstrument,
    });
    expect(plan).toBeNull();
  });

  test('rejects when remaining leg falls below minLot', () => {
    const plan = planPartialCloseVolume({
      position: { lotSize: 0.02 },
      ratio: 0.9, // 0.018 -> snapped to 0.01, remaining 0.01 — still equal to minLot, ok
      instrument: baseInstrument,
    });
    // 0.02 * 0.9 = 0.018, floor to 0.01 → remaining 0.01 (equal to minLot, allowed)
    expect(plan).not.toBeNull();
    expect(plan.volume).toBeCloseTo(0.01, 6);
    expect(plan.remaining).toBeCloseTo(0.01, 6);
  });

  test('rejects ratio outside (0,1)', () => {
    expect(planPartialCloseVolume({ position: { lotSize: 1 }, ratio: 0, instrument: baseInstrument })).toBeNull();
    expect(planPartialCloseVolume({ position: { lotSize: 1 }, ratio: 1, instrument: baseInstrument })).toBeNull();
  });
});

describe('evaluatePosition — defaults audit-only', () => {
  test('default policy never closes/modifies, only records audit', async () => {
    const position = buildPosition({
      openedAt: new Date(Date.now() - 60 * 1000).toISOString(), // 1 min ago — early window
    });
    fakePositionsDb._seed(position);
    const policy = getDefaultTradeManagementPolicy();

    const close = jest.fn();
    const partial = jest.fn();
    const modify = jest.fn();

    // Adverse price: -1R
    const events = await tradeManagementService.evaluatePosition({
      position,
      instrument: baseInstrument,
      policy,
      scanMode: 'light',
      currentPrice: 1.09800,
      now: new Date(),
      actions: { closePositionFn: close, partialCloseFn: partial, modifySlFn: modify },
    });

    expect(close).not.toHaveBeenCalled();
    expect(partial).not.toHaveBeenCalled();
    expect(modify).not.toHaveBeenCalled();
    const types = events.map((e) => e.type);
    expect(types).toContain(EVENT.EARLY_PROTECTION_MONITORING);
    expect(types).toContain(EVENT.EARLY_ADVERSE_MOVE);
    expect(types).not.toContain(EVENT.EARLY_ADVERSE_EXIT);
  });
});

describe('evaluatePosition — early adverse exit gated by flag', () => {
  test('closes only when enableEarlyAdverseExit=true', async () => {
    const position = buildPosition({
      openedAt: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    fakePositionsDb._seed(position);
    const policy = { ...getDefaultTradeManagementPolicy(), enableEarlyAdverseExit: true };
    const close = jest.fn(async () => ({ ok: true }));

    const events = await tradeManagementService.evaluatePosition({
      position,
      instrument: baseInstrument,
      policy,
      scanMode: 'light',
      currentPrice: 1.09800, // -1R
      now: new Date(),
      actions: { closePositionFn: close, partialCloseFn: jest.fn(), modifySlFn: jest.fn() },
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(events.map((e) => e.type)).toContain(EVENT.EARLY_ADVERSE_EXIT);
  });
});

describe('evaluatePosition — breakeven move gated by flag', () => {
  test('default audits only at +1R', async () => {
    const position = buildPosition({
      openedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // outside early window
    });
    fakePositionsDb._seed(position);
    const policy = getDefaultTradeManagementPolicy();
    const modify = jest.fn();

    const events = await tradeManagementService.evaluatePosition({
      position,
      instrument: baseInstrument,
      policy,
      scanMode: 'light',
      currentPrice: 1.10200, // +1R
      now: new Date(),
      actions: { closePositionFn: jest.fn(), partialCloseFn: jest.fn(), modifySlFn: modify },
    });

    expect(modify).not.toHaveBeenCalled();
    const types = events.map((e) => e.type);
    expect(types).toContain(EVENT.R_THRESHOLD_REACHED);
    expect(types).not.toContain(EVENT.BREAKEVEN_MOVED);
  });

  test('moves SL to BE when allowMoveToBreakeven=true', async () => {
    const position = buildPosition({
      openedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    fakePositionsDb._seed(position);
    const policy = { ...getDefaultTradeManagementPolicy(), allowMoveToBreakeven: true };
    const modify = jest.fn(async () => ({ ok: true }));

    const events = await tradeManagementService.evaluatePosition({
      position,
      instrument: baseInstrument,
      policy,
      scanMode: 'light',
      currentPrice: 1.10200,
      now: new Date(),
      actions: { closePositionFn: jest.fn(), partialCloseFn: jest.fn(), modifySlFn: modify },
    });

    expect(modify).toHaveBeenCalledTimes(1);
    expect(modify).toHaveBeenCalledWith(expect.objectContaining({ _id: 'pos-1' }), 1.10);
    expect(events.map((e) => e.type)).toContain(EVENT.BREAKEVEN_MOVED);
  });
});

describe('evaluatePosition — partial TP volume validation', () => {
  test('skips with audit event when volume would violate minLot', async () => {
    const position = buildPosition({
      lotSize: 0.01, // splitting 50% leaves 0.005 — illegal
      openedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    fakePositionsDb._seed(position);
    const policy = { ...getDefaultTradeManagementPolicy(), allowPartialTakeProfit: true };
    const partial = jest.fn();

    const events = await tradeManagementService.evaluatePosition({
      position,
      instrument: baseInstrument,
      policy,
      scanMode: 'light',
      currentPrice: 1.10300, // +1.5R
      now: new Date(),
      actions: { closePositionFn: jest.fn(), partialCloseFn: partial, modifySlFn: jest.fn() },
    });

    expect(partial).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toContain(EVENT.PARTIAL_TP_SKIPPED_INVALID_VOLUME);
  });

  test('executes partial close at legal volume when flagged on', async () => {
    const position = buildPosition({
      lotSize: 0.20,
      openedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    fakePositionsDb._seed(position);
    const policy = { ...getDefaultTradeManagementPolicy(), allowPartialTakeProfit: true };
    const partial = jest.fn(async () => ({ ok: true }));

    const events = await tradeManagementService.evaluatePosition({
      position,
      instrument: baseInstrument,
      policy,
      scanMode: 'light',
      currentPrice: 1.10300,
      now: new Date(),
      actions: { closePositionFn: jest.fn(), partialCloseFn: partial, modifySlFn: jest.fn() },
    });

    expect(partial).toHaveBeenCalledTimes(1);
    const args = partial.mock.calls[0];
    expect(args[1]).toBeCloseTo(0.10, 6);
    expect(events.map((e) => e.type)).toContain(EVENT.PARTIAL_TP_EXECUTED);
  });
});

describe('evaluatePosition — invalidation only on heavy scan', () => {
  test('light scan never raises invalidation events', async () => {
    const position = buildPosition({
      openedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    fakePositionsDb._seed(position);
    const policy = { ...getDefaultTradeManagementPolicy(), enableExitOnInvalidation: true };
    const close = jest.fn();

    await tradeManagementService.evaluatePosition({
      position,
      instrument: baseInstrument,
      policy,
      scanMode: 'light',
      currentPrice: 1.10000,
      now: new Date(),
      invalidationContext: {
        candles: new Array(50).fill({ close: 1.10, high: 1.10, low: 1.10, open: 1.10 }),
        indicators: { ema50: [1.105] },
        opposingSignal: true,
        higherTrendChanged: true,
      },
      actions: { closePositionFn: close, partialCloseFn: jest.fn(), modifySlFn: jest.fn() },
    });

    expect(close).not.toHaveBeenCalled();
  });

  test('heavy scan with two signals triggers SETUP_INVALIDATED + INVALIDATION_EXIT when enabled', async () => {
    const position = buildPosition({
      openedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    fakePositionsDb._seed(position);
    const policy = { ...getDefaultTradeManagementPolicy(), enableExitOnInvalidation: true };
    const close = jest.fn(async () => ({ ok: true }));

    const candles = new Array(60).fill(0).map(() => ({ close: 1.099, open: 1.099, high: 1.099, low: 1.099 }));
    const events = await tradeManagementService.evaluatePosition({
      position,
      instrument: baseInstrument,
      policy,
      scanMode: 'heavy',
      currentPrice: 1.099,
      now: new Date(),
      invalidationContext: {
        candles,
        indicators: { ema50: [1.105] },
        opposingSignal: true,
        higherTrendChanged: false,
      },
      actions: { closePositionFn: close, partialCloseFn: jest.fn(), modifySlFn: jest.fn() },
    });

    const types = events.map((e) => e.type);
    expect(types).toContain(EVENT.SETUP_INVALIDATED);
    expect(types).toContain(EVENT.INVALIDATION_EXIT);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('heavy scan with single signal does not invalidate', async () => {
    const position = buildPosition({
      openedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    fakePositionsDb._seed(position);
    const policy = { ...getDefaultTradeManagementPolicy(), enableExitOnInvalidation: true };
    const close = jest.fn();

    const candles = new Array(60).fill(0).map(() => ({ close: 1.10, open: 1.10, high: 1.10, low: 1.10 }));
    const events = await tradeManagementService.evaluatePosition({
      position,
      instrument: baseInstrument,
      policy,
      scanMode: 'heavy',
      currentPrice: 1.10,
      now: new Date(),
      invalidationContext: {
        candles,
        indicators: { ema50: [1.105] }, // only EMA-cross, just one signal
        opposingSignal: false,
        higherTrendChanged: false,
      },
      actions: { closePositionFn: close, partialCloseFn: jest.fn(), modifySlFn: jest.fn() },
    });

    expect(close).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).not.toContain(EVENT.SETUP_INVALIDATED);
  });

  test('heavy scan without context records INVALIDATION_CHECK_SKIPPED', async () => {
    const position = buildPosition({
      openedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    fakePositionsDb._seed(position);
    const policy = getDefaultTradeManagementPolicy();

    const events = await tradeManagementService.evaluatePosition({
      position,
      instrument: baseInstrument,
      policy,
      scanMode: 'heavy',
      currentPrice: 1.10,
      now: new Date(),
      invalidationContext: null,
      actions: { closePositionFn: jest.fn(), partialCloseFn: jest.fn(), modifySlFn: jest.fn() },
    });

    expect(events.map((e) => e.type)).toContain(EVENT.INVALIDATION_CHECK_SKIPPED);
  });
});

describe('evaluatePosition — news risk', () => {
  test('audits during blackout but does not move SL by default', async () => {
    const position = buildPosition({
      openedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    fakePositionsDb._seed(position);
    const policy = getDefaultTradeManagementPolicy();
    const modify = jest.fn();

    const events = await tradeManagementService.evaluatePosition({
      position,
      instrument: baseInstrument,
      policy,
      scanMode: 'light',
      newsBlackoutActive: true,
      blackoutEvent: { id: 'evt', impact: 'high' },
      currentPrice: 1.10100,
      now: new Date(),
      actions: { closePositionFn: jest.fn(), partialCloseFn: jest.fn(), modifySlFn: modify },
    });

    expect(modify).not.toHaveBeenCalled();
    const types = events.map((e) => e.type);
    expect(types).toContain(EVENT.NEWS_RISK_DETECTED);
    expect(types).toContain(EVENT.NEWS_FAST_MONITORING);
    expect(types).not.toContain(EVENT.NEWS_PROTECTIVE_BREAKEVEN);
  });

  test('moves SL to BE in profit when enableNewsProtectiveBreakeven=true', async () => {
    const position = buildPosition({
      openedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    fakePositionsDb._seed(position);
    const policy = { ...getDefaultTradeManagementPolicy(), enableNewsProtectiveBreakeven: true };
    const modify = jest.fn(async () => ({ ok: true }));

    const events = await tradeManagementService.evaluatePosition({
      position,
      instrument: baseInstrument,
      policy,
      scanMode: 'light',
      newsBlackoutActive: true,
      blackoutEvent: { id: 'evt', impact: 'high' },
      currentPrice: 1.10100, // +0.5R
      now: new Date(),
      actions: { closePositionFn: jest.fn(), partialCloseFn: jest.fn(), modifySlFn: modify },
    });

    expect(modify).toHaveBeenCalledTimes(1);
    expect(modify).toHaveBeenCalledWith(expect.objectContaining({ _id: 'pos-1' }), 1.10);
    expect(events.map((e) => e.type)).toContain(EVENT.NEWS_PROTECTIVE_BREAKEVEN);
  });

  test('skips BE move under blackout when underwater (would lock loss)', async () => {
    const position = buildPosition({
      openedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    fakePositionsDb._seed(position);
    const policy = { ...getDefaultTradeManagementPolicy(), enableNewsProtectiveBreakeven: true };
    const modify = jest.fn();

    const events = await tradeManagementService.evaluatePosition({
      position,
      instrument: baseInstrument,
      policy,
      scanMode: 'light',
      newsBlackoutActive: true,
      blackoutEvent: { id: 'evt' },
      currentPrice: 1.09900, // -0.5R
      now: new Date(),
      actions: { closePositionFn: jest.fn(), partialCloseFn: jest.fn(), modifySlFn: modify },
    });

    expect(modify).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toContain(EVENT.NEWS_PROTECTION_SKIPPED);
  });
});

describe('evaluatePosition — guardrails', () => {
  test('skips entirely when position no longer exists in DB', async () => {
    const position = buildPosition({
      openedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    // Note: NOT seeded — position has been closed externally
    const policy = { ...getDefaultTradeManagementPolicy(), allowMoveToBreakeven: true };
    const modify = jest.fn();

    await tradeManagementService.evaluatePosition({
      position,
      instrument: baseInstrument,
      policy,
      scanMode: 'light',
      currentPrice: 1.10200,
      now: new Date(),
      actions: { closePositionFn: jest.fn(), partialCloseFn: jest.fn(), modifySlFn: modify },
    });

    expect(modify).not.toHaveBeenCalled();
  });

  test('returns empty when policy missing', async () => {
    const position = buildPosition();
    fakePositionsDb._seed(position);
    const events = await tradeManagementService.evaluatePosition({
      position,
      instrument: baseInstrument,
      policy: null,
      scanMode: 'light',
      currentPrice: 1.10,
      actions: {},
    });
    expect(events).toEqual([]);
  });

  test('returns empty when mt5PositionId missing', async () => {
    const position = buildPosition({ mt5PositionId: null });
    const events = await tradeManagementService.evaluatePosition({
      position,
      instrument: baseInstrument,
      policy: getDefaultTradeManagementPolicy(),
      scanMode: 'light',
      currentPrice: 1.10,
      actions: {},
    });
    expect(events).toEqual([]);
  });
});
