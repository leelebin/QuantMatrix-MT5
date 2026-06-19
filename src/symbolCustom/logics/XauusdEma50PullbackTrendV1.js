const BaseSymbolCustom = require('../BaseSymbolCustom');

const XAUUSD_EMA50_PULLBACK_TREND_V1 = 'XAUUSD_EMA50_PULLBACK_TREND_V1';
const XAUUSD_EMA50_PULLBACK_TREND_V1_VERSION = 1;
const CANDIDATE_PRESET = 'xauusd_m30_ema50_pullback_trend_default';
const LIVE_BLOCKED_REASON = 'XAUUSD_EMA50_PULLBACK_TREND_V1 live execution is blocked by default';

const DEFAULT_PARAMETER_SCHEMA = Object.freeze([
  { key: 'logicId', label: 'Logic ID', type: 'string', defaultValue: XAUUSD_EMA50_PULLBACK_TREND_V1 },
  { key: 'mode', label: 'Mode', type: 'string', defaultValue: 'SYMBOLCUSTOM' },
  { key: 'source', label: 'Source', type: 'string', defaultValue: 'symbolCustom' },
  { key: 'symbol', label: 'Symbol', type: 'string', defaultValue: 'XAUUSD' },
  { key: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: false },
  { key: 'setupTimeframe', label: 'Setup Timeframe', type: 'string', defaultValue: '30m' },
  { key: 'entryTimeframe', label: 'Entry Timeframe', type: 'string', defaultValue: '30m' },
  { key: 'higherTimeframe', label: 'Higher Timeframe', type: 'string', defaultValue: '30m' },
  { key: 'enableBuy', label: 'Enable BUY', type: 'boolean', defaultValue: true },
  { key: 'enableSell', label: 'Enable SELL', type: 'boolean', defaultValue: true },
  { key: 'trendEmaFast', label: 'Trend EMA Fast', type: 'number', defaultValue: 20, min: 8, max: 40, step: 1 },
  { key: 'pullbackEma', label: 'Pullback EMA', type: 'number', defaultValue: 50, min: 30, max: 100, step: 1 },
  { key: 'trendEmaSlow', label: 'Trend EMA Slow', type: 'number', defaultValue: 200, min: 100, max: 300, step: 5 },
  { key: 'pullbackLookbackBars', label: 'Pullback Lookback Bars', type: 'number', defaultValue: 4, min: 1, max: 12, step: 1 },
  { key: 'pullbackToleranceAtr', label: 'Pullback Tolerance ATR', type: 'number', defaultValue: 0.05, min: 0, max: 0.5, step: 0.01 },
  { key: 'rsiPeriod', label: 'RSI Period', type: 'number', defaultValue: 14, min: 6, max: 30, step: 1 },
  { key: 'rsiMidline', label: 'RSI Midline', type: 'number', defaultValue: 50, min: 40, max: 60, step: 1 },
  { key: 'atrPeriod', label: 'ATR Period', type: 'number', defaultValue: 14, min: 8, max: 30, step: 1 },
  { key: 'slAtrMultiplier', label: 'SL ATR Multiplier', type: 'number', defaultValue: 2.0, min: 0.8, max: 4, step: 0.1 },
  { key: 'riskReward', label: 'Risk Reward', type: 'number', defaultValue: 1.8, min: 1, max: 3, step: 0.1 },
  { key: 'maxBarsInTrade', label: 'Max Bars In Trade', type: 'number', defaultValue: 96, min: 8, max: 240, step: 4 },
  { key: 'maxMinutesInTrade', label: 'Max Minutes In Trade', type: 'number', defaultValue: 2880, min: 120, max: 7200, step: 30 },
  { key: 'cooldownBarsAfterAnyExit', label: 'Cooldown Bars After Any Exit', type: 'number', defaultValue: 0, min: 0, max: 48, step: 1 },
  { key: 'cooldownBarsAfterSL', label: 'Cooldown Bars After SL', type: 'number', defaultValue: 0, min: 0, max: 96, step: 1 },
  { key: 'maxDailyTrades', label: 'Max Daily Trades', type: 'number', defaultValue: 4, min: 0, max: 20, step: 1 },
  { key: 'maxDailyLosses', label: 'Max Daily Losses', type: 'number', defaultValue: 3, min: 0, max: 10, step: 1 },
  { key: 'maxConsecutiveLosses', label: 'Max Consecutive Losses', type: 'number', defaultValue: 3, min: 0, max: 10, step: 1 },
  { key: 'maxRollingConsecutiveLosses', label: 'Max Rolling Consecutive Losses', type: 'number', defaultValue: 0, min: 0, max: 20, step: 1 },
  { key: 'rollingLossCooldownBars', label: 'Rolling Loss Cooldown Bars', type: 'number', defaultValue: 0, min: 0, max: 336, step: 1 },
  { key: 'useSpreadFilter', label: 'Use Spread Filter', type: 'boolean', defaultValue: true },
  { key: 'spreadMaxPoints', label: 'Max Spread Points', type: 'number', defaultValue: 60, min: 5, max: 200, step: 5 },
  { key: 'spreadPointSize', label: 'Spread Point Size', type: 'number', defaultValue: 0.01, min: 0.00001, max: 1, step: 0.00001 },
  { key: 'spreadAtrMaxRatio', label: 'Max Spread ATR Ratio', type: 'number', defaultValue: 0.05, min: 0.005, max: 0.3, step: 0.005 },
  { key: 'rejectIfSpreadUnavailable', label: 'Reject If Spread Unavailable', type: 'boolean', defaultValue: false },
  { key: 'minAtr', label: 'Minimum ATR', type: 'number', defaultValue: 0, min: 0, max: 50, step: 0.1 },
  { key: 'shortAtrPeriod', label: 'Short ATR Period', type: 'number', defaultValue: 5, min: 3, max: 20, step: 1 },
  { key: 'longAtrPeriod', label: 'Long ATR Period', type: 'number', defaultValue: 20, min: 10, max: 60, step: 1 },
  { key: 'maxAtrSpikeRatio', label: 'Max ATR Spike Ratio', type: 'number', defaultValue: 2.8, min: 1, max: 6, step: 0.1 },
  { key: 'allowedUtcHours', label: 'Allowed UTC Hours', type: 'json', defaultValue: [0, 1, 3, 4, 5, 7, 8, 9, 10, 11, 12, 14, 15, 17, 19, 22, 23] },
  { key: 'blockNewsWindow', label: 'Block News Window', type: 'boolean', defaultValue: false },
  { key: 'minSignalScore', label: 'Min Signal Score', type: 'number', defaultValue: 70, min: 40, max: 95, step: 1 },
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

function normalizeParameters(rawParameters = {}) {
  const merged = {
    ...buildDefaultParameters(),
    ...(rawParameters || {}),
  };

  return {
    ...merged,
    enabled: toBoolean(merged.enabled, false),
    enableBuy: toBoolean(merged.enableBuy, true),
    enableSell: toBoolean(merged.enableSell, true),
    useSpreadFilter: toBoolean(merged.useSpreadFilter, true),
    rejectIfSpreadUnavailable: toBoolean(merged.rejectIfSpreadUnavailable, false),
    blockNewsWindow: toBoolean(merged.blockNewsWindow, false),
    debugSignal: toBoolean(merged.debugSignal, true),
    trendEmaFast: Math.max(2, toInteger(merged.trendEmaFast, 20)),
    pullbackEma: Math.max(3, toInteger(merged.pullbackEma, 50)),
    trendEmaSlow: Math.max(4, toInteger(merged.trendEmaSlow, 200)),
    pullbackLookbackBars: Math.max(1, toInteger(merged.pullbackLookbackBars, 4)),
    pullbackToleranceAtr: Math.max(0, toNumber(merged.pullbackToleranceAtr, 0.05)),
    rsiPeriod: Math.max(2, toInteger(merged.rsiPeriod, 14)),
    rsiMidline: clamp(toNumber(merged.rsiMidline, 50), 1, 99),
    atrPeriod: Math.max(2, toInteger(merged.atrPeriod, 14)),
    slAtrMultiplier: Math.max(0.1, toNumber(merged.slAtrMultiplier, 2.0)),
    riskReward: Math.max(1, toNumber(merged.riskReward, 1.5)),
    maxBarsInTrade: Math.max(1, toInteger(merged.maxBarsInTrade, 96)),
    maxMinutesInTrade: Math.max(1, toInteger(merged.maxMinutesInTrade, 2880)),
    cooldownBarsAfterAnyExit: Math.max(0, toInteger(merged.cooldownBarsAfterAnyExit, 0)),
    cooldownBarsAfterSL: Math.max(0, toInteger(merged.cooldownBarsAfterSL, 0)),
    maxDailyTrades: Math.max(0, toInteger(merged.maxDailyTrades, 4)),
    maxDailyLosses: Math.max(0, toInteger(merged.maxDailyLosses, 3)),
    maxConsecutiveLosses: Math.max(0, toInteger(merged.maxConsecutiveLosses, 3)),
    maxRollingConsecutiveLosses: Math.max(0, toInteger(merged.maxRollingConsecutiveLosses, 0)),
    rollingLossCooldownBars: Math.max(0, toInteger(merged.rollingLossCooldownBars, 0)),
    spreadMaxPoints: Math.max(0, toNumber(merged.spreadMaxPoints, 60)),
    spreadPointSize: Math.max(0.00001, toNumber(merged.spreadPointSize, 0.01)),
    spreadAtrMaxRatio: Math.max(0, toNumber(merged.spreadAtrMaxRatio, 0.05)),
    minAtr: Math.max(0, toNumber(merged.minAtr, 0)),
    shortAtrPeriod: Math.max(2, toInteger(merged.shortAtrPeriod, 5)),
    longAtrPeriod: Math.max(3, toInteger(merged.longAtrPeriod, 20)),
    maxAtrSpikeRatio: Math.max(1, toNumber(merged.maxAtrSpikeRatio, 2.8)),
    minSignalScore: Math.max(1, toInteger(merged.minSignalScore, 70)),
    allowedUtcHours: merged.allowedUtcHours,
  };
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

function getClose(candle = {}) {
  return toNumber(candle.close, null);
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function isXauusdSymbol(symbol) {
  const normalized = normalizeSymbol(symbol);
  return normalized === 'XAUUSD' || /^XAUUSD[A-Z0-9._-]*$/.test(normalized);
}

function calculateEmaSeries(values = [], period = 20) {
  const safePeriod = Math.max(1, toInteger(period, 20));
  const clean = values.map((value) => toNumber(value, null));
  const result = Array(clean.length).fill(null);
  if (clean.length < safePeriod || clean.slice(0, safePeriod).some((value) => !Number.isFinite(value))) {
    return result;
  }

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
    const high = toNumber(candle.high, null);
    const low = toNumber(candle.low, null);
    if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
    if (index === 0) return high - low;
    const previousClose = getClose(candles[index - 1]);
    if (!Number.isFinite(previousClose)) return null;
    return Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
  });

  if (trueRanges.slice(0, safePeriod).some((value) => !Number.isFinite(value))) return result;
  let atr = trueRanges.slice(0, safePeriod).reduce((sum, value) => sum + value, 0) / safePeriod;
  result[safePeriod - 1] = atr;
  for (let index = safePeriod; index < trueRanges.length; index += 1) {
    if (!Number.isFinite(trueRanges[index])) continue;
    atr = ((atr * (safePeriod - 1)) + trueRanges[index]) / safePeriod;
    result[index] = atr;
  }

  return result;
}

function calculateRsiSeries(values = [], period = 14) {
  const safePeriod = Math.max(1, toInteger(period, 14));
  const closes = values.map((value) => toNumber(value, null));
  const result = Array(closes.length).fill(null);
  if (closes.length <= safePeriod || closes.slice(0, safePeriod + 1).some((value) => !Number.isFinite(value))) {
    return result;
  }

  let gainSum = 0;
  let lossSum = 0;
  for (let index = 1; index <= safePeriod; index += 1) {
    const change = closes[index] - closes[index - 1];
    if (change >= 0) gainSum += change;
    else lossSum += Math.abs(change);
  }

  let averageGain = gainSum / safePeriod;
  let averageLoss = lossSum / safePeriod;
  result[safePeriod] = averageLoss === 0
    ? (averageGain === 0 ? 50 : 100)
    : 100 - (100 / (1 + (averageGain / averageLoss)));

  for (let index = safePeriod + 1; index < closes.length; index += 1) {
    if (!Number.isFinite(closes[index]) || !Number.isFinite(closes[index - 1])) continue;
    const change = closes[index] - closes[index - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    averageGain = ((averageGain * (safePeriod - 1)) + gain) / safePeriod;
    averageLoss = ((averageLoss * (safePeriod - 1)) + loss) / safePeriod;
    result[index] = averageLoss === 0
      ? (averageGain === 0 ? 50 : 100)
      : 100 - (100 / (1 + (averageGain / averageLoss)));
  }

  return result;
}

function calculateSimpleAtr(candles = [], period = 14) {
  const source = Array.isArray(candles) ? candles.slice(-Math.max(1, period + 1)) : [];
  if (source.length < period + 1) return null;
  const values = [];
  for (let index = 1; index < source.length; index += 1) {
    const current = source[index] || {};
    const previous = source[index - 1] || {};
    const high = toNumber(current.high, null);
    const low = toNumber(current.low, null);
    const previousClose = getClose(previous);
    if (![high, low, previousClose].every(Number.isFinite)) return null;
    values.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
  }
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function findPullbackTouch({ candles, emaSeries, index, side, lookbackBars, tolerance }) {
  const startIndex = Math.max(0, index - lookbackBars + 1);
  for (let cursor = startIndex; cursor <= index; cursor += 1) {
    const ema = toNumber(emaSeries[cursor], null);
    const candle = candles[cursor] || {};
    const high = toNumber(candle.high, null);
    const low = toNumber(candle.low, null);
    if (![ema, high, low].every(Number.isFinite)) continue;
    if (side === 'BUY' && low <= ema + tolerance) {
      return { touched: true, touchIndex: cursor, touchPrice: low, emaAtTouch: ema };
    }
    if (side === 'SELL' && high >= ema - tolerance) {
      return { touched: true, touchIndex: cursor, touchPrice: high, emaAtTouch: ema };
    }
  }
  return { touched: false, touchIndex: null, touchPrice: null, emaAtTouch: null };
}

function resolveSpreadInfo(currentBar = {}, atr = null, parameters = {}) {
  const rawPriceSpread = currentBar.spreadPrice ?? currentBar.currentSpreadPrice;
  const rawPointSpread = currentBar.spread ?? currentBar.currentSpread ?? currentBar.spreadPoints;
  let spread = null;
  let spreadPoints = null;
  let spreadSource = null;

  if (rawPriceSpread !== undefined && rawPriceSpread !== null && rawPriceSpread !== '') {
    spread = toNumber(rawPriceSpread, null);
    spreadPoints = Number.isFinite(spread) && parameters.spreadPointSize > 0 ? spread / parameters.spreadPointSize : null;
    spreadSource = 'price';
  } else if (rawPointSpread !== undefined && rawPointSpread !== null && rawPointSpread !== '') {
    spreadPoints = toNumber(rawPointSpread, null);
    spread = Number.isFinite(spreadPoints) ? spreadPoints * parameters.spreadPointSize : null;
    spreadSource = 'points';
  }

  const spreadAtr = Number.isFinite(spread) && Number.isFinite(atr) && atr > 0 ? spread / atr : null;
  if (!parameters.useSpreadFilter) {
    return { passed: true, spread, spreadPoints, spreadAtr, spreadSource, spreadUnavailable: spread == null, score: 15 };
  }

  if (!Number.isFinite(spread)) {
    return {
      passed: !parameters.rejectIfSpreadUnavailable,
      reasonCode: parameters.rejectIfSpreadUnavailable ? 'SPREAD_UNAVAILABLE' : null,
      spread,
      spreadPoints,
      spreadAtr,
      spreadSource,
      spreadUnavailable: true,
      score: parameters.rejectIfSpreadUnavailable ? 0 : 8,
    };
  }

  if (Number.isFinite(spreadPoints) && parameters.spreadMaxPoints > 0 && spreadPoints > parameters.spreadMaxPoints) {
    return {
      passed: false,
      reasonCode: 'SPREAD_TOO_WIDE',
      spread,
      spreadPoints,
      spreadAtr,
      spreadSource,
      spreadUnavailable: false,
      score: 0,
    };
  }

  if (Number.isFinite(spreadAtr) && parameters.spreadAtrMaxRatio > 0 && spreadAtr > parameters.spreadAtrMaxRatio) {
    return {
      passed: false,
      reasonCode: 'SPREAD_TOO_WIDE',
      spread,
      spreadPoints,
      spreadAtr,
      spreadSource,
      spreadUnavailable: false,
      score: 0,
    };
  }

  return {
    passed: true,
    spread,
    spreadPoints,
    spreadAtr,
    spreadSource,
    spreadUnavailable: false,
    score: Number.isFinite(spreadAtr) && spreadAtr > parameters.spreadAtrMaxRatio * 0.75 ? 10 : 15,
  };
}

function getConsecutiveLosses(closedTrades = []) {
  let count = 0;
  for (let index = closedTrades.length - 1; index >= 0; index -= 1) {
    const pnl = toNumber(closedTrades[index].pnl ?? closedTrades[index].profitLoss, 0);
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
  const todayLosses = todayClosedTrades.filter((trade) => toNumber(trade.pnl ?? trade.profitLoss, 0) < 0).length;
  if (parameters.maxDailyLosses > 0 && todayLosses >= parameters.maxDailyLosses) {
    return { blocked: true, reasonCode: 'DAILY_LOSS_LIMIT_REACHED', reason: 'Max daily losses reached' };
  }

  const consecutiveLosses = getConsecutiveLosses(todayClosedTrades);
  if (parameters.maxConsecutiveLosses > 0 && consecutiveLosses >= parameters.maxConsecutiveLosses) {
    return { blocked: true, reasonCode: 'CONSECUTIVE_LOSS_GUARD_ACTIVE', reason: 'Max consecutive losses reached' };
  }

  const closedTrades = Array.isArray(context.closedTrades) ? context.closedTrades : [];
  const rollingConsecutiveLosses = getConsecutiveLosses(closedTrades);
  if (
    parameters.maxRollingConsecutiveLosses > 0
    && parameters.rollingLossCooldownBars > 0
    && rollingConsecutiveLosses >= parameters.maxRollingConsecutiveLosses
    && barsSinceLastExit != null
    && barsSinceLastExit < parameters.rollingLossCooldownBars
  ) {
    return {
      blocked: true,
      reasonCode: 'ROLLING_CONSECUTIVE_LOSS_GUARD_ACTIVE',
      reason: 'Rolling consecutive loss cooldown active',
      rollingConsecutiveLosses,
      maxRollingConsecutiveLosses: parameters.maxRollingConsecutiveLosses,
      barsSinceLastExit,
      rollingLossCooldownBars: parameters.rollingLossCooldownBars,
    };
  }

  return {
    blocked: false,
    todayLosses,
    todayTradeCount: todayTrades.length,
    consecutiveLosses,
    rollingConsecutiveLosses,
  };
}

function checkOpenPositionExit(context = {}, parameters = {}) {
  const openPosition = context.openPosition;
  if (!openPosition) return null;
  const currentIndex = Number(context.currentIndex);
  const entryIndex = Number(openPosition.entryIndex);
  if (Number.isFinite(currentIndex) && Number.isFinite(entryIndex) && currentIndex - entryIndex >= parameters.maxBarsInTrade) {
    return {
      signal: 'CLOSE',
      status: 'TRIGGERED',
      reason: 'Max bars in trade reached for XAUUSD EMA50 pullback trend',
      metadata: { exitRule: 'MAX_BARS_IN_TRADE', setupType: 'ema50_pullback_trend' },
    };
  }

  const currentEpoch = toEpoch(getCandleTime(context.currentBar || {}));
  const entryEpoch = toEpoch(openPosition.entryTime);
  if (currentEpoch != null && entryEpoch != null) {
    const minutes = (currentEpoch - entryEpoch) / (60 * 1000);
    if (minutes >= parameters.maxMinutesInTrade) {
      return {
        signal: 'CLOSE',
        status: 'TRIGGERED',
        reason: 'Max minutes in trade reached for XAUUSD EMA50 pullback trend',
        metadata: { exitRule: 'MAX_MINUTES_IN_TRADE', holdingMinutes: minutes, setupType: 'ema50_pullback_trend' },
      };
    }
  }

  return {
    signal: 'NONE',
    status: 'NO_SETUP',
    reason: 'Open XAUUSD EMA50 pullback position is managed by SL/TP/time guard',
    reasonCode: 'OPEN_POSITION_MANAGED',
    metadata: {
      source: 'symbolCustom',
      symbolCustomName: XAUUSD_EMA50_PULLBACK_TREND_V1,
      logicName: XAUUSD_EMA50_PULLBACK_TREND_V1,
      setupType: 'ema50_pullback_trend',
    },
  };
}

function buildNoSignal({ reasonCode, reason, status = 'NO_SETUP', side = null, debug = {}, parameters = {} }) {
  const metadata = {
    source: 'symbolCustom',
    symbolCustomName: XAUUSD_EMA50_PULLBACK_TREND_V1,
    logicName: XAUUSD_EMA50_PULLBACK_TREND_V1,
    strategyType: 'SymbolCustom',
    setupType: 'ema50_pullback_trend',
    candidatePreset: CANDIDATE_PRESET,
    hasSignal: false,
    side,
    reasonCode,
    filterReason: reason,
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

function buildSignal({ side, currentBar, atr, parameters, score, debug }) {
  const entry = getClose(currentBar);
  const risk = atr * parameters.slAtrMultiplier;
  if (!Number.isFinite(entry) || !Number.isFinite(risk) || risk <= 0) {
    return buildNoSignal({
      reasonCode: 'RR_INVALID',
      reason: 'Invalid entry or ATR stop distance for XAUUSD EMA50 pullback trend',
      side,
      debug,
      parameters,
    });
  }

  const sl = side === 'BUY' ? entry - risk : entry + risk;
  const tp = side === 'BUY' ? entry + (risk * parameters.riskReward) : entry - (risk * parameters.riskReward);
  const confidence = round(clamp(score.totalScore / 100, 0, 0.95), 4);
  const reason = side === 'BUY'
    ? 'XAUUSD M30 bullish EMA200 trend, EMA50 pullback, EMA20 reclaim, RSI midline recovery'
    : 'XAUUSD M30 bearish EMA200 trend, EMA50 pullback, EMA20 rejection, RSI midline rollover';

  const metadata = {
    source: 'symbolCustom',
    symbolCustomName: XAUUSD_EMA50_PULLBACK_TREND_V1,
    logicName: XAUUSD_EMA50_PULLBACK_TREND_V1,
    strategyType: 'SymbolCustom',
    setupType: 'ema50_pullback_trend',
    module: 'TREND_PULLBACK_CONTINUATION',
    candidatePreset: CANDIDATE_PRESET,
    scope: debug.scope,
    symbol: debug.symbol,
    hasSignal: true,
    side,
    entry,
    entryPrice: entry,
    sl,
    tp,
    stopLoss: sl,
    takeProfit: tp,
    riskReward: parameters.riskReward,
    confidence,
    marketQualityScore: score.totalScore,
    marketQualityThreshold: parameters.minSignalScore,
    pattern: side === 'BUY' ? 'EMA50_PULLBACK_RSI50_RECOVERY' : 'EMA50_PULLBACK_RSI50_ROLLOVER',
    timeframe: debug.entryTimeframe,
    atrAtEntry: atr,
    ema20: debug.ema20,
    ema50: debug.ema50,
    ema200: debug.ema200,
    rsi: debug.rsi,
    scoreBreakdown: score,
    spreadAtEntry: debug.spread,
    spreadAtr: debug.spreadAtr,
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
    riskReward: parameters.riskReward,
    logic: XAUUSD_EMA50_PULLBACK_TREND_V1,
    pattern: metadata.pattern,
    timeframe: debug.entryTimeframe,
    reason,
    debug,
    metadata,
  };
}

function analyzeSide({ side, candles, index, indicators, parameters }) {
  const currentBar = candles[index] || {};
  const previousIndex = index - 1;
  const close = getClose(currentBar);
  const ema20 = toNumber(indicators.ema20[index], null);
  const ema50 = toNumber(indicators.ema50[index], null);
  const ema200 = toNumber(indicators.ema200[index], null);
  const rsi = toNumber(indicators.rsi[index], null);
  const previousRsi = toNumber(indicators.rsi[previousIndex], null);
  const atr = toNumber(indicators.atr[index], null);

  if (![close, ema20, ema50, ema200, rsi, previousRsi, atr].every(Number.isFinite) || atr <= 0) {
    return { passed: false, reasonCode: 'INDICATORS_UNAVAILABLE' };
  }

  const tolerance = atr * parameters.pullbackToleranceAtr;
  const touch = findPullbackTouch({
    candles,
    emaSeries: indicators.ema50,
    index,
    side,
    lookbackBars: parameters.pullbackLookbackBars,
    tolerance,
  });

  const trendPassed = side === 'BUY'
    ? close > ema200 && ema50 > ema200
    : close < ema200 && ema50 < ema200;
  const reclaimPassed = side === 'BUY' ? close > ema20 : close < ema20;
  const momentumPassed = side === 'BUY'
    ? rsi >= parameters.rsiMidline && previousRsi < parameters.rsiMidline
    : rsi <= parameters.rsiMidline && previousRsi > parameters.rsiMidline;

  const passed = trendPassed && touch.touched && reclaimPassed && momentumPassed;
  const trendSeparationAtr = Math.abs(ema50 - ema200) / atr;
  const score = {
    trendScore: trendPassed ? (trendSeparationAtr >= 0.5 ? 25 : 20) : 0,
    pullbackScore: touch.touched ? 20 : 0,
    reclaimScore: reclaimPassed ? 15 : 0,
    momentumScore: momentumPassed ? 25 : 0,
  };

  return {
    passed,
    reasonCode: passed ? null : 'NO_EMA50_PULLBACK_TREND_SETUP',
    trendPassed,
    touch,
    reclaimPassed,
    momentumPassed,
    trendSeparationAtr,
    score,
    values: { close, ema20, ema50, ema200, rsi, previousRsi, atr },
  };
}

class XauusdEma50PullbackTrendV1 extends BaseSymbolCustom {
  constructor() {
    super({
      name: XAUUSD_EMA50_PULLBACK_TREND_V1,
      symbol: 'XAUUSD',
      description: 'XAUUSD M30 trend-continuation logic: EMA200/EMA50 bias, EMA50 pullback, EMA20 reclaim, RSI50 momentum confirmation, ATR risk.',
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
    if (scope === 'live' && context.liveAnalysisAllowed !== true) {
      return {
        signal: 'NONE',
        status: 'BLOCKED',
        reason: LIVE_BLOCKED_REASON,
        reasonCode: 'SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED',
      };
    }
    if (!['backtest', 'paper', 'live'].includes(scope)) {
      return buildNoSignal({
        reasonCode: 'SCOPE_NOT_SUPPORTED',
        reason: 'XAUUSD EMA50 pullback trend supports backtest, paper, and gated live analysis scopes only',
        status: 'BLOCKED',
        parameters: { debugSignal: true },
      });
    }

    const parameters = normalizeParameters(context.parameters || {});
    if (!parameters.enabled) {
      return buildNoSignal({
        reasonCode: 'STRATEGY_DISABLED',
        reason: 'XAUUSD EMA50 pullback trend parameter enabled=false',
        status: 'FILTERED',
        parameters,
      });
    }

    const symbol = context.symbol || this.symbol;
    if (!isXauusdSymbol(symbol)) {
      return buildNoSignal({
        reasonCode: 'SYMBOL_NOT_SUPPORTED',
        reason: 'XAUUSD EMA50 pullback trend only supports XAUUSD symbols',
        status: 'FILTERED',
        parameters,
        debug: { symbol },
      });
    }

    const openPositionExit = checkOpenPositionExit(context, parameters);
    if (openPositionExit) return openPositionExit;

    const entryCandles = Array.isArray(context.candles?.entry) ? context.candles.entry : [];
    const setupCandles = Array.isArray(context.candles?.setup) && context.candles.setup.length ? context.candles.setup : entryCandles;
    const currentBar = context.currentBar || setupCandles[setupCandles.length - 1] || {};
    const minBars = Math.max(parameters.trendEmaSlow + 2, parameters.rsiPeriod + 2, parameters.atrPeriod + 2);
    if (!Array.isArray(setupCandles) || setupCandles.length < minBars) {
      return buildNoSignal({
        reasonCode: 'NOT_ENOUGH_CANDLES',
        reason: 'Not enough M30 candles for XAUUSD EMA50 pullback trend analysis',
        status: 'NO_SETUP',
        parameters,
        debug: { setupCandles: setupCandles.length, minBars },
      });
    }

    const currentUtcHour = getUtcHour(context, currentBar);
    const allowedHours = parseUtcHours(parameters.allowedUtcHours);
    if (allowedHours.length > 0 && !allowedHours.includes(currentUtcHour)) {
      return buildNoSignal({
        reasonCode: 'UTC_HOUR_FILTERED',
        reason: 'Current UTC hour is not allowed for XAUUSD EMA50 pullback trend',
        status: 'FILTERED',
        parameters,
        debug: { currentUtcHour, allowedUtcHours: allowedHours },
      });
    }

    if (parameters.blockNewsWindow && (context.isNewsBlackout || context.newsFilter?.isNewsBlackout)) {
      return buildNoSignal({
        reasonCode: 'NEWS_BLACKOUT',
        reason: `News blackout: ${context.newsReason || context.newsFilter?.newsReason || 'active'}`,
        status: 'FILTERED',
        parameters,
        debug: { isNewsBlackout: true, newsReason: context.newsReason || context.newsFilter?.newsReason || null },
      });
    }

    const guard = checkGuards(context, parameters);
    if (guard.blocked) {
      return buildNoSignal({
        reasonCode: guard.reasonCode,
        reason: guard.reason,
        status: 'FILTERED',
        parameters,
        debug: guard,
      });
    }

    const analysisWindow = Math.max(parameters.trendEmaSlow + 30, parameters.longAtrPeriod + 20, parameters.pullbackLookbackBars + 5);
    const analysisCandles = setupCandles.slice(-analysisWindow);
    const index = analysisCandles.length - 1;
    const closes = analysisCandles.map(getClose);
    const indicators = {
      ema20: calculateEmaSeries(closes, parameters.trendEmaFast),
      ema50: calculateEmaSeries(closes, parameters.pullbackEma),
      ema200: calculateEmaSeries(closes, parameters.trendEmaSlow),
      rsi: calculateRsiSeries(closes, parameters.rsiPeriod),
      atr: calculateAtrSeries(analysisCandles, parameters.atrPeriod),
    };
    const atr = toNumber(indicators.atr[index], null);
    if (!Number.isFinite(atr) || atr <= 0 || atr < parameters.minAtr) {
      return buildNoSignal({
        reasonCode: 'ATR_FILTERED',
        reason: 'ATR unavailable or below minimum for XAUUSD EMA50 pullback trend',
        status: 'FILTERED',
        parameters,
        debug: { atr, minAtr: parameters.minAtr },
      });
    }

    const shortAtr = calculateSimpleAtr(analysisCandles, parameters.shortAtrPeriod);
    const longAtr = calculateSimpleAtr(analysisCandles, parameters.longAtrPeriod);
    const atrSpikeRatio = Number.isFinite(shortAtr) && Number.isFinite(longAtr) && longAtr > 0 ? shortAtr / longAtr : null;
    if (Number.isFinite(atrSpikeRatio) && atrSpikeRatio > parameters.maxAtrSpikeRatio) {
      return buildNoSignal({
        reasonCode: 'ATR_SPIKE_AVOID_CHASING',
        reason: 'ATR spike detected; avoiding chase entry',
        status: 'FILTERED',
        parameters,
        debug: { shortAtr, longAtr, atrSpikeRatio, maxAtrSpikeRatio: parameters.maxAtrSpikeRatio },
      });
    }

    const spreadInfo = resolveSpreadInfo(currentBar, atr, parameters);
    if (!spreadInfo.passed) {
      return buildNoSignal({
        reasonCode: spreadInfo.reasonCode || 'SPREAD_TOO_WIDE',
        reason: 'Spread too wide or unavailable for XAUUSD EMA50 pullback trend',
        status: 'FILTERED',
        parameters,
        debug: { ...spreadInfo, atr },
      });
    }

    const candidates = [];
    for (const side of ['BUY', 'SELL']) {
      if (side === 'BUY' && !parameters.enableBuy) continue;
      if (side === 'SELL' && !parameters.enableSell) continue;
      const sideAnalysis = analyzeSide({
        side,
        candles: analysisCandles,
        index,
        indicators,
        parameters,
      });
      if (!sideAnalysis.passed) continue;

      const volatilityScore = Number.isFinite(atrSpikeRatio) && atrSpikeRatio <= 1.5 ? 15 : 10;
      const score = {
        ...sideAnalysis.score,
        volatilityScore,
        costScore: spreadInfo.score,
      };
      score.totalScore = Math.min(
        100,
        score.trendScore + score.pullbackScore + score.reclaimScore + score.momentumScore + score.volatilityScore + score.costScore
      );

      const debug = {
        scope,
        symbol,
        currentUtcHour,
        setupTimeframe: context.timeframes?.setupTimeframe || parameters.setupTimeframe,
        entryTimeframe: context.timeframes?.entryTimeframe || parameters.entryTimeframe,
        higherTimeframe: context.timeframes?.higherTimeframe || parameters.higherTimeframe,
        atr,
        shortAtr,
        longAtr,
        atrSpikeRatio,
        ema20: sideAnalysis.values.ema20,
        ema50: sideAnalysis.values.ema50,
        ema200: sideAnalysis.values.ema200,
        rsi: sideAnalysis.values.rsi,
        previousRsi: sideAnalysis.values.previousRsi,
        close: sideAnalysis.values.close,
        trendPassed: sideAnalysis.trendPassed,
        pullbackTouch: sideAnalysis.touch,
        reclaimPassed: sideAnalysis.reclaimPassed,
        momentumPassed: sideAnalysis.momentumPassed,
        trendSeparationAtr: sideAnalysis.trendSeparationAtr,
        spread: spreadInfo.spread,
        spreadPoints: spreadInfo.spreadPoints,
        spreadAtr: spreadInfo.spreadAtr,
        spreadSource: spreadInfo.spreadSource,
        guard,
        parameters: cloneValue(parameters),
      };

      candidates.push({ side, score, debug });
    }

    if (!candidates.length) {
      return buildNoSignal({
        reasonCode: 'NO_EMA50_PULLBACK_TREND_SETUP',
        reason: 'No side passed trend, EMA50 pullback, EMA20 reclaim, and RSI50 confirmation filters',
        status: 'NO_SETUP',
        parameters,
        debug: {
          currentUtcHour,
          atr,
          shortAtr,
          longAtr,
          atrSpikeRatio,
          spreadInfo,
          ema20: round(indicators.ema20[index], 4),
          ema50: round(indicators.ema50[index], 4),
          ema200: round(indicators.ema200[index], 4),
          rsi: round(indicators.rsi[index], 4),
        },
      });
    }

    candidates.sort((left, right) => right.score.totalScore - left.score.totalScore);
    const best = candidates[0];
    if (best.score.totalScore < parameters.minSignalScore) {
      return buildNoSignal({
        reasonCode: 'SIGNAL_SCORE_TOO_LOW',
        reason: `Signal score below threshold: ${best.score.totalScore} < ${parameters.minSignalScore}`,
        side: best.side,
        status: 'FILTERED',
        parameters,
        debug: best.debug,
      });
    }

    return buildSignal({
      side: best.side,
      currentBar,
      atr,
      parameters,
      score: best.score,
      debug: best.debug,
    });
  }
}

XauusdEma50PullbackTrendV1.XAUUSD_EMA50_PULLBACK_TREND_V1 = XAUUSD_EMA50_PULLBACK_TREND_V1;
XauusdEma50PullbackTrendV1.XAUUSD_EMA50_PULLBACK_TREND_V1_VERSION = XAUUSD_EMA50_PULLBACK_TREND_V1_VERSION;
XauusdEma50PullbackTrendV1.CANDIDATE_PRESET = CANDIDATE_PRESET;
XauusdEma50PullbackTrendV1.LIVE_BLOCKED_REASON = LIVE_BLOCKED_REASON;
XauusdEma50PullbackTrendV1.DEFAULT_PARAMETER_SCHEMA = DEFAULT_PARAMETER_SCHEMA;
XauusdEma50PullbackTrendV1.calculateEmaSeries = calculateEmaSeries;
XauusdEma50PullbackTrendV1.calculateRsiSeries = calculateRsiSeries;
XauusdEma50PullbackTrendV1.calculateAtrSeries = calculateAtrSeries;
XauusdEma50PullbackTrendV1.normalizeParameters = normalizeParameters;

module.exports = XauusdEma50PullbackTrendV1;
