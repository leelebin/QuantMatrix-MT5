const breakevenService = require('../src/services/breakevenService');
const TrendFollowingStrategy = require('../src/strategies/TrendFollowingStrategy');
const MomentumStrategy = require('../src/strategies/MomentumStrategy');
const BreakoutStrategy = require('../src/strategies/BreakoutStrategy');
const MultiTimeframeStrategy = require('../src/strategies/MultiTimeframeStrategy');
const MeanReversionStrategy = require('../src/strategies/MeanReversionStrategy');

describe('exitPlan contract', () => {
  const instrument = { spread: 1.5, pipSize: 0.0001 };

  describe('normalizeExitPlan / resolveEffectiveExitPlan', () => {
    test('default exit plan normalizes and exposes all sections', () => {
      const plan = breakevenService.normalizeExitPlan(null);
      expect(plan).toEqual({
        breakeven: expect.objectContaining({
          enabled: true,
          triggerAtrMultiple: 0.8,
        }),
        trailing: expect.objectContaining({
          enabled: true,
          startAtrMultiple: 1.5,
          distanceAtrMultiple: 1.0,
          mode: 'atr',
        }),
        partials: [],
        timeExit: null,
        adaptiveEvaluator: null,
      });
    });

    test('accepts partials + timeExit and sorts partials ascending', () => {
      const plan = breakevenService.normalizeExitPlan({
        partials: [
          { atProfitAtr: 2.5, closeFraction: 0.3, label: 'tp2' },
          { atProfitAtr: 1.0, closeFraction: 0.5, label: 'tp1' },
        ],
        timeExit: { maxHoldMinutes: 90, reason: 'TEST' },
      });
      expect(plan.partials).toHaveLength(2);
      expect(plan.partials[0].label).toBe('tp1');
      expect(plan.partials[1].label).toBe('tp2');
      expect(plan.timeExit).toEqual({ maxHoldMinutes: 90, reason: 'TEST' });
    });

    test('rejects trailing.mode outside the supported set', () => {
      let caught;
      try {
        breakevenService.normalizeExitPlan({
          trailing: { enabled: true, startAtrMultiple: 1, distanceAtrMultiple: 1, mode: 'bogus' },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(caught.details).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'exitPlan.trailing.mode' }),
      ]));
    });

    test('rejects trailing.startAtrMultiple below breakeven.triggerAtrMultiple when enabled', () => {
      let caught;
      try {
        breakevenService.normalizeExitPlan({
          breakeven: { enabled: true, triggerAtrMultiple: 1.5, includeSpreadCompensation: true, extraBufferPips: 0 },
          trailing: { enabled: true, startAtrMultiple: 1.0, distanceAtrMultiple: 1.0, mode: 'atr' },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(caught.details).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'exitPlan.trailing.startAtrMultiple' }),
      ]));
    });

    test('signal.exitPlan overrides profile + strategy legacy configs', () => {
      const activeProfile = {
        tradeManagement: {
          breakeven: {
            enabled: true,
            triggerAtrMultiple: 0.9,
            includeSpreadCompensation: true,
            extraBufferPips: 0,
            trailStartAtrMultiple: 1.7,
            trailDistanceAtrMultiple: 1.1,
          },
        },
      };
      const strategy = {
        tradeManagement: {
          breakevenOverride: { triggerAtrMultiple: 0.6 },
        },
      };
      const signalExitPlan = {
        trailing: { enabled: true, startAtrMultiple: 2.5, distanceAtrMultiple: 1.5, mode: 'chandelier' },
        partials: [{ atProfitAtr: 1.0, closeFraction: 0.5 }],
      };

      const plan = breakevenService.resolveEffectiveExitPlan(activeProfile, strategy, signalExitPlan);
      expect(plan.trailing).toEqual({
        enabled: true,
        startAtrMultiple: 2.5,
        distanceAtrMultiple: 1.5,
        mode: 'chandelier',
      });
      expect(plan.breakeven.triggerAtrMultiple).toBe(0.6); // strategy override retained
      expect(plan.partials).toHaveLength(1);
    });
  });

  describe('calculateExitAdjustment', () => {
    test('chandelier trailing anchors SL to maxFavourablePrice not current price', () => {
      const position = {
        type: 'BUY',
        entryPrice: 1.1,
        currentSl: 1.095,
        atrAtEntry: 0.001,
        maxFavourablePrice: 1.108,
        exitPlan: {
          breakeven: { enabled: true, triggerAtrMultiple: 0.8, includeSpreadCompensation: false, extraBufferPips: 0 },
          trailing: { enabled: true, startAtrMultiple: 1.5, distanceAtrMultiple: 1.0, mode: 'chandelier' },
        },
      };
      // Current price 1.1065 — profit 6.5 pips > 1.5*ATR (1.5 pips) so trailing fires.
      // Chandelier should anchor to maxFavourablePrice (1.108) not current price.
      const result = breakevenService.calculateExitAdjustment(position, 1.1065, instrument);
      expect(result.shouldUpdate).toBe(true);
      expect(result.phase).toBe('trailing');
      // anchor(1.108) - distance(1.0 * 0.001) = 1.107 ± rounding
      expect(result.newSl).toBeCloseTo(1.107, 4);
    });

    test('trailing disabled + breakeven disabled => phase=disabled and no update', () => {
      const position = {
        type: 'BUY',
        entryPrice: 1.1,
        currentSl: 1.095,
        atrAtEntry: 0.001,
        exitPlan: {
          breakeven: { enabled: false, triggerAtrMultiple: 0.8, includeSpreadCompensation: false, extraBufferPips: 0 },
          trailing: { enabled: false, startAtrMultiple: 1.5, distanceAtrMultiple: 1.0, mode: 'atr' },
        },
      };
      const result = breakevenService.calculateExitAdjustment(position, 1.108, instrument);
      expect(result.shouldUpdate).toBe(false);
      expect(result.phase).toBe('disabled');
    });
  });

  describe('findPartialTriggers', () => {
    test('returns only unexecuted partials whose profit threshold was crossed', () => {
      const position = {
        type: 'BUY',
        entryPrice: 1.1,
        atrAtEntry: 0.001,
        partialsExecutedIndices: [0],
        exitPlan: {
          breakeven: { enabled: true, triggerAtrMultiple: 0.5, includeSpreadCompensation: false, extraBufferPips: 0 },
          trailing: { enabled: false, startAtrMultiple: 1.5, distanceAtrMultiple: 1.0, mode: 'atr' },
          partials: [
            { atProfitAtr: 1.0, closeFraction: 0.4, label: 'p1' },
            { atProfitAtr: 2.0, closeFraction: 0.3, label: 'p2' },
            { atProfitAtr: 3.0, closeFraction: 0.3, label: 'p3' },
          ],
        },
      };
      const triggers = breakevenService.findPartialTriggers(position, 1.1025, null);
      // profit = 25 pips = 2.5 * ATR => p2 fires, p3 doesn't, p1 already executed
      expect(triggers.map((t) => t.index)).toEqual([1]);
      expect(triggers[0].label).toBe('p2');
    });
  });

  describe('isTimeExitTriggered', () => {
    test('fires when elapsed > maxHoldMinutes', () => {
      const opened = new Date('2026-04-01T00:00:00.000Z');
      const now = new Date('2026-04-02T01:00:00.000Z').getTime(); // 25h later
      const position = {
        openedAt: opened.toISOString(),
        exitPlan: {
          breakeven: { enabled: true, triggerAtrMultiple: 0.5, includeSpreadCompensation: false, extraBufferPips: 0 },
          trailing: { enabled: false, startAtrMultiple: 1.5, distanceAtrMultiple: 1.0, mode: 'atr' },
          timeExit: { maxHoldMinutes: 24 * 60, reason: 'MR_TIMEOUT' },
        },
      };
      const result = breakevenService.isTimeExitTriggered(position, now);
      expect(result.exceeded).toBe(true);
      expect(result.reason).toBe('MR_TIMEOUT');
    });

    test('does not fire without a configured timeExit', () => {
      const position = { openedAt: new Date().toISOString(), exitPlan: { breakeven: { enabled: true, triggerAtrMultiple: 0.5, includeSpreadCompensation: false, extraBufferPips: 0 }, trailing: { enabled: false, startAtrMultiple: 1.5, distanceAtrMultiple: 1.0, mode: 'atr' }, timeExit: null } };
      expect(breakevenService.isTimeExitTriggered(position).exceeded).toBe(false);
    });
  });
});

