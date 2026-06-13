const {
  DIRECTION_CONTROL_ACTIONS,
  normalizeDirectionControlConfig,
  resolveDirectionControlConfig,
} = require('../src/services/directionControlConfig');
const { evaluateDirectionControl } = require('../src/services/directionControlEvaluator');
const { buildDirectionControlSummary } = require('../src/services/directionControlSummary');
const { evaluateRuntimeDirectionControl } = require('../src/services/directionControlRuntimeService');
const breakevenService = require('../src/services/breakevenService');

function candle(index, overrides = {}) {
  return {
    time: new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    atr: 1,
    ...overrides,
  };
}

function baseCandles() {
  return [
    candle(0, { high: 100, low: 100, close: 100 }),
    candle(1, { high: 102, low: 99, close: 101 }),
    candle(2, { high: 102, low: 98, close: 100 }),
    candle(3, { high: 101, low: 96, close: 97 }),
    candle(4, { high: 98, low: 95, close: 96 }),
    candle(5, { high: 98, low: 94, close: 95 }),
    candle(6, { high: 98, low: 94, close: 95 }),
    candle(7, { high: 98, low: 94, close: 95 }),
    candle(8, { high: 98, low: 94, close: 95 }),
    candle(9, { high: 98, low: 94, close: 95 }),
  ];
}

function lowMfeCandles() {
  return [
    candle(0, { high: 100, low: 100, close: 100 }),
    candle(1, { high: 100.5, low: 99, close: 99.5 }),
    candle(2, { high: 100.75, low: 98, close: 98.5 }),
    candle(3, { high: 100.8, low: 96, close: 97 }),
    candle(4, { high: 100.9, low: 95, close: 96 }),
  ];
}

function scoreConfig(overrides = {}) {
  return normalizeDirectionControlConfig({
    enabled: true,
    minBarsAfterEntry: 1,
    triggerScore: 2,
    requiredCategories: 2,
    checks: {
      adverseR: { enabled: true, thresholdR: -0.6, score: 1, critical: false },
      failedFollowThrough: {
        enabled: true,
        minFavourableR: 0.25,
        currentRThreshold: -0.35,
        score: 1,
        critical: false,
      },
      structureBreak: { enabled: false },
      opposingSignal: { enabled: false },
      ...overrides.checks,
    },
    ...overrides,
  });
}

function basePosition(overrides = {}) {
  return {
    id: 'pos-1',
    symbol: 'EURUSD',
    strategy: 'MockStrategy',
    type: 'BUY',
    entryPrice: 100,
    sl: 95,
    currentSl: 95,
    tp: 110,
    entryIndex: 0,
    entryTime: candle(0).time,
    plannedRiskAmount: 100,
    managementEvents: [],
    ...overrides,
  };
}

describe('directionControlConfig', () => {
  test('default config is disabled and unsupported modes normalize to audit', () => {
    const empty = normalizeDirectionControlConfig();
    expect(empty.enabled).toBe(false);
    expect(empty.mode).toBe('audit');

    const normalized = normalizeDirectionControlConfig({
      enabled: true,
      mode: 'protective',
      wouldHaveAction: 'CLOSE_NOW',
    });
    expect(normalized.enabled).toBe(true);
    expect(normalized.mode).toBe('audit');
    expect(normalized.wouldHaveAction).toBe(DIRECTION_CONTROL_ACTIONS.TIGHTEN_SL_OR_EXIT_ON_PULLBACK);
  });

  test('resolves normal and SymbolCustom config sources', () => {
    const normal = resolveDirectionControlConfig({
      strategyInstance: {
        tradeManagement: {
          directionControl: { enabled: true, minBarsAfterEntry: 4 },
        },
      },
    });
    expect(normal.enabled).toBe(true);
    expect(normal.minBarsAfterEntry).toBe(4);

    const custom = resolveDirectionControlConfig({
      source: 'symbolCustom',
      symbolCustom: {
        exitConfig: {
          directionControl: { enabled: true, triggerScore: 3 },
        },
      },
    });
    expect(custom.enabled).toBe(true);
    expect(custom.triggerScore).toBe(3);
  });

  test('strategy trade-management normalization preserves old overrides and accepts directionControl', () => {
    const normalized = breakevenService.normalizeStrategyTradeManagement({
      breakevenOverride: { triggerAtrMultiple: 1.2 },
      exitPlanOverride: { breakeven: { enabled: false } },
      directionControl: { enabled: true, mode: 'protective' },
    });

    expect(normalized.breakevenOverride.triggerAtrMultiple).toBe(1.2);
    expect(normalized.exitPlanOverride).toBeTruthy();
    expect(normalized.directionControl).toEqual(expect.objectContaining({
      enabled: true,
      mode: 'audit',
      schemaVersion: 1,
    }));
  });
});

