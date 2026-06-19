const Us30OpeningRangeFailedBreakoutFadeV1 = require('../src/symbolCustom/logics/Us30OpeningRangeFailedBreakoutFadeV1');

function candle(time, open, high, low, close, extra = {}) {
  return {
    time,
    open,
    high,
    low,
    close,
    volume: 200,
    tickVolume: 200,
    spread: 30,
    ...extra,
  };
}

function addMinutes(startMs, minutes) {
  return new Date(startMs + minutes * 60 * 1000).toISOString();
}

function buildHistoryCandles({ base = 39000, count = 92 } = {}) {
  const candles = [];
  const startMs = Date.parse('2026-06-14T14:00:00Z');
  let close = base;
  for (let index = 0; index < count; index += 1) {
    const open = close;
    close = open + ((index % 4) - 1.5) * 4;
    candles.push(candle(
      addMinutes(startMs, index * 15),
      open,
      Math.max(open, close) + 28,
      Math.min(open, close) - 28,
      close
    ));
  }
  return candles;
}

function buildHigherCandles({ base = 38950, count = 130 } = {}) {
  const candles = [];
  const startMs = Date.parse('2026-06-10T00:00:00Z');
  let close = base;
  for (let index = 0; index < count; index += 1) {
    const open = close;
    close = open + ((index % 3) - 1) * 5;
    candles.push(candle(
      addMinutes(startMs, index * 60),
      open,
      Math.max(open, close) + 35,
      Math.min(open, close) - 35,
      close
    ));
  }
  return candles;
}

function buildFailedUpsideContext({ parameters = {} } = {}) {
  const history = buildHistoryCandles();
  const setup = [
    ...history,
    candle('2026-06-15T13:00:00Z', 39020, 39085, 39005, 39070),
    candle('2026-06-15T13:15:00Z', 39070, 39100, 39025, 39040),
    candle('2026-06-15T13:30:00Z', 39040, 39092, 39000, 39030),
    candle('2026-06-15T13:45:00Z', 39030, 39078, 39018, 39062),
    candle('2026-06-15T14:00:00Z', 39062, 39158, 39055, 39132),
    candle('2026-06-15T14:15:00Z', 39132, 39162, 39088, 39095),
  ];
  const entry = [
    candle('2026-06-15T14:00:00Z', 39062, 39118, 39058, 39105),
    candle('2026-06-15T14:05:00Z', 39105, 39162, 39100, 39145),
    candle('2026-06-15T14:10:00Z', 39145, 39155, 39110, 39130),
    candle('2026-06-15T14:15:00Z', 39130, 39136, 39092, 39105),
    candle('2026-06-15T14:20:00Z', 39105, 39110, 39082, 39095),
  ];
  return {
    scope: 'paper',
    symbol: 'US30',
    timeframes: { setupTimeframe: '15m', entryTimeframe: '5m', higherTimeframe: '1h' },
    candles: { setup, entry, higher: buildHigherCandles() },
    currentBar: entry[entry.length - 1],
    currentUtcHour: 14,
    parameters: {
      enabled: true,
      allowedUtcHours: [14, 15, 16, 17, 18, 19],
      minSignalScore: 55,
      minTargetR: 0.35,
      blockStrongHigherTrend: false,
      ...parameters,
    },
  };
}

