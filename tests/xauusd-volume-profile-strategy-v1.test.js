const XauusdVolumeProfileStrategyV1 = require('../src/symbolCustom/logics/XauusdVolumeProfileStrategyV1');
const { runSymbolCustomBacktestSimulation } = require('../src/services/symbolCustomBacktestRunnerService');

function buildSetupCandles({ direction = 'BUY', count = 90 } = {}) {
  const candles = [];
  const startMs = Date.parse('2026-05-01T08:00:00Z');
  let close = direction === 'BUY' ? 2300 : 2350;
  for (let index = 0; index < count; index += 1) {
    const drift = direction === 'BUY' ? 0.16 : -0.16;
    const open = close;
    close = open + drift;
    candles.push({
      time: new Date(startMs + index * 5 * 60 * 1000).toISOString(),
      open,
      high: Math.max(open, close) + 0.25,
      low: Math.min(open, close) - 0.25,
      close,
      volume: 100,
      spread: 20,
    });
  }
  return candles;
}

function buildEntryCandles({ direction = 'BUY', count = 100, wideSpread = false } = {}) {
  const candles = [];
  const startMs = Date.parse('2026-05-01T15:00:00Z');
  let close = direction === 'BUY' ? 2320 : 2330;
  for (let index = 0; index < count - 1; index += 1) {
    const drift = direction === 'BUY' ? 0.015 : -0.015;
    const open = close;
    close = open + drift + ((index % 4) - 1.5) * 0.002;
    candles.push({
      time: new Date(startMs + index * 60 * 1000).toISOString(),
      open,
      high: Math.max(open, close) + 0.34,
      low: Math.min(open, close) - 0.34,
      close,
      volume: 100,
      tickVolume: 100,
      spread: wideSpread ? 50 : 20,
    });
  }

  const lastTime = new Date(startMs + (count - 1) * 60 * 1000).toISOString();
  if (direction === 'BUY') {
    const structureHigh = Math.max(...candles.slice(-12).map((candle) => candle.high));
    candles.push({
      time: lastTime,
      open: structureHigh - 0.08,
      high: structureHigh + 0.58,
      low: structureHigh - 0.16,
      close: structureHigh + 0.52,
      volume: 220,
      tickVolume: 220,
      spread: wideSpread ? 50 : 20,
    });
  } else {
    const structureLow = Math.min(...candles.slice(-12).map((candle) => candle.low));
    candles.push({
      time: lastTime,
      open: structureLow + 0.08,
      high: structureLow + 0.16,
      low: structureLow - 0.58,
      close: structureLow - 0.52,
      volume: 220,
      tickVolume: 220,
      spread: wideSpread ? 50 : 20,
    });
  }
  return candles;
}

function buildContext({ direction = 'BUY', parameters = {}, wideSpread = false, overrides = {} } = {}) {
  const entry = buildEntryCandles({ direction, wideSpread });
  const setup = buildSetupCandles({ direction });
  return {
    scope: 'backtest',
    symbol: 'XAUUSD',
    symbolCustomName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
    logicName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
    timeframes: { setupTimeframe: '5m', entryTimeframe: '1m', higherTimeframe: '15m' },
    candles: { setup, entry, higher: setup },
    currentBar: entry[entry.length - 1],
    currentIndex: entry.length - 1,
    parameters,
    ...overrides,
  };
}

