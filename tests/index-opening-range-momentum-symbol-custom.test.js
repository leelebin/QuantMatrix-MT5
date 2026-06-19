const Us30IndexOpeningRangeMomentumV1 = require('../src/symbolCustom/logics/Us30IndexOpeningRangeMomentumV1');
const Nas100IndexOpeningRangeMomentumV1 = require('../src/symbolCustom/logics/Nas100IndexOpeningRangeMomentumV1');
const { runSymbolCustomBacktestSimulation } = require('../src/services/symbolCustomBacktestRunnerService');

function buildSetupCandles({ direction = 'BUY', symbol = 'US30', extraBars = 0, lowVolumeBreakout = false } = {}) {
  const candles = [];
  const startMs = Date.parse('2026-03-02T00:00:00Z');
  let close = symbol === 'NAS100' ? 18000 : 39000;
  const drift = direction === 'BUY' ? 8 : -8;

  for (let index = 0; index < 140; index += 1) {
    const time = new Date(startMs + index * 15 * 60 * 1000).toISOString();
    const open = close;
    close = open + drift + ((index % 4) - 1.5) * 0.8;
    candles.push({
      time,
      open,
      high: Math.max(open, close) + 8,
      low: Math.min(open, close) - 8,
      close,
      volume: 120,
      tickVolume: 120,
      spread: symbol === 'NAS100' ? 18 : 35,
    });
  }

  const breakoutIndex = candles.length;
  const breakoutTime = new Date(startMs + breakoutIndex * 15 * 60 * 1000).toISOString();
  const breakoutOpen = close;
  close = direction === 'BUY' ? breakoutOpen + 140 : breakoutOpen - 140;
  candles.push({
    time: breakoutTime,
    open: breakoutOpen,
    high: Math.max(breakoutOpen, close) + 12,
    low: Math.min(breakoutOpen, close) - 12,
    close,
    volume: lowVolumeBreakout ? 60 : 260,
    tickVolume: lowVolumeBreakout ? 60 : 260,
    spread: symbol === 'NAS100' ? 18 : 35,
  });

  for (let index = 0; index < extraBars; index += 1) {
    const time = new Date(startMs + (breakoutIndex + 1 + index) * 15 * 60 * 1000).toISOString();
    const open = close;
    close = direction === 'BUY' ? open + 70 : open - 70;
    candles.push({
      time,
      open,
      high: Math.max(open, close) + 10,
      low: Math.min(open, close) - 10,
      close,
      volume: 220,
      tickVolume: 220,
      spread: symbol === 'NAS100' ? 18 : 35,
    });
  }

  return candles;
}

function buildHigherCandles({ direction = 'BUY', symbol = 'US30' } = {}) {
  const candles = [];
  const startMs = Date.parse('2026-02-20T00:00:00Z');
  let close = symbol === 'NAS100' ? 17000 : 38000;
  const drift = direction === 'BUY' ? 35 : -35;

  for (let index = 0; index < 140; index += 1) {
    const time = new Date(startMs + index * 60 * 60 * 1000).toISOString();
    const open = close;
    close = open + drift + ((index % 3) - 1) * 1.5;
    candles.push({
      time,
      open,
      high: Math.max(open, close) + 15,
      low: Math.min(open, close) - 15,
      close,
      volume: 600,
      tickVolume: 600,
      spread: symbol === 'NAS100' ? 18 : 35,
    });
  }
  return candles;
}

function buildPostSetupEntryBar(setup, symbol = 'US30') {
  const last = setup[setup.length - 1];
  const time = new Date(Date.parse(last.time) + 10 * 60 * 1000).toISOString();
  return {
    ...last,
    time,
    open: last.close,
    high: last.close + 2,
    low: last.close - 2,
    close: last.close,
    spread: symbol === 'NAS100' ? 18 : 35,
  };
}

