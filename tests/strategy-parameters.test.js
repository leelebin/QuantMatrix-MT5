const indicatorService = require('../src/services/indicatorService');
const BreakoutStrategy = require('../src/strategies/BreakoutStrategy');
const MeanReversionStrategy = require('../src/strategies/MeanReversionStrategy');
const { resolveStrategyParameters } = require('../src/config/strategyParameters');

function makeRangeCandles(closes) {
  return closes.map((close, index) => ({
    time: `2026-04-13T${String(index).padStart(2, '0')}:00:00.000Z`,
    open: close - 0.6,
    high: close + 0.2,
    low: close - 0.8,
    close,
  }));
}

function makeBreakoutCandles() {
  const candles = [];
  for (let i = 0; i < 20; i++) {
    candles.push({
      time: `2026-04-13T${String(i).padStart(2, '0')}:00:00.000Z`,
      open: 98.8,
      high: 110,
      low: 98.6,
      close: 99.0,
    });
  }

  const recent = [99.1, 99.2, 99.35, 99.5, 99.7];
  recent.forEach((close, offset) => {
    candles.push({
      time: `2026-04-14T0${offset}:00:00.000Z`,
      open: close - 0.6,
      high: close + 0.2,
      low: close - 0.8,
      close,
    });
  });

  candles.push({
    time: '2026-04-14T06:00:00.000Z',
    open: 99.2,
    high: 101.1,
    low: 98.8,
    close: 100.8,
  });

  return candles;
}

describe('strategy parameter wiring', () => {
  test('parameter resolution follows default -> instrument -> stored -> runtime priority', () => {
    const resolved = resolveStrategyParameters({
      strategyType: 'Breakout',
      instrument: {
        riskParams: {
          riskPercent: 0.01,
          slMultiplier: 2,
          tpMultiplier: 5,
        },
      },
      storedParameters: {
        slMultiplier: 2.5,
        lookback_period: 18,
      },
      overrides: {
        slMultiplier: 3,
        body_multiplier: 1.8,
      },
    });

    expect(resolved.lookback_period).toBe(18);
    expect(resolved.tpMultiplier).toBe(5);
    expect(resolved.slMultiplier).toBe(3);
    expect(resolved.body_multiplier).toBe(1.8);
  });

  test('indicator service maps momentum ema_period into the ema50 slot used by the strategy', () => {
    const candles = makeRangeCandles([100, 99, 98, 97, 96, 95, 94, 93, 94, 95, 96, 97, 98, 99, 100]);
    const closes = candles.map((c) => c.close);
    const shortIndicators = indicatorService.calculateAll(candles, { ema_period: 5 });
    const defaultIndicators = indicatorService.calculateAll(candles);

    expect(shortIndicators.ema50).toEqual(indicatorService.ema(closes, 5));
    expect(shortIndicators.ema50).not.toEqual(defaultIndicators.ema50);
  });

  test('mean reversion uses configurable RSI oversold / overbought thresholds', () => {
    const strategy = new MeanReversionStrategy();
    const candles = [
      { time: '2026-04-13T00:00:00.000Z', open: 1.01, high: 1.02, low: 0.95, close: 0.96 },
      { time: '2026-04-13T01:00:00.000Z', open: 0.97, high: 1.01, low: 0.96, close: 0.99 },
    ];
    const indicators = {
      bollingerBands: [
        { upper: 1.05, middle: 1.00, lower: 0.97 },
        { upper: 1.04, middle: 0.995, lower: 0.98 },
      ],
      rsi: [30, 30],
      atr: [0.02, 0.02],
    };
    const instrument = {
      pipSize: 0.0001,
      riskParams: { slMultiplier: 1.5, tpMultiplier: 2 },
    };

    const strict = strategy.analyze(candles, indicators, instrument, {
      strategyParams: { rsi_oversold: 25, rsi_overbought: 75 },
    });
    const permissive = strategy.analyze(candles, indicators, instrument, {
      strategyParams: { rsi_oversold: 35, rsi_overbought: 65 },
    });

    expect(strict.signal).toBe('NONE');
    expect(permissive.signal).toBe('BUY');
  });

  test('breakout uses configurable lookback period', () => {
    const strategy = new BreakoutStrategy();
    const candles = makeBreakoutCandles();
    const indicators = {
      rsi: Array(20).fill(60),
      atr: Array(20).fill(1),
    };
    const instrument = {
      pipSize: 0.01,
      riskParams: { slMultiplier: 2, tpMultiplier: 5 },
    };

    const shortLookback = strategy.analyze(candles, indicators, instrument, {
      strategyParams: { lookback_period: 5, body_multiplier: 1.1 },
    });
    const longLookback = strategy.analyze(candles, indicators, instrument, {
      strategyParams: { lookback_period: 20, body_multiplier: 1.1 },
    });

    expect(shortLookback.signal).toBe('BUY');
    expect(longLookback.signal).toBe('NONE');
  });

  test('breakout uses configurable body multiplier', () => {
    const strategy = new BreakoutStrategy();
    const candles = makeBreakoutCandles();
    candles[candles.length - 1] = {
      time: '2026-04-14T06:00:00.000Z',
      open: 99.95,
      high: 100.65,
      low: 99.65,
      close: 100.55,
    };

    const indicators = {
      rsi: Array(20).fill(60),
      atr: Array(20).fill(1),
    };
    const instrument = {
      pipSize: 0.01,
      riskParams: { slMultiplier: 2, tpMultiplier: 5 },
    };

    const permissive = strategy.analyze(candles, indicators, instrument, {
      strategyParams: { lookback_period: 5, body_multiplier: 1.0 },
    });
    const strict = strategy.analyze(candles, indicators, instrument, {
      strategyParams: { lookback_period: 5, body_multiplier: 1.3 },
    });

    expect(permissive.signal).toBe('BUY');
    expect(strict.signal).toBe('NONE');
  });
});
