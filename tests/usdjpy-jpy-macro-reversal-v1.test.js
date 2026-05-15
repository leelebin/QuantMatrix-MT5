const fs = require('fs');
const path = require('path');

const UsdjpyJpyMacroReversalV1 = require('../src/symbolCustom/logics/UsdjpyJpyMacroReversalV1');

function buildCandles({ direction = 'down', count = 48 } = {}) {
  const candles = [];
  let previousClose = direction === 'down' ? 150 : 140;

  for (let index = 0; index < count; index += 1) {
    const time = new Date(Date.UTC(2026, 0, 1, 0, index * 5)).toISOString();
    const delta = direction === 'down' ? -0.16 : 0.16;
    const close = previousClose + delta;
    candles.push({
      time,
      open: previousClose,
      high: Math.max(previousClose, close) + 0.08,
      low: Math.min(previousClose, close) - 0.08,
      close,
      volume: 100 + index,
    });
    previousClose = close;
  }

  const last = candles[candles.length - 1];
  if (direction === 'down') {
    candles[candles.length - 1] = {
      ...last,
      open: last.close - 0.08,
      low: last.close - 0.2,
      high: last.close + 0.08,
      close: last.close,
    };
  } else {
    candles[candles.length - 1] = {
      ...last,
      open: last.close + 0.08,
      low: last.close - 0.08,
      high: last.close + 0.2,
      close: last.close,
    };
  }

  return candles;
}

function buildContext(candles, overrides = {}) {
  return {
    scope: 'backtest',
    symbol: 'USDJPY',
    symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
    candles: {
      setup: candles,
      entry: candles,
      higher: candles,
    },
    currentBar: candles[candles.length - 1],
    currentIndex: candles.length - 1,
    parameters: {
      lookbackBars: 36,
      impulseAtrMultiplier: 1.2,
      reversalConfirmBars: 2,
      rsiPeriod: 14,
      rsiOverbought: 68,
      rsiOversold: 32,
      atrPeriod: 14,
      slAtrMultiplier: 1.2,
      tpAtrMultiplier: 1.8,
      maxBarsInTrade: 18,
      minAtr: 0,
      cooldownBars: 6,
      enableBuy: true,
      enableSell: true,
      allowedUtcHours: '',
      blockedUtcHours: '',
      cooldownBarsAfterAnyExit: 0,
      cooldownBarsAfterSL: 0,
      maxDailyLosses: 0,
      maxDailyTrades: 0,
    },
    ...overrides,
  };
}

