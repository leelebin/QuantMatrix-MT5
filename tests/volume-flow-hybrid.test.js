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
  function runStrategy(candles, { entryCandles = candles, instrumentSymbol = 'XAUUSD' } = {}) {
    const strategy = new VolumeFlowHybridStrategy();
    const executionConfig = getStrategyExecutionConfig(instrumentSymbol, 'VolumeFlowHybrid');
    const instrument = { ...getInstrument(instrumentSymbol), ...executionConfig };
    const params = resolveStrategyParameters({
      strategyType: 'VolumeFlowHybrid',
      instrument,
      storedParameters: null,
    });
    const indicators = indicatorService.calculateAll(candles, params);
    return strategy.analyze(candles, indicators, instrument, {
      strategyParams: params,
      entryCandles,
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
