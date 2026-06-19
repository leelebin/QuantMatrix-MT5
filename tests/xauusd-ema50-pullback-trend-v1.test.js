const fs = require('fs');
const path = require('path');

const XauusdEma50PullbackTrendV1 = require('../src/symbolCustom/logics/XauusdEma50PullbackTrendV1');
const { runSymbolCustomBacktestSimulation } = require('../src/services/symbolCustomBacktestRunnerService');

function buildPullbackCandles({ direction = 'BUY' } = {}) {
  const candles = [];
  const startMs = Date.parse('2026-02-02T00:00:00Z');
  let close = direction === 'BUY' ? 2000 : 2600;

  for (let index = 0; index < 220; index += 1) {
    const time = new Date(startMs + index * 30 * 60 * 1000).toISOString();
    const drift = direction === 'BUY' ? 1.2 : -1.2;
    const open = close;
    close = open + drift + ((index % 5) - 2) * 0.05;
    candles.push({
      time,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 100,
      tickVolume: 100,
      spread: 20,
    });
  }

  for (let index = 0; index < 14; index += 1) {
    const time = new Date(startMs + (220 + index) * 30 * 60 * 1000).toISOString();
    const drift = direction === 'BUY' ? -5 : 5;
    const open = close;
    close = open + drift;
    candles.push({
      time,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 110,
      tickVolume: 110,
      spread: 20,
    });
  }

  const finalIndex = candles.length;
  const time = new Date(startMs + finalIndex * 30 * 60 * 1000).toISOString();
  const open = close;
  close = direction === 'BUY' ? open + 60 : open - 60;
  candles.push({
    time,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 180,
    tickVolume: 180,
    spread: 20,
  });

  return candles;
}

function buildContext(candles, overrides = {}) {
  return {
    scope: 'backtest',
    symbol: 'XAUUSD',
    symbolCustomName: 'XAUUSD_EMA50_PULLBACK_TREND_V1',
    timeframes: {
      setupTimeframe: '30m',
      entryTimeframe: '30m',
      higherTimeframe: '30m',
    },
    candles: {
      setup: candles,
      entry: candles,
      higher: candles,
    },
    currentBar: candles[candles.length - 1],
    currentIndex: candles.length - 1,
    currentUtcHour: 8,
    parameters: {
      enabled: true,
      maxDailyTrades: 0,
    },
    ...overrides,
  };
}

