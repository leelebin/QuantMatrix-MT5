const BaseSymbolCustom = require('../BaseSymbolCustom');

const XAGUSD_VOL_TARGET_TREND_V1 = 'XAGUSD_VOL_TARGET_TREND_V1';
const XAGUSD_VOL_TARGET_TREND_V1_VERSION = 1;
const CANDIDATE_PRESET = 'xagusd_1h_vol_target_trend_default';
const LIVE_BLOCKED_REASON = 'XAGUSD_VOL_TARGET_TREND_V1 live execution is blocked by default';

const DEFAULT_PARAMETER_SCHEMA = Object.freeze([
  { key: 'logicId', label: 'Logic ID', type: 'string', defaultValue: XAGUSD_VOL_TARGET_TREND_V1 },
  { key: 'mode', label: 'Mode', type: 'string', defaultValue: 'SYMBOLCUSTOM' },
  { key: 'source', label: 'Source', type: 'string', defaultValue: 'symbolCustom' },
  { key: 'symbol', label: 'Symbol', type: 'string', defaultValue: 'XAGUSD' },
  { key: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: false },
  { key: 'setupTimeframe', label: 'Setup Timeframe', type: 'string', defaultValue: '1h' },
  { key: 'entryTimeframe', label: 'Entry Timeframe', type: 'string', defaultValue: '1h' },
  { key: 'higherTimeframe', label: 'Higher Timeframe', type: 'string', defaultValue: '4h' },
  { key: 'enableBuy', label: 'Enable BUY', type: 'boolean', defaultValue: true },
  { key: 'enableSell', label: 'Enable SELL', type: 'boolean', defaultValue: true },
  { key: 'fastEmaPeriod', label: 'Fast EMA Period', type: 'number', defaultValue: 20, min: 5, max: 80, step: 1 },
  { key: 'slowEmaPeriod', label: 'Slow EMA Period', type: 'number', defaultValue: 100, min: 40, max: 240, step: 5 },
  { key: 'higherFastEmaPeriod', label: 'Higher Fast EMA Period', type: 'number', defaultValue: 20, min: 5, max: 80, step: 1 },
  { key: 'higherSlowEmaPeriod', label: 'Higher Slow EMA Period', type: 'number', defaultValue: 100, min: 40, max: 240, step: 5 },
  { key: 'momentumLookbackBars', label: 'Momentum Lookback Bars', type: 'number', defaultValue: 72, min: 12, max: 240, step: 6 },
  { key: 'higherMomentumLookbackBars', label: 'Higher Momentum Lookback Bars', type: 'number', defaultValue: 24, min: 6, max: 120, step: 3 },
  { key: 'breakoutLookbackBars', label: 'Breakout Lookback Bars', type: 'number', defaultValue: 20, min: 6, max: 80, step: 1 },
  { key: 'breakoutBufferAtr', label: 'Breakout Buffer ATR', type: 'number', defaultValue: 0.05, min: 0, max: 0.5, step: 0.01 },
  { key: 'minMomentumAtr', label: 'Minimum Momentum ATR', type: 'number', defaultValue: 1.2, min: 0, max: 8, step: 0.1 },
  { key: 'maxExtensionAtr', label: 'Max Extension ATR', type: 'number', defaultValue: 4.0, min: 0.5, max: 10, step: 0.1 },
  { key: 'slopeLookbackBars', label: 'Slope Lookback Bars', type: 'number', defaultValue: 12, min: 3, max: 60, step: 1 },
  { key: 'atrPeriod', label: 'ATR Period', type: 'number', defaultValue: 14, min: 5, max: 40, step: 1 },
  { key: 'longAtrPeriod', label: 'Long ATR Period', type: 'number', defaultValue: 100, min: 30, max: 240, step: 5 },
  { key: 'shortAtrPeriod', label: 'Short ATR Period', type: 'number', defaultValue: 5, min: 3, max: 20, step: 1 },
  { key: 'minAtrRatio', label: 'Min ATR / Long ATR', type: 'number', defaultValue: 0.45, min: 0.1, max: 2, step: 0.05 },
  { key: 'maxAtrRatio', label: 'Max ATR / Long ATR', type: 'number', defaultValue: 1.75, min: 0.5, max: 5, step: 0.05 },
  { key: 'maxAtrSpikeRatio', label: 'Max ATR Spike Ratio', type: 'number', defaultValue: 2.2, min: 1, max: 6, step: 0.1 },
  { key: 'targetAtrRatio', label: 'Target ATR Ratio', type: 'number', defaultValue: 1.0, min: 0.2, max: 3, step: 0.05 },
  { key: 'minRiskScale', label: 'Minimum Risk Scale', type: 'number', defaultValue: 0.35, min: 0.05, max: 1, step: 0.05 },
  { key: 'maxRiskScale', label: 'Maximum Risk Scale', type: 'number', defaultValue: 1.0, min: 0.1, max: 2, step: 0.05 },
  { key: 'slAtrMultiplier', label: 'SL ATR Multiplier', type: 'number', defaultValue: 1.75, min: 0.8, max: 4, step: 0.05 },
  { key: 'riskReward', label: 'Risk Reward', type: 'number', defaultValue: 2.0, min: 1, max: 5, step: 0.1 },
  { key: 'maxBarsInTrade', label: 'Max Bars In Trade', type: 'number', defaultValue: 96, min: 12, max: 240, step: 4 },
  { key: 'maxMinutesInTrade', label: 'Max Minutes In Trade', type: 'number', defaultValue: 5760, min: 240, max: 14400, step: 60 },
  { key: 'cooldownBarsAfterAnyExit', label: 'Cooldown Bars After Any Exit', type: 'number', defaultValue: 3, min: 0, max: 48, step: 1 },
  { key: 'cooldownBarsAfterSL', label: 'Cooldown Bars After SL', type: 'number', defaultValue: 12, min: 0, max: 96, step: 1 },
  { key: 'maxDailyTrades', label: 'Max Daily Trades', type: 'number', defaultValue: 2, min: 0, max: 12, step: 1 },
  { key: 'maxDailyLosses', label: 'Max Daily Losses', type: 'number', defaultValue: 2, min: 0, max: 8, step: 1 },
  { key: 'maxConsecutiveLosses', label: 'Max Consecutive Losses', type: 'number', defaultValue: 2, min: 0, max: 8, step: 1 },
  { key: 'useSpreadFilter', label: 'Use Spread Filter', type: 'boolean', defaultValue: true },
  { key: 'spreadMaxPoints', label: 'Max Spread Points', type: 'number', defaultValue: 80, min: 1, max: 300, step: 1 },
  { key: 'spreadPointSize', label: 'Spread Point Size', type: 'number', defaultValue: 0.001, min: 0.00001, max: 1, step: 0.00001 },
  { key: 'spreadAtrMaxRatio', label: 'Max Spread ATR Ratio', type: 'number', defaultValue: 0.08, min: 0.005, max: 0.5, step: 0.005 },
  { key: 'rejectIfSpreadUnavailable', label: 'Reject If Spread Unavailable', type: 'boolean', defaultValue: false },
  { key: 'allowedUtcHours', label: 'Allowed UTC Hours', type: 'json', defaultValue: [] },
  { key: 'blockNewsWindow', label: 'Block News Window', type: 'boolean', defaultValue: false },
  { key: 'minSignalScore', label: 'Min Signal Score', type: 'number', defaultValue: 78, min: 40, max: 100, step: 1 },
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
    fastEmaPeriod: Math.max(2, toInteger(merged.fastEmaPeriod, 20)),
    slowEmaPeriod: Math.max(3, toInteger(merged.slowEmaPeriod, 100)),
    higherFastEmaPeriod: Math.max(2, toInteger(merged.higherFastEmaPeriod, 20)),
    higherSlowEmaPeriod: Math.max(3, toInteger(merged.higherSlowEmaPeriod, 100)),
    momentumLookbackBars: Math.max(1, toInteger(merged.momentumLookbackBars, 72)),
    higherMomentumLookbackBars: Math.max(1, toInteger(merged.higherMomentumLookbackBars, 24)),
    breakoutLookbackBars: Math.max(2, toInteger(merged.breakoutLookbackBars, 20)),
    breakoutBufferAtr: Math.max(0, toNumber(merged.breakoutBufferAtr, 0.05)),
    minMomentumAtr: Math.max(0, toNumber(merged.minMomentumAtr, 1.2)),
    maxExtensionAtr: Math.max(0.1, toNumber(merged.maxExtensionAtr, 4.0)),
    slopeLookbackBars: Math.max(1, toInteger(merged.slopeLookbackBars, 12)),
    atrPeriod: Math.max(2, toInteger(merged.atrPeriod, 14)),
    longAtrPeriod: Math.max(3, toInteger(merged.longAtrPeriod, 100)),
    shortAtrPeriod: Math.max(2, toInteger(merged.shortAtrPeriod, 5)),
    minAtrRatio: Math.max(0, toNumber(merged.minAtrRatio, 0.45)),
    maxAtrRatio: Math.max(0.01, toNumber(merged.maxAtrRatio, 1.75)),
    maxAtrSpikeRatio: Math.max(1, toNumber(merged.maxAtrSpikeRatio, 2.2)),
    targetAtrRatio: Math.max(0.01, toNumber(merged.targetAtrRatio, 1.0)),
    minRiskScale: clamp(toNumber(merged.minRiskScale, 0.35), 0.01, 10),
    maxRiskScale: clamp(toNumber(merged.maxRiskScale, 1.0), 0.01, 10),
    slAtrMultiplier: Math.max(0.1, toNumber(merged.slAtrMultiplier, 1.75)),
    riskReward: Math.max(1, toNumber(merged.riskReward, 2.0)),
    maxBarsInTrade: Math.max(1, toInteger(merged.maxBarsInTrade, 96)),
    maxMinutesInTrade: Math.max(1, toInteger(merged.maxMinutesInTrade, 5760)),
    cooldownBarsAfterAnyExit: Math.max(0, toInteger(merged.cooldownBarsAfterAnyExit, 3)),
    cooldownBarsAfterSL: Math.max(0, toInteger(merged.cooldownBarsAfterSL, 12)),
    maxDailyTrades: Math.max(0, toInteger(merged.maxDailyTrades, 2)),
    maxDailyLosses: Math.max(0, toInteger(merged.maxDailyLosses, 2)),
    maxConsecutiveLosses: Math.max(0, toInteger(merged.maxConsecutiveLosses, 2)),
    spreadMaxPoints: Math.max(0, toNumber(merged.spreadMaxPoints, 80)),
    spreadPointSize: Math.max(0.00001, toNumber(merged.spreadPointSize, 0.001)),
    spreadAtrMaxRatio: Math.max(0, toNumber(merged.spreadAtrMaxRatio, 0.08)),
    minSignalScore: Math.max(1, toInteger(merged.minSignalScore, 78)),
  };
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

function isXagusdSymbol(symbol) {
  const normalized = normalizeSymbol(symbol);
  return normalized === 'XAGUSD' || /^XAGUSD[A-Z0-9._-]*$/.test(normalized);
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

function highestHigh(candles = [], endExclusive, lookbackBars) {
  const start = Math.max(0, endExclusive - lookbackBars);
  const highs = candles.slice(start, endExclusive)
    .map((candle) => toNumber(candle.high, null))
    .filter(Number.isFinite);
  return highs.length ? Math.max(...highs) : null;
}

function lowestLow(candles = [], endExclusive, lookbackBars) {
  const start = Math.max(0, endExclusive - lookbackBars);
  const lows = candles.slice(start, endExclusive)
    .map((candle) => toNumber(candle.low, null))
    .filter(Number.isFinite);
  return lows.length ? Math.min(...lows) : null;
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
    return { passed: true, spread, spreadPoints, spreadAtr, spreadSource, spreadUnavailable: spread == null, score: 12 };
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
    return { passed: false, reasonCode: 'SPREAD_TOO_WIDE', spread, spreadPoints, spreadAtr, spreadSource, spreadUnavailable: false, score: 0 };
  }
  if (Number.isFinite(spreadAtr) && parameters.spreadAtrMaxRatio > 0 && spreadAtr > parameters.spreadAtrMaxRatio) {
    return { passed: false, reasonCode: 'SPREAD_TOO_WIDE', spread, spreadPoints, spreadAtr, spreadSource, spreadUnavailable: false, score: 0 };
  }
  return {
    passed: true,
    spread,
    spreadPoints,
    spreadAtr,
    spreadSource,
    spreadUnavailable: false,
    score: Number.isFinite(spreadAtr) && spreadAtr > parameters.spreadAtrMaxRatio * 0.75 ? 8 : 12,
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
  return { blocked: false, todayLosses, todayTradeCount: todayTrades.length, consecutiveLosses };
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
      reason: 'Max bars in trade reached for XAGUSD volatility-targeted trend',
      metadata: { exitRule: 'MAX_BARS_IN_TRADE', setupType: 'vol_target_trend' },
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
        reason: 'Max minutes in trade reached for XAGUSD volatility-targeted trend',
        metadata: { exitRule: 'MAX_MINUTES_IN_TRADE', holdingMinutes: minutes, setupType: 'vol_target_trend' },
      };
    }
  }
  return {
    signal: 'NONE',
    status: 'NO_SETUP',
    reason: 'Open XAGUSD volatility-targeted trend position is managed by SL/TP/time guard',
    reasonCode: 'OPEN_POSITION_MANAGED',
    metadata: {
      source: 'symbolCustom',
      symbolCustomName: XAGUSD_VOL_TARGET_TREND_V1,
      logicName: XAGUSD_VOL_TARGET_TREND_V1,
      setupType: 'vol_target_trend',
    },
  };
}

