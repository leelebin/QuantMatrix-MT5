const BaseSymbolCustom = require('../BaseSymbolCustom');
const { getTimeframeDurationMs } = require('../../utils/timeframe');

const US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1 = 'US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1';
const US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1_VERSION = 1;
const CANDIDATE_PRESET = 'us30_opening_range_failed_breakout_fade_v1';

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? number : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return Number(value) === 1;
}

function round(value, digits = 4) {
  const number = Number(value);
  return Number.isFinite(number) ? parseFloat(number.toFixed(digits)) : null;
}

function getCandleTime(candle = {}) {
  return candle.time || candle.timestamp || candle.date || null;
}

function toEpoch(value) {
  if (!value) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : null;
}

function getEpoch(candle = {}) {
  return toEpoch(getCandleTime(candle));
}

function getUtcHour(candle = {}) {
  const epoch = getEpoch(candle);
  return epoch == null ? null : new Date(epoch).getUTCHours();
}

function getUtcDate(candle = {}) {
  const epoch = getEpoch(candle);
  return epoch == null ? null : new Date(epoch).toISOString().slice(0, 10);
}

function parseUtcHours(value) {
  if (Array.isArray(value)) {
    return value.map((hour) => Number(hour)).filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
  }
  if (value == null || String(value).trim() === '') return [];
  return String(value)
    .split(',')
    .map((item) => Number(String(item).trim()))
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
}

function normalizeTargetMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['adaptive', 'mid', 'opposite_boundary'].includes(normalized)) return normalized;
  return 'adaptive';
}

function getClose(candle = {}) {
  return toNumber(candle.close, null);
}

function getOpen(candle = {}) {
  return toNumber(candle.open, null);
}

function getHigh(candle = {}) {
  return toNumber(candle.high, null);
}