function buildFailedDownsideContext() {
  const context = buildFailedUpsideContext();
  const setup = [
    ...buildHistoryCandles(),
    candle('2026-06-15T13:00:00Z', 39080, 39095, 39015, 39030),
    candle('2026-06-15T13:15:00Z', 39030, 39075, 39000, 39060),
    candle('2026-06-15T13:30:00Z', 39060, 39100, 39010, 39070),
    candle('2026-06-15T13:45:00Z', 39070, 39082, 39022, 39038),
    candle('2026-06-15T14:00:00Z', 39038, 39045, 38942, 38968),
    candle('2026-06-15T14:15:00Z', 38968, 39012, 38938, 39005),
  ];
  const entry = [
    candle('2026-06-15T14:00:00Z', 39038, 39042, 38982, 38995),
    candle('2026-06-15T14:05:00Z', 38995, 39000, 38938, 38955),
    candle('2026-06-15T14:10:00Z', 38955, 38990, 38945, 38970),
    candle('2026-06-15T14:15:00Z', 38970, 39008, 38964, 38992),
    candle('2026-06-15T14:20:00Z', 38992, 39018, 38988, 39005),
  ];
  return {
    ...context,
    candles: { setup, entry, higher: buildHigherCandles() },
    currentBar: entry[entry.length - 1],
  };
}

describe('US30 opening-range failed-breakout fade SymbolCustom', () => {
  test('default parameters keep V2 disabled', () => {
    const logic = new Us30OpeningRangeFailedBreakoutFadeV1();

    expect(logic.analyze(buildFailedUpsideContext({ parameters: { enabled: false } }))).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'DISABLED',
      reasonCode: 'STRATEGY_DISABLED',
    }));
  });

  test('failed upside breakout reclaim emits SELL fade signal', () => {
    const logic = new Us30OpeningRangeFailedBreakoutFadeV1();
    const result = logic.analyze(buildFailedUpsideContext());

    expect(result.signal).toBe('SELL');
    expect(result.sl).toBeGreaterThan(result.tp);
    expect(result.sl).toBeGreaterThan(39095);
    expect(result.tp).toBeLessThan(39095);
    expect(result.metadata).toEqual(expect.objectContaining({
      source: 'symbolCustom',
      logicName: 'US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1',
      module: 'INDEX_FAILED_BREAKOUT_FADE',
      pattern: 'US30_FAILED_UPSIDE_BREAKOUT_FADE',
      closedBarSafe: true,
    }));
    expect(result.zoneBoundary).toBeGreaterThan(result.tp);
    expect(result.entrySwing).toBeGreaterThan(result.zoneBoundary);
  });

  test('opposite-boundary target mode extends SELL target beyond adaptive midline', () => {
    const logic = new Us30OpeningRangeFailedBreakoutFadeV1();
    const adaptive = logic.analyze(buildFailedUpsideContext());
    const oppositeBoundary = logic.analyze(buildFailedUpsideContext({
      parameters: { targetMode: 'opposite_boundary' },
    }));

    expect(adaptive.signal).toBe('SELL');
    expect(oppositeBoundary.signal).toBe('SELL');
    expect(oppositeBoundary.tp).toBeLessThan(adaptive.tp);
    expect(oppositeBoundary.metadata.targetMode).toBe('opposite_boundary');
    expect(oppositeBoundary.metadata.rewardR).toBeGreaterThan(adaptive.metadata.rewardR);
  });

  test('failed downside breakout reclaim emits BUY fade signal', () => {
    const logic = new Us30OpeningRangeFailedBreakoutFadeV1();
    const result = logic.analyze(buildFailedDownsideContext());

    expect(result.signal).toBe('BUY');
    expect(result.sl).toBeLessThan(39005);
    expect(result.tp).toBeGreaterThan(39005);
    expect(result.metadata.pattern).toBe('US30_FAILED_DOWNSIDE_BREAKOUT_FADE');
    expect(result.zoneBoundary).toBeLessThan(result.tp);
    expect(result.entrySwing).toBeLessThan(result.zoneBoundary);
  });

  test('live scope remains blocked until validation promotes V2', () => {
    const logic = new Us30OpeningRangeFailedBreakoutFadeV1();

    expect(logic.analyze({ scope: 'live', symbol: 'US30' })).toEqual(expect.objectContaining({
      signal: 'NONE',
      status: 'BLOCKED',
      reasonCode: 'SYMBOLCUSTOM_LIVE_BLOCKED_PENDING_VALIDATION',
    }));
  });
});