function buildNoSignal({ reasonCode, reason, status = 'NO_SETUP', side = null, debug = {}, parameters = {} }) {
  const metadata = {
    source: 'symbolCustom',
    symbolCustomName: XAGUSD_VOL_TARGET_TREND_V1,
    logicName: XAGUSD_VOL_TARGET_TREND_V1,
    strategyType: 'SymbolCustom',
    setupType: 'vol_target_trend',
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
      reason: 'Invalid entry or ATR stop distance for XAGUSD volatility-targeted trend',
      side,
      debug,
      parameters,
    });
  }
  const sl = side === 'BUY' ? entry - risk : entry + risk;
  const tp = side === 'BUY' ? entry + (risk * parameters.riskReward) : entry - (risk * parameters.riskReward);
  const confidence = round(clamp(score.totalScore / 100, 0, 0.95), 4);
  const reason = side === 'BUY'
    ? 'XAGUSD 1h/4h bullish volatility-targeted trend breakout'
    : 'XAGUSD 1h/4h bearish volatility-targeted trend breakdown';
  const metadata = {
    source: 'symbolCustom',
    symbolCustomName: XAGUSD_VOL_TARGET_TREND_V1,
    logicName: XAGUSD_VOL_TARGET_TREND_V1,
    strategyType: 'SymbolCustom',
    setupType: 'vol_target_trend',
    module: 'VOL_TARGET_TREND_FOLLOWING',
    candidatePreset: CANDIDATE_PRESET,
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
    pattern: side === 'BUY' ? 'VOL_TARGET_UPTREND_BREAKOUT' : 'VOL_TARGET_DOWNTREND_BREAKDOWN',
    timeframe: debug.entryTimeframe,
    atrAtEntry: atr,
    atrRatio: debug.atrRatio,
    atrSpikeRatio: debug.atrSpikeRatio,
    riskScale: debug.riskScale,
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
    logic: XAGUSD_VOL_TARGET_TREND_V1,
    pattern: metadata.pattern,
    timeframe: debug.entryTimeframe,
    reason,
    debug,
    metadata,
  };
}