function getLow(candle = {}) {
  return toNumber(candle.low, null);
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function calculateEmaSeries(values = [], period = 20) {
  const safePeriod = Math.max(1, toInteger(period, 20));
  const clean = values.map((value) => toNumber(value, null));
  const result = Array(clean.length).fill(null);
  if (clean.length < safePeriod || clean.slice(0, safePeriod).some((value) => !Number.isFinite(value))) return result;
  const multiplier = 2 / (safePeriod + 1);
  let ema = clean.slice(0, safePeriod).reduce((sum, value) => sum + value, 0) / safePeriod;
  result[safePeriod - 1] = ema;
  for (let index = safePeriod; index < clean.length; index += 1) {
    if (!Number.isFinite(clean[index])) continue;
    ema = ((clean[index] - ema) * multiplier) + ema;
    result[index] = ema;
  }
  return result;
}

function calculateAtrSeries(candles = [], period = 14) {
  const safePeriod = Math.max(1, toInteger(period, 14));
  const result = Array(candles.length).fill(null);
  if (!Array.isArray(candles) || candles.length < safePeriod + 1) return result;
  const trueRanges = candles.map((candle, index) => {
    const high = getHigh(candle);
    const low = getLow(candle);
    if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
    if (index === 0) return high - low;
    const previousClose = getClose(candles[index - 1]);
    if (!Number.isFinite(previousClose)) return high - low;
    return Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
  });
  if (trueRanges.slice(1, safePeriod + 1).some((value) => !Number.isFinite(value))) return result;
  let atr = trueRanges.slice(1, safePeriod + 1).reduce((sum, value) => sum + value, 0) / safePeriod;
  result[safePeriod] = atr;
  for (let index = safePeriod + 1; index < trueRanges.length; index += 1) {
    if (!Number.isFinite(trueRanges[index])) continue;
    atr = ((atr * (safePeriod - 1)) + trueRanges[index]) / safePeriod;
    result[index] = atr;
  }
  return result;
}

function getEvaluationCloseEpoch(context = {}, currentBar = {}, parameters = {}) {
  const currentEpoch = getEpoch(currentBar);
  if (currentEpoch == null) return null;
  const timeframe = context.timeframes?.entryTimeframe || parameters.entryTimeframe || '5m';
  return currentEpoch + (getTimeframeDurationMs(timeframe) || 0);
}

function getClosedCandlesAtEvaluation(candles = [], evaluationCloseEpoch, timeframe) {
  if (!Array.isArray(candles) || evaluationCloseEpoch == null) return Array.isArray(candles) ? candles : [];
  const durationMs = getTimeframeDurationMs(timeframe);
  if (!durationMs) return candles;
  let endIndex = candles.length;
  while (endIndex > 0) {
    const candleEpoch = getEpoch(candles[endIndex - 1]);
    if (candleEpoch != null && candleEpoch + durationMs <= evaluationCloseEpoch) break;
    endIndex -= 1;
  }
  return endIndex === candles.length ? candles : candles.slice(0, endIndex);
}

function buildNoSignal({ reasonCode, reason, status = 'FILTERED', parameters, debug = {} }) {
  return {
    signal: 'NONE',
    status,
    reason,
    reasonCode,
    symbolCustomName: US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1,
    symbol: 'US30',
    parameters: cloneValue(parameters),
    metadata: {
      source: 'symbolCustom',
      symbolCustomName: US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1,
      logicName: US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1,
      setupType: 'us30_opening_range_failed_breakout_fade',
      module: 'INDEX_FAILED_BREAKOUT_FADE',
      reasonCode,
      debug: cloneValue(debug),
    },
  };
}

function buildParameterSchema() {
  return Object.freeze([
    { key: 'logicId', label: 'Logic ID', type: 'string', defaultValue: US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1 },
    { key: 'mode', label: 'Mode', type: 'string', defaultValue: 'SYMBOLCUSTOM' },
    { key: 'source', label: 'Source', type: 'string', defaultValue: 'symbolCustom' },
    { key: 'symbol', label: 'Symbol', type: 'string', defaultValue: 'US30' },
    { key: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: false },
    { key: 'setupTimeframe', label: 'Setup Timeframe', type: 'string', defaultValue: '15m' },
    { key: 'entryTimeframe', label: 'Entry Timeframe', type: 'string', defaultValue: '5m' },
    { key: 'higherTimeframe', label: 'Higher Timeframe', type: 'string', defaultValue: '1h' },
    { key: 'enableBuy', label: 'Enable BUY', type: 'boolean', defaultValue: true },
    { key: 'enableSell', label: 'Enable SELL', type: 'boolean', defaultValue: true },
    { key: 'rangeStartUtcHour', label: 'Range Start UTC Hour', type: 'number', defaultValue: 13, min: 0, max: 23, step: 1 },
    { key: 'openingRangeBars', label: 'Opening Range Bars', type: 'number', defaultValue: 4, min: 2, max: 12, step: 1 },
    { key: 'allowedUtcHours', label: 'Allowed UTC Hours', type: 'json', defaultValue: [14, 15, 16, 17, 18, 19] },
    { key: 'atrPeriod', label: 'ATR Period', type: 'number', defaultValue: 14, min: 5, max: 40, step: 1 },
    { key: 'longAtrPeriod', label: 'Long ATR Period', type: 'number', defaultValue: 80, min: 30, max: 240, step: 5 },
    { key: 'higherFastEmaPeriod', label: 'Higher Fast EMA Period', type: 'number', defaultValue: 20, min: 5, max: 80, step: 1 },
    { key: 'higherSlowEmaPeriod', label: 'Higher Slow EMA Period', type: 'number', defaultValue: 100, min: 40, max: 240, step: 5 },
    { key: 'minAtrRatio', label: 'Min ATR / Long ATR', type: 'number', defaultValue: 0.35, min: 0, max: 2, step: 0.05 },
    { key: 'maxAtrRatio', label: 'Max ATR / Long ATR', type: 'number', defaultValue: 2.2, min: 0.2, max: 6, step: 0.05 },
    { key: 'minRangeAtr', label: 'Min Opening Range ATR', type: 'number', defaultValue: 0.45, min: 0.1, max: 4, step: 0.05 },
    { key: 'maxRangeAtr', label: 'Max Opening Range ATR', type: 'number', defaultValue: 3.2, min: 0.5, max: 10, step: 0.1 },
    { key: 'breakoutBufferAtr', label: 'Breakout Buffer ATR', type: 'number', defaultValue: 0.12, min: 0, max: 1, step: 0.01 },
    { key: 'reclaimBufferAtr', label: 'Reclaim Buffer ATR', type: 'number', defaultValue: 0.03, min: 0, max: 0.5, step: 0.01 },
    { key: 'failedBreakoutLookbackBars', label: 'Failed Breakout Lookback Bars', type: 'number', defaultValue: 12, min: 2, max: 48, step: 1 },
    { key: 'requireRejectionCandle', label: 'Require Rejection Candle', type: 'boolean', defaultValue: true },
    { key: 'blockStrongHigherTrend', label: 'Block Strong Higher Trend', type: 'boolean', defaultValue: true },
    { key: 'maxHigherTrendAtr', label: 'Max Higher Trend ATR', type: 'number', defaultValue: 1.15, min: 0, max: 5, step: 0.05 },
    { key: 'slAtrBuffer', label: 'SL ATR Buffer', type: 'number', defaultValue: 0.18, min: 0, max: 2, step: 0.01 },
    { key: 'targetMode', label: 'Target Mode', type: 'string', defaultValue: 'adaptive' },
    { key: 'minTargetR', label: 'Minimum Target R', type: 'number', defaultValue: 0.75, min: 0.2, max: 3, step: 0.05 },
    { key: 'maxBarsInTrade', label: 'Max Bars In Trade', type: 'number', defaultValue: 36, min: 4, max: 160, step: 1 },
    { key: 'cooldownBarsAfterAnyExit', label: 'Cooldown Bars After Any Exit', type: 'number', defaultValue: 8, min: 0, max: 96, step: 1 },
    { key: 'cooldownBarsAfterSL', label: 'Cooldown Bars After SL', type: 'number', defaultValue: 24, min: 0, max: 160, step: 1 },
    { key: 'maxDailyTrades', label: 'Max Daily Trades', type: 'number', defaultValue: 2, min: 0, max: 12, step: 1 },
    { key: 'maxDailyLosses', label: 'Max Daily Losses', type: 'number', defaultValue: 1, min: 0, max: 8, step: 1 },
    { key: 'minSignalScore', label: 'Min Signal Score', type: 'number', defaultValue: 62, min: 1, max: 100, step: 1 },
    { key: 'debugSignal', label: 'Debug Signal', type: 'boolean', defaultValue: true },
  ]);
}

function buildDefaultParameters(schema) {
  return schema.reduce((params, field) => {
    params[field.key] = cloneValue(field.defaultValue);
    return params;
  }, {});
}

function normalizeParameters(rawParameters = {}, defaults = buildDefaultParameters(buildParameterSchema())) {
  const merged = { ...defaults, ...(rawParameters || {}) };
  return {
    ...merged,
    enabled: toBoolean(merged.enabled, false),
    enableBuy: toBoolean(merged.enableBuy, true),
    enableSell: toBoolean(merged.enableSell, true),
    requireRejectionCandle: toBoolean(merged.requireRejectionCandle, true),
    blockStrongHigherTrend: toBoolean(merged.blockStrongHigherTrend, true),
    debugSignal: toBoolean(merged.debugSignal, true),
    rangeStartUtcHour: Math.max(0, Math.min(23, toInteger(merged.rangeStartUtcHour, 13))),
    openingRangeBars: Math.max(2, toInteger(merged.openingRangeBars, 4)),
    atrPeriod: Math.max(2, toInteger(merged.atrPeriod, 14)),
    longAtrPeriod: Math.max(3, toInteger(merged.longAtrPeriod, 80)),
    higherFastEmaPeriod: Math.max(2, toInteger(merged.higherFastEmaPeriod, 20)),
    higherSlowEmaPeriod: Math.max(3, toInteger(merged.higherSlowEmaPeriod, 100)),
    minAtrRatio: Math.max(0, toNumber(merged.minAtrRatio, 0.35)),
    maxAtrRatio: Math.max(0.01, toNumber(merged.maxAtrRatio, 2.2)),
    minRangeAtr: Math.max(0, toNumber(merged.minRangeAtr, 0.45)),
    maxRangeAtr: Math.max(0.1, toNumber(merged.maxRangeAtr, 3.2)),
    breakoutBufferAtr: Math.max(0, toNumber(merged.breakoutBufferAtr, 0.12)),
    reclaimBufferAtr: Math.max(0, toNumber(merged.reclaimBufferAtr, 0.03)),
    failedBreakoutLookbackBars: Math.max(1, toInteger(merged.failedBreakoutLookbackBars, 12)),
    maxHigherTrendAtr: Math.max(0, toNumber(merged.maxHigherTrendAtr, 1.15)),
    slAtrBuffer: Math.max(0, toNumber(merged.slAtrBuffer, 0.18)),
    targetMode: normalizeTargetMode(merged.targetMode),
    minTargetR: Math.max(0.1, toNumber(merged.minTargetR, 0.75)),
    maxBarsInTrade: Math.max(1, toInteger(merged.maxBarsInTrade, 36)),
    cooldownBarsAfterAnyExit: Math.max(0, toInteger(merged.cooldownBarsAfterAnyExit, 8)),
    cooldownBarsAfterSL: Math.max(0, toInteger(merged.cooldownBarsAfterSL, 24)),
    maxDailyTrades: Math.max(0, toInteger(merged.maxDailyTrades, 2)),
    maxDailyLosses: Math.max(0, toInteger(merged.maxDailyLosses, 1)),
    minSignalScore: Math.max(1, toInteger(merged.minSignalScore, 62)),
    allowedUtcHours: merged.allowedUtcHours,
  };
}

function getTodaySessionCandles(candles = [], currentBar = {}, rangeStartUtcHour = 13) {
  const currentDate = getUtcDate(currentBar);
  if (!currentDate) return [];
  return candles.filter((candle) => (
    getUtcDate(candle) === currentDate
      && getUtcHour(candle) != null
      && getUtcHour(candle) >= rangeStartUtcHour
  ));
}

function rangeFromCandles(candles = []) {
  const highs = candles.map(getHigh).filter(Number.isFinite);
  const lows = candles.map(getLow).filter(Number.isFinite);
  if (!highs.length || !lows.length) return null;
  return {
    high: Math.max(...highs),
    low: Math.min(...lows),
    mid: (Math.max(...highs) + Math.min(...lows)) / 2,
  };
}

function resolveFadeTarget(side, close, range = {}, targetMode = 'adaptive') {
  const mode = normalizeTargetMode(targetMode);
  if (side === 'SELL') {
    if (mode === 'mid') return range.mid;
    if (mode === 'opposite_boundary') return range.low;
    return close > range.mid ? range.mid : range.low;
  }
  if (mode === 'mid') return range.mid;
  if (mode === 'opposite_boundary') return range.high;
  return close < range.mid ? range.mid : range.high;
}

function buildHigherTrend(higherCandles = [], parameters = {}) {
  const minBars = Math.max(parameters.higherSlowEmaPeriod + 5, parameters.atrPeriod + 5);
  const window = Array.isArray(higherCandles)
    ? higherCandles.slice(-Math.max(minBars + 10, 140))
    : [];
  if (window.length < minBars) {
    return { regime: 'UNKNOWN', trendDistanceAtr: null, bullish: false, bearish: false };
  }
  const closes = window.map(getClose);
  const fast = calculateEmaSeries(closes, parameters.higherFastEmaPeriod).at(-1);
  const slow = calculateEmaSeries(closes, parameters.higherSlowEmaPeriod).at(-1);
  const atr = calculateAtrSeries(window, parameters.atrPeriod).at(-1);
  const trendDistanceAtr = Number.isFinite(fast) && Number.isFinite(slow) && Number.isFinite(atr) && atr > 0
    ? Math.abs(fast - slow) / atr
    : null;
  const bullish = Number.isFinite(fast) && Number.isFinite(slow) && fast > slow;
  const bearish = Number.isFinite(fast) && Number.isFinite(slow) && fast < slow;
  return {
    regime: bullish ? 'BULL_TREND' : (bearish ? 'BEAR_TREND' : 'RANGE'),
    trendDistanceAtr,
    bullish,
    bearish,
    fast,
    slow,
    atr,
  };
}

function checkGuards(context = {}, parameters = {}, currentBar = {}) {
  const lastClosedTrade = context.lastClosedTrade || null;
  const barsSinceLastExit = context.barsSinceLastExit;
  if (lastClosedTrade && barsSinceLastExit != null && barsSinceLastExit < parameters.cooldownBarsAfterAnyExit) {
    return { blocked: true, reasonCode: 'COOLDOWN_ACTIVE', reason: 'Cooldown active after previous exit' };
  }
  if (
    lastClosedTrade
    && String(lastClosedTrade.exitReason || '').toUpperCase().includes('SL')
    && barsSinceLastExit != null
    && barsSinceLastExit < parameters.cooldownBarsAfterSL
  ) {
    return { blocked: true, reasonCode: 'COOLDOWN_AFTER_SL_ACTIVE', reason: 'Cooldown active after SL' };
  }
  const currentDate = getUtcDate(currentBar);
  const todayClosedTrades = Array.isArray(context.todayClosedTrades) ? context.todayClosedTrades : [];
  const todayTrades = Array.isArray(context.todayTrades) ? context.todayTrades : [];
  const todayLosses = todayClosedTrades
    .filter((trade) => !currentDate || trade.entryDateUtc === currentDate || String(trade.entryTime || '').startsWith(currentDate))
    .filter((trade) => Number(trade.pnl) < 0).length;
  if (parameters.maxDailyLosses > 0 && todayLosses >= parameters.maxDailyLosses) {
    return { blocked: true, reasonCode: 'DAILY_LOSS_LIMIT_REACHED', reason: 'Max daily losses reached' };
  }
  if (parameters.maxDailyTrades > 0 && todayTrades.length >= parameters.maxDailyTrades) {
    return { blocked: true, reasonCode: 'MAX_DAILY_TRADES_REACHED', reason: 'Max daily trades reached' };
  }
  return { blocked: false, todayLosses, todayTradeCount: todayTrades.length };
}

function buildSignal({
  side,
  currentBar,
  range,
  rangeHeightAtr,
  atr,
  breakoutExtreme,
  parameters,
  higherTrend,
  score,
  debug,
}) {
  const close = getClose(currentBar);
  const stopBuffer = atr * parameters.slAtrBuffer;
  const sl = side === 'SELL'
    ? breakoutExtreme + stopBuffer
    : breakoutExtreme - stopBuffer;
  const riskDistance = Math.abs(close - sl);
  const rangeTarget = resolveFadeTarget(side, close, range, parameters.targetMode);
  const rewardDistance = side === 'SELL' ? close - rangeTarget : rangeTarget - close;
  const rewardR = riskDistance > 0 ? rewardDistance / riskDistance : null;
  const signalName = side === 'SELL'
    ? 'US30_FAILED_UPSIDE_BREAKOUT_FADE'
    : 'US30_FAILED_DOWNSIDE_BREAKOUT_FADE';

  return {
    signal: side,
    status: 'TRIGGERED',
    confidence: round(score.totalScore / 100, 4),
    marketQualityScore: round(score.totalScore, 2),
    marketQualityThreshold: parameters.minSignalScore,
    sl,
    tp: rangeTarget,
    maxBarsInTrade: parameters.maxBarsInTrade,
    reason: `${side} US30 failed opening-range breakout fade | range ${round(range.low, 1)}-${round(range.high, 1)} | rewardR ${round(rewardR, 2)}`,
    zoneBoundary: side === 'SELL' ? range.high : range.low,
    entrySwing: breakoutExtreme,
    repaintSafe: true,
    metadata: {
      source: 'symbolCustom',
      symbolCustomName: US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1,
      logicName: US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1,
      strategyType: 'SymbolCustom',
      setupType: 'us30_opening_range_failed_breakout_fade',
      module: 'INDEX_FAILED_BREAKOUT_FADE',
      pattern: signalName,
      signalName,
      side,
      closedBarSafe: true,
      candidatePreset: CANDIDATE_PRESET,
      rangeHigh: round(range.high, 5),
      rangeLow: round(range.low, 5),
      rangeMid: round(range.mid, 5),
      rangeHeightAtr: round(rangeHeightAtr, 4),
      targetMode: parameters.targetMode,
      breakoutExtreme: round(breakoutExtreme, 5),
      atr: round(atr, 5),
      riskDistance: round(riskDistance, 5),
      rewardR: round(rewardR, 4),
      zoneBoundary: side === 'SELL' ? range.high : range.low,
      entrySwing: breakoutExtreme,
      higherTrend: {
        regime: higherTrend.regime,
        trendDistanceAtr: round(higherTrend.trendDistanceAtr, 4),
      },
      score: cloneValue(score),
      parameters: cloneValue(parameters),
      debug: parameters.debugSignal ? cloneValue(debug) : undefined,
    },
  };
}

class Us30OpeningRangeFailedBreakoutFadeV1 extends BaseSymbolCustom {
  constructor() {
    super({
      name: US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1,
      symbol: 'US30',
      description: 'US30 opening-range failed-breakout fade draft. It avoids V1 continuation chasing by waiting for a range break and reclaim before fading the failed move.',
    });
    this.parameterSchema = buildParameterSchema();
    this.defaultParameters = buildDefaultParameters(this.parameterSchema);
    this.liveBlockedReason = `${US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1} live execution is blocked until out-of-sample validation passes`;
  }

  getDefaultParameterSchema() {
    return cloneValue(this.parameterSchema);
  }

  getDefaultParameters() {
    return cloneValue(this.defaultParameters);
  }

  normalizeParameters(rawParameters = {}) {
    return normalizeParameters(rawParameters, this.defaultParameters);
  }

  analyze(context = {}) {
    const scope = String(context.scope || 'paper').toLowerCase();
    if (scope === 'live') {
      return {
        signal: 'NONE',
        status: 'BLOCKED',
        reason: this.liveBlockedReason,
        reasonCode: 'SYMBOLCUSTOM_LIVE_BLOCKED_PENDING_VALIDATION',
        symbolCustomName: this.name,
        symbol: this.symbol,
      };
    }

    const parameters = this.normalizeParameters(context.parameters || {});
    const symbol = normalizeSymbol(context.symbol || parameters.symbol || this.symbol);
    if (symbol !== this.symbol && !symbol.startsWith(this.symbol)) {
      return buildNoSignal({
        reasonCode: 'SYMBOL_NOT_SUPPORTED',
        reason: `${this.name} supports US30 only`,
        status: 'FILTERED',
        parameters,
        debug: { symbol },
      });
    }
    if (!parameters.enabled) {
      return buildNoSignal({
        reasonCode: 'STRATEGY_DISABLED',
        reason: `${this.name} disabled by parameters.enabled=false`,
        status: 'DISABLED',
        parameters,
      });
    }

    const rawSetupCandles = context.candles?.setup || context.candles?.entry || context.candles || [];
    const rawEntryCandles = context.candles?.entry || rawSetupCandles;
    const rawHigherCandles = context.candles?.higher || rawSetupCandles;
    const currentBar = context.currentBar || rawEntryCandles[rawEntryCandles.length - 1] || {};
    const evaluationCloseEpoch = getEvaluationCloseEpoch(context, currentBar, parameters);
    const setupTimeframe = context.timeframes?.setupTimeframe || parameters.setupTimeframe;
    const entryTimeframe = context.timeframes?.entryTimeframe || parameters.entryTimeframe;
    const higherTimeframe = context.timeframes?.higherTimeframe || parameters.higherTimeframe;
    const setupCandles = getClosedCandlesAtEvaluation(rawSetupCandles, evaluationCloseEpoch, setupTimeframe);
    const entryCandles = getClosedCandlesAtEvaluation(rawEntryCandles, evaluationCloseEpoch, entryTimeframe);
    const higherCandles = getClosedCandlesAtEvaluation(rawHigherCandles, evaluationCloseEpoch, higherTimeframe);
    const currentEpoch = getEpoch(currentBar);
    const close = getClose(currentBar);
    const open = getOpen(currentBar);
    if (currentEpoch == null || !Number.isFinite(close) || !Number.isFinite(open)) {
      return buildNoSignal({
        reasonCode: 'CURRENT_BAR_INVALID',
        reason: 'Current US30 entry candle is missing time or prices',
        status: 'NO_SETUP',
        parameters,
      });
    }

    const currentUtcHour = getUtcHour(currentBar);
    const allowedHours = parseUtcHours(parameters.allowedUtcHours);
    if (allowedHours.length > 0 && !allowedHours.includes(currentUtcHour)) {
      return buildNoSignal({
        reasonCode: 'UTC_HOUR_FILTERED',
        reason: 'Current UTC hour is outside US30 failed-breakout fade session',
        status: 'FILTERED',
        parameters,
        debug: { currentUtcHour, allowedHours },
      });
    }

    const guard = checkGuards(context, parameters, currentBar);
    if (guard.blocked) {
      return buildNoSignal({
        reasonCode: guard.reasonCode,
        reason: guard.reason,
        status: 'FILTERED',
        parameters,
        debug: guard,
      });
    }

    const minSetupBars = Math.max(parameters.longAtrPeriod + 5, parameters.atrPeriod + parameters.openingRangeBars + 5);
    if (!Array.isArray(setupCandles) || setupCandles.length < minSetupBars) {
      return buildNoSignal({
        reasonCode: 'NOT_ENOUGH_SETUP_CANDLES',
        reason: 'Not enough setup candles for US30 failed-breakout fade',
        status: 'NO_SETUP',
        parameters,
        debug: { setupCandles: setupCandles.length, minSetupBars },
      });
    }

    const atrSeries = calculateAtrSeries(setupCandles, parameters.atrPeriod);
    const longAtrSeries = calculateAtrSeries(setupCandles, parameters.longAtrPeriod);
    const atr = atrSeries.at(-1);
    const longAtr = longAtrSeries.at(-1);
    if (!Number.isFinite(atr) || !Number.isFinite(longAtr) || atr <= 0 || longAtr <= 0) {
      return buildNoSignal({
        reasonCode: 'ATR_UNAVAILABLE',
        reason: 'ATR unavailable for US30 failed-breakout fade',
        status: 'FILTERED',
        parameters,
        debug: { atr, longAtr },
      });
    }

    const atrRatio = atr / longAtr;
    if (atrRatio < parameters.minAtrRatio || atrRatio > parameters.maxAtrRatio) {
      return buildNoSignal({
        reasonCode: 'ATR_REGIME_FILTERED',
        reason: 'US30 ATR regime outside failed-breakout fade bounds',
        status: 'FILTERED',
        parameters,
        debug: { atr, longAtr, atrRatio },
      });
    }

    const sessionCandles = getTodaySessionCandles(setupCandles, currentBar, parameters.rangeStartUtcHour);
    if (sessionCandles.length < parameters.openingRangeBars + 1) {
      return buildNoSignal({
        reasonCode: 'OPENING_RANGE_NOT_READY',
        reason: 'US30 opening range is not complete yet',
        status: 'NO_SETUP',
        parameters,
        debug: { sessionCandles: sessionCandles.length, openingRangeBars: parameters.openingRangeBars },
      });
    }
    const rangeCandles = sessionCandles.slice(0, parameters.openingRangeBars);
    const range = rangeFromCandles(rangeCandles);
    if (!range) {
      return buildNoSignal({
        reasonCode: 'OPENING_RANGE_INVALID',
        reason: 'US30 opening range prices are invalid',
        status: 'NO_SETUP',
        parameters,
      });
    }
    const rangeHeight = range.high - range.low;
    const rangeHeightAtr = rangeHeight / atr;
    if (rangeHeightAtr < parameters.minRangeAtr || rangeHeightAtr > parameters.maxRangeAtr) {
      return buildNoSignal({
        reasonCode: 'OPENING_RANGE_SIZE_FILTERED',
        reason: 'US30 opening range size is outside configured ATR bounds',
        status: 'FILTERED',
        parameters,
        debug: { rangeHeight, rangeHeightAtr, minRangeAtr: parameters.minRangeAtr, maxRangeAtr: parameters.maxRangeAtr },
      });
    }

    const rangeEndEpoch = getEpoch(rangeCandles[rangeCandles.length - 1])
      + (getTimeframeDurationMs(setupTimeframe) || 0);
    const postRangeEntry = entryCandles
      .filter((candle) => {
        const epoch = getEpoch(candle);
        return epoch != null && epoch >= rangeEndEpoch && epoch <= currentEpoch;
      })
      .slice(-parameters.failedBreakoutLookbackBars);
    if (postRangeEntry.length < 2) {
      return buildNoSignal({
        reasonCode: 'NO_POST_RANGE_ENTRY_CANDLES',
        reason: 'Not enough post-range entry candles for failed breakout detection',
        status: 'NO_SETUP',
        parameters,
        debug: { rangeEndEpoch, currentEpoch },
      });
    }

    const recentHigh = Math.max(...postRangeEntry.map(getHigh).filter(Number.isFinite));
    const recentLow = Math.min(...postRangeEntry.map(getLow).filter(Number.isFinite));
    const breakoutBuffer = atr * parameters.breakoutBufferAtr;
    const reclaimBuffer = atr * parameters.reclaimBufferAtr;
    const failedUpside = recentHigh > range.high + breakoutBuffer && close < range.high - reclaimBuffer;
    const failedDownside = recentLow < range.low - breakoutBuffer && close > range.low + reclaimBuffer;
    const rejectionSell = !parameters.requireRejectionCandle || close < open;
    const rejectionBuy = !parameters.requireRejectionCandle || close > open;
    const higherTrend = buildHigherTrend(higherCandles, parameters);

    const candidates = [];
    if (failedUpside && rejectionSell && parameters.enableSell) {
      const blockedByTrend = parameters.blockStrongHigherTrend
        && higherTrend.bullish
        && Number.isFinite(higherTrend.trendDistanceAtr)
        && higherTrend.trendDistanceAtr > parameters.maxHigherTrendAtr;
      if (!blockedByTrend) {
        candidates.push({ side: 'SELL', breakoutExtreme: recentHigh });
      }
    }
    if (failedDownside && rejectionBuy && parameters.enableBuy) {
      const blockedByTrend = parameters.blockStrongHigherTrend
        && higherTrend.bearish
        && Number.isFinite(higherTrend.trendDistanceAtr)
        && higherTrend.trendDistanceAtr > parameters.maxHigherTrendAtr;
      if (!blockedByTrend) {
        candidates.push({ side: 'BUY', breakoutExtreme: recentLow });
      }
    }

    if (!candidates.length) {
      return buildNoSignal({
        reasonCode: 'NO_FAILED_BREAKOUT_FADE_SETUP',
        reason: 'No failed opening-range breakout reclaim passed rejection and higher-trend filters',
        status: 'NO_SETUP',
        parameters,
        debug: {
          range,
          recentHigh,
          recentLow,
          breakoutBuffer,
          reclaimBuffer,
          close,
          open,
          failedUpside,
          failedDownside,
          rejectionSell,
          rejectionBuy,
          higherTrend,
        },
      });
    }

    const scored = candidates.map((candidate) => {
      const failureDepthAtr = candidate.side === 'SELL'
        ? (candidate.breakoutExtreme - range.high) / atr
        : (range.low - candidate.breakoutExtreme) / atr;
      const reclaimDepthAtr = candidate.side === 'SELL'
        ? (range.high - close) / atr
        : (close - range.low) / atr;
      const rejectionBodyAtr = Math.abs(close - open) / atr;
      const trendPenalty = Number.isFinite(higherTrend.trendDistanceAtr)
        ? Math.min(12, higherTrend.trendDistanceAtr * 4)
        : 0;
      const score = {
        failureScore: Math.min(28, failureDepthAtr * 60),
        reclaimScore: Math.min(24, reclaimDepthAtr * 70),
        rangeScore: Math.max(0, 18 - Math.abs(rangeHeightAtr - 1.4) * 5),
        volatilityScore: atrRatio >= parameters.minAtrRatio && atrRatio <= parameters.maxAtrRatio ? 12 : 0,
        rejectionScore: Math.min(12, rejectionBodyAtr * 40),
        trendPenalty,
      };
      score.totalScore = Math.max(
        0,
        Math.min(100, score.failureScore + score.reclaimScore + score.rangeScore + score.volatilityScore + score.rejectionScore - score.trendPenalty)
      );
      return { ...candidate, score };
    }).sort((left, right) => right.score.totalScore - left.score.totalScore);

    const best = scored[0];
    const target = resolveFadeTarget(best.side, close, range, parameters.targetMode);
    const stopBuffer = atr * parameters.slAtrBuffer;
    const stop = best.side === 'SELL' ? best.breakoutExtreme + stopBuffer : best.breakoutExtreme - stopBuffer;
    const riskDistance = Math.abs(close - stop);
    const rewardDistance = best.side === 'SELL' ? close - target : target - close;
    const rewardR = riskDistance > 0 ? rewardDistance / riskDistance : null;
    if (!Number.isFinite(rewardR) || rewardR < parameters.minTargetR) {
      return buildNoSignal({
        reasonCode: 'TARGET_R_TOO_LOW',
        reason: 'US30 failed-breakout fade target does not offer enough R',
        status: 'FILTERED',
        parameters,
        debug: { target, stop, close, rewardR, minTargetR: parameters.minTargetR, targetMode: parameters.targetMode },
      });
    }
    if (best.score.totalScore < parameters.minSignalScore) {
      return buildNoSignal({
        reasonCode: 'SIGNAL_SCORE_TOO_LOW',
        reason: `Signal score below threshold: ${round(best.score.totalScore, 2)} < ${parameters.minSignalScore}`,
        status: 'FILTERED',
        parameters,
        debug: { score: best.score },
      });
    }

    return buildSignal({
      side: best.side,
      currentBar,
      range,
      rangeHeightAtr,
      atr,
      breakoutExtreme: best.breakoutExtreme,
      parameters,
      higherTrend,
      score: best.score,
      debug: {
        scope,
        currentUtcHour,
        atr,
        longAtr,
        atrRatio,
        range,
        recentHigh,
        recentLow,
        failedUpside,
        failedDownside,
        higherTrend,
        guard,
      },
    });
  }
}

Us30OpeningRangeFailedBreakoutFadeV1.US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1 = US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1;
Us30OpeningRangeFailedBreakoutFadeV1.US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1_VERSION = US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1_VERSION;
Us30OpeningRangeFailedBreakoutFadeV1.CANDIDATE_PRESET = CANDIDATE_PRESET;
Us30OpeningRangeFailedBreakoutFadeV1.calculateAtrSeries = calculateAtrSeries;
Us30OpeningRangeFailedBreakoutFadeV1.calculateEmaSeries = calculateEmaSeries;
Us30OpeningRangeFailedBreakoutFadeV1.normalizeParameters = normalizeParameters;

module.exports = Us30OpeningRangeFailedBreakoutFadeV1;
module.exports.US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1 = US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1;
module.exports.US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1_VERSION = US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1_VERSION;
