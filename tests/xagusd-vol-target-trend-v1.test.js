const fs = require('fs');
const path = require('path');

const XagusdVolTargetTrendV1 = require('../src/symbolCustom/logics/XagusdVolTargetTrendV1');
const { runSymbolCustomBacktestSimulation } = require('../src/services/symbolCustomBacktestRunnerService');

function buildTrendCandles({ direction = 'BUY', extraBars = 0, spikeLastBar = false } = {}) {
  const candles = [];
  const startMs = Date.parse('2026-01-01T00:00:00Z');
  let close = direction === 'BUY' ? 24 : 34;
  const drift = direction === 'BUY' ? 0.035 : -0.035;

  for (let index = 0; index < 180; index += 1) {
    const time = new Date(startMs + index * 60 * 60 * 1000).toISOString();
    const open = close;
    close = open + drift + ((index % 4) - 1.5) * 0.002;
    candles.push({
      time,
      open,
      high: Math.max(open, close) + 0.025,
      low: Math.min(open, close) - 0.025,
      close,
      volume: 200,
      tickVolume: 200,
      spread: 2,
    });
  }

  const signalIndex = candles.length;
  const signalTime = new Date(startMs + signalIndex * 60 * 60 * 1000).toISOString();
  const signalOpen = close;
  close = direction === 'BUY' ? signalOpen + 0.28 : signalOpen - 0.28;
  candles.push({
    time: signalTime,
    open: signalOpen,
    high: spikeLastBar ? Math.max(signalOpen, close) + 1.8 : Math.max(signalOpen, close) + 0.03,
    low: spikeLastBar ? Math.min(signalOpen, close) - 1.8 : Math.min(signalOpen, close) - 0.03,
    close,
    volume: 260,
    tickVolume: 260,
    spread: 2,
  });

  for (let index = 0; index < extraBars; index += 1) {
    const time = new Date(startMs + (signalIndex + 1 + index) * 60 * 60 * 1000).toISOString();
    const open = close;
    close = direction === 'BUY' ? open + 0.22 : open - 0.22;
    candles.push({
      time,
      open,
      high: Math.max(open, close) + 0.04,
      low: Math.min(open, close) - 0.04,
      close,
      volume: 240,
      tickVolume: 240,
      spread: 2,
    });
  }

  return candles;
}

function buildHigherCandles({ direction = 'BUY' } = {}) {
  const candles = [];
  const startMs = Date.parse('2025-12-01T00:00:00Z');
  let close = direction === 'BUY' ? 22 : 36;
  const drift = direction === 'BUY' ? 0.12 : -0.12;
  for (let index = 0; index < 140; index += 1) {
    const time = new Date(startMs + index * 4 * 60 * 60 * 1000).toISOString();
    const open = close;
    close = open + drift + ((index % 3) - 1) * 0.006;
    candles.push({
      time,
      open,
      high: Math.max(open, close) + 0.05,
      low: Math.min(open, close) - 0.05,
      close,
      volume: 600,
      tickVolume: 600,
      spread: 2,
    });
  }
  return candles;
}

function buildContext({ direction = 'BUY', candles = null, higher = null, parameters = {} } = {}) {
  const setup = candles || buildTrendCandles({ direction });
  const higherCandles = higher || buildHigherCandles({ direction });
  return {
    scope: 'backtest',
    symbol: 'XAGUSD',
    symbolCustomName: 'XAGUSD_VOL_TARGET_TREND_V1',
    timeframes: {
      setupTimeframe: '1h',
      entryTimeframe: '1h',
      higherTimeframe: '4h',
    },
    candles: {
      setup,
      entry: setup,
      higher: higherCandles,
    },
    currentBar: setup[setup.length - 1],
    currentIndex: setup.length - 1,
    currentUtcHour: 8,
    parameters: {
      enabled: true,
      maxDailyTrades: 0,
      allowedUtcHours: [],
      maxExtensionAtr: 20,
      ...parameters,
    },
  };
}