describe('strategy buildExitPlan contracts', () => {
  const instrument = { spread: 1.5, pipSize: 0.0001, riskParams: { slMultiplier: 1.5, tpMultiplier: 3 } };

  const cases = [
    { label: 'TrendFollowing', klass: TrendFollowingStrategy },
    { label: 'Momentum', klass: MomentumStrategy },
    { label: 'Breakout', klass: BreakoutStrategy },
    { label: 'MultiTimeframe', klass: MultiTimeframeStrategy },
    { label: 'MeanReversion', klass: MeanReversionStrategy },
  ];

  test.each(cases)('%s returns a valid exitPlan that survives normalization', ({ klass }) => {
    const strategy = new klass();
    const plan = strategy.buildExitPlan(instrument, 'BUY', {}, {});
    expect(() => breakevenService.normalizeExitPlan(plan)).not.toThrow();
    const normalized = breakevenService.normalizeExitPlan(plan);
    expect(normalized.adaptiveEvaluator).toBe(strategy.name);
  });

  test('MeanReversion default plan disables trailing and sets 24h time exit', () => {
    const strategy = new MeanReversionStrategy();
    const plan = strategy.buildExitPlan(instrument, 'BUY', {}, {});
    expect(plan.trailing.enabled).toBe(false);
    expect(plan.timeExit.maxHoldMinutes).toBe(24 * 60);
    expect(plan.timeExit.reason).toBe('MR_TIMEOUT');
  });

  test('Breakout uses chandelier trailing and a partial take-profit', () => {
    const strategy = new BreakoutStrategy();
    const plan = strategy.buildExitPlan(instrument, 'BUY', {}, {});
    expect(plan.trailing.mode).toBe('chandelier');
    expect(plan.partials.length).toBeGreaterThan(0);
  });
});

