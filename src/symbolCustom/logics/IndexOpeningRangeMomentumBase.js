const BaseSymbolCustom = require('../BaseSymbolCustom');
const { getTimeframeDurationMs } = require('../../utils/timeframe');

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

function buildSchema({ logicId, symbol, spreadPointSize, spreadMaxPoints, minSignalScore, allowedUtcHours }) {
  return Object.freeze([
    { key: 'logicId', label: 'Logic ID', type: 'string', defaultValue: logicId },
    { key: 'mode', label: 'Mode', type: 'string', defaultValue: 'SYMBOLCUSTOM' },
    { key: 'source', label: 'Source', type: 'string', defaultValue: 'symbolCustom' },
    { key: 'symbol', label: 'Symbol', type: 'string', defaultValue: symbol },
    { key: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: false },
    { key: 'setupTimeframe', label: 'Setup Timeframe', type: 'string', defaultValue: '15m' },
    { key: 'entryTimeframe', label: 'Entry Timeframe', type: 'string', defaultValue: '5m' },
    { key: 'higherTimeframe', label: 'Higher Timeframe', type: 'string', defaultValue: '1h' },
    { key: 'enableBuy', label: 'Enable BUY', type: 'boolean', defaultValue: true },
    { key: 'enableSell', label: 'Enable SELL', type: 'boolean', defaultValue: true },
    { key: 'fastEmaPeriod', label: 'Fast EMA Period', type: 'number', defaultValue: 20, min: 5, max: 80, step: 1 },
    { key: 'slowEmaPeriod', label: 'Slow EMA Period', type: 'number', defaultValue: 50, min: 20, max: 160, step: 5 },
    { key: 'higherFastEmaPeriod', label: 'Higher Fast EMA Period', type: 'number', defaultValue: 20, min: 5, max: 80, step: 1 },
    { key: 'higherSlowEmaPeriod', label: 'Higher Slow EMA Period', type: 'number', defaultValue: 100, min: 40, max: 240, step: 5 },
    { key: 'breakoutLookbackBars', label: 'Breakout Lookback Bars', type: 'number', defaultValue: 12, min: 4, max: 60, step: 1 },
    { key: 'breakoutBufferAtr', label: 'Breakout Buffer ATR', type: 'number', defaultValue: 0.08, min: 0, max: 0.5, step: 0.01 },
    { key: 'minBreakoutBodyAtr', label: 'Min Breakout Body ATR', type: 'number', defaultValue: 0.22, min: 0, max: 2, step: 0.01 },
    { key: 'maxPreBreakoutRangeAtr', label: 'Max Pre-Breakout Range ATR', type: 'number', defaultValue: 4.2, min: 1, max: 12, step: 0.1 },
    { key: 'momentumLookbackBars', label: 'Momentum Lookback Bars', type: 'number', defaultValue: 8, min: 2, max: 48, step: 1 },
    { key: 'minMomentumAtr', label: 'Minimum Momentum ATR', type: 'number', defaultValue: 0.6, min: 0, max: 8, step: 0.1 },
    { key: 'maxExtensionAtr', label: 'Max Extension ATR', type: 'number', defaultValue: 3.8, min: 0.5, max: 12, step: 0.1 },
    { key: 'atrPeriod', label: 'ATR Period', type: 'number', defaultValue: 14, min: 5, max: 40, step: 1 },
    { key: 'longAtrPeriod', label: 'Long ATR Period', type: 'number', defaultValue: 80, min: 30, max: 240, step: 5 },
    { key: 'shortAtrPeriod', label: 'Short ATR Period', type: 'number', defaultValue: 5, min: 3, max: 20, step: 1 },
    { key: 'minAtrRatio', label: 'Min ATR / Long ATR', type: 'number', defaultValue: 0.45, min: 0.1, max: 2, step: 0.05 },
    { key: 'maxAtrRatio', label: 'Max ATR / Long ATR', type: 'number', defaultValue: 2.25, min: 0.5, max: 5, step: 0.05 },
    { key: 'maxAtrSpikeRatio', label: 'Max ATR Spike Ratio', type: 'number', defaultValue: 2.8, min: 1, max: 8, step: 0.1 },
    { key: 'useVolumeFilter', label: 'Use Volume Filter', type: 'boolean', defaultValue: true },
    { key: 'volumeLookbackBars', label: 'Volume Lookback Bars', type: 'number', defaultValue: 20, min: 5, max: 80, step: 1 },
    { key: 'minRelativeVolume', label: 'Min Relative Volume', type: 'number', defaultValue: 1.12, min: 0, max: 5, step: 0.05 },
    { key: 'rejectIfVolumeUnavailable', label: 'Reject If Volume Unavailable', type: 'boolean', defaultValue: false },
    { key: 'slAtrMultiplier', label: 'SL ATR Multiplier', type: 'number', defaultValue: 1.4, min: 0.6, max: 5, step: 0.05 },
    { key: 'riskReward', label: 'Risk Reward', type: 'number', defaultValue: 1.8, min: 1, max: 5, step: 0.1 },
    { key: 'maxBarsInTrade', label: 'Max Bars In Trade', type: 'number', defaultValue: 32, min: 4, max: 160, step: 1 },
    { key: 'maxMinutesInTrade', label: 'Max Minutes In Trade', type: 'number', defaultValue: 480, min: 30, max: 2880, step: 30 },
    { key: 'cooldownBarsAfterAnyExit', label: 'Cooldown Bars After Any Exit', type: 'number', defaultValue: 4, min: 0, max: 96, step: 1 },
    { key: 'cooldownBarsAfterSL', label: 'Cooldown Bars After SL', type: 'number', defaultValue: 16, min: 0, max: 160, step: 1 },
    { key: 'maxDailyTrades', label: 'Max Daily Trades', type: 'number', defaultValue: 2, min: 0, max: 12, step: 1 },
    { key: 'maxDailyLosses', label: 'Max Daily Losses', type: 'number', defaultValue: 2, min: 0, max: 8, step: 1 },
    { key: 'maxConsecutiveLosses', label: 'Max Consecutive Losses', type: 'number', defaultValue: 2, min: 0, max: 8, step: 1 },
    { key: 'useSpreadFilter', label: 'Use Spread Filter', type: 'boolean', defaultValue: true },
    { key: 'spreadMaxPoints', label: 'Max Spread Points', type: 'number', defaultValue: spreadMaxPoints, min: 0, max: 500, step: 1 },
    { key: 'spreadPointSize', label: 'Spread Point Size', type: 'number', defaultValue: spreadPointSize, min: 0.00001, max: 10, step: 0.00001 },
    { key: 'spreadAtrMaxRatio', label: 'Max Spread ATR Ratio', type: 'number', defaultValue: 0.08, min: 0.005, max: 0.5, step: 0.005 },
    { key: 'rejectIfSpreadUnavailable', label: 'Reject If Spread Unavailable', type: 'boolean', defaultValue: false },
    { key: 'allowedUtcHours', label: 'Allowed UTC Hours', type: 'json', defaultValue: allowedUtcHours },
    { key: 'blockNewsWindow', label: 'Block News Window', type: 'boolean', defaultValue: true },
    { key: 'minSignalScore', label: 'Min Signal Score', type: 'number', defaultValue: minSignalScore, min: 40, max: 100, step: 1 },
    { key: 'debugSignal', label: 'Debug Signal', type: 'boolean', defaultValue: true },
  ]);
}