describe('XAUUSD_VOLUME_PROFILE_STRATEGY_V1', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('default parameters keep breakout continuation on and reversal off', () => {
    const defaults = new XauusdVolumeProfileStrategyV1().getDefaultParameters();

    expect(defaults).toEqual(expect.objectContaining({
      enabled: true,
      strategyName: 'XAUUSD Volume Profile',
      setupTimeframe: '5m',
      entryTimeframe: '1m',
      higherTimeframe: '15m',
      enableBreakoutContinuation: true,
      enableExhaustionReversal: false,
      allowBuySignals: true,
      allowSellSignals: true,
      restrictEntrySessionUtc: true,
      entrySessionRangesUtc: [[1, 5], [15, 18]],
      breakoutLookback: 8,
      minTrendEmaSeparationAtr: 0,
      riskReward: 1.5,
      maxHoldingMinutes: 30,
      maxSpreadPoints: 35,
      cooldownMinutes: 10,
      maxTradesPerDay: 5,
      maxConsecutiveLossesPerDay: 2,
      maxRollingConsecutiveLosses: 0,
      rollingLossCooldownMinutes: 1440,
      minConfidence: 65,
    }));
  });

  test('disabled parameter returns a clear no-signal result', () => {
    const logic = new XauusdVolumeProfileStrategyV1();

    expect(logic.analyze(buildContext({ parameters: { enabled: false } }))).toEqual(expect.objectContaining({
      signal: 'NONE',
      reasonCode: 'STRATEGY_DISABLED',
      strategyName: 'XAUUSD Volume Profile',
    }));
  });

  test('produces BUY breakout signal with full signal fields and indicator snapshot', () => {
    const logic = new XauusdVolumeProfileStrategyV1();
    const result = logic.analyze(buildContext({ direction: 'BUY' }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'BUY',
      symbol: 'XAUUSD',
      side: 'BUY',
      strategyName: 'XAUUSD Volume Profile',
      moduleName: 'BREAKOUT_CONTINUATION',
      riskReward: 1.5,
      confidence: expect.any(Number),
      score: expect.any(Number),
      reason: expect.stringContaining('BREAKOUT_CONTINUATION BUY'),
      indicators: expect.objectContaining({
        rvol: expect.any(Number),
        atr: expect.any(Number),
        emaFast: expect.any(Number),
        emaSlow: expect.any(Number),
        vwap: expect.any(Number),
        bodyAtrRatio: expect.any(Number),
        spreadPoints: 20,
        breakoutLookback: 8,
      }),
    }));
    expect(result.entry).toBeGreaterThan(result.stopLoss);
    expect(result.takeProfit).toBeGreaterThan(result.entry);
    expect(result.score).toBeGreaterThanOrEqual(65);
  });

  test('produces SELL breakout signal with fixed SL and TP', () => {
    const logic = new XauusdVolumeProfileStrategyV1();
    const result = logic.analyze(buildContext({ direction: 'SELL' }));

    expect(result.signal).toBe('SELL');
    expect(result.stopLoss).toBeGreaterThan(result.entry);
    expect(result.takeProfit).toBeLessThan(result.entry);
    expect(result.reason).toContain('BREAKOUT_CONTINUATION SELL');
  });

  test('BUY-only mode filters SELL breakout signals', () => {
    const logic = new XauusdVolumeProfileStrategyV1();
    const result = logic.analyze(buildContext({
      direction: 'SELL',
      parameters: { allowSellSignals: false },
    }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reasonCode: 'DIRECTION_FILTERED',
      metadata: expect.objectContaining({ side: 'SELL' }),
    }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('DIRECTION_FILTERED'));
  });

  test('EMA separation range filter rejects weak trend breakouts', () => {
    const logic = new XauusdVolumeProfileStrategyV1();
    const result = logic.analyze(buildContext({
      direction: 'BUY',
      parameters: { minTrendEmaSeparationAtr: 100 },
    }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reasonCode: 'RANGE_FILTERED',
      metadata: expect.objectContaining({ side: 'BUY' }),
    }));
    expect(result.indicators).toEqual(expect.objectContaining({
      trendEmaSeparationAtr: expect.any(Number),
    }));
  });

  test('spread filter rejects setups above maxSpreadPoints and logs the rejection', () => {
    const logic = new XauusdVolumeProfileStrategyV1();
    const result = logic.analyze(buildContext({ direction: 'BUY', wideSpread: true }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reasonCode: 'SPREAD_TOO_WIDE',
    }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('SPREAD_TOO_WIDE'));
  });

  test('entry session filter rejects new setups outside configured UTC ranges', () => {
    const logic = new XauusdVolumeProfileStrategyV1();
    const context = buildContext({ direction: 'BUY' });
    context.currentBar = {
      ...context.currentBar,
      time: '2026-05-01T12:39:00.000Z',
    };

    expect(logic.analyze(context)).toEqual(expect.objectContaining({
      signal: 'NONE',
      reasonCode: 'ENTRY_SESSION_FILTERED',
    }));
  });

  test('incremental VWAP matches intraday calculation and resets after five candles on a new day', () => {
    const candles = [];
    const append = (time, close, volume) => {
      const candle = {
        time,
        open: close - 0.1,
        high: close + 0.2,
        low: close - 0.2,
        close,
        volume,
      };
      candles.push(candle);
      return XauusdVolumeProfileStrategyV1.calculateVwap(candles, candle);
    };
    const expectedVwap = (rows) => rows.reduce((sum, candle) => {
      return sum + (((candle.high + candle.low + candle.close) / 3) * candle.volume);
    }, 0) / rows.reduce((sum, candle) => sum + candle.volume, 0);

    for (let index = 0; index < 6; index += 1) {
      append(`2026-05-01T00:0${index}:00Z`, 2300 + index, 100 + index);
    }
    expect(XauusdVolumeProfileStrategyV1.calculateVwap(candles, candles[candles.length - 1]))
      .toBeCloseTo(expectedVwap(candles), 10);

    const nextDay = [];
    for (let index = 0; index < 5; index += 1) {
      append(`2026-05-02T00:0${index}:00Z`, 2400 + index, 200 + index);
      nextDay.push(candles[candles.length - 1]);
    }
    expect(XauusdVolumeProfileStrategyV1.calculateVwap(candles, candles[candles.length - 1]))
      .toBeCloseTo(expectedVwap(nextDay), 10);
  });

  test('incremental EMA matches full-series EMA while candles are appended', () => {
    const candles = [];
    const closes = [2300, 2302, 2301, 2305, 2304, 2308, 2306, 2310];
    const expectedEma = (values, period) => {
      if (values.length < period) return null;
      const multiplier = 2 / (period + 1);
      let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
      values.slice(period).forEach((value) => {
        ema = ((value - ema) * multiplier) + ema;
      });
      return ema;
    };

    closes.forEach((close, index) => {
      candles.push({ time: `2026-05-01T00:0${index}:00Z`, close });
      const actual = XauusdVolumeProfileStrategyV1.calculateEma(candles, 3);
      const expected = expectedEma(closes.slice(0, index + 1), 3);
      if (expected === null) {
        expect(actual).toBeNull();
      } else {
        expect(actual).toBeCloseTo(expected, 10);
      }
    });
  });

  test('same-day consecutive loss guard halts only this strategy and symbol', () => {
    const logic = new XauusdVolumeProfileStrategyV1();
    const todayLosses = [
      {
        symbol: 'XAUUSD',
        symbolCustomName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
        logicName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
        pnl: -5,
        exitTime: '2026-05-01T15:10:00Z',
      },
      {
        symbol: 'XAUUSD',
        symbolCustomName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
        logicName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
        pnl: -4,
        exitTime: '2026-05-01T15:20:00Z',
      },
    ];

    const result = logic.analyze(buildContext({
      direction: 'BUY',
      overrides: {
        todayClosedTrades: todayLosses,
        closedTrades: todayLosses,
      },
    }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reasonCode: 'CONSECUTIVE_LOSS_GUARD_ACTIVE',
    }));
    expect(result.reason).toContain('XAUUSD Volume Profile halted for XAUUSD today');
  });

  test('rolling consecutive loss cooldown can halt signals across UTC days', () => {
    const logic = new XauusdVolumeProfileStrategyV1();
    const rollingLosses = [
      {
        symbol: 'XAUUSD',
        symbolCustomName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
        logicName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
        pnl: -5,
        exitTime: '2026-05-01T14:30:00Z',
      },
      {
        symbol: 'XAUUSD',
        symbolCustomName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
        logicName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
        pnl: -4,
        exitTime: '2026-05-01T15:30:00Z',
      },
    ];

    const result = logic.analyze(buildContext({
      direction: 'BUY',
      parameters: {
        maxConsecutiveLossesPerDay: 0,
        maxRollingConsecutiveLosses: 2,
        rollingLossCooldownMinutes: 180,
      },
      overrides: {
        closedTrades: rollingLosses,
        todayClosedTrades: [],
      },
    }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reasonCode: 'ROLLING_CONSECUTIVE_LOSS_GUARD_ACTIVE',
    }));
  });

  test('maxHoldingMinutes returns CLOSE with MAX_HOLDING_TIME_EXIT', () => {
    const logic = new XauusdVolumeProfileStrategyV1();
    const entry = buildEntryCandles();
    const currentBar = {
      ...entry[entry.length - 1],
      time: '2026-05-01T16:00:00.000Z',
      close: 2322,
    };

    const result = logic.analyze(buildContext({
      overrides: {
        currentBar,
        openPosition: {
          symbol: 'XAUUSD',
          entryTime: '2026-05-01T15:20:00.000Z',
          side: 'BUY',
        },
      },
    }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'CLOSE',
      reason: 'MAX_HOLDING_TIME_EXIT',
      reasonCode: 'MAX_HOLDING_TIME_EXIT',
      strategyName: 'XAUUSD Volume Profile',
      moduleName: 'POSITION_MONITOR',
    }));
  });

  test('backtest runner preserves custom max-holding exit reason and trade detail fields', async () => {
    const logic = {
      analyze: jest.fn(async (context) => {
        if (context.currentIndex === 0) {
          return {
            signal: 'BUY',
            strategyName: 'XAUUSD Volume Profile',
            moduleName: 'BREAKOUT_CONTINUATION',
            confidence: 0.8,
            score: 80,
            sl: 95,
            tp: 110,
            indicators: { rvol: 1.8 },
            reason: 'mock open',
            metadata: {
              strategyName: 'XAUUSD Volume Profile',
              moduleName: 'BREAKOUT_CONTINUATION',
              indicators: { rvol: 1.8 },
            },
          };
        }
        if (context.currentIndex === 1) {
          return {
            signal: 'CLOSE',
            reason: 'MAX_HOLDING_TIME_EXIT',
            reasonCode: 'MAX_HOLDING_TIME_EXIT',
            metadata: { exitRule: 'MAX_HOLDING_TIME_EXIT' },
          };
        }
        return { signal: 'NONE' };
      }),
    };

    const result = await runSymbolCustomBacktestSimulation({
      symbolCustom: {
        _id: 'xau-volume-profile',
        symbol: 'XAUUSD',
        symbolCustomName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
        logicName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
        timeframes: { setupTimeframe: '5m', entryTimeframe: '1m', higherTimeframe: '15m' },
        parameters: {},
      },
      logic,
      logicName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
      candles: {
        setup: [
          { time: '2026-05-01T00:00:00Z', open: 100, high: 101, low: 99, close: 100 },
          { time: '2026-05-01T00:01:00Z', open: 100, high: 104, low: 99, close: 104 },
        ],
        entry: [
          { time: '2026-05-01T00:00:00Z', open: 100, high: 101, low: 99, close: 100 },
          { time: '2026-05-01T00:01:00Z', open: 100, high: 104, low: 99, close: 104 },
        ],
        higher: [],
      },
      parameters: {},
      costModel: { spread: 0, slippage: 0, commissionPerTrade: 0 },
      initialBalance: 500,
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toEqual(expect.objectContaining({
      exitReason: 'MAX_HOLDING_TIME_EXIT',
      strategyName: 'XAUUSD Volume Profile',
      moduleName: 'BREAKOUT_CONTINUATION',
      indicators: { rvol: 1.8 },
    }));
    expect(result.summary).toEqual(expect.objectContaining({
      avgWin: expect.any(Number),
      avgLoss: expect.any(Number),
      maxConsecutiveLosses: expect.any(Number),
      dailyTradeCounts: expect.objectContaining({ '2026-05-01': 1 }),
      modulePerformance: expect.objectContaining({
        BREAKOUT_CONTINUATION: expect.objectContaining({ trades: 1 }),
      }),
    }));
  });

  test('source file stays independent from original strategy classes and execution services', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'symbolCustom', 'logics', 'XauusdVolumeProfileStrategyV1.js'),
      'utf8'
    );

    expect(source).not.toMatch(/src\/strategies|require\(['"].*strategies/);
    expect(source).not.toMatch(/VolumeFlowHybridStrategy|MomentumStrategy|BreakoutStrategy|MeanReversionStrategy|TrendFollowingStrategy|MultiTimeframeStrategy/);
    expect(source).not.toMatch(/tradeExecutor|riskManager|paperTradingService/);
  });
});