describe('USDJPY_JPY_MACRO_REVERSAL_V1', () => {
  test('scope paper returns NONE', () => {
    const logic = new UsdjpyJpyMacroReversalV1();

    expect(logic.analyze({ scope: 'paper', symbol: 'USDJPY' })).toEqual(expect.objectContaining({
      signal: 'NONE',
      reason: UsdjpyJpyMacroReversalV1.BACKTEST_ONLY_REASON,
    }));
  });

  test('scope live returns NONE', () => {
    const logic = new UsdjpyJpyMacroReversalV1();

    expect(logic.analyze({ scope: 'live', symbol: 'USDJPY' })).toEqual(expect.objectContaining({
      signal: 'NONE',
      reason: UsdjpyJpyMacroReversalV1.BACKTEST_ONLY_REASON,
    }));
  });

  test('backtest with insufficient candles returns NONE', () => {
    const logic = new UsdjpyJpyMacroReversalV1();
    const candles = buildCandles({ direction: 'down', count: 10 });

    expect(logic.analyze(buildContext(candles))).toEqual(expect.objectContaining({
      signal: 'NONE',
      reason: 'Not enough candles for USDJPY macro reversal analysis',
    }));
  });

  test('BUY setup can produce BUY with protective levels and metadata', () => {
    const logic = new UsdjpyJpyMacroReversalV1();
    const candles = buildCandles({ direction: 'down' });
    const result = logic.analyze(buildContext(candles));
    const entryClose = candles[candles.length - 1].close;

    expect(result.signal).toBe('BUY');
    expect(result.sl).toBeLessThan(entryClose);
    expect(result.tp).toBeGreaterThan(entryClose);
    expect(result.metadata).toEqual(expect.objectContaining({
      symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      setup: 'jpy_macro_reversal',
      atr: expect.any(Number),
      rsi: expect.any(Number),
      recentMove: expect.any(Number),
      impulseAtrMultiplier: 1.2,
      slAtrMultiplier: 1.2,
      tpAtrMultiplier: 1.8,
      scope: 'backtest',
    }));
  });

  test('SELL setup can produce SELL with protective levels and metadata', () => {
    const logic = new UsdjpyJpyMacroReversalV1();
    const candles = buildCandles({ direction: 'up' });
    const result = logic.analyze(buildContext(candles));
    const entryClose = candles[candles.length - 1].close;

    expect(result.signal).toBe('SELL');
    expect(result.sl).toBeGreaterThan(entryClose);
    expect(result.tp).toBeLessThan(entryClose);
    expect(result.metadata).toEqual(expect.objectContaining({
      setup: 'jpy_macro_reversal',
      atr: expect.any(Number),
      rsi: expect.any(Number),
      recentMove: expect.any(Number),
    }));
  });

  test('maxBarsInTrade with openPosition returns CLOSE', () => {
    const logic = new UsdjpyJpyMacroReversalV1();
    const candles = buildCandles({ direction: 'down', count: 24 });
    const result = logic.analyze(buildContext(candles, {
      openPosition: {
        side: 'BUY',
        entryTime: candles[0].time,
      },
      parameters: {
        ...buildContext(candles).parameters,
        maxBarsInTrade: 18,
      },
    }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'CLOSE',
      reason: 'Max bars in trade reached',
    }));
  });

  test('default parameter schema contains expected USDJPY macro reversal fields', () => {
    const logic = new UsdjpyJpyMacroReversalV1();

    expect(logic.getDefaultParameterSchema().map((field) => field.key)).toEqual([
      'lookbackBars',
      'impulseAtrMultiplier',
      'reversalConfirmBars',
      'rsiPeriod',
      'rsiOverbought',
      'rsiOversold',
      'atrPeriod',
      'slAtrMultiplier',
      'tpAtrMultiplier',
      'maxBarsInTrade',
      'minAtr',
      'cooldownBars',
      'enableBuy',
      'enableSell',
      'allowedUtcHours',
      'blockedUtcHours',
      'cooldownBarsAfterAnyExit',
      'cooldownBarsAfterSL',
      'maxDailyLosses',
      'maxDailyTrades',
    ]);
    expect(logic.getDefaultParameters()).toEqual(expect.objectContaining({
      lookbackBars: 36,
      impulseAtrMultiplier: 1.8,
      maxBarsInTrade: 18,
      enableBuy: true,
      enableSell: true,
      allowedUtcHours: '',
    }));
    expect(UsdjpyJpyMacroReversalV1.USDJPY_JPY_MACRO_REVERSAL_V1_VERSION).toBe(3);
  });

  test('enableBuy=false blocks BUY setup', () => {
    const logic = new UsdjpyJpyMacroReversalV1();
    const candles = buildCandles({ direction: 'down' });
    const result = logic.analyze(buildContext(candles, {
      parameters: {
        ...buildContext(candles).parameters,
        enableBuy: false,
      },
    }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reason: 'BUY disabled by enableBuy=false',
    }));
  });

  test('enableSell=false blocks SELL setup', () => {
    const logic = new UsdjpyJpyMacroReversalV1();
    const candles = buildCandles({ direction: 'up' });
    const result = logic.analyze(buildContext(candles, {
      parameters: {
        ...buildContext(candles).parameters,
        enableSell: false,
      },
    }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reason: 'SELL disabled by enableSell=false',
    }));
  });

  test('allowedUtcHours blocks hours not listed', () => {
    const logic = new UsdjpyJpyMacroReversalV1();
    const candles = buildCandles({ direction: 'down' });
    const result = logic.analyze(buildContext(candles, {
      currentUtcHour: 22,
      parameters: {
        ...buildContext(candles).parameters,
        allowedUtcHours: '0,1,2',
      },
    }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reason: 'UTC hour not in allowedUtcHours',
    }));
  });

  test('blockedUtcHours blocks listed hours', () => {
    const logic = new UsdjpyJpyMacroReversalV1();
    const candles = buildCandles({ direction: 'down' });
    const result = logic.analyze(buildContext(candles, {
      currentUtcHour: 3,
      parameters: {
        ...buildContext(candles).parameters,
        blockedUtcHours: '3,4',
      },
    }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reason: 'UTC hour blocked by blockedUtcHours',
    }));
  });

  test('cooldownBarsAfterSL blocks entries after SL', () => {
    const logic = new UsdjpyJpyMacroReversalV1();
    const candles = buildCandles({ direction: 'down' });
    const result = logic.analyze(buildContext(candles, {
      barsSinceLastExit: 2,
      lastClosedTrade: { exitReason: 'SL', pnl: -5 },
      parameters: {
        ...buildContext(candles).parameters,
        cooldownBarsAfterSL: 3,
      },
    }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reason: 'Cooldown after SL active',
    }));
  });

  test('maxDailyLosses blocks entries after daily loss limit', () => {
    const logic = new UsdjpyJpyMacroReversalV1();
    const candles = buildCandles({ direction: 'down' });
    const result = logic.analyze(buildContext(candles, {
      todayClosedTrades: [{ pnl: -1 }, { pnl: -2 }],
      parameters: {
        ...buildContext(candles).parameters,
        maxDailyLosses: 2,
      },
    }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reason: 'Max daily losses reached',
    }));
  });

  test('maxDailyTrades blocks entries after daily trade limit', () => {
    const logic = new UsdjpyJpyMacroReversalV1();
    const candles = buildCandles({ direction: 'down' });
    const result = logic.analyze(buildContext(candles, {
      todayTrades: [{ pnl: 1 }, { pnl: -1 }],
      parameters: {
        ...buildContext(candles).parameters,
        maxDailyTrades: 2,
      },
    }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reason: 'Max daily trades reached',
    }));
  });

  test('does not reference forbidden execution or old strategy modules', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'symbolCustom', 'logics', 'UsdjpyJpyMacroReversalV1.js'),
      'utf8'
    );

    expect(source).not.toMatch(/src\/strategies|\.\.\/strategies/);
    expect(source).not.toMatch(/TrendFollowing|MeanReversion|Breakout|Momentum|MultiTimeframe|VolumeFlowHybrid/);
    expect(source).not.toMatch(/tradeExecutor|executeTrade|placeOrder|preflightOrder/i);
    expect(source).not.toMatch(/riskManager|calculateLotSize/i);
    expect(source).not.toMatch(/backtestEngine|runBacktest/);
  });
});
