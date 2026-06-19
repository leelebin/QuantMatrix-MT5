const BaseSymbolCustom = require('../BaseSymbolCustom');
const indicatorService = require('../../services/indicatorService');
const volumeFeatures = require('../../services/volumeFeatureService');

const XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1 = 'XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1';
const XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1_VERSION = 3;
const CANDIDATE_PRESET = 'xau_breakout_ny_15_16_17_rvol28_both';
const BACKTEST_ONLY_REASON = 'XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1 is backtest-only while edge validation continues';
const LIVE_BLOCKED_REASON = 'XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1 live execution is blocked';

const DEFAULT_PARAMETER_SCHEMA = Object.freeze([
  { key: 'enableBreakout', label: 'Enable Breakout Module', type: 'boolean', defaultValue: true },
  { key: 'enableBuy', label: 'Enable BUY', type: 'boolean', defaultValue: true },
  { key: 'enableSell', label: 'Enable SELL', type: 'boolean', defaultValue: true },
  { key: 'allowedUtcHours', label: 'Allowed UTC Hours', type: 'string', defaultValue: '15,16,17' },
  { key: 'allowUnknownSession', label: 'Allow Unknown Session', type: 'boolean', defaultValue: false },
  { key: 'volumeAvgPeriod', label: 'Volume Average Period', type: 'number', defaultValue: 20, min: 10, max: 50, step: 5 },
  { key: 'breakoutLookback', label: 'Breakout Lookback Bars', type: 'number', defaultValue: 12, min: 8, max: 48, step: 2 },
  { key: 'rvolContinuation', label: 'RVOL Continuation', type: 'number', defaultValue: 2.8, min: 1.6, max: 3.5, step: 0.1 },
  { key: 'bodyAtrThreshold', label: 'Body ATR Threshold', type: 'number', defaultValue: 0.6, min: 0.3, max: 1.2, step: 0.1 },
  { key: 'atrPeriod', label: 'ATR Period', type: 'number', defaultValue: 14, min: 10, max: 30, step: 1 },
  { key: 'emaFast', label: 'Fast EMA', type: 'number', defaultValue: 20, min: 10, max: 40, step: 5 },
  { key: 'emaSlow', label: 'Slow EMA', type: 'number', defaultValue: 50, min: 30, max: 100, step: 10 },
  { key: 'deltaSmoothing', label: 'Delta Smoothing', type: 'number', defaultValue: 8, min: 2, max: 20, step: 1 },
  { key: 'requireDeltaSlope', label: 'Require Delta Slope', type: 'boolean', defaultValue: true },
  { key: 'vwapToleranceAtr', label: 'VWAP Tolerance ATR', type: 'number', defaultValue: 0.35, min: 0, max: 1, step: 0.05 },
  { key: 'slAtrMultiplier', label: 'SL ATR Multiplier', type: 'number', defaultValue: 2.0, min: 0.8, max: 3.5, step: 0.1 },
  { key: 'tpAtrMultiplier', label: 'TP ATR Multiplier', type: 'number', defaultValue: 5.0, min: 1, max: 8, step: 0.2 },
  { key: 'minConfidence', label: 'Minimum Confidence', type: 'number', defaultValue: 0.6, min: 0.4, max: 0.9, step: 0.01 },
  { key: 'useSpreadFilter', label: 'Use Spread Filter', type: 'boolean', defaultValue: true },
  { key: 'maxSpreadAtr', label: 'Max Spread ATR', type: 'number', defaultValue: 0.08, min: 0.01, max: 0.3, step: 0.01 },
  { key: 'rejectIfSpreadUnavailable', label: 'Reject If Spread Unavailable', type: 'boolean', defaultValue: false },
  { key: 'spreadPipSize', label: 'Spread Pip Size', type: 'number', defaultValue: 0.01, min: 0.00001, max: 1, step: 0.00001 },
  { key: 'maxTradesPerDay', label: 'Max Trades Per Day', type: 'number', defaultValue: 0, min: 0, max: 20, step: 1 },
  { key: 'maxConsecutiveLossesPerDay', label: 'Max Consecutive Losses Per Day', type: 'number', defaultValue: 0, min: 0, max: 10, step: 1 },
  { key: 'cooldownBarsAfterAnyExit', label: 'Cooldown Bars After Any Exit', type: 'number', defaultValue: 0, min: 0, max: 288, step: 1 },
  { key: 'cooldownBarsAfterSL', label: 'Cooldown Bars After SL', type: 'number', defaultValue: 0, min: 0, max: 288, step: 1 },
  { key: 'maxRollingConsecutiveLosses', label: 'Max Rolling Consecutive Losses', type: 'number', defaultValue: 0, min: 0, max: 20, step: 1 },
  { key: 'rollingLossCooldownBars', label: 'Rolling Loss Cooldown Bars', type: 'number', defaultValue: 0, min: 0, max: 2016, step: 1 },
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

function getUtcHour(candle = {}) {
  const time = getCandleTime(candle);
  const date = time ? new Date(time) : null;
  return date && Number.isFinite(date.getTime()) ? date.getUTCHours() : null;
}

function parseUtcHours(value) {
  if (value == null || String(value).trim() === '') return [];
  return String(value)
    .split(',')
    .map((item) => Number(String(item).trim()))
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
}

function calculateSMA(values = [], period = 14) {
  const safePeriod = Math.max(1, toInteger(period, 14));
  if (!Array.isArray(values) || values.length < safePeriod) return null;
  const slice = values.slice(-safePeriod).map((value) => toNumber(value, null));
  if (slice.some((value) => !Number.isFinite(value))) return null;
  return slice.reduce((sum, value) => sum + value, 0) / safePeriod;
}

function calculateATR(candles = [], period = 14) {
  const series = indicatorService.atr(candles, Math.max(1, toInteger(period, 14)));
  return Array.isArray(series) && series.length ? series[series.length - 1] : null;
}

function calculateEMA(candles = [], period = 20) {
  const closes = candles.map((candle) => Number(candle.close)).filter(Number.isFinite);
  const series = indicatorService.ema(closes, Math.max(1, toInteger(period, 20)));
  return Array.isArray(series) && series.length ? series[series.length - 1] : null;
}

function calculatePriceRange(candles = []) {
  if (!Array.isArray(candles) || candles.length === 0) return { high: null, low: null, range: null };
  const highs = candles.map((candle) => toNumber(candle.high, null)).filter(Number.isFinite);
  const lows = candles.map((candle) => toNumber(candle.low, null)).filter(Number.isFinite);
  if (!highs.length || !lows.length) return { high: null, low: null, range: null };
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  return { high, low, range: high - low };
}

function buildDefaultParameters() {
  return DEFAULT_PARAMETER_SCHEMA.reduce((params, field) => {
    params[field.key] = field.defaultValue;
    return params;
  }, {});
}

function mergeParameters(overrides = {}) {
  return {
    ...buildDefaultParameters(),
    ...(overrides || {}),
  };
}

function normalizeParameters(rawParameters = {}) {
  const merged = mergeParameters(rawParameters);
  return {
    ...merged,
    enableBreakout: toBoolean(merged.enableBreakout, true),
    enableBuy: toBoolean(merged.enableBuy, true),
    enableSell: toBoolean(merged.enableSell, true),
    allowUnknownSession: toBoolean(merged.allowUnknownSession, false),
    volumeAvgPeriod: Math.max(5, toInteger(merged.volumeAvgPeriod, 20)),
    breakoutLookback: Math.max(4, toInteger(merged.breakoutLookback, 12)),
    atrPeriod: Math.max(2, toInteger(merged.atrPeriod, 14)),
    emaFast: Math.max(2, toInteger(merged.emaFast, 20)),
    emaSlow: Math.max(3, toInteger(merged.emaSlow, 50)),
    deltaSmoothing: Math.max(2, toInteger(merged.deltaSmoothing, 8)),
    requireDeltaSlope: toBoolean(merged.requireDeltaSlope, true),
    useSpreadFilter: toBoolean(merged.useSpreadFilter, true),
    rejectIfSpreadUnavailable: toBoolean(merged.rejectIfSpreadUnavailable, false),
    rvolContinuation: toNumber(merged.rvolContinuation, 2.2),
    bodyAtrThreshold: toNumber(merged.bodyAtrThreshold, 0.6),
    vwapToleranceAtr: toNumber(merged.vwapToleranceAtr, 0.35),
    slAtrMultiplier: toNumber(merged.slAtrMultiplier, 1.2),
    tpAtrMultiplier: toNumber(merged.tpAtrMultiplier, 2.0),
    minConfidence: toNumber(merged.minConfidence, 0.6),
    maxSpreadAtr: toNumber(merged.maxSpreadAtr, 0.08),
    spreadPipSize: toNumber(merged.spreadPipSize, 0.01),
    maxTradesPerDay: Math.max(0, toInteger(merged.maxTradesPerDay, 0)),
    maxConsecutiveLossesPerDay: Math.max(0, toInteger(merged.maxConsecutiveLossesPerDay, 0)),
    cooldownBarsAfterAnyExit: Math.max(0, toInteger(merged.cooldownBarsAfterAnyExit, 0)),
    cooldownBarsAfterSL: Math.max(0, toInteger(merged.cooldownBarsAfterSL, 0)),
    maxRollingConsecutiveLosses: Math.max(0, toInteger(merged.maxRollingConsecutiveLosses, 0)),
    rollingLossCooldownBars: Math.max(0, toInteger(merged.rollingLossCooldownBars, 0)),
  };
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function tradeBelongsToStrategy(trade = {}, symbol, logicName, symbolCustomName) {
  if (symbol && normalizeSymbol(trade.symbol) && normalizeSymbol(trade.symbol) !== normalizeSymbol(symbol)) {
    return false;
  }

  const names = [
    trade.logicName,
    trade.symbolCustomName,
    trade.strategyName,
    trade.strategy,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  if (!names.length) return true;
  return names.includes(logicName) || names.includes(symbolCustomName) || names.includes(XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1);
}

function getScopedTrades(context = {}, fieldName) {
  const source = Array.isArray(context[fieldName]) ? context[fieldName] : [];
  return source.filter((trade) => tradeBelongsToStrategy(
    trade,
    context.symbol,
    context.logicName || XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1,
    context.symbolCustomName || XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1
  ));
}

function getConsecutiveLosses(trades = []) {
  let count = 0;
  for (let index = trades.length - 1; index >= 0; index -= 1) {
    const pnl = toNumber(trades[index].pnl ?? trades[index].profit ?? trades[index].profitLoss, 0);
    if (pnl < 0) count += 1;
    else break;
  }
  return count;
}

function checkTradeGuards(context = {}, parameters = {}) {
  const todayTrades = getScopedTrades(context, 'todayTrades');
  if (parameters.maxTradesPerDay > 0 && todayTrades.length >= parameters.maxTradesPerDay) {
    return {
      blocked: true,
      reasonCode: 'MAX_TRADES_PER_DAY_REACHED',
      reason: `XAUUSD Volume Flow maxTradesPerDay reached for ${context.symbol}`,
      debug: { todayTradeCount: todayTrades.length, maxTradesPerDay: parameters.maxTradesPerDay },
    };
  }

  const todayClosedTrades = getScopedTrades(context, 'todayClosedTrades');
  const todayConsecutiveLosses = getConsecutiveLosses(todayClosedTrades);
  if (parameters.maxConsecutiveLossesPerDay > 0 && todayConsecutiveLosses >= parameters.maxConsecutiveLossesPerDay) {
    return {
      blocked: true,
      reasonCode: 'CONSECUTIVE_LOSS_GUARD_ACTIVE',
      reason: `XAUUSD Volume Flow halted for ${context.symbol} today due to ${todayConsecutiveLosses} consecutive losses`,
      debug: { todayConsecutiveLosses, maxConsecutiveLossesPerDay: parameters.maxConsecutiveLossesPerDay },
    };
  }

  const barsSinceLastExit = toNumber(context.barsSinceLastExit, null);
  const lastClosedTrade = context.lastClosedTrade || null;
  const lastExitReason = String(lastClosedTrade?.exitReason || lastClosedTrade?.reason || '').toUpperCase();
  if (
    parameters.cooldownBarsAfterSL > 0
    && Number.isFinite(barsSinceLastExit)
    && barsSinceLastExit < parameters.cooldownBarsAfterSL
    && lastExitReason === 'SL'
  ) {
    return {
      blocked: true,
      reasonCode: 'SL_COOLDOWN_ACTIVE',
      reason: `XAUUSD Volume Flow SL cooldown active for ${context.symbol}`,
      debug: { barsSinceLastExit, cooldownBarsAfterSL: parameters.cooldownBarsAfterSL },
    };
  }

  if (
    parameters.cooldownBarsAfterAnyExit > 0
    && Number.isFinite(barsSinceLastExit)
    && barsSinceLastExit < parameters.cooldownBarsAfterAnyExit
  ) {
    return {
      blocked: true,
      reasonCode: 'COOLDOWN_ACTIVE',
      reason: `XAUUSD Volume Flow cooldown active for ${context.symbol}`,
      debug: { barsSinceLastExit, cooldownBarsAfterAnyExit: parameters.cooldownBarsAfterAnyExit },
    };
  }

  const closedTrades = getScopedTrades(context, 'closedTrades');
  const rollingConsecutiveLosses = getConsecutiveLosses(closedTrades);
  if (
    parameters.maxRollingConsecutiveLosses > 0
    && parameters.rollingLossCooldownBars > 0
    && rollingConsecutiveLosses >= parameters.maxRollingConsecutiveLosses
    && Number.isFinite(barsSinceLastExit)
    && barsSinceLastExit < parameters.rollingLossCooldownBars
  ) {
    return {
      blocked: true,
      reasonCode: 'ROLLING_CONSECUTIVE_LOSS_GUARD_ACTIVE',
      reason: `XAUUSD Volume Flow rolling loss cooldown active for ${context.symbol}`,
      debug: {
        rollingConsecutiveLosses,
        maxRollingConsecutiveLosses: parameters.maxRollingConsecutiveLosses,
        barsSinceLastExit,
        rollingLossCooldownBars: parameters.rollingLossCooldownBars,
      },
    };
  }

  return { blocked: false };
}

function classifySession(hour, parameters) {
  if (!Number.isInteger(hour)) return { sessionName: 'UNKNOWN', allowed: parameters.allowUnknownSession };
  if (hour >= 13 && hour < 22) return { sessionName: 'NEWYORK', allowed: true };
  return { sessionName: 'OUT_OF_SESSION', allowed: false };
}

function resolveSpreadInfo(candle = {}, parameters = {}) {
  const rawPriceSpread = candle.spreadPrice ?? candle.currentSpreadPrice;
  const rawPointSpread = candle.spread ?? candle.currentSpread;
  let spread = null;
  let source = null;

  if (rawPriceSpread !== undefined && rawPriceSpread !== null && rawPriceSpread !== '') {
    spread = toNumber(rawPriceSpread, null);
    source = 'price';
  } else if (rawPointSpread !== undefined && rawPointSpread !== null && rawPointSpread !== '') {
    const raw = toNumber(rawPointSpread, null);
    spread = Number.isFinite(raw) ? raw * parameters.spreadPipSize : null;
    source = 'pips';
  }

  if (!parameters.useSpreadFilter) {
    return { blocked: false, spread, spreadAtr: null, spreadSource: source, spreadUnavailable: spread == null };
  }

  if (!Number.isFinite(spread)) {
    return {
      blocked: parameters.rejectIfSpreadUnavailable,
      reason: parameters.rejectIfSpreadUnavailable ? 'Spread unavailable' : '',
      spread: null,
      spreadAtr: null,
      spreadSource: source,
      spreadUnavailable: true,
    };
  }

  return {
    blocked: false,
    spread,
    spreadAtr: null,
    spreadSource: source,
    spreadUnavailable: false,
  };
}

function buildConfidence({ rvol, bodyAtr, deltaOk, trendOk, vwapOk, spreadAtr, parameters }) {
  const breakdown = {
    base: 0.42,
    rvolScore: rvol >= 2.8 ? 0.16 : rvol >= 2.4 ? 0.13 : rvol >= 2.2 ? 0.10 : 0,
    bodyAtrScore: bodyAtr >= 1.0 ? 0.12 : bodyAtr >= 0.75 ? 0.08 : bodyAtr >= parameters.bodyAtrThreshold ? 0.05 : 0,
    deltaScore: deltaOk ? 0.08 : 0,
    trendScore: trendOk ? 0.08 : 0,
    vwapScore: vwapOk ? 0.04 : 0,
    spreadPenalty: Number.isFinite(spreadAtr) && spreadAtr > parameters.maxSpreadAtr * 0.8 ? 0.03 : 0,
  };
  const additive = breakdown.base
    + breakdown.rvolScore
    + breakdown.bodyAtrScore
    + breakdown.deltaScore
    + breakdown.trendScore
    + breakdown.vwapScore;
  const confidence = clamp(additive - breakdown.spreadPenalty, 0, 0.95);
  return {
    confidence: round(confidence, 4),
    breakdown,
  };
}

class XauusdVolumeFlowBreakoutNyV1 extends BaseSymbolCustom {
  constructor() {
    super({
      name: XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1,
      symbol: 'XAUUSD',
      description: 'XAUUSD New York high-RVOL volume-flow breakout candidate converted from VFH research.',
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
      return { signal: 'NONE', status: 'BLOCKED', reason: LIVE_BLOCKED_REASON, reasonCode: 'SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED' };
    }
    if (scope !== 'backtest') {
      return { signal: 'NONE', status: 'BLOCKED', reason: BACKTEST_ONLY_REASON };
    }

    const parameters = normalizeParameters(context.parameters || {});
    const symbol = String(context.symbol || this.symbol || '').toUpperCase();
    if (symbol && symbol !== 'XAUUSD') {
      return { signal: 'NONE', status: 'FILTERED', reason: 'XAUUSD volume-flow breakout logic only supports XAUUSD' };
    }
    if (!parameters.enableBreakout) {
      return { signal: 'NONE', status: 'FILTERED', reason: 'Breakout module disabled' };
    }

    const tradeGuard = checkTradeGuards(context, parameters);
    if (tradeGuard.blocked) {
      return {
        signal: 'NONE',
        status: 'FILTERED',
        reason: tradeGuard.reason,
        reasonCode: tradeGuard.reasonCode,
        metadata: {
          source: 'symbolCustom',
          symbolCustomName: XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1,
          logicName: XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1,
          strategyType: 'SymbolCustom',
          setupType: 'xauusd_volume_flow_breakout_ny',
          module: 'BREAKOUT_CONTINUATION',
          candidatePreset: CANDIDATE_PRESET,
          scope,
          hasSignal: false,
          debug: tradeGuard.debug || null,
        },
      };
    }

    const setupCandles = Array.isArray(context.candles?.setup) && context.candles.setup.length
      ? context.candles.setup
      : (Array.isArray(context.candles?.entry) ? context.candles.entry : []);
    const currentBar = context.currentBar || setupCandles[setupCandles.length - 1] || {};
    const minBars = Math.max(
      parameters.volumeAvgPeriod + parameters.breakoutLookback + 5,
      parameters.emaSlow + 5,
      parameters.atrPeriod + 5
    );
    if (!Array.isArray(setupCandles) || setupCandles.length < minBars) {
      return { signal: 'NONE', status: 'NO_SETUP', reason: 'Not enough candles for XAUUSD volume-flow breakout analysis' };
    }

    const hour = Number.isInteger(context.currentUtcHour) ? context.currentUtcHour : getUtcHour(currentBar);
    const allowedHours = parseUtcHours(parameters.allowedUtcHours);
    const sessionInfo = classifySession(hour, parameters);
    const hourAllowed = allowedHours.length === 0 || allowedHours.includes(hour);
    if (!sessionInfo.allowed || !hourAllowed) {
      return {
        signal: 'NONE',
        status: 'FILTERED',
        reason: 'XAUUSD volume-flow breakout filtered by UTC session',
        metadata: {
          sessionName: sessionInfo.sessionName,
          currentUtcHour: hour,
          allowedUtcHours: parameters.allowedUtcHours,
        },
      };
    }

    const latest = currentBar;
    const analysisWindow = Math.max(
      parameters.volumeAvgPeriod + parameters.breakoutLookback + 10,
      parameters.emaSlow + 10,
      parameters.atrPeriod + 10,
      120
    );
    const analysisCandles = setupCandles.slice(-analysisWindow);
    const previousCandles = analysisCandles.slice(0, -1);
    const structureWindow = previousCandles.slice(-parameters.breakoutLookback);
    const { high: structureHigh, low: structureLow } = calculatePriceRange(structureWindow);
    const atr = calculateATR(analysisCandles, parameters.atrPeriod);
    const fastEma = calculateEMA(analysisCandles, parameters.emaFast);
    const slowEma = calculateEMA(analysisCandles, parameters.emaSlow);
    if (!Number.isFinite(structureHigh) || !Number.isFinite(structureLow) || !Number.isFinite(atr) || atr <= 0) {
      return { signal: 'NONE', status: 'NO_SETUP', reason: 'XAUUSD volume-flow breakout missing structure or ATR' };
    }

    const features = volumeFeatures.computeLatestFeatures(analysisCandles, {
      volumeAvgPeriod: parameters.volumeAvgPeriod,
      deltaSmoothing: parameters.deltaSmoothing,
    });
    if (!features) {
      return { signal: 'NONE', status: 'NO_SETUP', reason: 'XAUUSD volume-flow breakout volume features unavailable' };
    }

    const close = toNumber(latest.close, null);
    const open = toNumber(latest.open, null);
    if (!Number.isFinite(close) || !Number.isFinite(open)) {
      return { signal: 'NONE', status: 'NO_SETUP', reason: 'XAUUSD volume-flow breakout missing candle prices' };
    }

    const bodyAtr = Math.abs(close - open) / atr;
    const rvol = toNumber(features.rvol, 0);
    const deltaSlope = toNumber(features.cumulativeDeltaSlope, 0);
    const deltaDelta = toNumber(features.cumulativeDeltaDelta, 0);
    const sessionVwap = toNumber(features.sessionVwap, null);
    const spreadInfo = resolveSpreadInfo(latest, parameters);
    const spreadAtr = Number.isFinite(spreadInfo.spread) ? spreadInfo.spread / atr : null;
    if (parameters.useSpreadFilter && Number.isFinite(spreadAtr) && spreadAtr > parameters.maxSpreadAtr) {
      return {
        signal: 'NONE',
        status: 'FILTERED',
        reason: 'Spread too high relative to ATR',
        metadata: { spread: spreadInfo.spread, spreadAtr, maxSpreadAtr: parameters.maxSpreadAtr },
      };
    }
    if (spreadInfo.blocked) {
      return { signal: 'NONE', status: 'FILTERED', reason: spreadInfo.reason || 'Spread unavailable' };
    }

    const bullishTrend = Number.isFinite(fastEma) && Number.isFinite(slowEma) && fastEma > slowEma;
    const bearishTrend = Number.isFinite(fastEma) && Number.isFinite(slowEma) && fastEma < slowEma;
    const buyBreakout = close > structureHigh;
    const sellBreakout = close < structureLow;
    const commonFilters = rvol >= parameters.rvolContinuation && bodyAtr >= parameters.bodyAtrThreshold;

    const buyDeltaOk = parameters.requireDeltaSlope ? deltaSlope > 0 : (deltaSlope > 0 || deltaDelta > 0);
    const sellDeltaOk = parameters.requireDeltaSlope ? deltaSlope < 0 : (deltaSlope < 0 || deltaDelta < 0);
    const buyVwapOk = Number.isFinite(sessionVwap) ? close >= sessionVwap - (parameters.vwapToleranceAtr * atr) : true;
    const sellVwapOk = Number.isFinite(sessionVwap) ? close <= sessionVwap + (parameters.vwapToleranceAtr * atr) : true;

    let side = null;
    let trendOk = false;
    let deltaOk = false;
    let vwapOk = false;
    if (parameters.enableBuy && buyBreakout && commonFilters && buyDeltaOk && bullishTrend && buyVwapOk) {
      side = 'BUY';
      trendOk = bullishTrend;
      deltaOk = buyDeltaOk;
      vwapOk = buyVwapOk;
    } else if (parameters.enableSell && sellBreakout && commonFilters && sellDeltaOk && bearishTrend && sellVwapOk) {
      side = 'SELL';
      trendOk = bearishTrend;
      deltaOk = sellDeltaOk;
      vwapOk = sellVwapOk;
    }

    const metadataBase = {
      source: 'symbolCustom',
      symbolCustomName: XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1,
      logicName: XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1,
      strategyType: 'SymbolCustom',
      setup: 'xauusd_volume_flow_breakout_ny',
      setupType: 'xauusd_volume_flow_breakout_ny',
      module: 'BREAKOUT_CONTINUATION',
      candidatePreset: CANDIDATE_PRESET,
      scope,
      currentUtcHour: hour,
      sessionName: sessionInfo.sessionName,
      atr,
      rvol,
      bodyAtr,
      structureHigh,
      structureLow,
      fastEma,
      slowEma,
      cumulativeDelta: features.cumulativeDelta,
      cumulativeDeltaDelta: deltaDelta,
      cumulativeDeltaSlope: deltaSlope,
      sessionVwap,
      spread: spreadInfo.spread,
      spreadAtr,
      spreadSource: spreadInfo.spreadSource,
      spreadUnavailable: spreadInfo.spreadUnavailable,
      parameters: cloneValue(parameters),
    };

    if (!side) {
      return {
        signal: 'NONE',
        status: 'NO_SETUP',
        reason: 'No XAUUSD New York breakout setup',
        metadata: metadataBase,
      };
    }

    const confidenceModel = buildConfidence({
      rvol,
      bodyAtr,
      deltaOk,
      trendOk,
      vwapOk,
      spreadAtr,
      parameters,
    });
    if (confidenceModel.confidence < parameters.minConfidence) {
      return {
        signal: 'NONE',
        status: 'FILTERED',
        reason: `Confidence below threshold: ${confidenceModel.confidence} < ${parameters.minConfidence}`,
        confidence: confidenceModel.confidence,
        metadata: { ...metadataBase, confidenceBreakdown: confidenceModel.breakdown },
      };
    }

    const sl = side === 'BUY'
      ? close - (atr * parameters.slAtrMultiplier)
      : close + (atr * parameters.slAtrMultiplier);
    const tp = side === 'BUY'
      ? close + (atr * parameters.tpAtrMultiplier)
      : close - (atr * parameters.tpAtrMultiplier);

    return {
      signal: side,
      status: 'TRIGGERED',
      confidence: confidenceModel.confidence,
      marketQualityScore: Math.round(confidenceModel.confidence * 100),
      marketQualityThreshold: Math.round(parameters.minConfidence * 100),
      sl,
      tp,
      reason: `${side} XAUUSD New York volume-flow breakout | RVOL ${round(rvol, 2)} | bodyATR ${round(bodyAtr, 2)}`,
      metadata: {
        ...metadataBase,
        confidence: confidenceModel.confidence,
        confidenceBreakdown: confidenceModel.breakdown,
        entryPrice: close,
        slAtrMultiplier: parameters.slAtrMultiplier,
        tpAtrMultiplier: parameters.tpAtrMultiplier,
      },
    };
  }
}

XauusdVolumeFlowBreakoutNyV1.XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1 = XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1;
XauusdVolumeFlowBreakoutNyV1.XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1_VERSION = XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1_VERSION;
XauusdVolumeFlowBreakoutNyV1.CANDIDATE_PRESET = CANDIDATE_PRESET;
XauusdVolumeFlowBreakoutNyV1.BACKTEST_ONLY_REASON = BACKTEST_ONLY_REASON;
XauusdVolumeFlowBreakoutNyV1.LIVE_BLOCKED_REASON = LIVE_BLOCKED_REASON;
XauusdVolumeFlowBreakoutNyV1.calculateATR = calculateATR;
XauusdVolumeFlowBreakoutNyV1.calculateSMA = calculateSMA;
XauusdVolumeFlowBreakoutNyV1.calculatePriceRange = calculatePriceRange;

module.exports = XauusdVolumeFlowBreakoutNyV1;