function analyzeSide({ side, setupCandles, higherCandles, setupIndex, higherIndex, setupIndicators, higherIndicators, parameters }) {
  const currentBar = setupCandles[setupIndex] || {};
  const close = getClose(currentBar);
  const atr = toNumber(setupIndicators.atr[setupIndex], null);
  const longAtr = toNumber(setupIndicators.longAtr[setupIndex], null);
  const fastEma = toNumber(setupIndicators.fastEma[setupIndex], null);
  const slowEma = toNumber(setupIndicators.slowEma[setupIndex], null);
  const slowEmaPast = toNumber(setupIndicators.slowEma[setupIndex - parameters.slopeLookbackBars], null);
  const momentumClose = getClose(setupCandles[setupIndex - parameters.momentumLookbackBars]);
  const priorHigh = highestHigh(setupCandles, setupIndex, parameters.breakoutLookbackBars);
  const priorLow = lowestLow(setupCandles, setupIndex, parameters.breakoutLookbackBars);
  const higherClose = getClose(higherCandles[higherIndex]);
  const higherFast = toNumber(higherIndicators.fastEma[higherIndex], null);
  const higherSlow = toNumber(higherIndicators.slowEma[higherIndex], null);
  const higherMomentumClose = getClose(higherCandles[higherIndex - parameters.higherMomentumLookbackBars]);

  if (![close, atr, longAtr, fastEma, slowEma, slowEmaPast, momentumClose, priorHigh, priorLow, higherClose, higherFast, higherSlow, higherMomentumClose].every(Number.isFinite) || atr <= 0 || longAtr <= 0) {
    return { passed: false, reasonCode: 'INDICATORS_UNAVAILABLE' };
  }

  const atrRatio = atr / longAtr;
  const momentumAtr = Math.abs(close - momentumClose) / atr;
  const extensionAtr = Math.abs(close - fastEma) / atr;
  const breakoutBuffer = atr * parameters.breakoutBufferAtr;
  const higherMomentumAtr = Math.abs(higherClose - higherMomentumClose) / atr;

  const setupTrendPassed = side === 'BUY'
    ? close > slowEma && fastEma > slowEma && slowEma > slowEmaPast
    : close < slowEma && fastEma < slowEma && slowEma < slowEmaPast;
  const higherTrendPassed = side === 'BUY'
    ? higherClose > higherSlow && higherFast > higherSlow && higherClose > higherMomentumClose
    : higherClose < higherSlow && higherFast < higherSlow && higherClose < higherMomentumClose;
  const momentumPassed = side === 'BUY'
    ? close > momentumClose && momentumAtr >= parameters.minMomentumAtr
    : close < momentumClose && momentumAtr >= parameters.minMomentumAtr;
  const breakoutPassed = side === 'BUY'
    ? close > priorHigh + breakoutBuffer
    : close < priorLow - breakoutBuffer;
  const extensionPassed = extensionAtr <= parameters.maxExtensionAtr;

  const riskScale = clamp(parameters.targetAtrRatio / Math.max(atrRatio, 0.00001), parameters.minRiskScale, parameters.maxRiskScale);
  const passed = setupTrendPassed && higherTrendPassed && momentumPassed && breakoutPassed && extensionPassed;
  const score = {
    setupTrendScore: setupTrendPassed ? 22 : 0,
    higherTrendScore: higherTrendPassed ? 22 : 0,
    momentumScore: momentumPassed ? (momentumAtr >= parameters.minMomentumAtr * 1.8 ? 18 : 14) : 0,
    breakoutScore: breakoutPassed ? 16 : 0,
    extensionScore: extensionPassed ? 8 : 0,
  };

  return {
    passed,
    reasonCode: passed ? null : 'NO_VOL_TARGET_TREND_SETUP',
    score,
    values: {
      close,
      atr,
      longAtr,
      atrRatio,
      fastEma,
      slowEma,
      slowEmaPast,
      momentumClose,
      momentumAtr,
      extensionAtr,
      priorHigh,
      priorLow,
      breakoutBuffer,
      higherClose,
      higherFast,
      higherSlow,
      higherMomentumClose,
      higherMomentumAtr,
      riskScale,
      setupTrendPassed,
      higherTrendPassed,
      momentumPassed,
      breakoutPassed,
      extensionPassed,
    },
  };
}

