const fs = require('fs');
const path = require('path');

const XbrusdOilBreakoutRetestV1 = require('../src/symbolCustom/logics/XbrusdOilBreakoutRetestV1');
const XbrusdOilLongRetestSessionV2 = require('../src/symbolCustom/logics/XbrusdOilLongRetestSessionV2');
const XtiusdOilBreakoutRetestV1 = require('../src/symbolCustom/logics/XtiusdOilBreakoutRetestV1');

function buildSetupCandles({ direction = 'BUY', count = 90 } = {}) {
  const candles = [];
  const startMs = Date.parse('2026-05-01T00:00:00Z');
  let close = direction === 'BUY' ? 90 : 105;

  for (let index = 0; index < count; index += 1) {
    const drift = direction === 'BUY' ? 0.04 : -0.04;
    const open = close;
    close = open + drift + ((index % 5) - 2) * 0.01;
    candles.push({
      time: new Date(startMs + index * 60 * 60 * 1000).toISOString(),
      open,
      high: Math.max(open, close) + 0.22,
      low: Math.min(open, close) - 0.22,
      close,
      volume: 0,
      spread: 14,
    });
  }

  const triggerIndex = candles.length - 1;
  const priorWindow = candles.slice(triggerIndex - 18, triggerIndex);
  const structureHigh = Math.max(...priorWindow.map((candle) => candle.high));
  const structureLow = Math.min(...priorWindow.map((candle) => candle.low));
  const previous = candles[triggerIndex - 1];
  const trigger = candles[triggerIndex];
  if (direction === 'BUY') {
    candles[triggerIndex] = {
      ...trigger,
      open: previous.close,
      close: structureHigh + 0.42,
      high: structureHigh + 0.55,
      low: previous.close - 0.12,
    };
  } else {
    candles[triggerIndex] = {
      ...trigger,
      open: previous.close,
      close: structureLow - 0.42,
      high: previous.close + 0.12,
      low: structureLow - 0.55,
    };
  }

  return {
    candles,
    structureHigh,
    structureLow,
    triggerTime: candles[triggerIndex].time,
  };
}

function buildEntryCandles({ direction = 'BUY', setup }) {
  const triggerCompleteMs = Date.parse(setup.triggerTime) + 60 * 60 * 1000;
  const candles = [];
  const structure = direction === 'BUY' ? setup.structureHigh : setup.structureLow;
  let close = direction === 'BUY' ? structure + 0.35 : structure - 0.35;

  for (let index = 0; index < 12; index += 1) {
    const time = new Date(triggerCompleteMs + index * 5 * 60 * 1000).toISOString();
    const open = close;
    if (direction === 'BUY') {
      close = index === 11 ? structure + 0.22 : Math.max(structure + 0.1, open - 0.04);
      candles.push({
        time,
        open,
        high: Math.max(open, close) + 0.12,
        low: index === 11 ? structure - 0.05 : Math.min(open, close) - 0.08,
        close,
        volume: 0,
        spread: 14,
      });
    } else {
      close = index === 11 ? structure - 0.22 : Math.min(structure - 0.1, open + 0.04);
      candles.push({
        time,
        open,
        high: index === 11 ? structure + 0.05 : Math.max(open, close) + 0.08,
        low: Math.min(open, close) - 0.12,
        close,
        volume: 0,
        spread: 14,
      });
    }
  }

  return candles;
}

function buildContext({ logic, direction = 'BUY', overrides = {} } = {}) {
  const setup = buildSetupCandles({ direction });
  const entry = buildEntryCandles({ direction, setup });
  const currentBar = entry[entry.length - 1];

  return {
    scope: 'backtest',
    symbol: logic.symbol,
    symbolCustomName: logic.name,
    timeframes: {
      setupTimeframe: '1h',
      entryTimeframe: '5m',
      higherTimeframe: '4h',
    },
    candles: {
      setup: setup.candles,
      entry,
      higher: setup.candles,
    },
    currentBar,
    currentIndex: entry.length - 1,
    currentUtcHour: new Date(currentBar.time).getUTCHours(),
    parameters: {
      allowedUtcHours: String(new Date(currentBar.time).getUTCHours()),
      maxBreakoutBodyAtr: 3,
      minConfidence: 0.55,
      requireHigherTrendAlignment: false,
    },
    ...overrides,
  };
}