function buildDefaultParameters(schema) {
  return schema.reduce((params, field) => {
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

function getCandleTime(candle = {}) {
  return candle.time || candle.timestamp || candle.date || null;
}

function toEpoch(value) {
  if (!value) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : null;
}

function getEvaluationCloseEpoch(context = {}, currentBar = {}, parameters = {}) {
  const currentEpoch = toEpoch(getCandleTime(currentBar));
  if (currentEpoch == null) return null;
  const entryTimeframe = context.timeframes?.entryTimeframe || parameters.entryTimeframe;
  const entryDurationMs = getTimeframeDurationMs(entryTimeframe);
  return currentEpoch + (entryDurationMs || 0);
}

function getClosedCandlesAtEvaluation(candles = [], evaluationCloseEpoch, timeframe) {
  if (!Array.isArray(candles) || evaluationCloseEpoch == null) return candles;
  const durationMs = getTimeframeDurationMs(timeframe);
  if (!durationMs) return candles;
  let endIndex = candles.length;
  while (endIndex > 0) {
    const candle = candles[endIndex - 1];
    const candleEpoch = toEpoch(getCandleTime(candle));
    if (candleEpoch != null && candleEpoch + durationMs <= evaluationCloseEpoch) break;
    endIndex -= 1;
  }
  return endIndex === candles.length ? candles : candles.slice(0, endIndex);
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

function getOpen(candle = {}) {
  return toNumber(candle.open, null);
}

function getHigh(candle = {}) {
  return toNumber(candle.high, null);
}

function getLow(candle = {}) {
  return toNumber(candle.low, null);
}

function getVolume(candle = {}) {
  return toNumber(candle.tickVolume ?? candle.volume ?? candle.realVolume, null);
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
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

function calculateSimpleAtr(candles = [], period = 5) {
  const safePeriod = Math.max(1, toInteger(period, 5));
  if (!Array.isArray(candles) || candles.length < safePeriod + 1) return null;
  const slice = candles.slice(-safePeriod - 1);
  const ranges = [];
  for (let index = 1; index < slice.length; index += 1) {
    const high = getHigh(slice[index]);
    const low = getLow(slice[index]);
    const previousClose = getClose(slice[index - 1]);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
    ranges.push(Number.isFinite(previousClose)
      ? Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose))
      : high - low);
  }
  if (!ranges.length) return null;
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

function highestHigh(candles, endIndex, lookbackBars) {
  const start = Math.max(0, endIndex - lookbackBars);
  const highs = candles.slice(start, endIndex).map(getHigh).filter(Number.isFinite);
  return highs.length ? Math.max(...highs) : null;
}

function lowestLow(candles, endIndex, lookbackBars) {
  const start = Math.max(0, endIndex - lookbackBars);
  const lows = candles.slice(start, endIndex).map(getLow).filter(Number.isFinite);
  return lows.length ? Math.min(...lows) : null;
}

function averageVolume(candles, endIndex, lookbackBars) {
  const start = Math.max(0, endIndex - lookbackBars);
  const values = candles.slice(start, endIndex).map(getVolume).filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function resolveSpreadInfo(currentBar, atr, parameters) {
  if (!parameters.useSpreadFilter) {
    return { passed: true, spread: null, spreadPoints: null, spreadAtr: null, spreadSource: 'disabled', score: 12 };
  }
  const spread = toNumber(
    currentBar.spread ?? currentBar.spreadPoints ?? currentBar.bidAskSpread ?? currentBar.askBidSpread,
    null
  );
  if (!Number.isFinite(spread)) {
    return parameters.rejectIfSpreadUnavailable
      ? { passed: false, reasonCode: 'SPREAD_UNAVAILABLE', spread: null, spreadPoints: null, spreadAtr: null, spreadSource: 'unavailable', score: 0 }
      : { passed: true, spread: null, spreadPoints: null, spreadAtr: null, spreadSource: 'unavailable', score: 8 };
  }
  const spreadPoints = spread;
  const spreadPrice = spreadPoints * parameters.spreadPointSize;
  const spreadAtr = Number.isFinite(atr) && atr > 0 ? spreadPrice / atr : null;
  if (spreadPoints > parameters.spreadMaxPoints) {
    return { passed: false, reasonCode: 'SPREAD_TOO_WIDE', spread, spreadPoints, spreadAtr, spreadSource: 'points', score: 0 };
  }
  if (Number.isFinite(spreadAtr) && spreadAtr > parameters.spreadAtrMaxRatio) {
    return { passed: false, reasonCode: 'SPREAD_ATR_TOO_WIDE', spread, spreadPoints, spreadAtr, spreadSource: 'atr', score: 0 };
  }
  return { passed: true, spread, spreadPoints, spreadAtr, spreadSource: 'points', score: spreadAtr == null ? 8 : 12 };
}

function countConsecutiveLosses(trades = []) {
  let count = 0;
  for (let index = trades.length - 1; index >= 0; index -= 1) {
    const pnl = toNumber(trades[index].pnl ?? trades[index].profitLoss ?? trades[index].profit, 0);
    if (pnl < 0) count += 1;
    else break;
  }
  return count;
}

function checkGuards(context = {}, parameters) {
  const barsSinceLastExit = context.barsSinceLastExit == null
    ? null
    : toNumber(context.barsSinceLastExit, null);
  const lastExitReason = String(context.lastExitReason || context.lastClosedTrade?.exitReason || '').toUpperCase();
  if (Number.isFinite(barsSinceLastExit) && barsSinceLastExit < parameters.cooldownBarsAfterAnyExit) {
    return { blocked: true, reasonCode: 'COOLDOWN_ACTIVE', reason: 'Cooldown active after previous exit' };
  }
  if (
    Number.isFinite(barsSinceLastExit)
    && lastExitReason.includes('SL')
    && barsSinceLastExit < parameters.cooldownBarsAfterSL
  ) {
    return { blocked: true, reasonCode: 'COOLDOWN_AFTER_SL_ACTIVE', reason: 'Cooldown active after SL' };
  }
  const todayTrades = Array.isArray(context.todayClosedTrades) ? context.todayClosedTrades : [];
  if (parameters.maxDailyTrades > 0 && todayTrades.length >= parameters.maxDailyTrades) {
    return { blocked: true, reasonCode: 'MAX_DAILY_TRADES_REACHED', reason: 'Max daily trades reached' };
  }
  const todayLosses = todayTrades.filter((trade) => toNumber(trade.pnl ?? trade.profitLoss ?? trade.profit, 0) < 0).length;
  if (parameters.maxDailyLosses > 0 && todayLosses >= parameters.maxDailyLosses) {
    return { blocked: true, reasonCode: 'DAILY_LOSS_LIMIT_REACHED', reason: 'Max daily losses reached' };
  }
  const closedTrades = Array.isArray(context.closedTrades) ? context.closedTrades : [];
  const consecutiveLosses = countConsecutiveLosses(closedTrades);
  if (parameters.maxConsecutiveLosses > 0 && consecutiveLosses >= parameters.maxConsecutiveLosses) {
    return { blocked: true, reasonCode: 'CONSECUTIVE_LOSS_GUARD_ACTIVE', reason: 'Max consecutive losses reached' };
  }
  return { blocked: false, todayTradeCount: todayTrades.length, todayLosses, consecutiveLosses };
}

function buildNoSignal({ reasonCode, reason, status = 'NO_SETUP', parameters, debug = {}, side = null }) {
  return {
    signal: 'NONE',
    hasSignal: false,
    status,
    reason,
    reasonCode,
    side,
    confidence: 0,
    marketQualityScore: 0,
    marketQualityThreshold: parameters ? parameters.minSignalScore : undefined,
    metadata: {
      reasonCode,
      setupType: 'index_opening_range_momentum',
      module: 'INDEX_OPENING_RANGE_BREAKOUT',
      debug,
    },
  };
}

function buildCloseSignal({ reasonCode, reason, metadata = {} }) {
  return {
    signal: 'CLOSE',
    status: 'TRIGGERED',
    reason,
    reasonCode,
    metadata: {
      setupType: 'index_opening_range_momentum',
      module: 'INDEX_POSITION_GUARD',
      exitRule: reasonCode,
      ...metadata,
    },
  };
}

function checkOpenPositionExit(context = {}, parameters) {
  const openPosition = context.openPosition;
  if (!openPosition) return null;
  const currentIndex = Number(context.currentIndex);
  const entryIndex = Number(openPosition.entryIndex);
  if (Number.isFinite(currentIndex) && Number.isFinite(entryIndex) && currentIndex - entryIndex >= parameters.maxBarsInTrade) {
    return buildCloseSignal({
      reasonCode: 'MAX_BARS_IN_TRADE',
      reason: 'Index opening-range position reached max bars in trade',
      metadata: { currentIndex, entryIndex, barsHeld: currentIndex - entryIndex },
    });
  }
  const entryEpoch = toEpoch(openPosition.entryTime || openPosition.openTime);
  const currentEpoch = toEpoch(context.currentBar && getCandleTime(context.currentBar));
  if (entryEpoch != null && currentEpoch != null) {
    const minutesHeld = (currentEpoch - entryEpoch) / 60000;
    if (minutesHeld >= parameters.maxMinutesInTrade) {
      return buildCloseSignal({
        reasonCode: 'MAX_MINUTES_IN_TRADE',
        reason: 'Index opening-range position reached max minutes in trade',
        metadata: { minutesHeld: round(minutesHeld, 2), maxMinutesInTrade: parameters.maxMinutesInTrade },
      });
    }
  }
  return null;
}

function analyzeSide({ side, candles, higherCandles, index, higherIndex, indicators, higherIndicators, parameters }) {
  const current = candles[index] || {};
  const currentClose = getClose(current);
  const currentOpen = getOpen(current);
  const atr = toNumber(indicators.atr[index], null);
  const longAtr = toNumber(indicators.longAtr[index], null);
  const fastEma = toNumber(indicators.fastEma[index], null);
  const slowEma = toNumber(indicators.slowEma[index], null);
  const higherFast = toNumber(higherIndicators.fastEma[higherIndex], null);
  const higherSlow = toNumber(higherIndicators.slowEma[higherIndex], null);
  const priorHigh = highestHigh(candles, index, parameters.breakoutLookbackBars);
  const priorLow = lowestLow(candles, index, parameters.breakoutLookbackBars);
  const momentumBase = getClose(candles[index - parameters.momentumLookbackBars]);

  if (![currentClose, currentOpen, atr, longAtr, fastEma, slowEma, higherFast, higherSlow, priorHigh, priorLow, momentumBase].every(Number.isFinite)) {
    return { passed: false, reasonCode: 'SIDE_DATA_UNAVAILABLE' };
  }

  const bodyAtr = Math.abs(currentClose - currentOpen) / atr;
  const preBreakoutRangeAtr = (priorHigh - priorLow) / atr;
  const momentumAtr = side === 'BUY'
    ? (currentClose - momentumBase) / atr
    : (momentumBase - currentClose) / atr;
  const extensionAtr = side === 'BUY'
    ? (currentClose - slowEma) / atr
    : (slowEma - currentClose) / atr;
  const breakoutLevel = side === 'BUY'
    ? priorHigh + (parameters.breakoutBufferAtr * atr)
    : priorLow - (parameters.breakoutBufferAtr * atr);
  const setupTrendPassed = side === 'BUY' ? fastEma > slowEma : fastEma < slowEma;
  const higherTrendPassed = side === 'BUY' ? higherFast > higherSlow : higherFast < higherSlow;
  const breakoutPassed = side === 'BUY' ? currentClose > breakoutLevel : currentClose < breakoutLevel;
  const momentumPassed = momentumAtr >= parameters.minMomentumAtr;
  const bodyPassed = bodyAtr >= parameters.minBreakoutBodyAtr;
  const rangePassed = preBreakoutRangeAtr <= parameters.maxPreBreakoutRangeAtr;
  const extensionPassed = extensionAtr <= parameters.maxExtensionAtr;

  if (!setupTrendPassed || !higherTrendPassed || !breakoutPassed || !momentumPassed || !bodyPassed || !rangePassed || !extensionPassed) {
    return {
      passed: false,
      reasonCode: 'SIDE_FILTERS_FAILED',
      values: {
        setupTrendPassed,
        higherTrendPassed,
        breakoutPassed,
        momentumPassed,
        bodyPassed,
        rangePassed,
        extensionPassed,
      },
    };
  }

  const score = {
    setupTrendScore: setupTrendPassed ? 14 : 0,
    higherTrendScore: higherTrendPassed ? 18 : 0,
    breakoutScore: breakoutPassed ? 18 : 0,
    momentumScore: momentumPassed ? 14 : 0,
    bodyScore: bodyPassed ? 8 : 0,
    rangeScore: rangePassed ? 6 : 0,
    extensionScore: extensionPassed ? 6 : 0,
  };

  return {
    passed: true,
    score,
    values: {
      currentClose,
      atr,
      longAtr,
      fastEma,
      slowEma,
      higherFast,
      higherSlow,
      priorHigh,
      priorLow,
      breakoutLevel,
      momentumAtr,
      bodyAtr,
      preBreakoutRangeAtr,
      extensionAtr,
      setupTrendPassed,
      higherTrendPassed,
      breakoutPassed,
      momentumPassed,
      bodyPassed,
      rangePassed,
      extensionPassed,
    },
  };
}

function buildSignal({ logic, side, currentBar, atr, parameters, score, debug }) {
  const close = getClose(currentBar);
  const riskDistance = atr * parameters.slAtrMultiplier;
  const stopLoss = side === 'BUY' ? close - riskDistance : close + riskDistance;
  const takeProfit = side === 'BUY' ? close + riskDistance * parameters.riskReward : close - riskDistance * parameters.riskReward;
  const totalScore = Math.min(100, score.totalScore);
  return {
    signal: side,
    hasSignal: true,
    status: 'TRIGGERED',
    reason: `${logic.symbol} index opening-range momentum ${side} signal`,
    reasonCode: `${logic.symbol}_INDEX_OPENING_RANGE_MOMENTUM_${side}`,
    confidence: round(totalScore / 100, 4),
    rawConfidence: round(totalScore / 100, 4),
    marketQualityScore: totalScore,
    marketQualityThreshold: parameters.minSignalScore,
    sl: round(stopLoss, 5),
    tp: round(takeProfit, 5),
    stopLoss: round(stopLoss, 5),
    takeProfit: round(takeProfit, 5),
    riskReward: parameters.riskReward,
    metadata: {
      source: 'symbolCustom',
      symbolCustomName: logic.name,
      logicName: logic.name,
      strategyName: logic.description,
      candidatePreset: logic.candidatePreset,
      setupType: logic.setupType,
      module: 'INDEX_OPENING_RANGE_BREAKOUT',
      pattern: side === 'BUY' ? 'INDEX_UPTREND_OPENING_RANGE_BREAKOUT' : 'INDEX_DOWNTREND_OPENING_RANGE_BREAKDOWN',
      side,
      score,
      marketQualityScore: totalScore,
      marketQualityThreshold: parameters.minSignalScore,
      atr: round(atr, 5),
      slAtrMultiplier: parameters.slAtrMultiplier,
      riskDistance: round(riskDistance, 5),
      debug: parameters.debugSignal ? cloneValue(debug) : undefined,
    },
  };
}

class IndexOpeningRangeMomentumBase extends BaseSymbolCustom {
  constructor(meta = {}) {
    super({
      name: meta.name,
      symbol: meta.symbol,
      description: meta.description || `${meta.symbol} index opening-range momentum SymbolCustom`,
    });
    this.candidatePreset = meta.candidatePreset;
    this.setupType = meta.setupType || 'index_opening_range_momentum';
    this.liveBlockedReason = `${meta.name} live execution is blocked until out-of-sample validation passes`;
    this.parameterSchema = buildSchema({
      logicId: meta.name,
      symbol: meta.symbol,
      spreadPointSize: meta.spreadPointSize == null ? 1 : meta.spreadPointSize,
      spreadMaxPoints: meta.spreadMaxPoints == null ? 80 : meta.spreadMaxPoints,
      minSignalScore: meta.minSignalScore == null ? 74 : meta.minSignalScore,
      allowedUtcHours: meta.allowedUtcHours || [13, 14, 15, 16, 17, 18],
    });
  }

  getDefaultParameterSchema() {
    return cloneValue(this.parameterSchema);
  }

  getDefaultParameters() {
    return buildDefaultParameters(this.parameterSchema);
  }

  normalizeParameters(rawParameters = {}) {
    const merged = {
      ...this.getDefaultParameters(),
      ...(rawParameters || {}),
    };
    return {
      ...merged,
      enabled: toBoolean(merged.enabled, false),
      enableBuy: toBoolean(merged.enableBuy, true),
      enableSell: toBoolean(merged.enableSell, true),
      useVolumeFilter: toBoolean(merged.useVolumeFilter, true),
      rejectIfVolumeUnavailable: toBoolean(merged.rejectIfVolumeUnavailable, false),
      useSpreadFilter: toBoolean(merged.useSpreadFilter, true),
      rejectIfSpreadUnavailable: toBoolean(merged.rejectIfSpreadUnavailable, false),
      blockNewsWindow: toBoolean(merged.blockNewsWindow, true),
      debugSignal: toBoolean(merged.debugSignal, true),
      fastEmaPeriod: Math.max(2, toInteger(merged.fastEmaPeriod, 20)),
      slowEmaPeriod: Math.max(3, toInteger(merged.slowEmaPeriod, 50)),
      higherFastEmaPeriod: Math.max(2, toInteger(merged.higherFastEmaPeriod, 20)),
      higherSlowEmaPeriod: Math.max(3, toInteger(merged.higherSlowEmaPeriod, 100)),
      breakoutLookbackBars: Math.max(2, toInteger(merged.breakoutLookbackBars, 12)),
      breakoutBufferAtr: Math.max(0, toNumber(merged.breakoutBufferAtr, 0.08)),
      minBreakoutBodyAtr: Math.max(0, toNumber(merged.minBreakoutBodyAtr, 0.22)),
      maxPreBreakoutRangeAtr: Math.max(0.1, toNumber(merged.maxPreBreakoutRangeAtr, 4.2)),
      momentumLookbackBars: Math.max(1, toInteger(merged.momentumLookbackBars, 8)),
      minMomentumAtr: Math.max(0, toNumber(merged.minMomentumAtr, 0.6)),
      maxExtensionAtr: Math.max(0.1, toNumber(merged.maxExtensionAtr, 3.8)),
      atrPeriod: Math.max(2, toInteger(merged.atrPeriod, 14)),
      longAtrPeriod: Math.max(3, toInteger(merged.longAtrPeriod, 80)),
      shortAtrPeriod: Math.max(2, toInteger(merged.shortAtrPeriod, 5)),
      minAtrRatio: Math.max(0, toNumber(merged.minAtrRatio, 0.45)),
      maxAtrRatio: Math.max(0.01, toNumber(merged.maxAtrRatio, 2.25)),
      maxAtrSpikeRatio: Math.max(1, toNumber(merged.maxAtrSpikeRatio, 2.8)),
      volumeLookbackBars: Math.max(1, toInteger(merged.volumeLookbackBars, 20)),
      minRelativeVolume: Math.max(0, toNumber(merged.minRelativeVolume, 1.12)),
      slAtrMultiplier: Math.max(0.1, toNumber(merged.slAtrMultiplier, 1.4)),
      riskReward: Math.max(1, toNumber(merged.riskReward, 1.8)),
      maxBarsInTrade: Math.max(1, toInteger(merged.maxBarsInTrade, 32)),
      maxMinutesInTrade: Math.max(1, toInteger(merged.maxMinutesInTrade, 480)),
      cooldownBarsAfterAnyExit: Math.max(0, toInteger(merged.cooldownBarsAfterAnyExit, 4)),
      cooldownBarsAfterSL: Math.max(0, toInteger(merged.cooldownBarsAfterSL, 16)),
      maxDailyTrades: Math.max(0, toInteger(merged.maxDailyTrades, 2)),
      maxDailyLosses: Math.max(0, toInteger(merged.maxDailyLosses, 2)),
      maxConsecutiveLosses: Math.max(0, toInteger(merged.maxConsecutiveLosses, 2)),
      spreadMaxPoints: Math.max(0, toNumber(merged.spreadMaxPoints, 80)),
      spreadPointSize: Math.max(0.00001, toNumber(merged.spreadPointSize, 1)),
      spreadAtrMaxRatio: Math.max(0, toNumber(merged.spreadAtrMaxRatio, 0.08)),
      minSignalScore: Math.max(1, toInteger(merged.minSignalScore, 74)),
      allowedUtcHours: merged.allowedUtcHours,
    };
  }

  matchesSymbol(symbol) {
    const normalized = normalizeSymbol(symbol);
    return normalized === this.symbol || normalized.startsWith(this.symbol);
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
    if (!this.matchesSymbol(symbol)) {
      return buildNoSignal({
        reasonCode: 'SYMBOL_NOT_SUPPORTED',
        reason: `${this.name} supports ${this.symbol} only`,
        status: 'FILTERED',
        parameters,
        debug: { symbol, supportedSymbol: this.symbol },
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
    const currentBar = context.currentBar || rawSetupCandles[rawSetupCandles.length - 1] || {};
    const rawHigherCandles = context.candles?.higher || rawSetupCandles;
    const evaluationCloseEpoch = getEvaluationCloseEpoch(context, currentBar, parameters);
    const setupCandles = getClosedCandlesAtEvaluation(
      rawSetupCandles,
      evaluationCloseEpoch,
      context.timeframes?.setupTimeframe || parameters.setupTimeframe
    );
    const higherCandles = getClosedCandlesAtEvaluation(
      rawHigherCandles,
      evaluationCloseEpoch,
      context.timeframes?.higherTimeframe || parameters.higherTimeframe
    );
    const exitSignal = checkOpenPositionExit({ ...context, currentBar }, parameters);
    if (exitSignal) return exitSignal;

    const setupMinBars = Math.max(
      parameters.slowEmaPeriod + parameters.breakoutLookbackBars + 5,
      parameters.longAtrPeriod + 5,
      parameters.volumeLookbackBars + 5
    );
    const higherMinBars = parameters.higherSlowEmaPeriod + 5;
    if (!Array.isArray(setupCandles) || setupCandles.length < setupMinBars || !Array.isArray(higherCandles) || higherCandles.length < higherMinBars) {
      return buildNoSignal({
        reasonCode: 'NOT_ENOUGH_CANDLES',
        reason: 'Not enough candles for index opening-range momentum analysis',
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
        reason: 'Current UTC hour is outside the configured index session',
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

    const setupWindow = Math.max(setupMinBars + 20, parameters.slowEmaPeriod + parameters.longAtrPeriod + 20);
    const higherWindow = Math.max(higherMinBars + 10, parameters.higherSlowEmaPeriod + 20);
    const setupSlice = setupCandles.slice(-setupWindow);
    const higherSlice = higherCandles.slice(-higherWindow);
    const index = setupSlice.length - 1;
    const higherIndex = higherSlice.length - 1;
    const setupCloses = setupSlice.map(getClose);
    const higherCloses = higherSlice.map(getClose);
    const indicators = {
      fastEma: calculateEmaSeries(setupCloses, parameters.fastEmaPeriod),
      slowEma: calculateEmaSeries(setupCloses, parameters.slowEmaPeriod),
      atr: calculateAtrSeries(setupSlice, parameters.atrPeriod),
      longAtr: calculateAtrSeries(setupSlice, parameters.longAtrPeriod),
    };
    const higherIndicators = {
      fastEma: calculateEmaSeries(higherCloses, parameters.higherFastEmaPeriod),
      slowEma: calculateEmaSeries(higherCloses, parameters.higherSlowEmaPeriod),
    };
    const atr = toNumber(indicators.atr[index], null);
    const longAtr = toNumber(indicators.longAtr[index], null);
    if (!Number.isFinite(atr) || !Number.isFinite(longAtr) || atr <= 0 || longAtr <= 0) {
      return buildNoSignal({
        reasonCode: 'ATR_UNAVAILABLE',
        reason: 'ATR unavailable for index opening-range momentum analysis',
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
        reason: 'Index ATR regime outside configured bounds',
        status: 'FILTERED',
        parameters,
        debug: { atr, longAtr, atrRatio, minAtrRatio: parameters.minAtrRatio, maxAtrRatio: parameters.maxAtrRatio },
      });
    }
    if (Number.isFinite(atrSpikeRatio) && atrSpikeRatio > parameters.maxAtrSpikeRatio) {
      return buildNoSignal({
        reasonCode: 'ATR_SPIKE_AVOID_CHASING',
        reason: 'Short ATR spike detected; avoiding index breakout chase',
        status: 'FILTERED',
        parameters,
        debug: { atr, shortAtr, longAtr, atrSpikeRatio, maxAtrSpikeRatio: parameters.maxAtrSpikeRatio },
      });
    }

    const spreadInfo = resolveSpreadInfo(currentBar, atr, parameters);
    if (!spreadInfo.passed) {
      return buildNoSignal({
        reasonCode: spreadInfo.reasonCode || 'SPREAD_TOO_WIDE',
        reason: 'Spread too wide or unavailable for index opening-range momentum',
        status: 'FILTERED',
        parameters,
        debug: { ...spreadInfo, atr },
      });
    }

    const avgVolume = averageVolume(setupSlice, index, parameters.volumeLookbackBars);
    const currentVolume = getVolume(currentBar);
    const relativeVolume = Number.isFinite(avgVolume) && avgVolume > 0 && Number.isFinite(currentVolume)
      ? currentVolume / avgVolume
      : null;
    if (parameters.useVolumeFilter) {
      if (!Number.isFinite(relativeVolume)) {
        if (parameters.rejectIfVolumeUnavailable) {
          return buildNoSignal({
            reasonCode: 'VOLUME_UNAVAILABLE',
            reason: 'Volume unavailable for index opening-range momentum',
            status: 'FILTERED',
            parameters,
            debug: { avgVolume, currentVolume },
          });
        }
      } else if (relativeVolume < parameters.minRelativeVolume) {
        return buildNoSignal({
          reasonCode: 'RELATIVE_VOLUME_TOO_LOW',
          reason: 'Relative volume is too low for index opening-range continuation',
          status: 'FILTERED',
          parameters,
          debug: { avgVolume, currentVolume, relativeVolume, minRelativeVolume: parameters.minRelativeVolume },
        });
      }
    }

    const candidates = [];
    for (const side of ['BUY', 'SELL']) {
      if (side === 'BUY' && !parameters.enableBuy) continue;
      if (side === 'SELL' && !parameters.enableSell) continue;
      const sideAnalysis = analyzeSide({
        side,
        candles: setupSlice,
        higherCandles: higherSlice,
        index,
        higherIndex,
        indicators,
        higherIndicators,
        parameters,
      });
      if (!sideAnalysis.passed) continue;
      const volatilityScore = atrRatio >= parameters.minAtrRatio && atrRatio <= parameters.maxAtrRatio ? 8 : 0;
      const spikeScore = Number.isFinite(atrSpikeRatio) && atrSpikeRatio <= parameters.maxAtrSpikeRatio ? 4 : 0;
      const volumeScore = parameters.useVolumeFilter
        ? (Number.isFinite(relativeVolume) ? Math.min(10, Math.max(0, relativeVolume / parameters.minRelativeVolume * 8)) : 4)
        : 8;
      const score = {
        ...sideAnalysis.score,
        volatilityScore,
        spikeScore,
        volumeScore,
        costScore: spreadInfo.score,
      };
      score.totalScore = Math.min(
        100,
        score.setupTrendScore
          + score.higherTrendScore
          + score.breakoutScore
          + score.momentumScore
          + score.bodyScore
          + score.rangeScore
          + score.extensionScore
          + score.volatilityScore
          + score.spikeScore
          + score.volumeScore
          + score.costScore
      );
      candidates.push({
        side,
        score,
        debug: {
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
          avgVolume,
          currentVolume,
          relativeVolume,
          spread: spreadInfo.spread,
          spreadPoints: spreadInfo.spreadPoints,
          spreadAtr: spreadInfo.spreadAtr,
          guard,
          parameters: cloneValue(parameters),
          ...sideAnalysis.values,
        },
      });
    }

    if (!candidates.length) {
      return buildNoSignal({
        reasonCode: 'NO_INDEX_OPENING_RANGE_SETUP',
        reason: 'No side passed index trend, range breakout, momentum, volatility, volume, and cost filters',
        status: 'NO_SETUP',
        parameters,
        debug: {
          currentUtcHour,
          atr,
          longAtr,
          shortAtr,
          atrRatio,
          atrSpikeRatio,
          avgVolume,
          currentVolume,
          relativeVolume,
          close: round(getClose(currentBar), 5),
          fastEma: round(indicators.fastEma[index], 5),
          slowEma: round(indicators.slowEma[index], 5),
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
      logic: this,
      side: best.side,
      currentBar,
      atr,
      parameters,
      score: best.score,
      debug: best.debug,
    });
  }
}

IndexOpeningRangeMomentumBase.calculateEmaSeries = calculateEmaSeries;
IndexOpeningRangeMomentumBase.calculateAtrSeries = calculateAtrSeries;
IndexOpeningRangeMomentumBase.parseUtcHours = parseUtcHours;

module.exports = IndexOpeningRangeMomentumBase;
