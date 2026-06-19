const fs = require('fs');
const path = require('path');

const XauusdVolumeFlowBreakoutNyV1 = require('../src/symbolCustom/logics/XauusdVolumeFlowBreakoutNyV1');

function buildBreakoutCandles({ direction = 'BUY', count = 90 } = {}) {
  const candles = [];
  const startMs = Date.parse('2026-02-02T06:30:00Z');
  let close = direction === 'BUY' ? 2000 : 2050;

  for (let index = 0; index < count; index += 1) {
    const time = new Date(startMs + index * 5 * 60 * 1000).toISOString();
    const drift = direction === 'BUY' ? 0.35 : -0.35;
    const open = close;
    close = open + drift + ((index % 5) - 2) * 0.03;
    candles.push({
      time,
      open,
      high: Math.max(open, close) + 0.18,
      low: Math.min(open, close) - 0.18,
      close,
      volume: 100,
      tickVolume: 100,
      spread: 1,
    });
  }

  const previous = candles[candles.length - 2];
  const last = candles[candles.length - 1];
  if (direction === 'BUY') {
    candles[candles.length - 1] = {
      ...last,
      open: previous.close,
      close: previous.high + 2.2,
      high: previous.high + 2.55,
      low: previous.close - 0.12,
      volume: 500,
      tickVolume: 500,
      spread: 1,
    };
  } else {
    candles[candles.length - 1] = {
      ...last,
      open: previous.close,
      close: previous.low - 2.2,
      high: previous.close + 0.12,
      low: previous.low - 2.55,
      volume: 500,
      tickVolume: 500,
      spread: 1,
    };
  }

  return candles;
}

function buildContext(candles, overrides = {}) {
  return {
    scope: 'backtest',
    symbol: 'XAUUSD',
    symbolCustomName: 'XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1',
    candles: {
      setup: candles,
      entry: candles,
      higher: candles,
    },
    currentBar: candles[candles.length - 1],
    currentIndex: candles.length - 1,
    currentUtcHour: 15,
    parameters: {
      useSpreadFilter: true,
      maxSpreadAtr: 0.08,
    },
    ...overrides,
  };
}

describe('XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1', () => {
  test('scope paper returns NONE while validation is backtest-only', () => {
    const logic = new XauusdVolumeFlowBreakoutNyV1();
    const candles = buildBreakoutCandles();

    expect(logic.analyze(buildContext(candles, { scope: 'paper' }))).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'BLOCKED',
      reason: XauusdVolumeFlowBreakoutNyV1.BACKTEST_ONLY_REASON,
    }));
  });

  test('scope live returns NONE/BLOCKED', () => {
    const logic = new XauusdVolumeFlowBreakoutNyV1();

    expect(logic.analyze({ scope: 'live', symbol: 'XAUUSD' })).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'BLOCKED',
      reason: XauusdVolumeFlowBreakoutNyV1.LIVE_BLOCKED_REASON,
    }));
  });

  test('BUY setup can produce BUY with protective levels and metadata', () => {
    const logic = new XauusdVolumeFlowBreakoutNyV1();
    const candles = buildBreakoutCandles({ direction: 'BUY' });
    const result = logic.analyze(buildContext(candles));
    const close = candles[candles.length - 1].close;

    expect(result.signal).toBe('BUY');
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.sl).toBeLessThan(close);
    expect(result.tp).toBeGreaterThan(close);
    expect(result.marketQualityScore).toBeGreaterThanOrEqual(result.marketQualityThreshold);
    expect(result.metadata).toEqual(expect.objectContaining({
      source: 'symbolCustom',
      symbolCustomName: 'XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1',
      logicName: 'XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1',
      candidatePreset: 'xau_breakout_ny_15_16_17_rvol28_both',
      setupType: 'xauusd_volume_flow_breakout_ny',
      module: 'BREAKOUT_CONTINUATION',
      sessionName: 'NEWYORK',
      rvol: expect.any(Number),
      bodyAtr: expect.any(Number),
      atr: expect.any(Number),
      confidence: expect.any(Number),
    }));
  });

  test('SELL setup can produce SELL with protective levels', () => {
    const logic = new XauusdVolumeFlowBreakoutNyV1();
    const candles = buildBreakoutCandles({ direction: 'SELL' });
    const result = logic.analyze(buildContext(candles, {
      parameters: {
        enableSell: true,
        useSpreadFilter: true,
        maxSpreadAtr: 0.08,
      },
    }));
    const close = candles[candles.length - 1].close;

    expect(result.signal).toBe('SELL');
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
    expect(result.sl).toBeGreaterThan(close);
    expect(result.tp).toBeLessThan(close);
  });

  test('session guard blocks non-New-York hours by default', () => {
    const logic = new XauusdVolumeFlowBreakoutNyV1();
    const candles = buildBreakoutCandles({ direction: 'BUY' });

    expect(logic.analyze(buildContext(candles, { currentUtcHour: 8 }))).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'FILTERED',
      reason: 'XAUUSD volume-flow breakout filtered by UTC session',
    }));
  });

  test('daily trade guard blocks entries when maxTradesPerDay is reached', () => {
    const logic = new XauusdVolumeFlowBreakoutNyV1();
    const candles = buildBreakoutCandles({ direction: 'BUY' });

    expect(logic.analyze(buildContext(candles, {
      todayTrades: [{
        symbol: 'XAUUSD',
        logicName: 'XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1',
        symbolCustomName: 'XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1',
        entryTime: '2026-02-02T14:00:00.000Z',
      }],
      parameters: {
        maxTradesPerDay: 1,
        useSpreadFilter: true,
        maxSpreadAtr: 0.08,
      },
    }))).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'FILTERED',
      reasonCode: 'MAX_TRADES_PER_DAY_REACHED',
    }));
  });

  test('rolling loss cooldown blocks entries after configured consecutive losses', () => {
    const logic = new XauusdVolumeFlowBreakoutNyV1();
    const candles = buildBreakoutCandles({ direction: 'BUY' });

    expect(logic.analyze(buildContext(candles, {
      barsSinceLastExit: 5,
      closedTrades: [
        { symbol: 'XAUUSD', logicName: 'XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1', pnl: -1, exitReason: 'SL', exitIndex: 10 },
        { symbol: 'XAUUSD', logicName: 'XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1', pnl: -1, exitReason: 'SL', exitIndex: 20 },
      ],
      lastClosedTrade: {
        symbol: 'XAUUSD',
        logicName: 'XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1',
        pnl: -1,
        exitReason: 'SL',
        exitIndex: 20,
      },
      parameters: {
        maxRollingConsecutiveLosses: 2,
        rollingLossCooldownBars: 24,
        useSpreadFilter: true,
        maxSpreadAtr: 0.08,
      },
    }))).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'FILTERED',
      reasonCode: 'ROLLING_CONSECUTIVE_LOSS_GUARD_ACTIVE',
    }));
  });

  test('source file does not import six strategy classes or execution services', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'symbolCustom', 'logics', 'XauusdVolumeFlowBreakoutNyV1.js'),
      'utf8'
    );

    expect(source).not.toMatch(/src\/strategies|require\(['"].*strategies/);
    expect(source).not.toMatch(/VolumeFlowHybridStrategy|MomentumStrategy|BreakoutStrategy|MeanReversionStrategy|TrendFollowingStrategy|MultiTimeframeStrategy/);
    expect(source).not.toMatch(/tradeExecutor|riskManager|paperTradingService/);
  });
});