describe('MeanReversion evaluateExit adaptive rules', () => {
  const instrument = { spread: 1.5, pipSize: 0.0001 };

  const mkIndicators = ({ atrNow, rsiNow, bbMid = 1.1 }) => ({
    atr: [atrNow * 0.9, atrNow, atrNow],
    rsi: [rsiNow - 1, rsiNow - 0.5, rsiNow],
    bollingerBands: [
      { upper: bbMid + 0.004, middle: bbMid, lower: bbMid - 0.004 },
      { upper: bbMid + 0.004, middle: bbMid, lower: bbMid - 0.004 },
    ],
  });

  test('volatility expansion enables trailing and tightens breakeven', () => {
    const strategy = new MeanReversionStrategy();
    const position = { type: 'BUY', atrAtEntry: 0.001, entryPrice: 1.09 };
    const override = strategy.evaluateExit(position, {
      indicators: mkIndicators({ atrNow: 0.0016, rsiNow: 25 }), // 1.6x ATR expansion
      candles: [{ time: 1, open: 1.1, high: 1.1, low: 1.1, close: 1.1 }],
      instrument,
    });
    expect(override).not.toBeNull();
    expect(override.trailing.enabled).toBe(true);
    expect(override.breakeven.triggerAtrMultiple).toBeLessThanOrEqual(0.3);
  });

  test('RSI-exhausted shortens timeExit and enables trailing', () => {
    const strategy = new MeanReversionStrategy();
    const position = { type: 'BUY', atrAtEntry: 0.001, entryPrice: 1.09 };
    const override = strategy.evaluateExit(position, {
      indicators: mkIndicators({ atrNow: 0.0011, rsiNow: 60 }),
      candles: [{ time: 1, open: 1.1, high: 1.1, low: 1.1, close: 1.1 }],
      instrument,
    });
    expect(override).not.toBeNull();
    expect(override.trailing.enabled).toBe(true);
    expect(override.timeExit.maxHoldMinutes).toBe(4 * 60);
    expect(override.timeExit.reason).toBe('MR_RSI_EXHAUSTED');
  });

  test('quiet regime with RSI still extreme returns null (no override)', () => {
    const strategy = new MeanReversionStrategy();
    const position = { type: 'BUY', atrAtEntry: 0.001, entryPrice: 1.09 };
    const override = strategy.evaluateExit(position, {
      indicators: mkIndicators({ atrNow: 0.0011, rsiNow: 25 }),
      candles: [{ time: 1, open: 1.1, high: 1.1, low: 1.1, close: 1.1 }],
      instrument,
    });
    expect(override).toBeNull();
  });
});

describe('Strategy tradeManagement normalization', () => {
  test('normalizeStrategyTradeManagement accepts exitPlanOverride', () => {
    const profile = {
      tradeManagement: {
        breakeven: {
          enabled: true,
          triggerAtrMultiple: 0.8,
          includeSpreadCompensation: true,
          extraBufferPips: 0,
          trailStartAtrMultiple: 1.5,
          trailDistanceAtrMultiple: 1.0,
        },
      },
    };
    const cleaned = breakevenService.normalizeStrategyTradeManagement(
      { exitPlanOverride: { partials: [{ atProfitAtr: 1.0, closeFraction: 0.5 }] } },
      { activeProfile: profile }
    );
    expect(cleaned.exitPlanOverride.partials).toHaveLength(1);
    expect(cleaned.exitPlanOverride.partials[0].closeFraction).toBe(0.5);
  });

  test('normalizeProfileTradeManagement accepts exitPlan default', () => {
    const cleaned = breakevenService.normalizeProfileTradeManagement(
      {
        breakeven: {
          enabled: true,
          triggerAtrMultiple: 0.9,
          includeSpreadCompensation: true,
          extraBufferPips: 0,
          trailStartAtrMultiple: 1.7,
          trailDistanceAtrMultiple: 1.1,
        },
        exitPlan: {
          partials: [{ atProfitAtr: 1.5, closeFraction: 0.4 }],
          timeExit: { maxHoldMinutes: 720, reason: 'PROFILE_TIMEOUT' },
        },
      },
      { partial: false }
    );
    expect(cleaned.exitPlan.partials).toHaveLength(1);
    expect(cleaned.exitPlan.timeExit.maxHoldMinutes).toBe(720);
  });
});
