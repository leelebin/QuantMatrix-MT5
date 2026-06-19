const BaseSymbolCustom = require('../BaseSymbolCustom');

const XAUUSD_MICROSTRUCTURE_SCALP_V1 = 'XAUUSD_MICROSTRUCTURE_SCALP_V1';
const XAUUSD_MICROSTRUCTURE_SCALP_V1_VERSION = 2;
const CANDIDATE_PRESET = 'microstructure_scalp_default_xauusd';
const LIVE_BLOCKED_REASON = 'XAUUSD_MICROSTRUCTURE_SCALP_V1 live execution is blocked by default';

const DEFAULT_PARAMETER_SCHEMA = Object.freeze([
  { key: 'logicId', label: 'Logic ID', type: 'string', defaultValue: XAUUSD_MICROSTRUCTURE_SCALP_V1 },
  { key: 'mode', label: 'Mode', type: 'string', defaultValue: 'SYMBOLCUSTOM' },
  { key: 'source', label: 'Source', type: 'string', defaultValue: 'symbolCustom' },
  { key: 'symbol', label: 'Symbol', type: 'string', defaultValue: 'XAUUSD' },
  { key: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: false },
  { key: 'setupTimeframe', label: 'Setup Timeframe', type: 'string', defaultValue: '5m' },
  { key: 'entryTimeframe', label: 'Entry Timeframe', type: 'string', defaultValue: '1m' },
  { key: 'higherTimeframe', label: 'Higher Timeframe', type: 'string', defaultValue: '15m' },
  { key: 'enableBuy', label: 'Enable BUY', type: 'boolean', defaultValue: true },
  { key: 'enableSell', label: 'Enable SELL', type: 'boolean', defaultValue: true },
  { key: 'riskReward', label: 'Risk Reward', type: 'enum', defaultValue: 1.5, options: [1.3, 1.5, 1.8] },
  { key: 'atrPeriod', label: 'ATR Period', type: 'number', defaultValue: 14, min: 8, max: 28, step: 1 },
  { key: 'slAtrMultiplier', label: 'SL ATR Multiplier', type: 'enum', defaultValue: 0.9, options: [0.7, 0.9, 1.1] },
  { key: 'tpAtrMultiplier', label: 'TP ATR Multiplier', type: 'number', defaultValue: 1.35, min: 0.9, max: 2.4, step: 0.15 },
  { key: 'maxBarsInTrade', label: 'Max Bars In Trade', type: 'number', defaultValue: 30, min: 5, max: 90, step: 5 },
  { key: 'maxMinutesInTrade', label: 'Max Minutes In Trade', type: 'number', defaultValue: 30, min: 5, max: 120, step: 5 },
  { key: 'cooldownBarsAfterAnyExit', label: 'Cooldown Bars After Any Exit', type: 'number', defaultValue: 5, min: 0, max: 40, step: 5 },
  { key: 'cooldownBarsAfterSL', label: 'Cooldown Bars After SL', type: 'enum', defaultValue: 15, options: [10, 15, 20] },
  { key: 'maxDailyTrades', label: 'Max Daily Trades', type: 'enum', defaultValue: 8, options: [4, 6, 8] },
  { key: 'maxDailyLosses', label: 'Max Daily Losses', type: 'number', defaultValue: 3, min: 1, max: 6, step: 1 },
  { key: 'maxConsecutiveLosses', label: 'Max Consecutive Losses', type: 'enum', defaultValue: 2, options: [2, 3] },
  { key: 'spreadMaxPoints', label: 'Max Spread Points', type: 'number', defaultValue: 45, min: 5, max: 100, step: 5 },
  { key: 'spreadAtrMaxRatio', label: 'Max Spread ATR Ratio', type: 'number', defaultValue: 0.18, min: 0.02, max: 0.4, step: 0.02 },
  { key: 'spreadPointSize', label: 'Spread Point Size', type: 'number', defaultValue: 0.01, min: 0.00001, max: 1, step: 0.00001 },
  { key: 'minAtr', label: 'Minimum ATR', type: 'number', defaultValue: 0, min: 0, max: 20, step: 0.1 },
  { key: 'maxAtrSpikeRatio', label: 'Max ATR Spike Ratio', type: 'number', defaultValue: 2.2, min: 1, max: 5, step: 0.1 },
  { key: 'shortAtrPeriod', label: 'Short ATR Period', type: 'number', defaultValue: 5, min: 3, max: 12, step: 1 },
  { key: 'longAtrPeriod', label: 'Long ATR Period', type: 'number', defaultValue: 20, min: 12, max: 40, step: 2 },
  { key: 'trendEmaFast', label: 'Trend EMA Fast', type: 'number', defaultValue: 20, min: 8, max: 40, step: 2 },
  { key: 'trendEmaSlow', label: 'Trend EMA Slow', type: 'number', defaultValue: 50, min: 30, max: 100, step: 5 },
  { key: 'trendSlopeLookback', label: 'Trend Slope Lookback', type: 'number', defaultValue: 5, min: 2, max: 12, step: 1 },
  { key: 'vwapLookbackBars', label: 'VWAP Lookback Bars', type: 'number', defaultValue: 30, min: 10, max: 80, step: 5 },
  { key: 'vwapReclaimToleranceAtr', label: 'VWAP Reclaim Tolerance ATR', type: 'enum', defaultValue: 0.25, options: [0.15, 0.25, 0.35] },
  { key: 'breakoutLookbackBars', label: 'Breakout Lookback Bars', type: 'enum', defaultValue: 12, options: [8, 12, 18] },
  { key: 'retestToleranceAtr', label: 'Retest Tolerance ATR', type: 'number', defaultValue: 0.2, min: 0.05, max: 0.6, step: 0.05 },
  { key: 'absorptionLookbackBars', label: 'Absorption Lookback Bars', type: 'number', defaultValue: 4, min: 2, max: 10, step: 1 },
  { key: 'tickProxyLookbackBars', label: 'Tick Proxy Lookback Bars', type: 'enum', defaultValue: 8, options: [5, 8, 12] },
  { key: 'minDirectionalCloseRatio', label: 'Min Directional Close Ratio', type: 'enum', defaultValue: 0.62, options: [0.58, 0.62, 0.66] },
  { key: 'minBodyToRangeRatio', label: 'Min Body To Range Ratio', type: 'number', defaultValue: 0.45, min: 0.2, max: 0.8, step: 0.05 },
  { key: 'maxOppositeWickRatio', label: 'Max Opposite Wick Ratio', type: 'number', defaultValue: 0.55, min: 0.2, max: 0.8, step: 0.05 },
  { key: 'useEntryQualityGuards', label: 'Use Entry Quality Guards', type: 'boolean', defaultValue: false },
  { key: 'minEntryCloseDirectionRatio', label: 'Min Entry Close Direction Ratio', type: 'number', defaultValue: 0, min: 0, max: 1, step: 0.01 },
  { key: 'maxEntryCloseDirectionRatio', label: 'Max Entry Close Direction Ratio', type: 'number', defaultValue: 1, min: 0, max: 1, step: 0.01 },
  { key: 'minEntryBodyToRangeRatio', label: 'Min Entry Body To Range Ratio', type: 'number', defaultValue: 0, min: 0, max: 1, step: 0.01 },
  { key: 'maxEntryBodyToRangeRatio', label: 'Max Entry Body To Range Ratio', type: 'number', defaultValue: 1, min: 0, max: 1, step: 0.01 },
  { key: 'minAtrSpikeRatio', label: 'Min ATR Spike Ratio', type: 'number', defaultValue: 0, min: 0, max: 2, step: 0.05 },
  { key: 'impulseAtrMultiplier', label: 'Impulse ATR Multiplier', type: 'number', defaultValue: 0.8, min: 0.3, max: 1.5, step: 0.1 },
  { key: 'avoidChasingAtrMultiplier', label: 'Avoid Chasing ATR Multiplier', type: 'number', defaultValue: 1.4, min: 0.8, max: 3, step: 0.1 },
  { key: 'allowedUtcHours', label: 'Allowed UTC Hours', type: 'json', defaultValue: [] },
  { key: 'blockNewsWindow', label: 'Block News Window', type: 'boolean', defaultValue: false },
  { key: 'minSignalScore', label: 'Min Signal Score', type: 'enum', defaultValue: 75, options: [70, 75, 80, 85] },
  { key: 'debugSignal', label: 'Debug Signal', type: 'boolean', defaultValue: true },
]);

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
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

