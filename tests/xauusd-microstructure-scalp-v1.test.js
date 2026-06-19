const fs = require('fs');
const path = require('path');

const XauusdMicrostructureScalpV1 = require('../src/symbolCustom/logics/XauusdMicrostructureScalpV1');
const { runSymbolCustomBacktestSimulation } = require('../src/services/symbolCustomBacktestRunnerService');

function buildScalpCandles({ direction = 'BUY', count = 90 } = {}) {
  const candles = [];
  const startMs = Date.parse('2026-05-01T07:00:00Z');
  let close = direction === 'BUY' ? 2300 : 2350;

  for (let index = 0; index < count; index += 1) {
    const time = new Date(startMs + index * 60 * 1000).toISOString();
    const drift = direction === 'BUY' ? 0.08 : -0.08;
    const open = close;
    close = open + drift + ((index % 3) - 1) * 0.01;
    candles.push({
      time,
      open,
      high: Math.max(open, close) + 0.12,
      low: Math.min(open, close) - 0.12,
      close,
      volume: 100 + index,
      spread: 10,
    });
  }

  const previous = candles[candles.length - 2];
  const last = candles[candles.length - 1];
  if (direction === 'BUY') {
    const structureHigh = Math.max(...candles.slice(-14, -1).map((candle) => candle.high));
    candles[candles.length - 1] = {
      ...last,
      open: structureHigh - 0.16,
      low: structureHigh - 0.22,
      close: structureHigh + 0.20,
      high: structureHigh + 0.28,
      volume: 260,
      spread: 10,
    };
  } else {
    const structureLow = Math.min(...candles.slice(-14, -1).map((candle) => candle.low));
    candles[candles.length - 1] = {
      ...last,
      open: structureLow + 0.16,
      high: structureLow + 0.22,
      close: structureLow - 0.20,
      low: structureLow - 0.28,
      volume: 260,
      spread: 10,
    };
  }

  return candles;
}

function buildContext(candles, overrides = {}) {
  return {
    scope: 'backtest',
    symbol: 'XAUUSD',
    symbolCustomName: 'XAUUSD_MICROSTRUCTURE_SCALP_V1',
    timeframes: {
      setupTimeframe: '5m',
      entryTimeframe: '1m',
      higherTimeframe: '15m',
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
      minSignalScore: 70,
      spreadMaxPoints: 45,
      allowedUtcHours: [],
    },
    ...overrides,
  };
}

