jest.mock('../src/config/db', () => ({
  backtestsDb: {
    insert: jest.fn(),
    find: jest.fn(() => ({
      sort: jest.fn(() => ({
        limit: jest.fn().mockResolvedValue([]),
      })),
    })),
    findOne: jest.fn(),
    remove: jest.fn(),
  },
}));

jest.mock('../src/models/Strategy', () => ({
  findAll: jest.fn().mockResolvedValue([]),
}));

const indicatorService = require('../src/services/indicatorService');
const volumeFeatures = require('../src/services/volumeFeatureService');
const VolumeFlowHybridStrategy = require('../src/strategies/VolumeFlowHybridStrategy');
const { resolveStrategyParameters } = require('../src/config/strategyParameters');
const { getStrategyExecutionConfig } = require('../src/config/strategyExecution');
const { getInstrument, STRATEGY_TYPES } = require('../src/config/instruments');
const strategyEngine = require('../src/services/strategyEngine');
const backtestEngine = require('../src/services/backtestEngine');
const { backtestsDb } = require('../src/config/db');

function buildBaselineCandles({
  symbol = 'XAUUSD',
  startMs = Date.parse('2026-04-01T00:00:00Z'),
  count = 280,
  drift = 0.4,
  baseVol = 100,
} = {}) {
  const candles = [];
  let price = 2000;
  for (let i = 0; i < count; i++) {
    const noise = (i % 7 - 3) * 0.1;
    const open = price;
    const close = open + drift + noise;
    const high = Math.max(open, close) + 0.2;
    const low = Math.min(open, close) - 0.2;
    candles.push({
      symbol,
      time: new Date(startMs + i * 5 * 60 * 1000).toISOString(),
      open,
      high,
      low,
      close,
      volume: baseVol,
      tickVolume: baseVol,
    });
    price = close;
  }
  return candles;
}

function appendBreakoutCandle(candles, { rangeBoost = 8, volBoost = 800 } = {}) {
  const last = candles[candles.length - 1];
  const open = last.close;
  const close = open + rangeBoost;
  candles.push({
    time: new Date(new Date(last.time).getTime() + 5 * 60 * 1000).toISOString(),
    open,
    high: close + 0.5,
    low: open - 0.2,
    close,
    volume: volBoost,
    tickVolume: volBoost,
  });
  return candles;
}

function buildReversalCandles() {
  const candles = buildBaselineCandles({ count: 80, drift: 0, baseVol: 100 });
  for (const candle of candles) {
    candle.open = 100.2;
    candle.high = 101;
    candle.low = 99.5;
    candle.close = 100.1;
  }
  const last = candles[candles.length - 1];
  Object.assign(last, {
    open: 100.3,
    high: 100.8,
    low: 98.4,
    close: 100.5,
    volume: 500,
    tickVolume: 500,
  });
  return candles;
}

function reversalFeatureSnapshot() {
  return {
    rvol: 3.2,
    volumeSpikeClass: 'extreme',
    averageVolume: 100,
    volume: 500,
    cumulativeDelta: 100,
    cumulativeDeltaPrev: 50,
    cumulativeDeltaDelta: 50,
    cumulativeDeltaSlope: 10,
    cumulativeDeltaSmoothed: 100,
    sessionVwap: 100.4,
    vwapDistance: 0.1,
    wickUpperRatio: 0,
    wickLowerRatio: 10,
    spreadEfficiency: 0.1,
  };
}