function buildContext({ logic, direction = 'BUY', symbol = 'US30', candles = null, higher = null, currentBar = null, parameters = {} } = {}) {
  const setup = candles || buildSetupCandles({ direction, symbol });
  const higherCandles = higher || buildHigherCandles({ direction, symbol });
  const resolvedCurrentBar = currentBar || buildPostSetupEntryBar(setup, symbol);
  return {
    scope: 'backtest',
    symbol,
    symbolCustomName: logic.name,
    timeframes: {
      setupTimeframe: '15m',
      entryTimeframe: '5m',
      higherTimeframe: '1h',
    },
    candles: {
      setup,
      entry: setup,
      higher: higherCandles,
    },
    currentBar: resolvedCurrentBar,
    currentIndex: setup.length - 1,
    currentUtcHour: 14,
    parameters: {
      enabled: true,
      maxDailyTrades: 0,
      allowedUtcHours: [],
      maxAtrRatio: 10,
      maxAtrSpikeRatio: 10,
      maxExtensionAtr: 30,
      maxPreBreakoutRangeAtr: 30,
      spreadAtrMaxRatio: 2,
      minSignalScore: 60,
      ...parameters,
    },
  };
}

describe('index opening-range momentum SymbolCustom logics', () => {
  test('default parameters keep US30 disabled', () => {
    const logic = new Us30IndexOpeningRangeMomentumV1();
    const result = logic.analyze(buildContext({ logic, parameters: { enabled: false } }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reasonCode: 'STRATEGY_DISABLED',
    }));
  });

  test('US30 BUY setup emits protected BUY signal', () => {
    const logic = new Us30IndexOpeningRangeMomentumV1();
    const candles = buildSetupCandles({ direction: 'BUY', symbol: 'US30' });
    const close = candles[candles.length - 1].close;
    const result = logic.analyze(buildContext({ logic, direction: 'BUY', symbol: 'US30', candles }));

    expect(result.signal).toBe('BUY');
    expect(result.sl).toBeLessThan(close);
    expect(result.tp).toBeGreaterThan(close);
    expect(result.marketQualityScore).toBeGreaterThanOrEqual(result.marketQualityThreshold);
    expect(result.metadata).toEqual(expect.objectContaining({
      source: 'symbolCustom',
      symbolCustomName: 'US30_INDEX_OPENING_RANGE_MOMENTUM_V1',
      logicName: 'US30_INDEX_OPENING_RANGE_MOMENTUM_V1',
      setupType: 'us30_index_opening_range_momentum',
      module: 'INDEX_OPENING_RANGE_BREAKOUT',
      pattern: 'INDEX_UPTREND_OPENING_RANGE_BREAKOUT',
    }));
  });

  test('NAS100 SELL setup emits protected SELL signal', () => {
    const logic = new Nas100IndexOpeningRangeMomentumV1();
    const candles = buildSetupCandles({ direction: 'SELL', symbol: 'NAS100' });
    const close = candles[candles.length - 1].close;
    const result = logic.analyze(buildContext({ logic, direction: 'SELL', symbol: 'NAS100', candles }));

    expect(result.signal).toBe('SELL');
    expect(result.sl).toBeGreaterThan(close);
    expect(result.tp).toBeLessThan(close);
    expect(result.metadata.pattern).toBe('INDEX_DOWNTREND_OPENING_RANGE_BREAKDOWN');
  });

  test('relative volume filter rejects weak breakout candles', () => {
    const logic = new Us30IndexOpeningRangeMomentumV1();
    const candles = buildSetupCandles({ direction: 'BUY', symbol: 'US30', lowVolumeBreakout: true });
    const result = logic.analyze(buildContext({ logic, direction: 'BUY', symbol: 'US30', candles }));

    expect(result).toEqual(expect.objectContaining({
      signal: 'NONE',
      reasonCode: 'RELATIVE_VOLUME_TOO_LOW',
    }));
  });

  test('does not use an unclosed setup candle for breakout detection', () => {
    const logic = new Us30IndexOpeningRangeMomentumV1();
    const candles = buildSetupCandles({ direction: 'BUY', symbol: 'US30' });
    const currentBarBeforeSetupClose = {
      ...candles[candles.length - 1],
      time: new Date(Date.parse(candles[candles.length - 1].time)).toISOString(),
    };
    const result = logic.analyze(buildContext({
      logic,
      direction: 'BUY',
      symbol: 'US30',
      candles,
      currentBar: currentBarBeforeSetupClose,
    }));

    expect(result.signal).toBe('NONE');
    expect(result.reasonCode).not.toBe('US30_INDEX_OPENING_RANGE_MOMENTUM_BUY');
  });

  test('live scope remains blocked until validation promotes the logic', () => {
    const logic = new Nas100IndexOpeningRangeMomentumV1();

    expect(logic.analyze({ scope: 'live', symbol: 'NAS100' })).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'BLOCKED',
      reasonCode: 'SYMBOLCUSTOM_LIVE_BLOCKED_PENDING_VALIDATION',
    }));
  });

  test('NAS100 paper scope can emit validation signals while live remains blocked', () => {
    const logic = new Nas100IndexOpeningRangeMomentumV1();
    const candles = buildSetupCandles({ direction: 'BUY', symbol: 'NAS100' });
    const context = buildContext({
      logic,
      direction: 'BUY',
      symbol: 'NAS100',
      candles,
      parameters: {
        enabled: true,
        allowedUtcHours: [],
        minSignalScore: 55,
        breakoutLookbackBars: 14,
        minRelativeVolume: 0,
        useVolumeFilter: false,
        maxAtrRatio: 10,
        maxAtrSpikeRatio: 10,
        maxExtensionAtr: 30,
        maxPreBreakoutRangeAtr: 30,
        spreadAtrMaxRatio: 2,
      },
    });
    const result = logic.analyze({ ...context, scope: 'paper' });

    expect(result.signal).toBe('BUY');
    expect(logic.analyze({ scope: 'live', symbol: 'NAS100' })).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'BLOCKED',
      reasonCode: 'SYMBOLCUSTOM_LIVE_BLOCKED_PENDING_VALIDATION',
    }));
  });

  test('symbolCustom backtest runner can execute US30 index logic', async () => {
    const logic = new Us30IndexOpeningRangeMomentumV1();
    const candles = buildSetupCandles({ direction: 'BUY', symbol: 'US30', extraBars: 4 });
    const higher = buildHigherCandles({ direction: 'BUY', symbol: 'US30' });

    const result = await runSymbolCustomBacktestSimulation({
      symbolCustom: {
        _id: 'us30-index-momentum',
        symbol: 'US30',
        symbolCustomName: 'US30_INDEX_OPENING_RANGE_MOMENTUM_V1',
        logicName: 'US30_INDEX_OPENING_RANGE_MOMENTUM_V1',
        timeframes: { setupTimeframe: '15m', entryTimeframe: '5m', higherTimeframe: '1h' },
        riskConfig: { maxRiskPerTradePct: 0.35 },
        parameters: {
          enabled: true,
          maxDailyTrades: 0,
          allowedUtcHours: [],
          maxAtrRatio: 10,
          maxAtrSpikeRatio: 10,
          maxExtensionAtr: 30,
          maxPreBreakoutRangeAtr: 30,
          spreadAtrMaxRatio: 2,
          minSignalScore: 60,
        },
      },
      logic,
      logicName: 'US30_INDEX_OPENING_RANGE_MOMENTUM_V1',
      candles: { setup: candles, entry: candles, higher },
      parameters: {
        enabled: true,
        maxDailyTrades: 0,
        allowedUtcHours: [],
        maxAtrRatio: 10,
        maxAtrSpikeRatio: 10,
        maxExtensionAtr: 30,
        maxPreBreakoutRangeAtr: 30,
        spreadAtrMaxRatio: 2,
        minSignalScore: 60,
      },
      costModel: { spread: 0, slippage: 0, commissionPerTrade: 0 },
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
    expect(result.trades[0]).toEqual(expect.objectContaining({
      symbol: 'US30',
      symbolCustomName: 'US30_INDEX_OPENING_RANGE_MOMENTUM_V1',
      logicName: 'US30_INDEX_OPENING_RANGE_MOMENTUM_V1',
    }));
  });
});