class XagusdVolTargetTrendV1 extends BaseSymbolCustom {
  constructor() {
    super({
      name: XAGUSD_VOL_TARGET_TREND_V1,
      symbol: 'XAGUSD',
      description: 'XAGUSD 1h/4h volatility-filtered trend-following logic with ATR regime gates and conservative time exits.',
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
        reason: 'XAGUSD volatility-targeted trend supports backtest and paper scopes only',
        status: 'BLOCKED',
        parameters: { debugSignal: true },
      });
    }

    const parameters = normalizeParameters(context.parameters || {});
    if (!parameters.enabled) {
      return buildNoSignal({
        reasonCode: 'STRATEGY_DISABLED',
        reason: 'XAGUSD volatility-targeted trend parameter enabled=false',
        status: 'FILTERED',
        parameters,
      });
    }

    const symbol = context.symbol || this.symbol;
    if (!isXagusdSymbol(symbol)) {
      return buildNoSignal({
        reasonCode: 'SYMBOL_NOT_SUPPORTED',
        reason: 'XAGUSD volatility-targeted trend only supports XAGUSD symbols',
        status: 'FILTERED',
        parameters,
        debug: { symbol },
      });
    }

    const openPositionExit = checkOpenPositionExit(context, parameters);
    if (openPositionExit) return openPositionExit;