describe('volumeFeatureService', () => {
  test('resolveVolume prefers real volume over tick volume when > 0', () => {
    expect(volumeFeatures.resolveVolume({ volume: 50, tickVolume: 200 })).toBe(50);
    expect(volumeFeatures.resolveVolume({ volume: 0, tickVolume: 75 })).toBe(75);
    expect(volumeFeatures.resolveVolume({ volume: 0, tickVolume: 0 })).toBe(0);
    expect(volumeFeatures.resolveVolume(null)).toBe(0);
  });

  test('classifyBar handles bull/bear/neutral', () => {
    expect(volumeFeatures.classifyBar({ open: 1, close: 2, high: 2, low: 1 })).toBe('BULL');
    expect(volumeFeatures.classifyBar({ open: 2, close: 1, high: 2, low: 1 })).toBe('BEAR');
    expect(volumeFeatures.classifyBar({ open: 1, close: 1, high: 2, low: 0 })).toBe('NEUTRAL');
  });

  test('relativeVolume returns >1 when latest bar has spike volume', () => {
    const candles = buildBaselineCandles({ count: 60 });
    candles[candles.length - 1].volume = 5000;
    candles[candles.length - 1].tickVolume = 5000;
    const rvol = volumeFeatures.relativeVolume(candles, 20);
    expect(rvol).toBeGreaterThan(10);
  });

  test('computeLatestFeatures returns all expected keys', () => {
    const candles = buildBaselineCandles({ count: 60 });
    const features = volumeFeatures.computeLatestFeatures(candles, {
      volumeAvgPeriod: 20,
      deltaSmoothing: 8,
    });
    expect(features).not.toBeNull();
    expect(typeof features.rvol).toBe('number');
    expect(typeof features.cumulativeDelta).toBe('number');
    expect(typeof features.cumulativeDeltaDelta).toBe('number');
    expect(typeof features.cumulativeDeltaSlope).toBe('number');
    expect(typeof features.sessionVwap).toBe('number');
    expect(typeof features.wickUpperRatio).toBe('number');
    expect(typeof features.wickLowerRatio).toBe('number');
  });

  test('buildFeatureSeries matches computeLatestFeatures for eligible candles', () => {
    const candles = buildBaselineCandles({ count: 80 });
    const series = volumeFeatures.buildFeatureSeries(candles, {
      volumeAvgPeriod: 20,
      deltaSmoothing: 8,
    });

    for (let i = 21; i < candles.length; i++) {
      const fromSeries = series[i];
      const direct = volumeFeatures.computeLatestFeatures(candles.slice(0, i + 1), {
        volumeAvgPeriod: 20,
        deltaSmoothing: 8,
      });

      expect(fromSeries).toEqual(direct);
    }
  });
});