function clamp(value, min = 0, max = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
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

function getUtcHour(context = {}, currentBar = {}) {
  const explicit = Number(context.currentUtcHour);
  if (Number.isInteger(explicit) && explicit >= 0 && explicit <= 23) return explicit;
  const epoch = toEpoch(getCandleTime(currentBar));
  return epoch == null ? null : new Date(epoch).getUTCHours();
}

function buildDefaultParameters() {
  return DEFAULT_PARAMETER_SCHEMA.reduce((params, field) => {
    params[field.key] = cloneValue(field.defaultValue);
    return params;
  }, {});
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

function normalizeParams(rawParameters = {}) {
  const merged = {
    ...buildDefaultParameters(),
    ...(rawParameters || {}),
  };

  return {
    ...merged,
    enabled: toBoolean(merged.enabled, false),
    enableBuy: toBoolean(merged.enableBuy, true),
    enableSell: toBoolean(merged.enableSell, true),
    blockNewsWindow: toBoolean(merged.blockNewsWindow, false),
    debugSignal: toBoolean(merged.debugSignal, true),
    useEntryQualityGuards: toBoolean(merged.useEntryQualityGuards, false),
    riskReward: toNumber(merged.riskReward, 1.5),
    atrPeriod: Math.max(2, toInteger(merged.atrPeriod, 14)),
    slAtrMultiplier: toNumber(merged.slAtrMultiplier, 0.9),
    tpAtrMultiplier: toNumber(merged.tpAtrMultiplier, 1.35),
    maxBarsInTrade: Math.max(1, toInteger(merged.maxBarsInTrade, 30)),
    maxMinutesInTrade: Math.max(1, toInteger(merged.maxMinutesInTrade, 30)),
    cooldownBarsAfterAnyExit: Math.max(0, toInteger(merged.cooldownBarsAfterAnyExit, 5)),
    cooldownBarsAfterSL: Math.max(0, toInteger(merged.cooldownBarsAfterSL, 15)),
    maxDailyTrades: Math.max(0, toInteger(merged.maxDailyTrades, 8)),
    maxDailyLosses: Math.max(0, toInteger(merged.maxDailyLosses, 3)),
    maxConsecutiveLosses: Math.max(0, toInteger(merged.maxConsecutiveLosses, 2)),
    spreadMaxPoints: toNumber(merged.spreadMaxPoints, 45),
    spreadAtrMaxRatio: toNumber(merged.spreadAtrMaxRatio, 0.18),
    spreadPointSize: toNumber(merged.spreadPointSize, 0.01),
    minAtr: toNumber(merged.minAtr, 0),
    maxAtrSpikeRatio: toNumber(merged.maxAtrSpikeRatio, 2.2),
    shortAtrPeriod: Math.max(2, toInteger(merged.shortAtrPeriod, 5)),
    longAtrPeriod: Math.max(3, toInteger(merged.longAtrPeriod, 20)),
    trendEmaFast: Math.max(2, toInteger(merged.trendEmaFast, 20)),
    trendEmaSlow: Math.max(3, toInteger(merged.trendEmaSlow, 50)),
    trendSlopeLookback: Math.max(1, toInteger(merged.trendSlopeLookback, 5)),
    vwapLookbackBars: Math.max(2, toInteger(merged.vwapLookbackBars, 30)),
    vwapReclaimToleranceAtr: toNumber(merged.vwapReclaimToleranceAtr, 0.25),
    breakoutLookbackBars: Math.max(3, toInteger(merged.breakoutLookbackBars, 12)),
    retestToleranceAtr: toNumber(merged.retestToleranceAtr, 0.2),
    absorptionLookbackBars: Math.max(2, toInteger(merged.absorptionLookbackBars, 4)),
    tickProxyLookbackBars: Math.max(2, toInteger(merged.tickProxyLookbackBars, 8)),
    minDirectionalCloseRatio: toNumber(merged.minDirectionalCloseRatio, 0.62),
    minBodyToRangeRatio: toNumber(merged.minBodyToRangeRatio, 0.45),
    maxOppositeWickRatio: toNumber(merged.maxOppositeWickRatio, 0.55),
    minEntryCloseDirectionRatio: clamp(toNumber(merged.minEntryCloseDirectionRatio, 0), 0, 1),
    maxEntryCloseDirectionRatio: clamp(toNumber(merged.maxEntryCloseDirectionRatio, 1), 0, 1),
    minEntryBodyToRangeRatio: clamp(toNumber(merged.minEntryBodyToRangeRatio, 0), 0, 1),
    maxEntryBodyToRangeRatio: clamp(toNumber(merged.maxEntryBodyToRangeRatio, 1), 0, 1),
    minAtrSpikeRatio: Math.max(0, toNumber(merged.minAtrSpikeRatio, 0)),
    impulseAtrMultiplier: toNumber(merged.impulseAtrMultiplier, 0.8),
    avoidChasingAtrMultiplier: toNumber(merged.avoidChasingAtrMultiplier, 1.4),
    minSignalScore: Math.max(1, toInteger(merged.minSignalScore, 75)),
    allowedUtcHours: merged.allowedUtcHours,
  };
}

function getClose(candle = {}) {
  return toNumber(candle.close, null);
}

function getRange(candle = {}) {
  const high = toNumber(candle.high, null);
  const low = toNumber(candle.low, null);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  return Math.max(0, high - low);
}

function calculateAtr(candles = [], period = 14) {
  const safePeriod = Math.max(1, toInteger(period, 14));
  if (!Array.isArray(candles) || candles.length < safePeriod + 1) return null;

  const values = [];
  const startIndex = Math.max(1, candles.length - safePeriod);
  for (let index = startIndex; index < candles.length; index += 1) {
    const current = candles[index] || {};
    const previous = candles[index - 1] || {};
    const high = toNumber(current.high, null);
    const low = toNumber(current.low, null);
    const previousClose = getClose(previous);
    if (![high, low, previousClose].every(Number.isFinite)) return null;
    values.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
  }

  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function calculateEmaSeries(values = [], period = 20) {
  const safePeriod = Math.max(1, toInteger(period, 20));
  const clean = values.map((value) => toNumber(value, null)).filter(Number.isFinite);
  if (clean.length < safePeriod) return [];
  const multiplier = 2 / (safePeriod + 1);
  let ema = clean.slice(0, safePeriod).reduce((sum, value) => sum + value, 0) / safePeriod;
  const series = [ema];
  for (let index = safePeriod; index < clean.length; index += 1) {
    ema = ((clean[index] - ema) * multiplier) + ema;
    series.push(ema);
  }
  return series;
}

function calculateEma(candles = [], period = 20) {
  const closes = (Array.isArray(candles) ? candles : []).map(getClose).filter(Number.isFinite);
  const series = calculateEmaSeries(closes, period);
  return series.length ? series[series.length - 1] : null;
}

function calculateEmaSlope(candles = [], period = 20, lookback = 5) {
  const closes = (Array.isArray(candles) ? candles : []).map(getClose).filter(Number.isFinite);
  const series = calculateEmaSeries(closes, period);
  const safeLookback = Math.max(1, toInteger(lookback, 5));
  if (series.length <= safeLookback) return null;
  return series[series.length - 1] - series[series.length - 1 - safeLookback];
}

function calculateVwap(candles = []) {
  const source = Array.isArray(candles) ? candles : [];
  let volumeSum = 0;
  let weightedSum = 0;
  source.forEach((candle) => {
    const high = toNumber(candle.high, null);
    const low = toNumber(candle.low, null);
    const close = toNumber(candle.close, null);
    if (![high, low, close].every(Number.isFinite)) return;
    const volume = Math.max(1, toNumber(candle.volume ?? candle.tickVolume ?? candle.tick_volume, 1));
    const typical = (high + low + close) / 3;
    volumeSum += volume;
    weightedSum += typical * volume;
  });
  return volumeSum > 0 ? weightedSum / volumeSum : null;
}

function calculatePriceRange(candles = []) {
  const source = Array.isArray(candles) ? candles : [];
  const highs = source.map((candle) => toNumber(candle.high, null)).filter(Number.isFinite);
  const lows = source.map((candle) => toNumber(candle.low, null)).filter(Number.isFinite);
  if (!highs.length || !lows.length) return { high: null, low: null };
  return { high: Math.max(...highs), low: Math.min(...lows) };
}

function calculateCandleShape(candle = {}) {
  const open = toNumber(candle.open, null);
  const high = toNumber(candle.high, null);
  const low = toNumber(candle.low, null);
  const close = toNumber(candle.close, null);
  if (![open, high, low, close].every(Number.isFinite)) {
    return {
      range: null,
      body: null,
      bodyToRangeRatio: null,
      upperWickRatio: null,
      lowerWickRatio: null,
    };
  }
  const range = Math.max(0, high - low);
  const body = Math.abs(close - open);
  if (range <= 0) {
    return { range, body, bodyToRangeRatio: null, upperWickRatio: null, lowerWickRatio: null };
  }
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  return {
    range,
    body,
    bodyToRangeRatio: body / range,
    upperWickRatio: upperWick / range,
    lowerWickRatio: lowerWick / range,
  };
}

function calculateCloseDirectionRatio(candles = [], side = 'BUY', lookback = 8) {
  const source = Array.isArray(candles) ? candles.slice(-Math.max(lookback + 1, 2)) : [];
  if (source.length < 2) return null;
  let directional = 0;
  let total = 0;
  for (let index = 1; index < source.length; index += 1) {
    const currentClose = getClose(source[index]);
    const previousClose = getClose(source[index - 1]);
    if (![currentClose, previousClose].every(Number.isFinite)) continue;
    if (side === 'BUY' && currentClose > previousClose) directional += 1;
    if (side === 'SELL' && currentClose < previousClose) directional += 1;
    total += 1;
  }
  return total > 0 ? directional / total : null;
}

function calculateTickFeatures(context = {}, side = 'BUY', parameters = {}) {
  const rawTicks = context.ticks || context.tickData || context.recentTicks || context.currentBar?.ticks;
  const ticks = Array.isArray(rawTicks) ? rawTicks.slice(-Math.max(parameters.tickProxyLookbackBars, 3)) : [];
  if (ticks.length < 3) return null;

  let up = 0;
  let down = 0;
  let adverse = 0;
  let previousMid = null;
  ticks.forEach((tick) => {
    const bid = toNumber(tick.bid, null);
    const ask = toNumber(tick.ask, null);
    const mid = Number.isFinite(bid) && Number.isFinite(ask)
      ? (bid + ask) / 2
      : toNumber(tick.mid ?? tick.price ?? tick.last, null);
    if (!Number.isFinite(mid)) return;
    if (previousMid != null) {
      if (mid > previousMid) up += 1;
      if (mid < previousMid) down += 1;
      if (side === 'BUY' && mid < previousMid) adverse += 1;
      if (side === 'SELL' && mid > previousMid) adverse += 1;
    }
    previousMid = mid;
  });

  const total = up + down;
  if (total <= 0) return null;
  const imbalance = (up - down) / total;
  const directionImbalance = side === 'BUY' ? imbalance : -imbalance;
  const firstMid = (() => {
    const first = ticks[0] || {};
    const bid = toNumber(first.bid, null);
    const ask = toNumber(first.ask, null);
    return Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : toNumber(first.mid ?? first.price ?? first.last, null);
  })();
  const midVelocity = Number.isFinite(firstMid) && Number.isFinite(previousMid) ? previousMid - firstMid : null;
  const last = ticks[ticks.length - 1] || {};
  const spread = Number.isFinite(toNumber(last.ask, null)) && Number.isFinite(toNumber(last.bid, null))
    ? toNumber(last.ask, null) - toNumber(last.bid, null)
    : null;

  return {
    tickUpCount: up,
    tickDownCount: down,
    tickDirectionImbalance: directionImbalance,
    recentMidPriceVelocity: midVelocity,
    recentAdverseTickCount: adverse,
    spread,
  };
}

function resolveSpreadInfo(currentBar = {}, tickFeatures = null, atr = null, parameters = {}) {
  const rawPriceSpread = currentBar.spreadPrice ?? currentBar.currentSpreadPrice ?? tickFeatures?.spread;
  const rawPointSpread = currentBar.spread ?? currentBar.currentSpread ?? currentBar.spreadPoints;
  let spread = null;
  let spreadPoints = null;
  let spreadUnavailable = false;

  if (rawPriceSpread !== undefined && rawPriceSpread !== null && rawPriceSpread !== '') {
    spread = toNumber(rawPriceSpread, null);
    spreadPoints = Number.isFinite(spread) && parameters.spreadPointSize > 0
      ? spread / parameters.spreadPointSize
      : null;
  } else if (rawPointSpread !== undefined && rawPointSpread !== null && rawPointSpread !== '') {
    spreadPoints = toNumber(rawPointSpread, null);
    spread = Number.isFinite(spreadPoints) ? spreadPoints * parameters.spreadPointSize : null;
  }

  if (!Number.isFinite(spread) && !Number.isFinite(spreadPoints)) {
    spreadUnavailable = true;
    return {
      passed: true,
      score: 8,
      spread: null,
      spreadPoints: null,
      spreadAtr: null,
      spreadUnavailable,
      reason: 'spread unavailable, using neutral cost mode',
    };
  }

  const spreadAtr = Number.isFinite(spread) && Number.isFinite(atr) && atr > 0 ? spread / atr : null;
  const pointsOk = Number.isFinite(spreadPoints) && spreadPoints <= parameters.spreadMaxPoints;
  const atrOk = Number.isFinite(spreadAtr) && spreadAtr <= parameters.spreadAtrMaxRatio;
  const passed = pointsOk || atrOk;
  return {
    passed,
    score: passed ? 15 : 0,
    spread,
    spreadPoints,
    spreadAtr,
    spreadUnavailable,
    reason: passed ? null : 'SPREAD_TOO_WIDE',
  };
}

function calculateTrendScore({ side, setupCandles, higherCandles, parameters }) {
  const setupWindow = Array.isArray(setupCandles) ? setupCandles.slice(-Math.max(parameters.trendEmaSlow + parameters.trendSlopeLookback + 10, 80)) : [];
  const higherWindow = Array.isArray(higherCandles) ? higherCandles.slice(-Math.max(parameters.trendEmaSlow + parameters.trendSlopeLookback + 10, 80)) : [];
  const fast = calculateEma(setupWindow, parameters.trendEmaFast);
  const slow = calculateEma(setupWindow, parameters.trendEmaSlow);
  const slope = calculateEmaSlope(setupWindow, parameters.trendEmaFast, parameters.trendSlopeLookback);
  const higherFast = calculateEma(higherWindow, parameters.trendEmaFast);
  const higherSlow = calculateEma(higherWindow, parameters.trendEmaSlow);

  const bullish = Number.isFinite(fast) && Number.isFinite(slow) && fast > slow;
  const bearish = Number.isFinite(fast) && Number.isFinite(slow) && fast < slow;
  const slopeBullish = Number.isFinite(slope) && slope > 0;
  const slopeBearish = Number.isFinite(slope) && slope < 0;
  const higherBullish = Number.isFinite(higherFast) && Number.isFinite(higherSlow) && higherFast > higherSlow;
  const higherBearish = Number.isFinite(higherFast) && Number.isFinite(higherSlow) && higherFast < higherSlow;

  const directionOk = side === 'BUY'
    ? (bullish || slopeBullish || higherBullish)
    : (bearish || slopeBearish || higherBearish);
  const clearOpposite = side === 'BUY'
    ? (bearish && slopeBearish && higherBearish)
    : (bullish && slopeBullish && higherBullish);
  const alignmentScore = side === 'BUY' ? (bullish ? 12 : 0) : (bearish ? 12 : 0);
  const slopeScore = side === 'BUY' ? (slopeBullish ? 7 : 0) : (slopeBearish ? 7 : 0);
  const higherScore = side === 'BUY' ? (higherBullish ? 6 : 0) : (higherBearish ? 6 : 0);
  const score = clearOpposite || !directionOk
    ? 0
    : Math.min(25, alignmentScore + slopeScore + higherScore);

  return {
    passed: directionOk && !clearOpposite,
    score,
    fast,
    slow,
    slope,
    higherFast,
    higherSlow,
    bullish,
    bearish,
    slopeBullish,
    slopeBearish,
    higherBullish,
    higherBearish,
    clearOpposite,
  };
}

function calculateVolatilityScore(entryCandles = [], currentBar = {}, parameters = {}) {
  const atr = calculateAtr(entryCandles, parameters.atrPeriod);
  const shortAtr = calculateAtr(entryCandles, parameters.shortAtrPeriod);
  const longAtr = calculateAtr(entryCandles, parameters.longAtrPeriod);
  if (!Number.isFinite(atr) || atr <= 0 || !Number.isFinite(shortAtr) || !Number.isFinite(longAtr) || longAtr <= 0) {
    return { passed: false, reasonCode: 'ATR_MISSING', score: 0, atr, shortAtr, longAtr, atrSpikeRatio: null };
  }
  const atrSpikeRatio = shortAtr / longAtr;
  const shape = calculateCandleShape(currentBar);
  const impulseAtr = Number.isFinite(shape.body) ? shape.body / atr : null;
  if (atr < parameters.minAtr) {
    return { passed: false, reasonCode: 'ATR_BELOW_MINIMUM', score: 0, atr, shortAtr, longAtr, atrSpikeRatio, impulseAtr };
  }
  if (atrSpikeRatio > parameters.maxAtrSpikeRatio) {
    return { passed: false, reasonCode: 'ATR_SPIKE_AVOID_CHASING', score: 0, atr, shortAtr, longAtr, atrSpikeRatio, impulseAtr };
  }
  if (parameters.minAtrSpikeRatio > 0 && atrSpikeRatio < parameters.minAtrSpikeRatio) {
    return { passed: false, reasonCode: 'ATR_CONTRACTION_FILTERED', score: 0, atr, shortAtr, longAtr, atrSpikeRatio, impulseAtr };
  }
  if (Number.isFinite(impulseAtr) && impulseAtr > parameters.avoidChasingAtrMultiplier) {
    return { passed: false, reasonCode: 'ATR_SPIKE_AVOID_CHASING', score: 0, atr, shortAtr, longAtr, atrSpikeRatio, impulseAtr };
  }
  const score = atrSpikeRatio <= 1.4 ? 15 : atrSpikeRatio <= 1.8 ? 12 : 9;
  return { passed: true, reasonCode: null, score, atr, shortAtr, longAtr, atrSpikeRatio, impulseAtr };
}

function detectBullishAbsorption(candles = [], parameters = {}) {
  const recent = candles.slice(-parameters.absorptionLookbackBars);
  if (recent.length < parameters.absorptionLookbackBars) return false;
  const latest = recent[recent.length - 1];
  const previous = recent.slice(0, -1);
  const latestVolume = toNumber(latest.volume ?? latest.tickVolume ?? latest.tick_volume, 0);
  const avgVolume = previous.reduce((sum, candle) => sum + Math.max(0, toNumber(candle.volume ?? candle.tickVolume ?? candle.tick_volume, 0)), 0) / previous.length;
  const previousLow = Math.min(...previous.map((candle) => toNumber(candle.low, Infinity)));
  const shape = calculateCandleShape(latest);
  return latestVolume >= avgVolume * 1.1
    && toNumber(latest.low, Infinity) >= previousLow - shape.range * 0.1
    && toNumber(latest.close, null) > toNumber(latest.open, null);
}

function detectBearishAbsorption(candles = [], parameters = {}) {
  const recent = candles.slice(-parameters.absorptionLookbackBars);
  if (recent.length < parameters.absorptionLookbackBars) return false;
  const latest = recent[recent.length - 1];
  const previous = recent.slice(0, -1);
  const latestVolume = toNumber(latest.volume ?? latest.tickVolume ?? latest.tick_volume, 0);
  const avgVolume = previous.reduce((sum, candle) => sum + Math.max(0, toNumber(candle.volume ?? candle.tickVolume ?? candle.tick_volume, 0)), 0) / previous.length;
  const previousHigh = Math.max(...previous.map((candle) => toNumber(candle.high, -Infinity)));
  const shape = calculateCandleShape(latest);
  return latestVolume >= avgVolume * 1.1
    && toNumber(latest.high, -Infinity) <= previousHigh + shape.range * 0.1
    && toNumber(latest.close, null) < toNumber(latest.open, null);
}

function detectCandlePressureImproving(candles = [], side = 'BUY', parameters = {}) {
  const recent = candles.slice(-Math.max(parameters.absorptionLookbackBars, 4));
  if (recent.length < 4) return false;
  const previous = recent.slice(0, -1);
  const latest = recent[recent.length - 1];
  const latestBody = calculateCandleShape(latest).body || 0;
  const opposingBodies = previous
    .filter((candle) => side === 'BUY' ? toNumber(candle.close, 0) < toNumber(candle.open, 0) : toNumber(candle.close, 0) > toNumber(candle.open, 0))
    .map((candle) => calculateCandleShape(candle).body || 0);
  const directionalBodies = previous
    .filter((candle) => side === 'BUY' ? toNumber(candle.close, 0) > toNumber(candle.open, 0) : toNumber(candle.close, 0) < toNumber(candle.open, 0))
    .map((candle) => calculateCandleShape(candle).body || 0);
  const avgOpposing = opposingBodies.length ? opposingBodies.reduce((sum, value) => sum + value, 0) / opposingBodies.length : 0;
  const avgDirectional = directionalBodies.length ? directionalBodies.reduce((sum, value) => sum + value, 0) / directionalBodies.length : 0;
  return latestBody >= avgDirectional && latestBody >= avgOpposing * 0.8;
}

function calculateMicrostructureScore({ side, entryCandles, currentBar, atr, vwap, emaFast, tickFeatures, parameters }) {
  const close = getClose(currentBar);
  const open = toNumber(currentBar.open, null);
  const shape = calculateCandleShape(currentBar);
  const lookback = parameters.tickProxyLookbackBars;
  const recent = entryCandles.slice(-Math.max(parameters.breakoutLookbackBars + 1, lookback + 1));
  const priorStructure = calculatePriceRange(recent.slice(0, -1));
  const closeDirectionRatio = tickFeatures
    ? Math.max(0, side === 'BUY' ? tickFeatures.tickDirectionImbalance : tickFeatures.tickDirectionImbalance)
    : calculateCloseDirectionRatio(entryCandles, side, lookback);
  const directionRatioOk = Number.isFinite(closeDirectionRatio) && closeDirectionRatio >= parameters.minDirectionalCloseRatio;
  const bodyRatioOk = Number.isFinite(shape.bodyToRangeRatio) && shape.bodyToRangeRatio >= parameters.minBodyToRangeRatio;
  const wickRejectionOk = side === 'BUY'
    ? Number.isFinite(shape.lowerWickRatio) && shape.lowerWickRatio >= 0.25 && shape.upperWickRatio <= parameters.maxOppositeWickRatio
    : Number.isFinite(shape.upperWickRatio) && shape.upperWickRatio >= 0.25 && shape.lowerWickRatio <= parameters.maxOppositeWickRatio;
  const vwapDistanceAtr = Number.isFinite(vwap) && Number.isFinite(close) && Number.isFinite(atr) && atr > 0
    ? (close - vwap) / atr
    : null;
  const vwapReclaimOk = side === 'BUY'
    ? (Number.isFinite(vwap) && close >= vwap - atr * parameters.vwapReclaimToleranceAtr)
      || (Number.isFinite(emaFast) && close >= emaFast)
    : (Number.isFinite(vwap) && close <= vwap + atr * parameters.vwapReclaimToleranceAtr)
      || (Number.isFinite(emaFast) && close <= emaFast);
  const breakoutRetestOk = side === 'BUY'
    ? Number.isFinite(priorStructure.high)
      && toNumber(currentBar.low, null) <= priorStructure.high + (atr * parameters.retestToleranceAtr)
      && close > priorStructure.high
    : Number.isFinite(priorStructure.low)
      && toNumber(currentBar.high, null) >= priorStructure.low - (atr * parameters.retestToleranceAtr)
      && close < priorStructure.low;
  const pressureImprovingOk = detectCandlePressureImproving(entryCandles, side, parameters);
  const absorptionOk = side === 'BUY'
    ? detectBullishAbsorption(entryCandles, parameters)
    : detectBearishAbsorption(entryCandles, parameters);
  const latestDirectional = side === 'BUY' ? close > open : close < open;

  const evidence = {
    directionRatioOk,
    bodyRatioOk: bodyRatioOk && latestDirectional,
    wickRejectionOk,
    vwapReclaimOk,
    breakoutRetestOk,
    pressureImprovingOk,
    absorptionOk,
  };
  const evidenceCount = Object.values(evidence).filter(Boolean).length;
  const score = Math.min(35, evidenceCount * 5);
  return {
    passed: evidenceCount >= 2,
    score,
    evidence,
    evidenceCount,
    closeDirectionRatio,
    bodyToRangeRatio: shape.bodyToRangeRatio,
    upperWickRatio: shape.upperWickRatio,
    lowerWickRatio: shape.lowerWickRatio,
    vwapDistanceAtr,
    priorStructure,
  };
}

function evaluateEntryQualityGuard({ microstructure = {}, parameters = {} } = {}) {
  if (!parameters.useEntryQualityGuards) {
    return { passed: true, reasonCode: null };
  }

  const closeDirectionRatio = toNumber(microstructure.closeDirectionRatio, null);
  if (
    Number.isFinite(closeDirectionRatio)
    && (
      closeDirectionRatio < parameters.minEntryCloseDirectionRatio
      || closeDirectionRatio > parameters.maxEntryCloseDirectionRatio
    )
  ) {
    return {
      passed: false,
      reasonCode: 'ENTRY_CLOSE_DIRECTION_RATIO_FILTERED',
      closeDirectionRatio,
      minEntryCloseDirectionRatio: parameters.minEntryCloseDirectionRatio,
      maxEntryCloseDirectionRatio: parameters.maxEntryCloseDirectionRatio,
    };
  }

  const bodyToRangeRatio = toNumber(microstructure.bodyToRangeRatio, null);
  if (
    Number.isFinite(bodyToRangeRatio)
    && (
      bodyToRangeRatio < parameters.minEntryBodyToRangeRatio
      || bodyToRangeRatio > parameters.maxEntryBodyToRangeRatio
    )
  ) {
    return {
      passed: false,
      reasonCode: 'ENTRY_BODY_TO_RANGE_RATIO_FILTERED',
      bodyToRangeRatio,
      minEntryBodyToRangeRatio: parameters.minEntryBodyToRangeRatio,
      maxEntryBodyToRangeRatio: parameters.maxEntryBodyToRangeRatio,
    };
  }

  return {
    passed: true,
    reasonCode: null,
    closeDirectionRatio,
    bodyToRangeRatio,
  };
}

function calculateEntryScore({ side, currentBar, atr, vwap, emaFast, microstructure }) {
  const close = getClose(currentBar);
  const open = toNumber(currentBar.open, null);
  const directionalClose = side === 'BUY' ? close > open : close < open;
  const reclaimed = side === 'BUY'
    ? (Number.isFinite(vwap) && close >= vwap) || (Number.isFinite(emaFast) && close >= emaFast)
    : (Number.isFinite(vwap) && close <= vwap) || (Number.isFinite(emaFast) && close <= emaFast);
  const structureReclaim = side === 'BUY'
    ? Number.isFinite(microstructure.priorStructure.high) && close > microstructure.priorStructure.high - atr * 0.05
    : Number.isFinite(microstructure.priorStructure.low) && close < microstructure.priorStructure.low + atr * 0.05;
  const passed = directionalClose && (reclaimed || structureReclaim);
  const score = passed ? 10 : (directionalClose ? 5 : 0);
  return { passed, score, directionalClose, reclaimed, structureReclaim };
}

function getConsecutiveLosses(closedTrades = []) {
  let count = 0;
  for (let index = closedTrades.length - 1; index >= 0; index -= 1) {
    const pnl = toNumber(closedTrades[index].pnl, 0);
    if (pnl < 0) count += 1;
    else break;
  }
  return count;
}

function checkGuards(context = {}, parameters = {}) {
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
    return { blocked: true, reasonCode: 'COOLDOWN_ACTIVE', reason: 'Cooldown active after SL' };
  }

  const todayTrades = Array.isArray(context.todayTrades) ? context.todayTrades : [];
  if (parameters.maxDailyTrades > 0 && todayTrades.length >= parameters.maxDailyTrades) {
    return { blocked: true, reasonCode: 'MAX_DAILY_TRADES_REACHED', reason: 'Max daily trades reached' };
  }

  const todayClosedTrades = Array.isArray(context.todayClosedTrades) ? context.todayClosedTrades : [];
  const todayLosses = todayClosedTrades.filter((trade) => toNumber(trade.pnl, 0) < 0).length;
  if (parameters.maxDailyLosses > 0 && todayLosses >= parameters.maxDailyLosses) {
    return { blocked: true, reasonCode: 'DAILY_LOSS_LIMIT_REACHED', reason: 'Max daily losses reached' };
  }

  const consecutiveLosses = getConsecutiveLosses(todayClosedTrades);
  if (parameters.maxConsecutiveLosses > 0 && consecutiveLosses >= parameters.maxConsecutiveLosses) {
    return { blocked: true, reasonCode: 'CONSECUTIVE_LOSS_GUARD_ACTIVE', reason: 'Max consecutive losses reached' };
  }

  return { blocked: false, consecutiveLosses, todayLosses, todayTradeCount: todayTrades.length };
}

function checkOpenPositionExit(context = {}, parameters = {}) {
  const openPosition = context.openPosition;
  if (!openPosition) return null;
  const currentIndex = Number(context.currentIndex);
  const entryIndex = Number(openPosition.entryIndex);
  if (Number.isFinite(currentIndex) && Number.isFinite(entryIndex) && currentIndex - entryIndex >= parameters.maxBarsInTrade) {
    return { signal: 'CLOSE', status: 'TRIGGERED', reason: 'Max bars in trade reached', metadata: { exitRule: 'MAX_BARS_IN_TRADE' } };
  }
  const currentEpoch = toEpoch(getCandleTime(context.currentBar || {}));
  const entryEpoch = toEpoch(openPosition.entryTime);
  if (currentEpoch != null && entryEpoch != null) {
    const minutes = (currentEpoch - entryEpoch) / (60 * 1000);
    if (minutes >= parameters.maxMinutesInTrade) {
      return { signal: 'CLOSE', status: 'TRIGGERED', reason: 'Max minutes in trade reached', metadata: { exitRule: 'MAX_MINUTES_IN_TRADE', holdingMinutes: minutes } };
    }
  }
  return { signal: 'NONE', status: 'NO_SETUP', reason: 'Open position is managed by SL/TP/time guard' };
}

function buildNoSignal({ reasonCode, reason, status = 'FILTERED', side = null, debug = {}, parameters = {} }) {
  const metadata = {
    source: 'symbolCustom',
    symbolCustomName: XAUUSD_MICROSTRUCTURE_SCALP_V1,
    logicName: XAUUSD_MICROSTRUCTURE_SCALP_V1,
    strategyType: 'SymbolCustom',
    setupType: 'microstructure_scalp',
    candidatePreset: CANDIDATE_PRESET,
    hasSignal: false,
    side,
    reasonCode,
    filterReason: reason,
    dataMode: debug.dataMode || 'candleProxy',
    debug: parameters.debugSignal === false ? undefined : debug,
  };
  return {
    signal: 'NONE',
    hasSignal: false,
    status,
    reason,
    reasonCode,
    filterReason: reason,
    metadata,
  };
}

function buildSignal({ side, currentBar, atr, parameters, score, pattern, reason, debug }) {
  const entry = getClose(currentBar);
  const recent = debug.recentEntryCandles || [];
  const range = calculatePriceRange(recent.slice(-Math.max(parameters.absorptionLookbackBars, 3)));
  const atrStop = side === 'BUY' ? entry - (atr * parameters.slAtrMultiplier) : entry + (atr * parameters.slAtrMultiplier);
  const structureStop = side === 'BUY' ? range.low : range.high;
  const sl = side === 'BUY'
    ? Math.min(atrStop, Number.isFinite(structureStop) ? structureStop : atrStop)
    : Math.max(atrStop, Number.isFinite(structureStop) ? structureStop : atrStop);
  const risk = Math.abs(entry - sl);
  if (!Number.isFinite(risk) || risk <= 0) {
    return buildNoSignal({
      reasonCode: 'RR_INVALID',
      reason: 'Invalid SL distance for microstructure scalp',
      side,
      debug,
      parameters,
    });
  }

  const riskReward = Math.max(1, parameters.riskReward || (parameters.tpAtrMultiplier / parameters.slAtrMultiplier));
  const tp = side === 'BUY' ? entry + risk * riskReward : entry - risk * riskReward;
  const effectiveRiskReward = Math.abs(tp - entry) / risk;
  if (effectiveRiskReward < 1.2 || effectiveRiskReward > 2.2) {
    return buildNoSignal({
      reasonCode: 'RR_INVALID',
      reason: `Risk reward outside microstructure scalp bounds: ${round(effectiveRiskReward, 2)}`,
      side,
      debug,
      parameters,
    });
  }

  const confidence = round(score.totalScore / 100, 4);
  const metadata = {
    source: 'symbolCustom',
    symbolCustomName: XAUUSD_MICROSTRUCTURE_SCALP_V1,
    logicName: XAUUSD_MICROSTRUCTURE_SCALP_V1,
    strategyType: 'SymbolCustom',
    setupType: 'microstructure_scalp',
    candidatePreset: CANDIDATE_PRESET,
    scope: debug.scope,
    logicId: XAUUSD_MICROSTRUCTURE_SCALP_V1,
    symbol: debug.symbol,
    hasSignal: true,
    side,
    entry,
    entryPrice: entry,
    sl,
    tp,
    stopLoss: sl,
    takeProfit: tp,
    riskReward: effectiveRiskReward,
    confidenceScore: score.totalScore,
    pattern,
    dataMode: debug.dataMode,
    timeframe: debug.entryTimeframe,
    scoreBreakdown: score,
    spreadAtEntry: debug.spread,
    atrAtEntry: atr,
    closeDirectionRatio: debug.closeDirectionRatio,
    vwapDistanceAtr: debug.vwapDistanceAtr,
    volatilityState: debug.volatilityState,
    debug: parameters.debugSignal === false ? undefined : debug,
  };

  return {
    signal: side,
    hasSignal: true,
    side,
    status: 'TRIGGERED',
    confidence,
    rawConfidence: confidence,
    marketQualityScore: score.totalScore,
    marketQualityThreshold: parameters.minSignalScore,
    entry,
    sl,
    tp,
    stopLoss: sl,
    takeProfit: tp,
    riskReward: effectiveRiskReward,
    logic: XAUUSD_MICROSTRUCTURE_SCALP_V1,
    pattern,
    dataMode: debug.dataMode,
    timeframe: debug.entryTimeframe,
    reason,
    debug,
    metadata,
  };
}

class XauusdMicrostructureScalpV1 extends BaseSymbolCustom {
  constructor() {
    super({
      name: XAUUSD_MICROSTRUCTURE_SCALP_V1,
      symbol: 'XAUUSD',
      description: 'XAUUSD microstructure-inspired SymbolCustom scalping logic using M5/M15 context and M1/tick proxy evidence.',
    });
  }

  getDefaultParameterSchema() {
    return cloneValue(DEFAULT_PARAMETER_SCHEMA);
  }

  getDefaultParameters() {
    return buildDefaultParameters();
  }

  analyze(context = {}) {
    const scope = String(context.scope || 'backtest').toLowerCase();
    if (scope === 'live') {
      return {
        signal: 'NONE',
        status: 'BLOCKED',
        reason: LIVE_BLOCKED_REASON,
        reasonCode: 'SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED',
      };
    }
    if (!['backtest', 'paper'].includes(scope)) {
      return buildNoSignal({
        reasonCode: 'SCOPE_NOT_SUPPORTED',
        reason: 'XAUUSD microstructure scalp supports backtest and paper scopes only',
        status: 'BLOCKED',
        parameters: { debugSignal: true },
      });
    }

    const parameters = normalizeParams(context.parameters || {});
    if (!parameters.enabled) {
      return buildNoSignal({
        reasonCode: 'STRATEGY_DISABLED',
        reason: 'XAUUSD microstructure scalp parameter enabled=false',
        status: 'FILTERED',
        parameters,
      });
    }

    const currentBar = context.currentBar || {};
    const entryCandles = Array.isArray(context.candles?.entry) ? context.candles.entry : [];
    const setupCandles = Array.isArray(context.candles?.setup) ? context.candles.setup : entryCandles;
    const higherCandles = Array.isArray(context.candles?.higher) ? context.candles.higher : setupCandles;
    const minBars = Math.max(parameters.longAtrPeriod + 2, parameters.trendEmaSlow + 2, parameters.vwapLookbackBars, parameters.breakoutLookbackBars + 2);
    if (entryCandles.length < minBars || setupCandles.length < parameters.trendEmaFast + 2) {
      return buildNoSignal({
        reasonCode: 'NOT_ENOUGH_CANDLES',
        reason: 'Not enough candles for XAUUSD microstructure scalp analysis',
        status: 'NO_SETUP',
        parameters,
        debug: { entryCandles: entryCandles.length, setupCandles: setupCandles.length, minBars },
      });
    }

    const openPositionExit = checkOpenPositionExit(context, parameters);
    if (openPositionExit) return openPositionExit;

    const currentUtcHour = getUtcHour(context, currentBar);
    const allowedHours = parseUtcHours(parameters.allowedUtcHours);
    if (allowedHours.length > 0 && !allowedHours.includes(currentUtcHour)) {
      return buildNoSignal({
        reasonCode: 'UTC_HOUR_FILTERED',
        reason: 'Current UTC hour is not allowed for microstructure scalp',
        parameters,
        debug: { currentUtcHour, allowedUtcHours: allowedHours },
      });
    }

    if (parameters.blockNewsWindow && (context.isNewsBlackout || context.newsFilter?.isNewsBlackout)) {
      return buildNoSignal({
        reasonCode: 'NEWS_BLACKOUT',
        reason: `News blackout: ${context.newsReason || context.newsFilter?.newsReason || 'active'}`,
        parameters,
        debug: { isNewsBlackout: true, newsReason: context.newsReason || context.newsFilter?.newsReason || null },
      });
    }

    const guard = checkGuards(context, parameters);
    if (guard.blocked) {
      return buildNoSignal({
        reasonCode: guard.reasonCode,
        reason: guard.reason,
        parameters,
        debug: guard,
      });
    }

    const volatility = calculateVolatilityScore(entryCandles, currentBar, parameters);
    if (!volatility.passed) {
      return buildNoSignal({
        reasonCode: volatility.reasonCode,
        reason: volatility.reasonCode === 'ATR_SPIKE_AVOID_CHASING'
          ? 'ATR spike detected; avoiding chase entry'
          : 'ATR volatility filter failed',
        parameters,
        debug: volatility,
      });
    }

    const vwapWindow = entryCandles.slice(-parameters.vwapLookbackBars);
    const vwap = calculateVwap(vwapWindow);
    const emaFast = calculateEma(entryCandles.slice(-Math.max(parameters.trendEmaFast + 20, 80)), parameters.trendEmaFast);
    const tickFeaturesForBuy = calculateTickFeatures(context, 'BUY', parameters);
    const tickFeaturesForSell = calculateTickFeatures(context, 'SELL', parameters);
    const dataMode = tickFeaturesForBuy || tickFeaturesForSell ? 'tick' : 'candleProxy';
    const cost = resolveSpreadInfo(currentBar, tickFeaturesForBuy || tickFeaturesForSell, volatility.atr, parameters);
    if (!cost.passed) {
      return buildNoSignal({
        reasonCode: 'SPREAD_TOO_WIDE',
        reason: 'Spread too wide relative to points or ATR',
        parameters,
        debug: { ...cost, atr: volatility.atr, dataMode },
      });
    }

    const candidates = [];
    for (const side of ['BUY', 'SELL']) {
      if (side === 'BUY' && !parameters.enableBuy) continue;
      if (side === 'SELL' && !parameters.enableSell) continue;

      const trend = calculateTrendScore({ side, setupCandles, higherCandles, parameters });
      if (!trend.passed) continue;

      const tickFeatures = side === 'BUY' ? tickFeaturesForBuy : tickFeaturesForSell;
      const microstructure = calculateMicrostructureScore({
        side,
        entryCandles,
        currentBar,
        atr: volatility.atr,
        vwap,
        emaFast,
        tickFeatures,
        parameters,
      });
      if (!microstructure.passed) continue;

      const entryQualityGuard = evaluateEntryQualityGuard({ microstructure, parameters });
      if (!entryQualityGuard.passed) continue;

      const entry = calculateEntryScore({
        side,
        currentBar,
        atr: volatility.atr,
        vwap,
        emaFast,
        microstructure,
      });
      if (!entry.passed) continue;

      const score = {
        trendScore: trend.score,
        costScore: cost.score,
        volatilityScore: volatility.score,
        microstructureScore: microstructure.score,
        entryScore: entry.score,
      };
      score.totalScore = score.trendScore + score.costScore + score.volatilityScore + score.microstructureScore + score.entryScore;

      const debug = {
        scope,
        symbol: context.symbol || this.symbol,
        dataMode,
        entryTimeframe: context.timeframes?.entryTimeframe || parameters.entryTimeframe,
        setupTimeframe: context.timeframes?.setupTimeframe || parameters.setupTimeframe,
        higherTimeframe: context.timeframes?.higherTimeframe || parameters.higherTimeframe,
        currentUtcHour,
        trendScore: trend.score,
        costScore: cost.score,
        volatilityScore: volatility.score,
        microstructureScore: microstructure.score,
        entryScore: entry.score,
        spread: cost.spread,
        spreadPoints: cost.spreadPoints,
        spreadAtr: cost.spreadAtr,
        spreadUnavailable: cost.spreadUnavailable,
        spreadNote: cost.reason,
        atr: volatility.atr,
        shortAtr: volatility.shortAtr,
        longAtr: volatility.longAtr,
        atrSpikeRatio: volatility.atrSpikeRatio,
        impulseAtr: volatility.impulseAtr,
        closeDirectionRatio: microstructure.closeDirectionRatio,
        bodyToRangeRatio: microstructure.bodyToRangeRatio,
        upperWickRatio: microstructure.upperWickRatio,
        lowerWickRatio: microstructure.lowerWickRatio,
        entryQualityGuard,
        vwap,
        emaFast,
        vwapDistanceAtr: microstructure.vwapDistanceAtr,
        evidence: microstructure.evidence,
        evidenceCount: microstructure.evidenceCount,
        trend,
        tickFeatures,
        guard,
        volatilityState: volatility.atrSpikeRatio <= 1.4 ? 'NORMAL' : 'ELEVATED',
        recentEntryCandles: entryCandles.slice(-Math.max(parameters.absorptionLookbackBars, 3)),
      };

      candidates.push({ side, score, debug });
    }

    if (!candidates.length) {
      return buildNoSignal({
        reasonCode: 'MICROSTRUCTURE_SCORE_TOO_LOW',
        reason: 'No side passed trend, microstructure, and entry confirmation filters',
        status: 'NO_SETUP',
        parameters,
        debug: {
          dataMode,
          cost,
          volatility,
          vwap,
          emaFast,
          currentUtcHour,
        },
      });
    }

    candidates.sort((left, right) => right.score.totalScore - left.score.totalScore);
    const best = candidates[0];
    if (best.score.totalScore < parameters.minSignalScore) {
      return buildNoSignal({
        reasonCode: 'MICROSTRUCTURE_SCORE_TOO_LOW',
        reason: `Signal score below threshold: ${best.score.totalScore} < ${parameters.minSignalScore}`,
        side: best.side,
        parameters,
        debug: best.debug,
      });
    }

    const pattern = best.side === 'BUY'
      ? 'VWAP_RECLAIM_WITH_BULLISH_ABSORPTION'
      : 'VWAP_REJECT_WITH_BEARISH_ABSORPTION';
    const reason = best.side === 'BUY'
      ? 'M5/M15 bullish bias + cost ok + VWAP reclaim + bullish close imbalance + sell pressure absorption'
      : 'M5/M15 bearish bias + cost ok + VWAP reject + bearish close imbalance + buy pressure absorption';

    return buildSignal({
      side: best.side,
      currentBar,
      atr: volatility.atr,
      parameters,
      score: best.score,
      pattern,
      reason,
      debug: best.debug,
    });
  }
}

XauusdMicrostructureScalpV1.XAUUSD_MICROSTRUCTURE_SCALP_V1 = XAUUSD_MICROSTRUCTURE_SCALP_V1;
XauusdMicrostructureScalpV1.XAUUSD_MICROSTRUCTURE_SCALP_V1_VERSION = XAUUSD_MICROSTRUCTURE_SCALP_V1_VERSION;
XauusdMicrostructureScalpV1.LIVE_BLOCKED_REASON = LIVE_BLOCKED_REASON;
XauusdMicrostructureScalpV1.DEFAULT_PARAMETER_SCHEMA = DEFAULT_PARAMETER_SCHEMA;
XauusdMicrostructureScalpV1.calculateAtr = calculateAtr;
XauusdMicrostructureScalpV1.calculateEma = calculateEma;
XauusdMicrostructureScalpV1.calculateVwap = calculateVwap;
XauusdMicrostructureScalpV1.calculateTrendScore = calculateTrendScore;
XauusdMicrostructureScalpV1.calculateVolatilityScore = calculateVolatilityScore;
XauusdMicrostructureScalpV1.calculateMicrostructureScore = calculateMicrostructureScore;
XauusdMicrostructureScalpV1.detectBullishAbsorption = detectBullishAbsorption;
XauusdMicrostructureScalpV1.detectBearishAbsorption = detectBearishAbsorption;
XauusdMicrostructureScalpV1.buildSignal = buildSignal;
XauusdMicrostructureScalpV1.buildNoSignal = buildNoSignal;
XauusdMicrostructureScalpV1.normalizeParams = normalizeParams;

module.exports = XauusdMicrostructureScalpV1;
