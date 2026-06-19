const BaseSymbolCustom = require('../BaseSymbolCustom');
const indicatorService = require('../../services/indicatorService');

const LIVE_BLOCKED_REASON = 'Oil breakout retest SymbolCustom live execution is blocked';
const NON_BACKTEST_REASON = 'Oil breakout retest SymbolCustom is backtest-only while edge validation continues';
const DEFAULT_RUNTIME_SCOPES = Object.freeze(['backtest']);

const DEFAULT_PARAMETER_SCHEMA = Object.freeze([
  { key: 'enableBuy', label: 'Enable BUY', type: 'boolean', defaultValue: true },
  { key: 'enableSell', label: 'Enable SELL', type: 'boolean', defaultValue: true },
  { key: 'allowedUtcHours', label: 'Allowed UTC Hours', type: 'string', defaultValue: '7,8,9,10,13,14,15,16,17,18' },
  { key: 'blockedUtcHours', label: 'Blocked UTC Hours', type: 'string', defaultValue: '' },
  { key: 'breakoutLookback', label: 'Breakout Lookback Setup Bars', type: 'number', defaultValue: 18, min: 8, max: 72, step: 2 },
  { key: 'atrPeriod', label: 'ATR Period', type: 'number', defaultValue: 14, min: 8, max: 30, step: 1 },
  { key: 'emaFast', label: 'Fast EMA', type: 'number', defaultValue: 20, min: 10, max: 40, step: 5 },
  { key: 'emaSlow', label: 'Slow EMA', type: 'number', defaultValue: 50, min: 30, max: 100, step: 10 },
  { key: 'minBreakDistanceAtr', label: 'Min Break Distance ATR', type: 'number', defaultValue: 0.12, min: 0, max: 1, step: 0.02 },
  { key: 'bodyAtrThreshold', label: 'Breakout Body ATR Threshold', type: 'number', defaultValue: 0.45, min: 0.1, max: 2, step: 0.05 },
  { key: 'maxBreakoutBodyAtr', label: 'Max Breakout Body ATR', type: 'number', defaultValue: 1.8, min: 0.5, max: 4, step: 0.1 },
  { key: 'retestMaxEntryBars', label: 'Retest Max Entry Bars', type: 'number', defaultValue: 18, min: 3, max: 72, step: 3 },
  { key: 'retestToleranceAtr', label: 'Retest Tolerance ATR', type: 'number', defaultValue: 0.28, min: 0.05, max: 1, step: 0.05 },
  { key: 'maxEntryDistanceAtr', label: 'Max Entry Distance From Structure ATR', type: 'number', defaultValue: 0.55, min: 0.1, max: 2, step: 0.05 },
  { key: 'requireRetestRejection', label: 'Require Retest Rejection', type: 'boolean', defaultValue: true },
  { key: 'requireHigherTrendAlignment', label: 'Require Higher Trend Alignment', type: 'boolean', defaultValue: false },
  { key: 'minHigherTrendStrength', label: 'Min Higher Trend Strength', type: 'number', defaultValue: 0, min: 0, max: 2, step: 0.05 },
  { key: 'slAtrMultiplier', label: 'SL ATR Multiplier', type: 'number', defaultValue: 1.4, min: 0.6, max: 4, step: 0.1 },
  { key: 'tpAtrMultiplier', label: 'TP ATR Multiplier', type: 'number', defaultValue: 2.4, min: 0.8, max: 8, step: 0.1 },
  { key: 'minConfidence', label: 'Minimum Confidence', type: 'number', defaultValue: 0.62, min: 0.4, max: 0.9, step: 0.01 },
  { key: 'cooldownBarsAfterAnyExit', label: 'Cooldown Bars After Any Exit', type: 'number', defaultValue: 6, min: 0, max: 96, step: 3 },
  { key: 'cooldownBarsAfterSL', label: 'Cooldown Bars After SL', type: 'number', defaultValue: 18, min: 0, max: 144, step: 3 },
  { key: 'maxDailyLosses', label: 'Max Daily Losses', type: 'number', defaultValue: 2, min: 0, max: 10, step: 1 },
  { key: 'maxDailyTrades', label: 'Max Daily Trades', type: 'number', defaultValue: 4, min: 0, max: 30, step: 1 },
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

function getEpoch(candle = {}) {
  const time = getCandleTime(candle);
  const epoch = time ? Date.parse(time) : NaN;
  return Number.isFinite(epoch) ? epoch : null;
}

function getUtcHour(candle = {}) {
  const epoch = getEpoch(candle);
  return epoch == null ? null : new Date(epoch).getUTCHours();
}

function parseUtcHours(value) {
  if (value == null || String(value).trim() === '') return [];
  return String(value)
    .split(',')
    .map((item) => Number(String(item).trim()))
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
}

function calculateATR(candles = [], period = 14) {
  const series = indicatorService.atr(candles, Math.max(1, toInteger(period, 14)));
  return Array.isArray(series) && series.length ? series[series.length - 1] : null;
}

function calculateEMAValue(candles = [], period = 20) {
  const closes = candles.map((candle) => Number(candle.close)).filter(Number.isFinite);
  const series = indicatorService.ema(closes, Math.max(1, toInteger(period, 20)));
  return Array.isArray(series) && series.length ? series[series.length - 1] : null;
}

function calculatePriceRange(candles = []) {
  const highs = candles.map((candle) => toNumber(candle.high, null)).filter(Number.isFinite);
  const lows = candles.map((candle) => toNumber(candle.low, null)).filter(Number.isFinite);
  if (!highs.length || !lows.length) return { high: null, low: null };
  return { high: Math.max(...highs), low: Math.min(...lows) };
}

function buildDefaultParameters() {
  return DEFAULT_PARAMETER_SCHEMA.reduce((params, field) => {
    params[field.key] = field.defaultValue;
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
    enableBuy: toBoolean(merged.enableBuy, true),
    enableSell: toBoolean(merged.enableSell, true),
    requireRetestRejection: toBoolean(merged.requireRetestRejection, true),
    requireHigherTrendAlignment: toBoolean(merged.requireHigherTrendAlignment, false),
    breakoutLookback: Math.max(4, toInteger(merged.breakoutLookback, 18)),
    atrPeriod: Math.max(2, toInteger(merged.atrPeriod, 14)),
    emaFast: Math.max(2, toInteger(merged.emaFast, 20)),
    emaSlow: Math.max(3, toInteger(merged.emaSlow, 50)),
    retestMaxEntryBars: Math.max(1, toInteger(merged.retestMaxEntryBars, 18)),
    cooldownBarsAfterAnyExit: Math.max(0, toInteger(merged.cooldownBarsAfterAnyExit, 6)),
    cooldownBarsAfterSL: Math.max(0, toInteger(merged.cooldownBarsAfterSL, 18)),
    maxDailyLosses: Math.max(0, toInteger(merged.maxDailyLosses, 2)),
    maxDailyTrades: Math.max(0, toInteger(merged.maxDailyTrades, 4)),
    minBreakDistanceAtr: toNumber(merged.minBreakDistanceAtr, 0.12),
    bodyAtrThreshold: toNumber(merged.bodyAtrThreshold, 0.45),
    maxBreakoutBodyAtr: toNumber(merged.maxBreakoutBodyAtr, 1.8),
    retestToleranceAtr: toNumber(merged.retestToleranceAtr, 0.28),
    maxEntryDistanceAtr: toNumber(merged.maxEntryDistanceAtr, 0.55),
    minHigherTrendStrength: toNumber(merged.minHigherTrendStrength, 0),
    slAtrMultiplier: toNumber(merged.slAtrMultiplier, 1.4),
    tpAtrMultiplier: toNumber(merged.tpAtrMultiplier, 2.4),
    minConfidence: toNumber(merged.minConfidence, 0.62),
  };
}

function timeframeToMs(timeframe = '1h') {
  const match = String(timeframe || '').trim().toLowerCase().match(/^(\d+)\s*(m|h|d)$/);
  if (!match) return 60 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  return value * 24 * 60 * 60 * 1000;
}

function getEvaluationCloseEpoch(currentBar = {}, entryTimeframe = '5m') {
  const currentEpoch = getEpoch(currentBar);
  if (currentEpoch == null) return null;
  return currentEpoch + timeframeToMs(entryTimeframe);
}

function filterCompletedCandlesAtEvaluation(candles = [], evaluationCloseEpoch = null, timeframe = '1h', maxLookback = 300) {
  const recentCandles = Array.isArray(candles) ? candles.slice(-maxLookback) : [];
  if (evaluationCloseEpoch == null) return recentCandles;
  const durationMs = timeframeToMs(timeframe);
  let endIndex = recentCandles.length;
  while (endIndex > 0) {
    const candleEpoch = getEpoch(recentCandles[endIndex - 1]);
    if (candleEpoch != null && candleEpoch + durationMs <= evaluationCloseEpoch) break;
    endIndex -= 1;
  }
  return endIndex === recentCandles.length
    ? recentCandles
    : recentCandles.slice(0, endIndex);
}

function findLatestBreakout(setupCandles = [], entryCandles = [], currentBar = {}, parameters = {}, setupTimeframe = '1h') {
  const currentEpoch = getEpoch(currentBar);
  if (currentEpoch == null) return null;

  const maxBarsMs = parameters.retestMaxEntryBars * 5 * 60 * 1000;
  const setupDurationMs = timeframeToMs(setupTimeframe);
  const candidates = setupCandles.slice(-(parameters.retestMaxEntryBars + 8)).reverse();
  for (const trigger of candidates) {
    const triggerEpoch = getEpoch(trigger);
    if (triggerEpoch == null) continue;
    const triggerCompleteEpoch = triggerEpoch + setupDurationMs;
    if (triggerCompleteEpoch > currentEpoch) continue;
    if (currentEpoch - triggerCompleteEpoch > maxBarsMs) continue;

    const triggerIndex = setupCandles.indexOf(trigger);
    if (triggerIndex < parameters.breakoutLookback) continue;
    const structureWindow = setupCandles.slice(triggerIndex - parameters.breakoutLookback, triggerIndex);
    const { high: structureHigh, low: structureLow } = calculatePriceRange(structureWindow);
    const atrWindow = setupCandles.slice(Math.max(0, triggerIndex - parameters.atrPeriod * 3), triggerIndex + 1);
    const atr = calculateATR(atrWindow, parameters.atrPeriod);
    if (!Number.isFinite(structureHigh) || !Number.isFinite(structureLow) || !Number.isFinite(atr) || atr <= 0) {
      continue;
    }

    const close = toNumber(trigger.close, null);
    const open = toNumber(trigger.open, null);
    const high = toNumber(trigger.high, null);
    const low = toNumber(trigger.low, null);
    if (![close, open, high, low].every(Number.isFinite)) continue;

    const bodyAtr = Math.abs(close - open) / atr;
    if (bodyAtr < parameters.bodyAtrThreshold || bodyAtr > parameters.maxBreakoutBodyAtr) continue;

    const buyBreakDistance = close - structureHigh;
    const sellBreakDistance = structureLow - close;
    const minBreakDistance = atr * parameters.minBreakDistanceAtr;
    const direction = buyBreakDistance >= minBreakDistance
      ? 'BUY'
      : (sellBreakDistance >= minBreakDistance ? 'SELL' : null);
    if (!direction) continue;

    const barsSinceBreakout = Math.floor((currentEpoch - triggerCompleteEpoch) / (5 * 60 * 1000));

    return {
      direction,
      trigger,
      triggerEpoch,
      triggerCompleteEpoch,
      structureHigh,
      structureLow,
      structureLevel: direction === 'BUY' ? structureHigh : structureLow,
      atr,
      bodyAtr,
      breakDistanceAtr: (direction === 'BUY' ? buyBreakDistance : sellBreakDistance) / atr,
      barsSinceBreakout,
    };
  }
  return null;
}

function buildHigherRegime(higherCandles = [], parameters = {}) {
  const higherWindow = Array.isArray(higherCandles)
    ? higherCandles.slice(-Math.max(parameters.emaSlow + 10, parameters.atrPeriod * 3, 80))
    : [];
  const minBars = Math.max(parameters.emaSlow + 5, parameters.atrPeriod + 5);
  if (higherWindow.length < minBars) {
    return {
      htfRegime: 'UNKNOWN',
      htfBullish: false,
      htfBearish: false,
      htfTrendStrength: null,
      htfEmaFast: null,
      htfEmaSlow: null,
      htfAtr: null,
    };
  }
  const htfEmaFast = calculateEMAValue(higherWindow, parameters.emaFast);
  const htfEmaSlow = calculateEMAValue(higherWindow, parameters.emaSlow);
  const htfAtr = calculateATR(higherWindow, parameters.atrPeriod);
  const htfTrendStrength = Number.isFinite(htfEmaFast) && Number.isFinite(htfEmaSlow) && Number.isFinite(htfAtr) && htfAtr > 0
    ? Math.abs(htfEmaFast - htfEmaSlow) / htfAtr
    : null;
  const htfBullish = Number.isFinite(htfEmaFast) && Number.isFinite(htfEmaSlow) && htfEmaFast > htfEmaSlow;
  const htfBearish = Number.isFinite(htfEmaFast) && Number.isFinite(htfEmaSlow) && htfEmaFast < htfEmaSlow;
  return {
    htfRegime: htfBullish ? 'BULL_TREND' : htfBearish ? 'BEAR_TREND' : 'RANGE',
    htfBullish,
    htfBearish,
    htfTrendStrength,
    htfEmaFast,
    htfEmaSlow,
    htfAtr,
  };
}

function dailyKeyFromBar(bar = {}) {
  const epoch = getEpoch(bar);
  return epoch == null ? null : new Date(epoch).toISOString().slice(0, 10);
}

class OilBreakoutRetestBase extends BaseSymbolCustom {
  constructor(meta = {}) {
    super(meta);
    this.candidatePreset = meta.candidatePreset || 'oil_breakout_retest_v1';
    this.setupType = meta.setupType || 'oil_breakout_retest';
    this.runtimeScopes = new Set(
      Array.isArray(meta.runtimeScopes) && meta.runtimeScopes.length
        ? meta.runtimeScopes.map((scope) => String(scope || '').trim().toLowerCase()).filter(Boolean)
        : DEFAULT_RUNTIME_SCOPES
    );
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
      return { signal: 'NONE', status: 'BLOCKED', reason: LIVE_BLOCKED_REASON, reasonCode: 'SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED' };
    }
    if (!this.runtimeScopes.has(scope)) {
      return { signal: 'NONE', status: 'BLOCKED', reason: NON_BACKTEST_REASON };
    }

    const parameters = normalizeParameters({
      ...this.getDefaultParameters(),
      ...(context.parameters || {}),
    });
    const currentBar = context.currentBar || {};
    const setupCandles = Array.isArray(context.candles?.setup) ? context.candles.setup : [];
    const entryCandles = Array.isArray(context.candles?.entry) ? context.candles.entry : [];
    const higherCandles = Array.isArray(context.candles?.higher) ? context.candles.higher : [];
    const setupTimeframe = context.timeframes?.setupTimeframe || '1h';
    const entryTimeframe = context.timeframes?.entryTimeframe || '5m';
    const higherTimeframe = context.timeframes?.higherTimeframe || setupTimeframe;
    const evaluationCloseEpoch = getEvaluationCloseEpoch(currentBar, entryTimeframe);
    const setupLookback = Math.max(
      120,
      parameters.breakoutLookback + parameters.atrPeriod * 4 + parameters.retestMaxEntryBars + 20
    );
    const completedSetupCandles = filterCompletedCandlesAtEvaluation(
      setupCandles,
      evaluationCloseEpoch,
      setupTimeframe,
      setupLookback
    );
    const higherLookback = Math.max(parameters.emaSlow + 10, parameters.atrPeriod * 3, 80);
    const completedHigherCandles = filterCompletedCandlesAtEvaluation(
      higherCandles,
      evaluationCloseEpoch,
      higherTimeframe,
      higherLookback
    );

    if (entryCandles.length < 10 || completedSetupCandles.length < parameters.breakoutLookback + parameters.atrPeriod + 5) {
      return { signal: 'NONE', status: 'NO_SETUP', reason: 'Not enough candles for oil breakout retest analysis' };
    }

    const currentUtcHour = Number.isInteger(context.currentUtcHour) ? context.currentUtcHour : getUtcHour(currentBar);
    const allowedHours = parseUtcHours(parameters.allowedUtcHours);
    const blockedHours = parseUtcHours(parameters.blockedUtcHours);
    if (blockedHours.includes(currentUtcHour) || (allowedHours.length > 0 && !allowedHours.includes(currentUtcHour))) {
      return {
        signal: 'NONE',
        status: 'FILTERED',
        reason: 'Oil breakout retest filtered by UTC hour',
        metadata: { currentUtcHour, allowedUtcHours: parameters.allowedUtcHours, blockedUtcHours: parameters.blockedUtcHours },
      };
    }

    const lastClosedTrade = context.lastClosedTrade || null;
    const barsSinceLastExit = context.barsSinceLastExit;
    const anyExitCooldown = parameters.cooldownBarsAfterAnyExit;
    const slCooldown = parameters.cooldownBarsAfterSL;
    if (lastClosedTrade && barsSinceLastExit != null && barsSinceLastExit < anyExitCooldown) {
      return { signal: 'NONE', status: 'FILTERED', reason: 'Cooldown active after previous exit' };
    }
    if (
      lastClosedTrade
      && String(lastClosedTrade.exitReason || '').toUpperCase().includes('SL')
      && barsSinceLastExit != null
      && barsSinceLastExit < slCooldown
    ) {
      return { signal: 'NONE', status: 'FILTERED', reason: 'Cooldown active after SL' };
    }

    const todayClosedTrades = Array.isArray(context.todayClosedTrades) ? context.todayClosedTrades : [];
    const todayTrades = Array.isArray(context.todayTrades) ? context.todayTrades : [];
    const currentDay = dailyKeyFromBar(currentBar);
    const todayLosses = todayClosedTrades
      .filter((trade) => !currentDay || trade.entryDateUtc === currentDay || String(trade.entryTime || '').startsWith(currentDay))
      .filter((trade) => Number(trade.pnl) < 0).length;
    if (parameters.maxDailyLosses > 0 && todayLosses >= parameters.maxDailyLosses) {
      return { signal: 'NONE', status: 'FILTERED', reason: 'Max daily losses reached' };
    }
    if (parameters.maxDailyTrades > 0 && todayTrades.length >= parameters.maxDailyTrades) {
      return { signal: 'NONE', status: 'FILTERED', reason: 'Max daily trades reached' };
    }

    const breakout = findLatestBreakout(completedSetupCandles, entryCandles, currentBar, parameters, setupTimeframe);
    if (!breakout) {
      return { signal: 'NONE', status: 'NO_SETUP', reason: 'No recent oil breakout trigger waiting for retest' };
    }
    if (breakout.direction === 'BUY' && !parameters.enableBuy) {
      return { signal: 'NONE', status: 'FILTERED', reason: 'BUY disabled' };
    }
    if (breakout.direction === 'SELL' && !parameters.enableSell) {
      return { signal: 'NONE', status: 'FILTERED', reason: 'SELL disabled' };
    }

    const close = toNumber(currentBar.close, null);
    const open = toNumber(currentBar.open, null);
    const high = toNumber(currentBar.high, null);
    const low = toNumber(currentBar.low, null);
    if (![close, open, high, low].every(Number.isFinite)) {
      return { signal: 'NONE', status: 'NO_SETUP', reason: 'Current entry candle is missing prices' };
    }

    const previousEntry = entryCandles.length >= 2 ? entryCandles[entryCandles.length - 2] : null;
    const previousClose = toNumber(previousEntry?.close, close);
    const tolerance = breakout.atr * parameters.retestToleranceAtr;
    const maxDistance = breakout.atr * parameters.maxEntryDistanceAtr;
    const structureLevel = breakout.structureLevel;
    const distanceFromStructure = Math.abs(close - structureLevel);
    const regime = buildHigherRegime(completedHigherCandles, parameters);
    const htfAligned = breakout.direction === 'BUY' ? regime.htfBullish : regime.htfBearish;
    const htfStrongEnough = !Number.isFinite(regime.htfTrendStrength)
      || regime.htfTrendStrength >= parameters.minHigherTrendStrength;
    if (parameters.requireHigherTrendAlignment && (!htfAligned || !htfStrongEnough)) {
      return { signal: 'NONE', status: 'FILTERED', reason: 'Higher timeframe trend is not aligned with oil breakout retest' };
    }

    const retestOk = breakout.direction === 'BUY'
      ? low <= structureLevel + tolerance && close > structureLevel && distanceFromStructure <= maxDistance
      : high >= structureLevel - tolerance && close < structureLevel && distanceFromStructure <= maxDistance;
    const rejectionOk = !parameters.requireRetestRejection || (
      breakout.direction === 'BUY'
        ? close > open && close >= previousClose
        : close < open && close <= previousClose
    );
    if (!retestOk || !rejectionOk) {
      return {
        signal: 'NONE',
        status: 'NO_SETUP',
        reason: 'Oil breakout trigger found, waiting for valid retest rejection',
        metadata: {
          direction: breakout.direction,
          structureLevel,
          retestOk,
          rejectionOk,
          distanceFromStructure,
          tolerance,
        },
      };
    }

    const trendBonus = htfAligned ? 0.08 : 0;
    const breakScore = Math.min(0.12, breakout.breakDistanceAtr * 0.08);
    const bodyScore = Math.min(0.12, breakout.bodyAtr * 0.07);
    const retestScore = 0.12;
    const rejectionScore = rejectionOk ? 0.08 : 0;
    const hourScore = allowedHours.length > 0 ? 0.04 : 0;
    const confidence = round(clamp(0.38 + trendBonus + breakScore + bodyScore + retestScore + rejectionScore + hourScore, 0, 0.95), 4);
    if (confidence < parameters.minConfidence) {
      return {
        signal: 'NONE',
        status: 'FILTERED',
        reason: `Confidence below threshold: ${confidence} < ${parameters.minConfidence}`,
        confidence,
      };
    }

    const side = breakout.direction;
    const sl = side === 'BUY'
      ? close - breakout.atr * parameters.slAtrMultiplier
      : close + breakout.atr * parameters.slAtrMultiplier;
    const tp = side === 'BUY'
      ? close + breakout.atr * parameters.tpAtrMultiplier
      : close - breakout.atr * parameters.tpAtrMultiplier;

    const metadata = {
      source: 'symbolCustom',
      symbolCustomName: this.name,
      logicName: this.name,
      strategyType: 'SymbolCustom',
      setup: this.setupType,
      setupType: this.setupType,
      module: 'BREAKOUT_RETEST',
      candidatePreset: this.candidatePreset,
      scope,
      symbol: this.symbol,
      currentUtcHour,
      atr: breakout.atr,
      structureHigh: breakout.structureHigh,
      structureLow: breakout.structureLow,
      structureLevel,
      breakDistanceAtr: breakout.breakDistanceAtr,
      breakoutBodyAtr: breakout.bodyAtr,
      barsSinceBreakout: breakout.barsSinceBreakout,
      retestToleranceAtr: parameters.retestToleranceAtr,
      maxEntryDistanceAtr: parameters.maxEntryDistanceAtr,
      htfRegime: regime.htfRegime,
      htfBullish: regime.htfBullish,
      htfBearish: regime.htfBearish,
      htfTrendStrength: regime.htfTrendStrength,
      confidenceBreakdown: {
        base: 0.38,
        trendBonus,
        breakScore,
        bodyScore,
        retestScore,
        rejectionScore,
        hourScore,
      },
      parameters: cloneValue(parameters),
    };

    return {
      signal: side,
      status: 'TRIGGERED',
      confidence,
      marketQualityScore: Math.round(confidence * 100),
      marketQualityThreshold: Math.round(parameters.minConfidence * 100),
      sl,
      tp,
      reason: `${side} ${this.symbol} oil breakout retest | structure ${round(structureLevel, 2)} | breakATR ${round(breakout.breakDistanceAtr, 2)}`,
      metadata,
    };
  }
}

OilBreakoutRetestBase.DEFAULT_PARAMETER_SCHEMA = DEFAULT_PARAMETER_SCHEMA;
OilBreakoutRetestBase.LIVE_BLOCKED_REASON = LIVE_BLOCKED_REASON;
OilBreakoutRetestBase.NON_BACKTEST_REASON = NON_BACKTEST_REASON;
OilBreakoutRetestBase.calculateATR = calculateATR;
OilBreakoutRetestBase.calculatePriceRange = calculatePriceRange;
OilBreakoutRetestBase.normalizeParameters = normalizeParameters;

module.exports = OilBreakoutRetestBase;