describe('XAGUSD_VOL_TARGET_TREND_V1', () => {
  test('default parameter enabled=false returns NONE', () => {
    const logic = new XagusdVolTargetTrendV1();
    const result = logic.analyze(buildContext({ parameters: { enabled: false } }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reasonCode: 'STRATEGY_DISABLED',
    }));
  });

  test('BUY setup produces BUY with volatility metadata', () => {
    const logic = new XagusdVolTargetTrendV1();
    const candles = buildTrendCandles({ direction: 'BUY' });
    const close = candles[candles.length - 1].close;

    const result = logic.analyze(buildContext({
      direction: 'BUY',
      candles,
      parameters: { maxAtrRatio: 10 },
    }));

    expect(result.signal).toBe('BUY');
    expect(result.sl).toBeLessThan(close);
    expect(result.tp).toBeGreaterThan(close);
    expect(result.riskReward).toBeCloseTo(2.0, 5);
    expect(result.marketQualityScore).toBeGreaterThanOrEqual(result.marketQualityThreshold);
    expect(result.metadata).toEqual(expect.objectContaining({
      source: 'symbolCustom',
      symbolCustomName: 'XAGUSD_VOL_TARGET_TREND_V1',
      logicName: 'XAGUSD_VOL_TARGET_TREND_V1',
      setupType: 'vol_target_trend',
      module: 'VOL_TARGET_TREND_FOLLOWING',
      pattern: 'VOL_TARGET_UPTREND_BREAKOUT',
      atrRatio: expect.any(Number),
      riskScale: expect.any(Number),
    }));
    expect(result.metadata.debug).toEqual(expect.objectContaining({
      setupTrendPassed: true,
      higherTrendPassed: true,
      momentumPassed: true,
      breakoutPassed: true,
    }));
  });

  test('SELL setup produces SELL with protective levels', () => {
    const logic = new XagusdVolTargetTrendV1();
    const candles = buildTrendCandles({ direction: 'SELL' });
    const close = candles[candles.length - 1].close;

    const result = logic.analyze(buildContext({ direction: 'SELL', candles }));

    expect(result.signal).toBe('SELL');
    expect(result.sl).toBeGreaterThan(close);
    expect(result.tp).toBeLessThan(close);
    expect(result.metadata.pattern).toBe('VOL_TARGET_DOWNTREND_BREAKDOWN');
  });

  test('ATR spike filter rejects chase entries', () => {
    const logic = new XagusdVolTargetTrendV1();
    const candles = buildTrendCandles({ direction: 'BUY', spikeLastBar: true });

    const result = logic.analyze(buildContext({
      direction: 'BUY',
      candles,
      parameters: { maxAtrRatio: 10 },
    }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reasonCode: 'ATR_SPIKE_AVOID_CHASING',
    }));
  });

  test('live scope remains blocked', () => {
    const logic = new XagusdVolTargetTrendV1();

    expect(logic.analyze({ scope: 'live', symbol: 'XAGUSD' })).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'BLOCKED',
      reason: XagusdVolTargetTrendV1.LIVE_BLOCKED_REASON,
    }));
  });

  test('symbolCustom backtest runner can execute the logic', async () => {
    const logic = new XagusdVolTargetTrendV1();
    const candles = buildTrendCandles({ direction: 'BUY', extraBars: 8 });
    const higher = buildHigherCandles({ direction: 'BUY' });

    const result = await runSymbolCustomBacktestSimulation({
      symbolCustom: {
        _id: 'xag-vol-target',
        symbol: 'XAGUSD',
        symbolCustomName: 'XAGUSD_VOL_TARGET_TREND_V1',
        logicName: 'XAGUSD_VOL_TARGET_TREND_V1',
        timeframes: { setupTimeframe: '1h', entryTimeframe: '1h', higherTimeframe: '4h' },
        riskConfig: { maxRiskPerTradePct: 0.5 },
        parameters: { enabled: true, maxDailyTrades: 0, allowedUtcHours: [], maxExtensionAtr: 20 },
      },
      logic,
      logicName: 'XAGUSD_VOL_TARGET_TREND_V1',
      candles: { setup: candles, entry: candles, higher },
      parameters: { enabled: true, maxDailyTrades: 0, allowedUtcHours: [], maxExtensionAtr: 20 },
      costModel: { spread: 0.001, slippage: 0, commissionPerTrade: 0 },
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
      symbol: 'XAGUSD',
      symbolCustomName: 'XAGUSD_VOL_TARGET_TREND_V1',
      logicName: 'XAGUSD_VOL_TARGET_TREND_V1',
    }));
  });

  test('source file stays SymbolCustom-only', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'symbolCustom', 'logics', 'XagusdVolTargetTrendV1.js'),
      'utf8'
    );

    expect(source).not.toMatch(/src\/strategies|require\(['"].*strategies/);
    expect(source).not.toMatch(/tradeExecutor|riskManager|paperTradingService/);
  });
});
