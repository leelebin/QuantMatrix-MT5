jest.mock('../src/models/Strategy', () => ({
  findAll: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/services/strategyInstanceService', () => ({
  getStrategyInstance: jest.fn(),
}));

const MomentumStrategy = require('../src/strategies/MomentumStrategy');
const BreakoutStrategy = require('../src/strategies/BreakoutStrategy');
const strategyEngine = require('../src/services/strategyEngine');
const Strategy = require('../src/models/Strategy');
const { getStrategyInstance } = require('../src/services/strategyInstanceService');
const { STRATEGY_TYPES } = require('../src/config/instruments');

function makeMomentumCandles({ lastThreeBody = 1.2, baseBody = 0.4 } = {}) {
  const closes = [100, 100.3, 100.6, 100.9, 101.2, 101.5, 101.8, 102.1, 102.6, 103.1, 103.6, 104.1];
  return closes.map((close, index) => {
    const body = index >= 8 && index <= 10 ? lastThreeBody : baseBody;
    const open = close - body;
    return {
      time: `2026-04-13T${String(index).padStart(2, '0')}:00:00.000Z`,
      open,
      high: close + 0.4,
      low: open - 0.2,
      close,
    };
  });
}

function makeBreakoutCandles({ positiveSlope = true, breakoutClose = 100.2, breakoutBody = 1.4, currentRange = 1.8 } = {}) {
  const candles = [];
  for (let i = 0; i < 24; i++) {
    let close;
    if (i < 14) {
      close = 99.2 + (i * 0.03);
    } else if (positiveSlope) {
      close = 99.1 + ((i - 14) * 0.08);
    } else {
      close = 99.9 - ((i - 14) * 0.08);
    }
    const open = close - 0.6;
    candles.push({
      time: `2026-04-13T${String(i).padStart(2, '0')}:00:00.000Z`,
      open,
      high: close + 0.2,
      low: open - 0.2,
      close,
    });
  }

  candles.push({
    time: '2026-04-14T00:00:00.000Z',
    open: breakoutClose - breakoutBody,
    high: breakoutClose + ((currentRange - breakoutBody) / 2),
    low: (breakoutClose - breakoutBody) - ((currentRange - breakoutBody) / 2),
    close: breakoutClose,
  });

  return candles;
}