describe('directionControlEvaluator', () => {
  test('missing config stays skipped and produces no event', () => {
    const result = evaluateDirectionControl({
      config: normalizeDirectionControlConfig(),
      position: basePosition(),
      candles: baseCandles(),
      currentBar: baseCandles()[4],
      currentIndex: 4,
    });
    expect(result.skipped).toBe(true);
    expect(result.triggered).toBe(false);
    expect(result.event).toBeNull();
  });

  test('score trigger requires multiple categories and does not mutate inputs', () => {
    const config = scoreConfig();
    const position = basePosition();
    const before = JSON.stringify(position);
    const candles = lowMfeCandles();
    const result = evaluateDirectionControl({
      config,
      position,
      candles,
      currentBar: candles[4],
      currentIndex: 4,
      strategyContext: { currentBarClosed: true },
      serverTime: '2026-01-01T04:00:00.000Z',
    });

    expect(result.triggered).toBe(true);
    expect(result.event).toEqual(expect.objectContaining({
      type: 'POST_ENTRY_DIRECTION_CONTROL',
      action: 'AUDIT_ONLY',
      mode: 'audit',
      side: 'BUY',
      score: 2,
      unrealizedR: -0.8,
    }));
    expect(result.statePatch.directionControl.firstTriggered).toBe(true);
    expect(JSON.stringify(position)).toBe(before);
  });

  test('failedFollowThrough triggers when MFE stays below minimum and currentR breaches threshold', () => {
    const candles = lowMfeCandles();
    const result = evaluateDirectionControl({
      config: scoreConfig({
        triggerScore: 1,
        requiredCategories: 1,
        checks: {
          adverseR: { enabled: false },
          failedFollowThrough: {
            enabled: true,
            minFavourableR: 0.25,
            currentRThreshold: -0.35,
            score: 1,
            critical: false,
          },
        },
      }),
      position: basePosition(),
      candles,
      currentBar: candles[4],
      currentIndex: 4,
    });

    expect(result.triggered).toBe(true);
    expect(result.checkResults.failedFollowThrough).toEqual(expect.objectContaining({
      triggered: true,
      mfeR: 0.18,
      currentR: -0.8,
    }));
  });

  test('failedFollowThrough does not trigger once MFE has reached the minimum favourable excursion', () => {
    const result = evaluateDirectionControl({
      config: scoreConfig({
        triggerScore: 1,
        requiredCategories: 1,
        checks: {
          adverseR: { enabled: false },
          failedFollowThrough: {
            enabled: true,
            minFavourableR: 0.25,
            currentRThreshold: -0.35,
            score: 1,
            critical: false,
          },
        },
      }),
      position: basePosition(),
      candles: baseCandles(),
      currentBar: baseCandles()[4],
      currentIndex: 4,
    });

    expect(result.triggered).toBe(false);
    expect(result.checkResults.failedFollowThrough).toEqual(expect.objectContaining({
      triggered: false,
      mfeR: 0.4,
      currentR: -0.8,
    }));
  });

  test('adverseR alone does not trigger unless critical', () => {
    const result = evaluateDirectionControl({
      config: scoreConfig({
        triggerScore: 1,
        requiredCategories: 1,
        checks: {
          failedFollowThrough: { enabled: false },
          adverseR: { enabled: true, thresholdR: -0.6, score: 1, critical: false },
        },
      }),
      position: basePosition(),
      candles: baseCandles(),
      currentBar: baseCandles()[4],
      currentIndex: 4,
    });

    expect(result.triggered).toBe(false);
    expect(result.event).toBeNull();
    expect(result.summaryInput.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'adverseR_alone_not_enough' }),
    ]));
  });

  test('critical structureBreak bypasses requiredCategories and uses thesis levels first', () => {
    const result = evaluateDirectionControl({
      config: normalizeDirectionControlConfig({
        enabled: true,
        minBarsAfterEntry: 1,
        requiredCategories: 3,
        checks: {
          adverseR: { enabled: false },
          failedFollowThrough: { enabled: false },
          opposingSignal: { enabled: false },
          structureBreak: {
            enabled: true,
            critical: true,
            bufferAtr: 0.1,
            levels: ['zone_boundary', 'pinbar_extreme', 'entry_swing'],
          },
        },
      }),
      position: basePosition({ entryThesisLevels: { zone_boundary: 98 } }),
      candles: baseCandles(),
      currentBar: baseCandles()[4],
      currentIndex: 4,
      strategyContext: { atr: 1 },
    });

    expect(result.triggered).toBe(true);
    expect(result.checkResults.structureBreak).toEqual(expect.objectContaining({
      triggered: true,
      levelType: 'zone_boundary',
      critical: true,
    }));
  });

  test('opposingSignal refuses to trigger when repaint safety is unconfirmed', () => {
    const result = evaluateDirectionControl({
      config: normalizeDirectionControlConfig({
        enabled: true,
        minBarsAfterEntry: 1,
        triggerScore: 1,
        requiredCategories: 1,
        checks: {
          adverseR: { enabled: false },
          failedFollowThrough: { enabled: false },
          structureBreak: { enabled: false },
          opposingSignal: { enabled: true, score: 1, critical: false, allowRepaintSignal: false },
        },
      }),
      position: basePosition(),
      candles: baseCandles(),
      currentBar: baseCandles()[4],
      currentIndex: 4,
      strategyContext: {
        opposingSignal: { signal: 'SELL', barIndex: 4, repaintSafe: false },
        currentBarClosed: true,
      },
    });

    expect(result.triggered).toBe(false);
    expect(result.checkResults.opposingSignal.reason).toBe('opposing_signal_repaint_safety_unconfirmed');
  });

  test('firstTriggerOnly and cooldown prevent event spam across persisted state', () => {
    const candles = lowMfeCandles();
    const first = evaluateDirectionControl({
      config: scoreConfig(),
      position: basePosition(),
      candles,
      currentBar: candles[4],
      currentIndex: 4,
    });
    expect(first.triggered).toBe(true);

    const repeated = evaluateDirectionControl({
      config: scoreConfig(),
      position: basePosition({ directionControl: first.statePatch.directionControl }),
      candles,
      currentBar: candles[4],
      currentIndex: 4,
    });
    expect(repeated.triggered).toBe(false);
    expect(repeated.checkResults.reason).toBe('first_trigger_already_recorded');

    const cooldown = evaluateDirectionControl({
      config: scoreConfig({ firstTriggerOnly: false, cooldownBars: 3 }),
      position: basePosition({ directionControl: { firstTriggered: true, lastTriggeredBarIndex: 5, triggerCount: 1 } }),
      candles,
      currentBar: candles[4],
      currentIndex: 6,
    });
    expect(cooldown.triggered).toBe(false);
    expect(cooldown.checkResults.reason).toBe('cooldown_bars_not_elapsed');
  });
});