    const entryCandles = Array.isArray(context.candles?.entry) ? context.candles.entry : [];
    const setupCandles = Array.isArray(context.candles?.setup) && context.candles.setup.length ? context.candles.setup : entryCandles;
    const higherCandles = Array.isArray(context.candles?.higher) && context.candles.higher.length ? context.candles.higher : setupCandles;
    const currentBar = context.currentBar || setupCandles[setupCandles.length - 1] || {};
    const setupMinBars = Math.max(
      parameters.slowEmaPeriod + parameters.slopeLookbackBars + 2,
      parameters.longAtrPeriod + 2,
      parameters.momentumLookbackBars + 2,
      parameters.breakoutLookbackBars + 2
    );
    const higherMinBars = Math.max(parameters.higherSlowEmaPeriod + 2, parameters.higherMomentumLookbackBars + 2);
    if (!Array.isArray(setupCandles) || setupCandles.length < setupMinBars || !Array.isArray(higherCandles) || higherCandles.length < higherMinBars) {
      return buildNoSignal({
        reasonCode: 'NOT_ENOUGH_CANDLES',
        reason: 'Not enough candles for XAGUSD volatility-targeted trend analysis',
        status: 'NO_SETUP',
        parameters,
        debug: { setupCandles: setupCandles.length, setupMinBars, higherCandles: higherCandles.length, higherMinBars },
      });
    }