function buildBearishHigherCandlesWithUnclosedBullTrap(currentBar) {
  const candles = [];
  const endMs = Date.parse(currentBar.time) - (4 * 60 * 60 * 1000);
  let close = 110;

  for (let index = 119; index >= 0; index -= 1) {
    const time = new Date(endMs - index * 4 * 60 * 60 * 1000).toISOString();
    const open = close;
    close = open - 0.08;
    candles.push({
      time,
      open,
      high: Math.max(open, close) + 0.1,
      low: Math.min(open, close) - 0.1,
      close,
      volume: 0,
      spread: 14,
    });
  }

  candles.push({
    time: currentBar.time,
    open: close,
    high: close + 20,
    low: close - 0.1,
    close: close + 18,
    volume: 0,
    spread: 14,
  });

  return candles;
}

describe('oil breakout retest SymbolCustom logics', () => {
  test('XBRUSD logic is backtest-only for paper/live scopes', () => {
    const logic = new XbrusdOilBreakoutRetestV1();

    expect(logic.analyze({ scope: 'paper', symbol: 'XBRUSD' })).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'BLOCKED',
    }));
    expect(logic.analyze({ scope: 'live', symbol: 'XBRUSD' })).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'BLOCKED',
    }));
  });

  test('XBRUSD BUY retest can produce BUY with confidence and metadata', () => {
    const logic = new XbrusdOilBreakoutRetestV1();
    const context = buildContext({ logic, direction: 'BUY' });
    const result = logic.analyze(context);
    const close = context.currentBar.close;

    expect(result.signal).toBe('BUY');
    expect(result.confidence).toBeGreaterThanOrEqual(0.55);
    expect(result.sl).toBeLessThan(close);
    expect(result.tp).toBeGreaterThan(close);
    expect(result.metadata).toEqual(expect.objectContaining({
      source: 'symbolCustom',
      symbolCustomName: 'XBRUSD_OIL_BREAKOUT_RETEST_V1',
      logicName: 'XBRUSD_OIL_BREAKOUT_RETEST_V1',
      module: 'BREAKOUT_RETEST',
      setupType: 'xbrusd_oil_breakout_retest',
    }));
  });

  test('XTIUSD SELL retest can produce SELL with protective levels', () => {
    const logic = new XtiusdOilBreakoutRetestV1();
    const context = buildContext({ logic, direction: 'SELL' });
    const result = logic.analyze(context);
    const close = context.currentBar.close;

    expect(result.signal).toBe('SELL');
    expect(result.sl).toBeGreaterThan(close);
    expect(result.tp).toBeLessThan(close);
  });

  test('XTIUSD oil retest is enabled for paper validation but remains live blocked', () => {
    const logic = new XtiusdOilBreakoutRetestV1();
    const paperContext = buildContext({ logic, direction: 'BUY', overrides: { scope: 'paper' } });
    const paperResult = logic.analyze(paperContext);

    expect(paperResult.signal).toBe('BUY');
    expect(logic.analyze({ scope: 'live', symbol: 'XTIUSD' })).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'BLOCKED',
      reasonCode: 'SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED',
    }));
  });

  test('XBRUSD V2 defaults to paper-testing BUY session candidate with live blocked', () => {
    const logic = new XbrusdOilLongRetestSessionV2();
    const defaults = logic.getDefaultParameters();
    const schemaByKey = new Map(logic.getDefaultParameterSchema().map((field) => [field.key, field]));

    expect(defaults.enableBuy).toBe(true);
    expect(defaults.enableSell).toBe(false);
    expect(defaults.allowedUtcHours).toBe('8,9,16,17');
    expect(defaults.maxDailyLosses).toBe(1);
    expect(schemaByKey.get('enableSell').defaultValue).toBe(false);
    expect(schemaByKey.get('allowedUtcHours').defaultValue).toBe('8,9,16,17');
    expect(schemaByKey.get('minConfidence').defaultValue).toBe(0.55);
    expect(logic.analyze({ scope: 'paper', symbol: 'XBRUSD' })).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'NO_SETUP',
      reason: 'Not enough candles for oil breakout retest analysis',
    }));
    expect(logic.analyze({ scope: 'live', symbol: 'XBRUSD' })).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'BLOCKED',
      reasonCode: 'SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED',
    }));
  });

  test('XBRUSD V2 can produce BUY but blocks SELL by default', () => {
    const logic = new XbrusdOilLongRetestSessionV2();
    const buyContext = buildContext({
      logic,
      direction: 'BUY',
      overrides: {
        currentUtcHour: 16,
        parameters: {
          ...logic.getDefaultParameters(),
          allowedUtcHours: '16',
          maxBreakoutBodyAtr: 3,
        },
      },
    });
    const sellContext = buildContext({
      logic,
      direction: 'SELL',
      overrides: {
        currentUtcHour: 16,
        parameters: {
          ...logic.getDefaultParameters(),
          allowedUtcHours: '16',
          maxBreakoutBodyAtr: 3,
        },
      },
    });

    expect(logic.analyze(buyContext)).toEqual(expect.objectContaining({
      signal: 'BUY',
      status: 'TRIGGERED',
      metadata: expect.objectContaining({
        setupType: 'xbrusd_oil_long_retest_session',
      }),
    }));
    expect(logic.analyze(sellContext)).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'FILTERED',
      reason: 'SELL disabled',
    }));
  });

  test('cooldown does not block the first trade when there is no last closed trade', () => {
    const logic = new XbrusdOilBreakoutRetestV1();
    const context = buildContext({
      logic,
      direction: 'BUY',
      overrides: {
        barsSinceLastExit: null,
        lastClosedTrade: null,
        parameters: {
          allowedUtcHours: '0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23',
          cooldownBarsAfterAnyExit: 24,
          cooldownBarsAfterSL: 48,
          maxBreakoutBodyAtr: 3,
          minConfidence: 0.55,
        },
      },
    });

    expect(logic.analyze(context).signal).toBe('BUY');
  });

  test('higher timeframe alignment ignores unclosed higher candle', () => {
    const logic = new XbrusdOilBreakoutRetestV1();
    const baseContext = buildContext({ logic, direction: 'BUY' });
    const context = {
      ...baseContext,
      candles: {
        ...baseContext.candles,
        higher: buildBearishHigherCandlesWithUnclosedBullTrap(baseContext.currentBar),
      },
      parameters: {
        allowedUtcHours: String(new Date(baseContext.currentBar.time).getUTCHours()),
        maxBreakoutBodyAtr: 3,
        minConfidence: 0.55,
        requireHigherTrendAlignment: true,
        minHigherTrendStrength: 0,
      },
    };

    expect(logic.analyze(context)).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'FILTERED',
      reason: 'Higher timeframe trend is not aligned with oil breakout retest',
    }));
  });

  test('source files do not import six strategies or live execution services', () => {
    for (const file of [
      'OilBreakoutRetestBase.js',
      'XbrusdOilBreakoutRetestV1.js',
      'XbrusdOilLongRetestSessionV2.js',
      'XtiusdOilBreakoutRetestV1.js',
    ]) {
      const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'symbolCustom', 'logics', file),
        'utf8'
      );

      expect(source).not.toMatch(/src\/strategies|require\(['"].*strategies/);
      expect(source).not.toMatch(/VolumeFlowHybridStrategy|MomentumStrategy|BreakoutStrategy|MeanReversionStrategy|TrendFollowingStrategy|MultiTimeframeStrategy/);
      expect(source).not.toMatch(/tradeExecutor|riskManager|paperTradingService/);
    }
  });
});