describe('directionControlSummary and runtime integration', () => {
  test('summary calculates analytical hypothetical impact without changing trade results', () => {
    const trade = {
      id: 1,
      exitReason: 'INITIAL_SL_HIT',
      realizedRMultiple: -1,
      profitLoss: -100,
      exitPrice: 95,
      directionControlEvents: [{
        type: 'POST_ENTRY_DIRECTION_CONTROL',
        triggered: true,
        unrealizedR: -0.4,
        candleTime: '2026-01-01T04:00:00.000Z',
      }],
      directionControlPostTriggerMfeR: 0.2,
      directionControlPostTriggerMaeR: -0.6,
    };
    const summary = buildDirectionControlSummary([
      trade,
      { id: 2, exitReason: 'TP_HIT', realizedRMultiple: 1.5, profitLoss: 150, exitPrice: 110 },
    ]);

    expect(summary).toEqual(expect.objectContaining({
      totalTrades: 2,
      triggeredTrades: 1,
      triggeredThenHitSL: 1,
      hypotheticalSavedLossR: 0.6,
      netHypotheticalImpactR: 0.6,
    }));
    expect(trade.exitPrice).toBe(95);
    expect(trade.profitLoss).toBe(-100);
  });

  test('runtime path persists only management event and directionControl patch for normal strategy', async () => {
    const patches = [];
    const updates = await evaluateRuntimeDirectionControl({
      positions: [basePosition({ _id: 'normal-position', entryTime: baseCandles()[0].time })],
      scope: 'live',
      getStrategyInstanceFn: async () => ({
        tradeManagement: { directionControl: scoreConfig() },
      }),
      getPriceFn: async () => ({ bid: 96, ask: 96.1 }),
      getCandlesFn: async () => lowMfeCandles(),
      updatePositionFn: async (id, patch) => patches.push({ id, patch }),
      now: new Date('2026-01-01T04:00:00.000Z'),
    });

    expect(updates).toHaveLength(1);
    expect(patches[0].patch).toEqual(expect.objectContaining({
      directionControl: expect.objectContaining({ firstTriggered: true }),
      managementEvents: expect.arrayContaining([
        expect.objectContaining({ type: 'POST_ENTRY_DIRECTION_CONTROL', action: 'AUDIT_ONLY' }),
      ]),
    }));
  });

  test('runtime SymbolCustom path reads exitConfig and includes custom ids and names', async () => {
    const patches = [];
    await evaluateRuntimeDirectionControl({
      positions: [basePosition({
        _id: 'custom-position',
        source: 'symbolCustom',
        symbolCustomId: 'sc-1',
        symbolCustomName: 'Custom One',
        strategy: 'Custom One',
        entryTime: baseCandles()[0].time,
      })],
      scope: 'paper',
      getSymbolCustomFn: async () => ({
        _id: 'sc-1',
        symbol: 'EURUSD',
        symbolCustomName: 'Custom One',
        exitConfig: { directionControl: scoreConfig() },
      }),
      getPriceFn: async () => ({ bid: 96, ask: 96.1 }),
      getCandlesFn: async () => lowMfeCandles(),
      updatePositionFn: async (id, patch) => patches.push({ id, patch }),
      now: new Date('2026-01-01T04:00:00.000Z'),
    });

    expect(patches[0].patch.managementEvents[0]).toEqual(expect.objectContaining({
      symbolCustomId: 'sc-1',
      symbolCustomName: 'Custom One',
    }));
  });
});