describe('XAUUSD_EMA50_PULLBACK_TREND_V1', () => {
  test('default parameter enabled=false returns NONE', () => {
    const logic = new XauusdEma50PullbackTrendV1();
    const candles = buildPullbackCandles();

    const result = logic.analyze(buildContext(candles, { parameters: {} }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reasonCode: 'STRATEGY_DISABLED',
    }));
  });

  test('BUY setup produces BUY with ATR protective levels and trend metadata', () => {
    const logic = new XauusdEma50PullbackTrendV1();
    const candles = buildPullbackCandles({ direction: 'BUY' });
    const close = candles[candles.length - 1].close;

    const result = logic.analyze(buildContext(candles));

    expect(result.signal).toBe('BUY');
    expect(result.sl).toBeLessThan(close);
    expect(result.tp).toBeGreaterThan(close);
    expect(result.riskReward).toBeCloseTo(1.8, 5);
    expect(result.marketQualityScore).toBeGreaterThanOrEqual(result.marketQualityThreshold);
    expect(result.metadata).toEqual(expect.objectContaining({
      source: 'symbolCustom',
      symbolCustomName: 'XAUUSD_EMA50_PULLBACK_TREND_V1',
      logicName: 'XAUUSD_EMA50_PULLBACK_TREND_V1',
      setupType: 'ema50_pullback_trend',
      module: 'TREND_PULLBACK_CONTINUATION',
      pattern: 'EMA50_PULLBACK_RSI50_RECOVERY',
      ema20: expect.any(Number),
      ema50: expect.any(Number),
      ema200: expect.any(Number),
      rsi: expect.any(Number),
    }));
    expect(result.metadata.debug).toEqual(expect.objectContaining({
      trendPassed: true,
      reclaimPassed: true,
      momentumPassed: true,
      pullbackTouch: expect.objectContaining({ touched: true }),
    }));
  });

  test('SELL setup produces SELL with ATR protective levels', () => {
    const logic = new XauusdEma50PullbackTrendV1();
    const candles = buildPullbackCandles({ direction: 'SELL' });
    const close = candles[candles.length - 1].close;

    const result = logic.analyze(buildContext(candles));

    expect(result.signal).toBe('SELL');
    expect(result.sl).toBeGreaterThan(close);
    expect(result.tp).toBeLessThan(close);
    expect(result.metadata.pattern).toBe('EMA50_PULLBACK_RSI50_ROLLOVER');
  });

  test('live scope remains blocked', () => {
    const logic = new XauusdEma50PullbackTrendV1();

    expect(logic.analyze({ scope: 'live', symbol: 'XAUUSD' })).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'BLOCKED',
      reason: XauusdEma50PullbackTrendV1.LIVE_BLOCKED_REASON,
    }));
  });

  test('spread filter rejects wide spreads', () => {
    const logic = new XauusdEma50PullbackTrendV1();
    const candles = buildPullbackCandles({ direction: 'BUY' }).map((candle) => ({ ...candle, spread: 120 }));

    const result = logic.analyze(buildContext(candles));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reasonCode: 'SPREAD_TOO_WIDE',
    }));
  });

  test('open position can be closed by the 96-bar timeout guard', () => {
    const logic = new XauusdEma50PullbackTrendV1();
    const candles = buildPullbackCandles({ direction: 'BUY' });

    const result = logic.analyze(buildContext(candles, {
      currentIndex: 120,
      openPosition: {
        entryIndex: 24,
        entryTime: candles[24].time,
      },
    }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'CLOSE',
      status: 'TRIGGERED',
    }));
    expect(result.metadata).toEqual(expect.objectContaining({
      exitRule: 'MAX_BARS_IN_TRADE',
    }));
  });

  test('rolling loss cooldown blocks new entries after cross-day consecutive losses', () => {
    const logic = new XauusdEma50PullbackTrendV1();
    const candles = buildPullbackCandles({ direction: 'BUY' });

    const result = logic.analyze(buildContext(candles, {
      barsSinceLastExit: 12,
      closedTrades: [
        { pnl: -5, exitTime: '2026-02-01T20:00:00Z', exitIndex: 210 },
        { pnl: -4, exitTime: '2026-02-02T02:00:00Z', exitIndex: 222 },
      ],
      todayClosedTrades: [],
      parameters: {
        enabled: true,
        maxDailyTrades: 0,
        maxRollingConsecutiveLosses: 2,
        rollingLossCooldownBars: 36,
      },
    }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'FILTERED',
      reasonCode: 'ROLLING_CONSECUTIVE_LOSS_GUARD_ACTIVE',
    }));
    expect(result.metadata.debug).toEqual(expect.objectContaining({
      rollingConsecutiveLosses: 2,
      maxRollingConsecutiveLosses: 2,
      barsSinceLastExit: 12,
      rollingLossCooldownBars: 36,
    }));
  });

  test('rolling loss cooldown default is disabled for backward-compatible parameters', () => {
    const parameters = XauusdEma50PullbackTrendV1.normalizeParameters({
      enabled: true,
    });

    expect(parameters.maxRollingConsecutiveLosses).toBe(0);
    expect(parameters.rollingLossCooldownBars).toBe(0);
  });

  test('symbolCustom backtest runner can execute the logic without paper/live services', async () => {
    const logic = new XauusdEma50PullbackTrendV1();
    const candles = buildPullbackCandles({ direction: 'BUY' });

    const result = await runSymbolCustomBacktestSimulation({
      symbolCustom: {
        _id: 'xau-ema50',
        symbol: 'XAUUSD',
        symbolCustomName: 'XAUUSD_EMA50_PULLBACK_TREND_V1',
        logicName: 'XAUUSD_EMA50_PULLBACK_TREND_V1',
        timeframes: { setupTimeframe: '30m', entryTimeframe: '30m', higherTimeframe: '30m' },
        parameters: { enabled: true, maxDailyTrades: 0, allowedUtcHours: [] },
      },
      logic,
      logicName: 'XAUUSD_EMA50_PULLBACK_TREND_V1',
      candles: { setup: candles, entry: candles, higher: candles },
      parameters: { enabled: true, maxDailyTrades: 0, allowedUtcHours: [] },
      costModel: { spread: 0.1, slippage: 0, commissionPerTrade: 0 },
      initialBalance: 500,
      options: {
        executionPolicy: {
          minExecutionScore: 0.6,
          cooldownBarsAfterLoss: 0,
          maxSameDirectionPositionsPerSymbol: 1,
          maxSameDirectionPositionsPerCategory: 2,
          duplicateEntryWindowBars: 0,
        },
      },
    });

    expect(result.status).toBe('completed');
    expect(result.summary.rawSignals).toBeGreaterThanOrEqual(1);
    expect(result.summary.openedSignals).toBeGreaterThanOrEqual(1);
    expect(result.trades.length).toBeGreaterThanOrEqual(1);
    expect(result.trades[0]).toEqual(expect.objectContaining({
      symbol: 'XAUUSD',
      symbolCustomName: 'XAUUSD_EMA50_PULLBACK_TREND_V1',
      logicName: 'XAUUSD_EMA50_PULLBACK_TREND_V1',
    }));
  });

  test('source file stays SymbolCustom-only', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'symbolCustom', 'logics', 'XauusdEma50PullbackTrendV1.js'),
      'utf8'
    );

    expect(source).not.toMatch(/src\/strategies|require\(['"].*strategies/);
    expect(source).not.toMatch(/tradeExecutor|riskManager|paperTradingService/);
  });
});