describe('VolumeFlowHybridStrategy', () => {
  function runStrategy(candles, {
    entryCandles = candles,
    instrumentSymbol = 'XAUUSD',
    parameterOverrides = {},
    contextOverrides = {},
  } = {}) {
    const strategy = new VolumeFlowHybridStrategy();
    const executionConfig = getStrategyExecutionConfig(instrumentSymbol, 'VolumeFlowHybrid');
    const instrument = { ...getInstrument(instrumentSymbol), ...executionConfig };
    const params = {
      ...resolveStrategyParameters({
      strategyType: 'VolumeFlowHybrid',
      instrument,
      storedParameters: null,
      }),
      ...parameterOverrides,
    };
    const indicators = indicatorService.calculateAll(candles, params);
    return strategy.analyze(candles, indicators, instrument, {
      strategyParams: params,
      entryCandles,
      ...contextOverrides,
    });
  }

  test('does not signal in a quiet baseline regime', () => {
    const candles = buildBaselineCandles({ count: 280 });
    const result = runStrategy(candles);
    expect(result.signal).toBe('NONE');
  });

  test('triggers BREAKOUT_CONTINUATION on a high-volume structural break', () => {
    const candles = appendBreakoutCandle(buildBaselineCandles({ count: 280 }));
    const result = runStrategy(candles);
    expect(result.signal).toBe('BUY');
    expect(result.indicatorsSnapshot.module).toBe('BREAKOUT_CONTINUATION');
    expect(result.indicatorsSnapshot.rvol).toBeGreaterThan(2);
    expect(result.sl).toBeLessThan(result.indicatorsSnapshot.entryPrice);
    expect(result.tp).toBeGreaterThan(result.indicatorsSnapshot.entryPrice);
    expect(result.exitPlan).toBeTruthy();
  });

  test('module and direction gates default to enabled for backward compatibility', () => {
    const strategy = new VolumeFlowHybridStrategy();

    expect(strategy._isModuleEnabled(VolumeFlowHybridStrategy.MODULE_BREAKOUT, {})).toBe(true);
    expect(strategy._isModuleEnabled(VolumeFlowHybridStrategy.MODULE_REVERSAL, {})).toBe(true);
    expect(strategy._isDirectionAllowed('BUY', {})).toBe(true);
    expect(strategy._isDirectionAllowed('SELL', {})).toBe(true);
  });

  test('unknown UTC session is allowed by default but can be disabled', () => {
    const strategy = new VolumeFlowHybridStrategy();
    const unknownTime = '2026-04-01T22:30:00Z';

    expect(strategy._resolveSessionInfo(unknownTime, {}, VolumeFlowHybridStrategy.MODULE_BREAKOUT))
      .toEqual(expect.objectContaining({
        sessionName: 'UNKNOWN',
        sessionAllowed: true,
      }));
    expect(strategy._resolveSessionInfo(unknownTime, { allow_unknown_session: 0 }, VolumeFlowHybridStrategy.MODULE_BREAKOUT))
      .toEqual(expect.objectContaining({
        sessionName: 'UNKNOWN',
        sessionAllowed: false,
        sessionFilterReason: 'Unknown session disabled',
      }));
  });

  test('enable_breakout_module=0 suppresses an otherwise valid breakout', () => {
    const candles = appendBreakoutCandle(buildBaselineCandles({ count: 280 }));
    const enabled = runStrategy(candles, {
      parameterOverrides: {
        min_confidence: 0.1,
        use_entry_confirmation: 0,
      },
    });
    const disabled = runStrategy(candles, {
      parameterOverrides: {
        enable_breakout_module: 0,
        min_confidence: 0.1,
        use_entry_confirmation: 0,
      },
    });

    expect(enabled.signal).toBe('BUY');
    expect(enabled.indicatorsSnapshot.module).toBe('BREAKOUT_CONTINUATION');
    expect(disabled.signal).toBe('NONE');
  });

  test('allow_buy=0 suppresses an otherwise valid BUY signal', () => {
    const candles = appendBreakoutCandle(buildBaselineCandles({ count: 280 }));
    const enabled = runStrategy(candles, {
      parameterOverrides: {
        min_confidence: 0.1,
        use_entry_confirmation: 0,
      },
    });
    const disabled = runStrategy(candles, {
      parameterOverrides: {
        allow_buy: 0,
        min_confidence: 0.1,
        use_entry_confirmation: 0,
      },
    });

    expect(enabled.signal).toBe('BUY');
    expect(disabled.signal).toBe('NONE');
  });

  test('enable_reversal_module=0 suppresses an otherwise valid reversal', () => {
    const candles = buildReversalCandles();
    const commonOverrides = {
      rvol_reversal: 2.0,
      min_confidence: 0.1,
      use_entry_confirmation: 0,
      use_session_filter: 0,
    };
    const enabled = runStrategy(candles, {
      parameterOverrides: commonOverrides,
      contextOverrides: {
        volumeFeatureSnapshot: reversalFeatureSnapshot(),
      },
    });
    const disabled = runStrategy(candles, {
      parameterOverrides: {
        ...commonOverrides,
        enable_reversal_module: 0,
      },
      contextOverrides: {
        volumeFeatureSnapshot: reversalFeatureSnapshot(),
      },
    });

    expect(enabled.signal).toBe('BUY');
    expect(enabled.indicatorsSnapshot.module).toBe('EXHAUSTION_REVERSAL');
    expect(disabled.signal).toBe('NONE');
  });

  test('reversal VWAP reclaim cannot be bypassed by structure reclaim alone', () => {
    const candles = buildBaselineCandles({ count: 80, drift: 0, baseVol: 100 });
    for (const candle of candles) {
      candle.open = 100.2;
      candle.high = 101;
      candle.low = 99.5;
      candle.close = 100.1;
    }
    const last = candles[candles.length - 1];
    Object.assign(last, {
      open: 100.3,
      high: 100.8,
      low: 98.4,
      close: 100.5,
      volume: 500,
      tickVolume: 500,
    });

    const result = runStrategy(candles, {
      parameterOverrides: {
        rvol_reversal: 2.0,
        min_confidence: 0.1,
        use_entry_confirmation: 0,
        use_session_filter: 0,
      },
      contextOverrides: {
        volumeFeatureSnapshot: {
          rvol: 3.2,
          volumeSpikeClass: 'extreme',
          averageVolume: 100,
          volume: 500,
          cumulativeDelta: 100,
          cumulativeDeltaPrev: 50,
          cumulativeDeltaDelta: 50,
          cumulativeDeltaSlope: 10,
          sessionVwap: 110,
          vwapDistance: -9.5,
          wickUpperRatio: 0,
          wickLowerRatio: 10,
          spreadEfficiency: 0.1,
        },
      },
    });

    expect(result.signal).toBe('NONE');
    expect(result.status).toBe('FILTERED');
    expect(result.filterReason).toContain('VWAP reclaim/reject missing');
  });

  test('tiny-body doji candle does not trigger reversal from wick ratio explosion', () => {
    const candles = buildBaselineCandles({ count: 80, drift: 0, baseVol: 100 });
    for (const candle of candles) {
      candle.open = 100.2;
      candle.high = 101;
      candle.low = 99.5;
      candle.close = 100.1;
    }
    const last = candles[candles.length - 1];
    Object.assign(last, {
      open: 100.49,
      high: 100.8,
      low: 98.4,
      close: 100.5,
      volume: 500,
      tickVolume: 500,
    });

    const result = runStrategy(candles, {
      parameterOverrides: {
        rvol_reversal: 2.0,
        min_confidence: 0.1,
        use_entry_confirmation: 0,
        use_session_filter: 0,
      },
      contextOverrides: {
        volumeFeatureSnapshot: {
          rvol: 2.8,
          volumeSpikeClass: 'extreme',
          averageVolume: 100,
          volume: 500,
          cumulativeDelta: 100,
          cumulativeDeltaPrev: 50,
          cumulativeDeltaDelta: 50,
          cumulativeDeltaSlope: 10,
          sessionVwap: 100.4,
          vwapDistance: 0.1,
          wickUpperRatio: 0,
          wickLowerRatio: 100,
          spreadEfficiency: 0.01,
        },
      },
    });

    expect(result.signal).toBe('NONE');
    expect(result.status).toBe('FILTERED');
    expect(result.filterReason).toContain('doji body below minimum ratio');
  });

  test('missing optional spread, news, higher TF, and exposure data does not crash', () => {
    const candles = appendBreakoutCandle(buildBaselineCandles({ count: 280 }));
    const result = runStrategy(candles);

    expect(result.indicatorsSnapshot).toEqual(expect.objectContaining({
      spreadFilterAvailable: false,
      spreadUnavailable: true,
      newsFilterAvailable: false,
      exposureFilterAvailable: false,
      htfRegime: expect.any(String),
    }));
  });

  test('spread filter converts MT5-style spread points into price units before ATR comparison', () => {
    const strategy = new VolumeFlowHybridStrategy();
    const instrument = getInstrument('XAUUSD');

    const result = strategy._resolveSpreadInfo(
      { spread: 25 },
      {},
      instrument,
      5,
      { use_spread_filter: 1, max_spread_atr_xau: 0.08 }
    );

    expect(result.blocked).toBe(false);
    expect(result.snapshot.spreadRaw).toBe(25);
    expect(result.snapshot.spread).toBeCloseTo(0.25, 8);
    expect(result.snapshot.spreadAtr).toBeCloseTo(0.05, 8);
    expect(result.snapshot.spreadUnit).toBe('pips');
  });

  test('spreadPrice remains a direct price-unit input for spread filtering', () => {
    const strategy = new VolumeFlowHybridStrategy();
    const instrument = getInstrument('XAUUSD');

    const result = strategy._resolveSpreadInfo(
      { spreadPrice: 0.5 },
      {},
      instrument,
      5,
      { use_spread_filter: 1, max_spread_atr_xau: 0.08 }
    );

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('Spread too high relative to ATR');
    expect(result.snapshot.spread).toBeCloseTo(0.5, 8);
    expect(result.snapshot.spreadAtr).toBeCloseTo(0.1, 8);
    expect(result.snapshot.spreadUnit).toBe('price');
  });

  test('entry timeframe confirmation filters structure loss', () => {
    const candles = appendBreakoutCandle(buildBaselineCandles({ count: 280 }));
    const structureHigh = Math.max(...candles.slice(-14, -1).map((candle) => candle.high));
    const entryCandles = buildBaselineCandles({
      count: 12,
      drift: 0,
      baseVol: 80,
      startMs: Date.parse(candles[candles.length - 1].time) - 11 * 60 * 1000,
    });
    const lastEntry = entryCandles[entryCandles.length - 1];
    Object.assign(lastEntry, {
      open: structureHigh - 2,
      high: structureHigh - 1,
      low: structureHigh - 4,
      close: structureHigh - 3,
    });

    const result = runStrategy(candles, {
      entryCandles,
      parameterOverrides: {
        min_confidence: 0.1,
        entry_confirm_reject_strong_opposite_wick: 0,
      },
    });

    expect(result.signal).toBe('NONE');
    expect(result.status).toBe('FILTERED');
    expect(result.filterReason).toContain('structure hold failed');
  });

  test('exposes both module identifiers', () => {
    expect(VolumeFlowHybridStrategy.MODULE_BREAKOUT).toBe('BREAKOUT_CONTINUATION');
    expect(VolumeFlowHybridStrategy.MODULE_REVERSAL).toBe('EXHAUSTION_REVERSAL');
  });
});