describe('XAUUSD_MICROSTRUCTURE_SCALP_V1', () => {
  test('default parameter enabled=false returns NONE', () => {
    const logic = new XauusdMicrostructureScalpV1();
    const candles = buildScalpCandles();

    const result = logic.analyze(buildContext(candles, { parameters: {} }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reasonCode: 'STRATEGY_DISABLED',
    }));
  });

  test('paper scope can produce BUY with candleProxy debug and protective levels', () => {
    const logic = new XauusdMicrostructureScalpV1();
    const candles = buildScalpCandles({ direction: 'BUY' });
    const close = candles[candles.length - 1].close;

    const result = logic.analyze(buildContext(candles, { scope: 'paper' }));

    expect(result.signal).toBe('BUY');
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.sl).toBeLessThan(close);
    expect(result.tp).toBeGreaterThan(close);
    expect(result.marketQualityScore).toBeGreaterThanOrEqual(result.marketQualityThreshold);
    expect(result.metadata).toEqual(expect.objectContaining({
      source: 'symbolCustom',
      symbolCustomName: 'XAUUSD_MICROSTRUCTURE_SCALP_V1',
      logicName: 'XAUUSD_MICROSTRUCTURE_SCALP_V1',
      strategyType: 'SymbolCustom',
      setupType: 'microstructure_scalp',
      dataMode: 'candleProxy',
      pattern: 'VWAP_RECLAIM_WITH_BULLISH_ABSORPTION',
      scoreBreakdown: expect.objectContaining({
        microstructureScore: expect.any(Number),
      }),
    }));
  });

  test('backtest scope can produce SELL with 1:1.5 style RR', () => {
    const logic = new XauusdMicrostructureScalpV1();
    const candles = buildScalpCandles({ direction: 'SELL' });
    const close = candles[candles.length - 1].close;

    const result = logic.analyze(buildContext(candles, { scope: 'backtest' }));

    expect(result.signal).toBe('SELL');
    expect(result.sl).toBeGreaterThan(close);
    expect(result.tp).toBeLessThan(close);
    expect(result.riskReward).toBeGreaterThanOrEqual(1.49);
    expect(result.riskReward).toBeLessThanOrEqual(1.51);
  });

  test('live scope remains blocked', () => {
    const logic = new XauusdMicrostructureScalpV1();

    expect(logic.analyze({ scope: 'live', symbol: 'XAUUSD' })).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'BLOCKED',
      reason: XauusdMicrostructureScalpV1.LIVE_BLOCKED_REASON,
    }));
  });

  test('spread filter rejects wide spreads with reason code', () => {
    const logic = new XauusdMicrostructureScalpV1();
    const candles = buildScalpCandles({ direction: 'BUY' }).map((candle) => ({ ...candle, spread: 200 }));

    expect(logic.analyze(buildContext(candles))).toEqual(expect.objectContaining({
      signal: 'NONE',
      reasonCode: 'SPREAD_TOO_WIDE',
    }));
  });

  test('consecutive loss guard is scoped to today, not the full backtest history', () => {
    const logic = new XauusdMicrostructureScalpV1();
    const candles = buildScalpCandles({ direction: 'BUY' });
    const priorDayLosses = [
      { pnl: -5, exitReason: 'SL', exitTime: '2026-04-30T08:10:00Z' },
      { pnl: -5, exitReason: 'SL', exitTime: '2026-04-30T09:10:00Z' },
    ];

    const result = logic.analyze(buildContext(candles, {
      closedTrades: priorDayLosses,
      todayClosedTrades: [],
      parameters: {
        enabled: true,
        minSignalScore: 70,
        maxConsecutiveLosses: 2,
      },
    }));

    expect(result.signal).toBe('BUY');
  });

  test('consecutive loss guard blocks after same-day consecutive losses', () => {
    const logic = new XauusdMicrostructureScalpV1();
    const candles = buildScalpCandles({ direction: 'BUY' });
    const todayLosses = [
      { pnl: -5, exitReason: 'SL', exitTime: '2026-05-01T07:10:00Z' },
      { pnl: -5, exitReason: 'SL', exitTime: '2026-05-01T08:10:00Z' },
    ];

    const result = logic.analyze(buildContext(candles, {
      closedTrades: todayLosses,
      todayClosedTrades: todayLosses,
      parameters: {
        enabled: true,
        minSignalScore: 70,
        maxConsecutiveLosses: 2,
      },
    }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reasonCode: 'CONSECUTIVE_LOSS_GUARD_ACTIVE',
    }));
  });

  test('entry quality guard can filter close direction ratios outside configured band', () => {
    const logic = new XauusdMicrostructureScalpV1();
    const candles = buildScalpCandles({ direction: 'BUY' });

    const result = logic.analyze(buildContext(candles, {
      parameters: {
        enabled: true,
        minSignalScore: 70,
        useEntryQualityGuards: true,
        minEntryCloseDirectionRatio: 0,
        maxEntryCloseDirectionRatio: 0.75,
      },
    }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reasonCode: 'MICROSTRUCTURE_SCORE_TOO_LOW',
    }));
  });

  test('symbolCustom backtest runner can execute the logic without paper/live services', async () => {
    const logic = new XauusdMicrostructureScalpV1();
    const candles = buildScalpCandles({ direction: 'BUY' });

    const result = await runSymbolCustomBacktestSimulation({
      symbolCustom: {
        _id: 'xau-micro',
        symbol: 'XAUUSD',
        symbolCustomName: 'XAUUSD_MICROSTRUCTURE_SCALP_V1',
        logicName: 'XAUUSD_MICROSTRUCTURE_SCALP_V1',
        timeframes: { setupTimeframe: '5m', entryTimeframe: '1m', higherTimeframe: '15m' },
        parameters: { enabled: true, minSignalScore: 70 },
      },
      logic,
      logicName: 'XAUUSD_MICROSTRUCTURE_SCALP_V1',
      candles: { setup: candles, entry: candles, higher: candles },
      parameters: { enabled: true, minSignalScore: 70 },
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
      symbolCustomName: 'XAUUSD_MICROSTRUCTURE_SCALP_V1',
      logicName: 'XAUUSD_MICROSTRUCTURE_SCALP_V1',
      side: 'BUY',
      confidence: expect.any(Number),
    }));
  });


  test('source file does not import six strategies or execution services', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'symbolCustom', 'logics', 'XauusdMicrostructureScalpV1.js'),
      'utf8'
    );

    expect(source).not.toMatch(/src\/strategies|require\(['"].*strategies/);
    expect(source).not.toMatch(/VolumeFlowHybridStrategy|MomentumStrategy|BreakoutStrategy|MeanReversionStrategy|TrendFollowingStrategy|MultiTimeframeStrategy/);
    expect(source).not.toMatch(/tradeExecutor|riskManager|paperTradingService/);
  });
});