describe('market quality filters', () => {
  beforeEach(() => {
    strategyEngine.signals = [];
    strategyEngine.lastEmittedSignals.clear();
    jest.restoreAllMocks();
    Strategy.findAll.mockResolvedValue([]);
    getStrategyInstance.mockImplementation(async () => ({
      parameters: {},
      enabled: true,
      source: 'instance',
    }));
  });

  test('Momentum filters low-volatility regimes even when direction aligns', () => {
    const strategy = new MomentumStrategy();
    const result = strategy.analyze(makeMomentumCandles(), {
      ema50: [100.5, 101.0, 101.6, 102.1, 102.7],
      rsi: [54, 57, 60],
      macd: [
        { MACD: 1.1, signal: 0.8, histogram: 0.3 },
        { MACD: 1.2, signal: 0.85, histogram: 0.35 },
        { MACD: 1.3, signal: 0.9, histogram: 0.4 },
      ],
      atr: Array(19).fill(2).concat([1]),
    }, {
      pipSize: 0.01,
      riskParams: { slMultiplier: 1.5, tpMultiplier: 3 },
    });

    expect(result.signal).toBe('NONE');
    expect(result.status).toBe('FILTERED');
    expect(result.filterReason).toContain('ATR regime below threshold');
    expect(result.marketQualityThreshold).toBe(2);
  });

  test('Momentum filters weak EMA50 slope before allowing entry', () => {
    const strategy = new MomentumStrategy();
    const result = strategy.analyze(makeMomentumCandles({ lastThreeBody: 1.2, baseBody: 0.4 }), {
      ema50: [102.4, 102.45, 102.5, 102.55, 102.6],
      rsi: [54, 57, 60],
      macd: [
        { MACD: 1.1, signal: 0.8, histogram: 0.32 },
        { MACD: 1.12, signal: 0.82, histogram: 0.3 },
        { MACD: 1.18, signal: 0.86, histogram: 0.34 },
      ],
      atr: Array(20).fill(2),
    }, {
      pipSize: 0.01,
      riskParams: { slMultiplier: 1.5, tpMultiplier: 3 },
    });

    expect(result.signal).toBe('NONE');
    expect(result.filterReason).toContain('weak EMA50 slope');
    expect(result.marketQualityScore).toBe(1);
  });

  test('Momentum allows entries once 2 of 3 quality checks pass', () => {
    const strategy = new MomentumStrategy();
    const result = strategy.analyze(makeMomentumCandles({ lastThreeBody: 1.2, baseBody: 0.4 }), {
      ema50: [101.8, 102.1, 102.5, 102.9, 103.3],
      rsi: [54, 57, 60],
      macd: [
        { MACD: 1.1, signal: 0.8, histogram: 0.32 },
        { MACD: 1.12, signal: 0.82, histogram: 0.3 },
        { MACD: 1.18, signal: 0.86, histogram: 0.34 },
      ],
      atr: Array(20).fill(2),
    }, {
      pipSize: 0.01,
      riskParams: { slMultiplier: 1.5, tpMultiplier: 3 },
    });

    expect(result.signal).toBe('BUY');
    expect(result.marketQualityScore).toBe(2);
    expect(result.reason).toContain('quality 2/3');
  });

  test('Momentum still blocks entries when only 1 quality check passes', () => {
    const strategy = new MomentumStrategy();
    const result = strategy.analyze(makeMomentumCandles({ lastThreeBody: 0.3, baseBody: 1.0 }), {
      ema50: [101.8, 102.1, 102.5, 102.9, 103.3],
      rsi: [54, 57, 60],
      macd: [
        { MACD: 1.1, signal: 0.8, histogram: 0.32 },
        { MACD: 1.12, signal: 0.82, histogram: 0.3 },
        { MACD: 1.18, signal: 0.86, histogram: 0.34 },
      ],
      atr: Array(20).fill(2),
    }, {
      pipSize: 0.01,
      riskParams: { slMultiplier: 1.5, tpMultiplier: 3 },
    });

    expect(result.signal).toBe('NONE');
    expect(result.marketQualityScore).toBe(1);
    expect(result.filterReason).toContain('weak directional candle bodies');
  });

  test('Breakout filters shallow breaks that do not clear structure enough', () => {
    const strategy = new BreakoutStrategy();
    const result = strategy.analyze(makeBreakoutCandles({ breakoutClose: 100.05 }), {
      rsi: [56, 58, 60],
      atr: Array(20).fill(1),
    }, {
      pipSize: 0.01,
      riskParams: { slMultiplier: 2, tpMultiplier: 5 },
    });

    expect(result.signal).toBe('NONE');
    expect(result.filterReason).toContain('break distance below quality threshold');
  });

  test('Breakout filters weak breakout quality when body and range do not expand enough', () => {
    const strategy = new BreakoutStrategy();
    const result = strategy.analyze(makeBreakoutCandles({ breakoutClose: 100.4, breakoutBody: 0.65, currentRange: 0.9 }), {
      rsi: [56, 58, 60],
      atr: Array(20).fill(1),
    }, {
      pipSize: 0.01,
      riskParams: { slMultiplier: 2, tpMultiplier: 5 },
    });

    expect(result.signal).toBe('NONE');
    expect(result.marketQualityScore).toBe(1);
    expect(result.filterReason).toContain('weak breakout body conviction');
  });

  test('Breakout filters breaks that fight the recent close slope', () => {
    const strategy = new BreakoutStrategy();
    const result = strategy.analyze(makeBreakoutCandles({ positiveSlope: false, breakoutClose: 100.4 }), {
      rsi: [56, 58, 60],
      atr: Array(20).fill(1),
    }, {
      pipSize: 0.01,
      riskParams: { slMultiplier: 2, tpMultiplier: 5 },
    });

    expect(result.signal).toBe('NONE');
    expect(result.filterReason).toContain('short-term slope opposes breakout direction');
  });

  test('Breakout still opens trades when quality score reaches threshold', () => {
    const strategy = new BreakoutStrategy();
    const result = strategy.analyze(makeBreakoutCandles({ positiveSlope: true, breakoutClose: 100.4, breakoutBody: 1.5, currentRange: 1.9 }), {
      rsi: [56, 58, 60],
      atr: Array(20).fill(1),
    }, {
      pipSize: 0.01,
      riskParams: { slMultiplier: 2, tpMultiplier: 5 },
    });

    expect(result.signal).toBe('BUY');
    expect(result.marketQualityScore).toBeGreaterThanOrEqual(2);
  });

  test('strategyEngine keeps filtered market-quality signals in recentSignals', async () => {
    const analyzeSpy = jest.spyOn(
      strategyEngine.strategies[STRATEGY_TYPES.MOMENTUM],
      'analyze'
    ).mockReturnValue({
      signal: 'NONE',
      confidence: 0,
      sl: 0,
      tp: 0,
      reason: 'Momentum filtered: weak EMA50 slope',
      filterReason: 'Momentum filtered: weak EMA50 slope',
      marketQualityScore: 1,
      marketQualityThreshold: 2,
      marketQualityDetails: {
        ema50SlopeScore: 0,
        directionalBodyScore: 1,
        momentumPersistenceScore: 0,
      },
      indicatorsSnapshot: {
        marketQualityScore: 1,
      },
      status: 'FILTERED',
    });

    const candles = Array.from({ length: 60 }, (_, index) => ({
      time: `2026-04-13T${String(index).padStart(2, '0')}:00:00.000Z`,
      open: 100 + index,
      high: 100.5 + index,
      low: 99.5 + index,
      close: 100.2 + index,
    }));

    const getCandlesFn = jest.fn(async () => candles);
    const onSignalFn = jest.fn();

    await strategyEngine.analyzeAll(getCandlesFn, onSignalFn, ['US30']);

    expect(onSignalFn).not.toHaveBeenCalled();
    expect(strategyEngine.getRecentSignals('US30', 1)[0]).toEqual(expect.objectContaining({
      status: 'FILTERED',
      filterReason: 'Momentum filtered: weak EMA50 slope',
      marketQualityScore: 1,
      marketQualityThreshold: 2,
      marketQualityDetails: expect.objectContaining({
        ema50SlopeScore: 0,
      }),
    }));

    analyzeSpy.mockRestore();
  });
});
