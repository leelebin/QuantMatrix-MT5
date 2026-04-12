const TrendFollowingStrategy = require('../src/strategies/TrendFollowingStrategy');
const MultiTimeframeStrategy = require('../src/strategies/MultiTimeframeStrategy');
const strategyEngine = require('../src/services/strategyEngine');
const { STRATEGY_TYPES } = require('../src/config/instruments');

function makeCandles(values, prefix = '2026-04-12T') {
  return values.map((value, index) => ({
    time: `${prefix}${String(index).padStart(2, '0')}:00:00.000Z`,
    open: value - 0.001,
    high: value + 0.002,
    low: value - 0.002,
    close: value,
  }));
}

describe('lower timeframe entry logic', () => {
  beforeEach(() => {
    strategyEngine.signals = [];
    strategyEngine.lastEmittedSignals.clear();
    jest.restoreAllMocks();
  });

  test('TrendFollowing waits for a 15m reclaim before triggering a BUY', () => {
    const strategy = new TrendFollowingStrategy();
    const instrument = {
      timeframe: '1h',
      entryTimeframe: '15m',
      pipSize: 0.0001,
      riskParams: { slMultiplier: 1.5, tpMultiplier: 3 },
    };

    const candles = makeCandles([1.09, 1.095, 1.102, 1.108]);
    const indicators = {
      ema20: [1.09, 1.094, 1.099, 1.105],
      ema50: [1.095, 1.096, 1.098, 1.1],
      rsi: [42, 47, 52, 55],
      atr: Array(20).fill(0.004),
    };

    const waiting = strategy.analyze(candles, indicators, instrument, {
      entryCandles: makeCandles([1.103, 1.106, 1.107], '2026-04-12T10:'),
      entryIndicators: {
        ema20: [1.101, 1.104, 1.106],
        rsi: [49, 52, 56],
        atr: [0.0015, 0.0016, 0.0017],
      },
    });

    expect(waiting.signal).toBe('NONE');
    expect(waiting.setupActive).toBe(true);
    expect(waiting.status).toBe('SETUP_ACTIVE');
    expect(waiting.triggerReason).toContain('reclaim EMA20');

    const triggered = strategy.analyze(candles, indicators, instrument, {
      entryCandles: makeCandles([1.103, 1.1035, 1.1062], '2026-04-12T11:'),
      entryIndicators: {
        ema20: [1.104, 1.104, 1.105],
        rsi: [49, 52, 56],
        atr: [0.0015, 0.0016, 0.004],
      },
    });

    expect(triggered.signal).toBe('BUY');
    expect(triggered.setupTimeframe).toBe('1h');
    expect(triggered.entryTimeframe).toBe('15m');
    expect(triggered.triggerReason).toContain('reclaimed EMA20');
  });

  test('TrendFollowing blocks a BUY when 15m price is too extended from EMA20', () => {
    const strategy = new TrendFollowingStrategy();
    const instrument = {
      timeframe: '1h',
      entryTimeframe: '15m',
      pipSize: 0.0001,
      riskParams: { slMultiplier: 1.5, tpMultiplier: 3 },
    };

    const result = strategy.analyze(makeCandles([1.09, 1.095, 1.102, 1.108]), {
      ema20: [1.09, 1.094, 1.099, 1.105],
      ema50: [1.095, 1.096, 1.098, 1.1],
      rsi: [42, 47, 52, 55],
      atr: Array(20).fill(0.004),
    }, instrument, {
      entryCandles: makeCandles([1.103, 1.1035, 1.111], '2026-04-12T12:'),
      entryIndicators: {
        ema20: [1.104, 1.104, 1.105],
        rsi: [49, 52, 58],
        atr: [0.0015, 0.0016, 0.004],
      },
    });

    expect(result.signal).toBe('NONE');
    expect(result.setupActive).toBe(true);
    expect(result.triggerReason).toContain('too extended');
  });

  test('MultiTimeframe requires aligned 15m trigger and blocks low-volatility entries', () => {
    const strategy = new MultiTimeframeStrategy();
    strategy.setHigherTimeframeTrend('BULLISH', { ema200: 2400, price: 2420 });

    const instrument = {
      timeframe: '1h',
      entryTimeframe: '15m',
      pipSize: 0.01,
      riskParams: { slMultiplier: 2, tpMultiplier: 5 },
    };

    const candles = makeCandles([2410, 2415, 2420], '2026-04-12T20:');
    const indicators = {
      ema200: [2390, 2395, 2400],
      macd: [
        { MACD: -0.5, signal: -0.3, histogram: -0.2 },
        { MACD: 0.1, signal: -0.05, histogram: 0.15 },
        { MACD: 0.3, signal: 0.1, histogram: 0.2 },
      ],
      stochastic: [
        { k: 35, d: 40 },
        { k: 48, d: 45 },
        { k: 58, d: 50 },
      ],
      atr: Array(20).fill(8),
    };

    const lowVol = strategy.analyze(candles, indicators, instrument, {
      entryCandles: makeCandles([2418, 2419, 2422], '2026-04-12T21:'),
      entryIndicators: {
        macd: [
          { MACD: 0.05, signal: 0.01, histogram: 0.04 },
          { MACD: 0.06, signal: 0.02, histogram: 0.04 },
          { MACD: 0.08, signal: 0.03, histogram: 0.05 },
        ],
        stochastic: [
          { k: 42, d: 43 },
          { k: 44, d: 44 },
          { k: 50, d: 46 },
        ],
        atr: Array(20).fill(0.4).concat([0.2]),
      },
    });

    expect(lowVol.signal).toBe('NONE');
    expect(lowVol.triggerReason).toContain('volatility too low');

    const triggered = strategy.analyze(candles, indicators, instrument, {
      entryCandles: makeCandles([2418, 2419, 2422], '2026-04-12T22:'),
      entryIndicators: {
        macd: [
          { MACD: 0.05, signal: 0.01, histogram: 0.04 },
          { MACD: 0.06, signal: 0.02, histogram: 0.04 },
          { MACD: 0.08, signal: 0.03, histogram: 0.05 },
        ],
        stochastic: [
          { k: 42, d: 43 },
          { k: 44, d: 44 },
          { k: 50, d: 46 },
        ],
        atr: Array(20).fill(0.4).concat([0.35]),
      },
    });

    expect(triggered.signal).toBe('BUY');
    expect(triggered.entryTimeframe).toBe('15m');
    expect(triggered.triggerReason).toContain('MACD histogram positive');
  });

  test('strategyEngine fetches entry timeframe candles and logs setup-only states', async () => {
    const analyzeSpy = jest.spyOn(
      strategyEngine.strategies[STRATEGY_TYPES.TREND_FOLLOWING],
      'analyze'
    ).mockReturnValue({
      signal: 'NONE',
      confidence: 0.65,
      sl: 1.095,
      tp: 1.11,
      reason: '1h BUY setup active',
      indicatorsSnapshot: { atr: 0.002 },
      setupTimeframe: '1h',
      entryTimeframe: '15m',
      triggerReason: 'Waiting for 15m reclaim',
      setupActive: true,
      setupDirection: 'BUY',
      status: 'SETUP_ACTIVE',
      setupCandleTime: '2026-04-12T03:00:00.000Z',
      entryCandleTime: '2026-04-12T03:45:00.000Z',
    });

    const candles = makeCandles(Array.from({ length: 60 }, (_, i) => 1.05 + (i * 0.001)), '2026-04-12T');
    const getCandlesFn = jest.fn(async (_symbol, timeframe) => {
      if (timeframe === '15m') {
        return makeCandles(Array.from({ length: 60 }, (_, i) => 1.05 + (i * 0.0002)), '2026-04-12T10:');
      }
      return candles;
    });
    const onSignalFn = jest.fn();

    await strategyEngine.analyzeAll(getCandlesFn, onSignalFn, ['EURUSD']);

    expect(getCandlesFn).toHaveBeenCalledWith('EURUSD', '1h', 251);
    expect(getCandlesFn).toHaveBeenCalledWith('EURUSD', '15m', 251);
    expect(onSignalFn).not.toHaveBeenCalled();
    expect(strategyEngine.getRecentSignals('EURUSD', 1)[0]).toEqual(expect.objectContaining({
      status: 'SETUP_ACTIVE',
      setupTimeframe: '1h',
      entryTimeframe: '15m',
      triggerReason: 'Waiting for 15m reclaim',
    }));

    analyzeSpy.mockReturnValue({
      signal: 'BUY',
      confidence: 0.8,
      sl: 1.095,
      tp: 1.11,
      reason: '1h BUY setup active',
      indicatorsSnapshot: { atr: 0.002 },
      setupTimeframe: '1h',
      entryTimeframe: '15m',
      triggerReason: '15m reclaim confirmed',
      setupActive: true,
      setupDirection: 'BUY',
      status: 'TRIGGERED',
      setupCandleTime: '2026-04-12T03:00:00.000Z',
      entryCandleTime: '2026-04-12T04:00:00.000Z',
    });

    await strategyEngine.analyzeAll(getCandlesFn, onSignalFn, ['EURUSD']);
    await strategyEngine.analyzeAll(getCandlesFn, onSignalFn, ['EURUSD']);

    expect(onSignalFn).toHaveBeenCalledTimes(1);
  });
});