    const currentUtcHour = getUtcHour(context, currentBar);
    const allowedHours = parseUtcHours(parameters.allowedUtcHours);
    if (allowedHours.length > 0 && !allowedHours.includes(currentUtcHour)) {
      return buildNoSignal({
        reasonCode: 'UTC_HOUR_FILTERED',
        reason: 'Current UTC hour is not allowed for XAGUSD volatility-targeted trend',
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

    const setupWindow = Math.max(setupMinBars + 20, parameters.slowEmaPeriod + 30);
    const higherWindow = Math.max(higherMinBars + 10, parameters.higherSlowEmaPeriod + 20);
    const setupSlice = setupCandles.slice(-setupWindow);
    const higherSlice = higherCandles.slice(-higherWindow);
    const setupIndex = setupSlice.length - 1;
    const higherIndex = higherSlice.length - 1;
    const setupCloses = setupSlice.map(getClose);
    const higherCloses = higherSlice.map(getClose);
    const setupIndicators = {
      fastEma: calculateEmaSeries(setupCloses, parameters.fastEmaPeriod),
      slowEma: calculateEmaSeries(setupCloses, parameters.slowEmaPeriod),
      atr: calculateAtrSeries(setupSlice, parameters.atrPeriod),
      longAtr: calculateAtrSeries(setupSlice, parameters.longAtrPeriod),
    };
    const higherIndicators = {
      fastEma: calculateEmaSeries(higherCloses, parameters.higherFastEmaPeriod),
      slowEma: calculateEmaSeries(higherCloses, parameters.higherSlowEmaPeriod),
    };
    const atr = toNumber(setupIndicators.atr[setupIndex], null);
    const longAtr = toNumber(setupIndicators.longAtr[setupIndex], null);
    if (!Number.isFinite(atr) || !Number.isFinite(longAtr) || atr <= 0 || longAtr <= 0) {
      return buildNoSignal({
        reasonCode: 'ATR_UNAVAILABLE',
        reason: 'ATR unavailable for XAGUSD volatility-targeted trend',
        status: 'FILTERED',
        parameters,
        debug: { atr, longAtr },
      });
    }

    const shortAtr = calculateSimpleAtr(setupSlice, parameters.shortAtrPeriod);
    const atrRatio = atr / longAtr;
    const atrSpikeRatio = Number.isFinite(shortAtr) && longAtr > 0 ? shortAtr / longAtr : null;
    if (atrRatio < parameters.minAtrRatio || atrRatio > parameters.maxAtrRatio) {
      return buildNoSignal({
        reasonCode: 'ATR_REGIME_FILTERED',
        reason: 'ATR regime outside volatility-targeted bounds',
        status: 'FILTERED',
        parameters,
        debug: { atr, longAtr, atrRatio, minAtrRatio: parameters.minAtrRatio, maxAtrRatio: parameters.maxAtrRatio },
      });
    }
    if (Number.isFinite(atrSpikeRatio) && atrSpikeRatio > parameters.maxAtrSpikeRatio) {
      return buildNoSignal({
        reasonCode: 'ATR_SPIKE_AVOID_CHASING',
        reason: 'Short ATR spike detected; avoiding chase entry',
        status: 'FILTERED',
        parameters,
        debug: { atr, shortAtr, longAtr, atrSpikeRatio, maxAtrSpikeRatio: parameters.maxAtrSpikeRatio },
      });
    }

    const spreadInfo = resolveSpreadInfo(currentBar, atr, parameters);
    if (!spreadInfo.passed) {
      return buildNoSignal({
        reasonCode: spreadInfo.reasonCode || 'SPREAD_TOO_WIDE',
        reason: 'Spread too wide or unavailable for XAGUSD volatility-targeted trend',
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
        setupCandles: setupSlice,
        higherCandles: higherSlice,
        setupIndex,
        higherIndex,
        setupIndicators,
        higherIndicators,
        parameters,
      });
      if (!sideAnalysis.passed) continue;
      const volatilityScore = atrRatio >= parameters.minAtrRatio && atrRatio <= parameters.maxAtrRatio ? 14 : 0;
      const spikeScore = Number.isFinite(atrSpikeRatio) && atrSpikeRatio <= parameters.maxAtrSpikeRatio ? 6 : 0;
      const score = {
        ...sideAnalysis.score,
        volatilityScore,
        spikeScore,
        costScore: spreadInfo.score,
      };
      score.totalScore = Math.min(
        100,
        score.setupTrendScore
          + score.higherTrendScore
          + score.momentumScore
          + score.breakoutScore
          + score.extensionScore
          + score.volatilityScore
          + score.spikeScore
          + score.costScore
      );
      const debug = {
        scope,
        symbol,
        currentUtcHour,
        setupTimeframe: context.timeframes?.setupTimeframe || parameters.setupTimeframe,
        entryTimeframe: context.timeframes?.entryTimeframe || parameters.entryTimeframe,
        higherTimeframe: context.timeframes?.higherTimeframe || parameters.higherTimeframe,
        atr,
        longAtr,
        shortAtr,
        atrRatio,
        atrSpikeRatio,
        ...sideAnalysis.values,
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
        reasonCode: 'NO_VOL_TARGET_TREND_SETUP',
        reason: 'No side passed 1h/4h trend, momentum, breakout, volatility, and extension filters',
        status: 'NO_SETUP',
        parameters,
        debug: {
          currentUtcHour,
          atr,
          longAtr,
          shortAtr,
          atrRatio,
          atrSpikeRatio,
          spreadInfo,
          close: round(getClose(currentBar), 5),
          fastEma: round(setupIndicators.fastEma[setupIndex], 5),
          slowEma: round(setupIndicators.slowEma[setupIndex], 5),
          higherFast: round(higherIndicators.fastEma[higherIndex], 5),
          higherSlow: round(higherIndicators.slowEma[higherIndex], 5),
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

XagusdVolTargetTrendV1.XAGUSD_VOL_TARGET_TREND_V1 = XAGUSD_VOL_TARGET_TREND_V1;
XagusdVolTargetTrendV1.XAGUSD_VOL_TARGET_TREND_V1_VERSION = XAGUSD_VOL_TARGET_TREND_V1_VERSION;
XagusdVolTargetTrendV1.CANDIDATE_PRESET = CANDIDATE_PRESET;
XagusdVolTargetTrendV1.LIVE_BLOCKED_REASON = LIVE_BLOCKED_REASON;
XagusdVolTargetTrendV1.DEFAULT_PARAMETER_SCHEMA = DEFAULT_PARAMETER_SCHEMA;
XagusdVolTargetTrendV1.normalizeParameters = normalizeParameters;
XagusdVolTargetTrendV1.calculateEmaSeries = calculateEmaSeries;
XagusdVolTargetTrendV1.calculateAtrSeries = calculateAtrSeries;

module.exports = XagusdVolTargetTrendV1;
module.exports.XAGUSD_VOL_TARGET_TREND_V1 = XAGUSD_VOL_TARGET_TREND_V1;
module.exports.XAGUSD_VOL_TARGET_TREND_V1_VERSION = XAGUSD_VOL_TARGET_TREND_V1_VERSION;