describe('VolumeFlowHybrid registration', () => {
  test('strategy engine registers VolumeFlowHybrid', () => {
    const info = strategyEngine.getStrategiesInfo();
    const entry = info.find((i) => i.type === STRATEGY_TYPES.VOLUME_FLOW_HYBRID);
    expect(entry).toBeTruthy();
    expect(entry.symbols.length).toBeGreaterThan(0);
  });

  test('backtest engine accepts VolumeFlowHybrid via simulate()', async () => {
    const candles = buildBaselineCandles({ count: 700, drift: 0.2 });
    // Inject a few volume-spike breakouts
    for (let i = 300; i < candles.length; i += 80) {
      candles[i].volume = 1500;
      candles[i].tickVolume = 1500;
      const open = candles[i].open;
      candles[i].close = open + 6;
      candles[i].high = candles[i].close + 0.4;
    }
    const result = await backtestEngine.simulate({
      symbol: 'XAUUSD',
      strategyType: 'VolumeFlowHybrid',
      timeframe: '5m',
      candles,
      initialBalance: 10000,
      tradeStartTime: candles[0].time,
      tradeEndTime: candles[candles.length - 1].time,
    });
    expect(result.summary.totalTrades).toBeGreaterThanOrEqual(0);
    expect(result.parameters).toHaveProperty('rvol_continuation');
    expect(result.volumeFlowHybridBreakdown).toEqual(expect.objectContaining({
      module: expect.any(Object),
      symbol: expect.any(Object),
      session: expect.any(Object),
      direction: expect.any(Object),
      filterReason: expect.any(Object),
    }));
  });

  test('backtest engine keeps VolumeFlowHybrid filter stats when no trades are opened', () => {
    const breakdown = backtestEngine._generateVolumeFlowHybridBreakdown([], 'XAUUSD', {
      'Spread too high relative to ATR': {
        totalSignals: 42,
        module: null,
        session: null,
        status: 'FILTERED',
      },
    });

    expect(breakdown.module).toEqual({});
    expect(breakdown.filterImpact.spread.totalSignals).toBe(42);
    expect(breakdown.management).toEqual(expect.objectContaining({
      totalTrades: 0,
      partialCloseTrades: 0,
      maxHoldingExitTrades: 0,
      directionControlTriggeredTrades: 0,
    }));
    expect(breakdown.filterReason).toEqual({
      'Spread too high relative to ATR': {
        totalSignals: 42,
        module: null,
        session: null,
        status: 'FILTERED',
      },
    });
  });

  test('VolumeFlowHybrid breakdown exposes module, filter, and management audit stats', () => {
    const breakdown = backtestEngine._generateVolumeFlowHybridBreakdown([
      {
        type: 'BUY',
        profitLoss: -1.5,
        realizedRMultiple: -0.1,
        exitReason: 'BREAKEVEN_SL_HIT',
        breakevenActivated: true,
        trailingActivated: false,
        exitPlanSnapshot: {
          partials: [{ atProfitAtr: 1, closeFraction: 0.4 }],
          timeExit: { reason: 'VFH_BREAKOUT_MAX_HOLD', maxHoldMinutes: 120 },
        },
        indicatorsAtEntry: {
          module: 'BREAKOUT_CONTINUATION',
          sessionName: 'LONDON',
        },
        directionControl: { firstTriggered: true },
        directionControlEvents: [{ type: 'POST_ENTRY_DIRECTION_CONTROL' }],
      },
      {
        type: 'SELL',
        profitLoss: 8,
        realizedRMultiple: 1.2,
        exitReason: 'TP_HIT',
        breakevenActivated: true,
        trailingActivated: true,
        exitPlanSnapshot: {
          partials: [{ atProfitAtr: 0.8, closeFraction: 0.4 }],
          timeExit: { reason: 'VFH_REVERSAL_MAX_HOLD', maxHoldMinutes: 45 },
        },
        indicatorsAtEntry: {
          module: 'EXHAUSTION_REVERSAL',
          sessionName: 'NEWYORK',
        },
        directionControl: { firstTriggered: true },
      },
    ], 'XAUUSD', {
      'BREAKOUT_CONTINUATION not allowed in Asia session': {
        totalSignals: 3,
        module: 'BREAKOUT_CONTINUATION',
        session: 'ASIA',
        status: 'FILTERED',
      },
      'News blackout: CPI': {
        totalSignals: 2,
        module: null,
        session: null,
        status: 'FILTERED',
      },
      'Spread too high relative to ATR': {
        totalSignals: 5,
        module: null,
        session: null,
        status: 'FILTERED',
      },
    });

    expect(breakdown.module.BREAKOUT_CONTINUATION).toEqual(expect.objectContaining({
      totalTrades: 1,
      netPnl: -1.5,
    }));
    expect(breakdown.module.EXHAUSTION_REVERSAL).toEqual(expect.objectContaining({
      totalTrades: 1,
      netPnl: 8,
    }));
    expect(breakdown.filterImpact.session.totalSignals).toBe(3);
    expect(breakdown.filterImpact.news.totalSignals).toBe(2);
    expect(breakdown.filterImpact.spread.totalSignals).toBe(5);
    expect(breakdown.management).toEqual(expect.objectContaining({
      breakevenExitTrades: 1,
      breakevenTriggeredTrades: 2,
      trailingTriggeredTrades: 1,
      configuredPartialPlanTrades: 2,
      partialCloseTrades: 0,
      partialCloseSimulationStatus: 'not_simulated_or_not_triggered',
      configuredTimeExitTrades: 2,
      maxHoldingExitTrades: 0,
      maxHoldingSimulationStatus: 'not_simulated_or_not_triggered',
      directionControlTriggeredTrades: 2,
      directionControlThenHitTp: 1,
      directionControlThenHitSl: 1,
      bePostExitTpReachStatus: 'requires_post_exit_candle_capture',
    }));
    expect(breakdown.managementByModule.BREAKOUT_CONTINUATION).toEqual(expect.objectContaining({
      directionControlThenHitSl: 1,
    }));
  });

  test('backtest engine skips lower timeframe indicator builds for VolumeFlowHybrid', async () => {
    const setupCandles = buildBaselineCandles({ count: 320, drift: 0.2 });
    const entryCandles = buildBaselineCandles({
      count: 320,
      drift: 0.05,
      baseVol: 80,
    });
    const calcSpy = jest.spyOn(indicatorService, 'calculateForStrategy');

    await backtestEngine.simulate({
      symbol: 'XAUUSD',
      strategyType: 'VolumeFlowHybrid',
      timeframe: '5m',
      candles: setupCandles,
      lowerTfCandles: entryCandles,
      initialBalance: 10000,
      tradeStartTime: setupCandles[0].time,
      tradeEndTime: setupCandles[setupCandles.length - 1].time,
    });

    const vfhCalls = calcSpy.mock.calls.filter(([strategyType]) => strategyType === 'VolumeFlowHybrid');
    expect(vfhCalls).toHaveLength(1);
  });

  test('backtest engine returns chartData for VolumeFlowHybrid without persisting it', async () => {
    backtestsDb.insert.mockResolvedValue({ _id: 'bt-1' });
    const candles = buildBaselineCandles({ count: 700, drift: 0.2 });
    for (let i = 300; i < candles.length; i += 80) {
      candles[i].volume = 1500;
      candles[i].tickVolume = 1500;
      candles[i].close = candles[i].open + 6;
      candles[i].high = candles[i].close + 0.4;
    }

    const result = await backtestEngine.run({
      symbol: 'XAUUSD',
      strategyType: 'VolumeFlowHybrid',
      timeframe: '5m',
      candles,
      initialBalance: 10000,
      tradeStartTime: candles[100].time,
      tradeEndTime: candles[candles.length - 1].time,
      includeChartData: true,
      parameterPreset: 'default',
      parameterPresetResolution: {
        preset: 'default',
        fallbackUsed: false,
        resolvedFrom: 'instance',
      },
    });

    expect(result.chartData).toEqual(expect.objectContaining({
      strategy: 'VolumeFlowHybrid',
      effectiveTimeframe: '5m',
      candles: expect.any(Array),
      tradeEvents: expect.any(Array),
      panels: expect.any(Array),
    }));
    expect(result.chartData.panels.some((panel) =>
      panel.series.some((series) => series.id === 'sessionVwap' || series.id === 'cumulativeDelta' || series.id === 'rvol')
    )).toBe(true);
    expect(backtestsDb.insert).toHaveBeenCalledWith(expect.not.objectContaining({
      chartData: expect.anything(),
    }));
  });
});
