const BaseSymbolCustom = require('../BaseSymbolCustom');

const XAUUSD_VOLUME_PROFILE_STRATEGY_V1 = 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1';
const XAUUSD_VOLUME_PROFILE_STRATEGY_V1_VERSION = 1;
const STRATEGY_NAME = 'XAUUSD Volume Profile';
const MODULE_BREAKOUT_CONTINUATION = 'BREAKOUT_CONTINUATION';
const MODULE_EXHAUSTION_REVERSAL = 'EXHAUSTION_REVERSAL';
const CANDIDATE_PRESET = 'xauusd_m1_m5_volume_profile_strategy_v1';
const LIVE_BLOCKED_REASON = 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1 live execution is blocked by default';
const DECISION_LOG_THROTTLE_MS = 60 * 1000;
const ALWAYS_LOG_REASON_CODES = new Set(['SIGNAL_TRIGGERED', 'MAX_HOLDING_TIME_EXIT']);
const decisionLogStateByKey = new Map();
const emaStateBySeries = new WeakMap();
const vwapStateBySeries = new WeakMap();

const DEFAULT_PARAMETER_SCHEMA = Object.freeze([
  { key: 'logicId', label: 'Logic ID', type: 'string', defaultValue: XAUUSD_VOLUME_PROFILE_STRATEGY_V1 },
  { key: 'strategyName', label: 'Strategy Name', type: 'string', defaultValue: STRATEGY_NAME },
  { key: 'mode', label: 'Mode', type: 'string', defaultValue: 'SYMBOLCUSTOM' },
  { key: 'source', label: 'Source', type: 'string', defaultValue: 'symbolCustom' },
  { key: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: true },
  { key: 'symbols', label: 'Symbols', type: 'json', defaultValue: ['XAUUSD'] },
  { key: 'setupTimeframe', label: 'Setup Timeframe', type: 'string', defaultValue: '5m' },
  { key: 'entryTimeframe', label: 'Entry Timeframe', type: 'string', defaultValue: '1m' },
  { key: 'higherTimeframe', label: 'Higher Timeframe', type: 'string', defaultValue: '15m' },
  { key: 'enableBreakoutContinuation', label: 'Enable Breakout Continuation', type: 'boolean', defaultValue: true },
  { key: 'enableExhaustionReversal', label: 'Enable Exhaustion Reversal', type: 'boolean', defaultValue: false },
  { key: 'allowBuySignals', label: 'Allow Buy Signals', type: 'boolean', defaultValue: true },
  { key: 'allowSellSignals', label: 'Allow Sell Signals', type: 'boolean', defaultValue: true },
  { key: 'conservativeConfirm', label: 'Conservative Reversal Confirm', type: 'boolean', defaultValue: true },
  { key: 'restrictEntrySessionUtc', label: 'Restrict Entry Session UTC', type: 'boolean', defaultValue: true },
  { key: 'entrySessionRangesUtc', label: 'Entry Session Ranges UTC', type: 'json', defaultValue: [[1, 5], [15, 18]] },
  { key: 'volumeAvgPeriod', label: 'Volume Average Period', type: 'number', defaultValue: 20, min: 5, max: 80, step: 1 },
  { key: 'rvolContinuation', label: 'RVOL Continuation', type: 'number', defaultValue: 1.6, min: 1, max: 5, step: 0.1 },
  { key: 'rvolReversal', label: 'RVOL Reversal', type: 'number', defaultValue: 2.2, min: 1, max: 6, step: 0.1 },
  { key: 'emaFast', label: 'Fast EMA', type: 'number', defaultValue: 20, min: 5, max: 80, step: 1 },
  { key: 'emaSlow', label: 'Slow EMA', type: 'number', defaultValue: 50, min: 10, max: 150, step: 1 },
  { key: 'minTrendEmaSeparationAtr', label: 'Minimum Trend EMA Separation ATR', type: 'number', defaultValue: 0, min: 0, max: 5, step: 0.05 },
  { key: 'atrPeriod', label: 'ATR Period', type: 'number', defaultValue: 14, min: 5, max: 50, step: 1 },
  { key: 'breakoutLookback', label: 'Breakout Lookback', type: 'number', defaultValue: 8, min: 4, max: 60, step: 1 },
  { key: 'bodyAtrThreshold', label: 'Body ATR Threshold', type: 'number', defaultValue: 0.45, min: 0.1, max: 2, step: 0.05 },
  { key: 'wickRatioThreshold', label: 'Wick Ratio Threshold', type: 'number', defaultValue: 1.8, min: 0.5, max: 5, step: 0.1 },
  { key: 'vwapToleranceAtr', label: 'VWAP Tolerance ATR', type: 'number', defaultValue: 0.25, min: 0, max: 1, step: 0.05 },
  { key: 'riskReward', label: 'Risk Reward', type: 'number', defaultValue: 1.5, min: 1, max: 4, step: 0.1 },
  { key: 'maxHoldingMinutes', label: 'Max Holding Minutes', type: 'number', defaultValue: 30, min: 5, max: 240, step: 5 },
  { key: 'slAtrBuffer', label: 'SL ATR Buffer', type: 'number', defaultValue: 0.2, min: 0, max: 2, step: 0.05 },
  { key: 'minStopAtr', label: 'Minimum Stop ATR', type: 'number', defaultValue: 0.35, min: 0.1, max: 2, step: 0.05 },
  { key: 'maxStopAtr', label: 'Maximum Stop ATR', type: 'number', defaultValue: 2.5, min: 0.5, max: 6, step: 0.1 },
  { key: 'maxSpreadPoints', label: 'Max Spread Points', type: 'number', defaultValue: 35, min: 1, max: 200, step: 1 },
  { key: 'spreadPointSize', label: 'Spread Point Size', type: 'number', defaultValue: 0.01, min: 0.00001, max: 1, step: 0.00001 },
  { key: 'rejectIfSpreadUnavailable', label: 'Reject If Spread Unavailable', type: 'boolean', defaultValue: false },
  { key: 'cooldownMinutes', label: 'Cooldown Minutes', type: 'number', defaultValue: 10, min: 0, max: 240, step: 1 },
  { key: 'maxTradesPerDay', label: 'Max Trades Per Day', type: 'number', defaultValue: 5, min: 0, max: 50, step: 1 },
  { key: 'maxConsecutiveLossesPerDay', label: 'Max Consecutive Losses Per Day', type: 'number', defaultValue: 2, min: 0, max: 20, step: 1 },
  { key: 'maxRollingConsecutiveLosses', label: 'Max Rolling Consecutive Losses', type: 'number', defaultValue: 0, min: 0, max: 20, step: 1 },
  { key: 'rollingLossCooldownMinutes', label: 'Rolling Loss Cooldown Minutes', type: 'number', defaultValue: 1440, min: 0, max: 10080, step: 60 },
  { key: 'minConfidence', label: 'Minimum Confidence', type: 'number', defaultValue: 65, min: 1, max: 100, step: 1 },
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

function parseSymbols(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean);
  }
  if (value == null || String(value).trim() === '') return ['XAUUSD'];
  return String(value)
    .split(',')
    .map((item) => String(item || '').trim().toUpperCase())
    .filter(Boolean);
}

function parseEntrySessionRangesUtc(value) {
  if (!Array.isArray(value)) return [[1, 5], [15, 18]];
  return value.reduce((ranges, range) => {
    if (!Array.isArray(range) || range.length < 2) return ranges;
    const rawStart = toInteger(range[0], -1);
    const rawEnd = toInteger(range[1], -1);
    if (rawStart < 0 || rawEnd < 0) return ranges;
    const start = Math.max(0, Math.min(23, rawStart));
    const end = Math.max(0, Math.min(24, rawEnd));
    if (start === end) return ranges;
    ranges.push([start, end]);
    return ranges;
  }, []);
}

function normalizeParameters(rawParameters = {}) {
  const merged = {
    ...buildDefaultParameters(),
    ...(rawParameters || {}),
  };

  return {
    ...merged,
    enabled: toBoolean(merged.enabled, true),
    strategyName: String(merged.strategyName || STRATEGY_NAME).trim() || STRATEGY_NAME,
    symbols: parseSymbols(merged.symbols),
    setupTimeframe: String(merged.setupTimeframe || '5m'),
    entryTimeframe: String(merged.entryTimeframe || '1m'),
    higherTimeframe: String(merged.higherTimeframe || '15m'),
    enableBreakoutContinuation: toBoolean(merged.enableBreakoutContinuation, true),
    enableExhaustionReversal: toBoolean(merged.enableExhaustionReversal, false),
    allowBuySignals: toBoolean(merged.allowBuySignals, true),
    allowSellSignals: toBoolean(merged.allowSellSignals, true),
    conservativeConfirm: toBoolean(merged.conservativeConfirm, true),
    restrictEntrySessionUtc: toBoolean(merged.restrictEntrySessionUtc, true),
    entrySessionRangesUtc: parseEntrySessionRangesUtc(merged.entrySessionRangesUtc),
    volumeAvgPeriod: Math.max(2, toInteger(merged.volumeAvgPeriod, 20)),
    rvolContinuation: Math.max(0, toNumber(merged.rvolContinuation, 1.6)),
    rvolReversal: Math.max(0, toNumber(merged.rvolReversal, 2.2)),
    emaFast: Math.max(2, toInteger(merged.emaFast, 20)),
    emaSlow: Math.max(3, toInteger(merged.emaSlow, 50)),
    minTrendEmaSeparationAtr: Math.max(0, toNumber(merged.minTrendEmaSeparationAtr, 0)),
    atrPeriod: Math.max(2, toInteger(merged.atrPeriod, 14)),
    breakoutLookback: Math.max(2, toInteger(merged.breakoutLookback, 8)),
    bodyAtrThreshold: Math.max(0, toNumber(merged.bodyAtrThreshold, 0.45)),
    wickRatioThreshold: Math.max(0, toNumber(merged.wickRatioThreshold, 1.8)),
    vwapToleranceAtr: Math.max(0, toNumber(merged.vwapToleranceAtr, 0.25)),
    riskReward: Math.max(0.1, toNumber(merged.riskReward, 1.5)),
    maxHoldingMinutes: Math.max(1, toInteger(merged.maxHoldingMinutes, 30)),
    slAtrBuffer: Math.max(0, toNumber(merged.slAtrBuffer, 0.2)),
    minStopAtr: Math.max(0.01, toNumber(merged.minStopAtr, 0.35)),
    maxStopAtr: Math.max(0.01, toNumber(merged.maxStopAtr, 2.5)),
    maxSpreadPoints: Math.max(0, toNumber(merged.maxSpreadPoints, 35)),
    spreadPointSize: Math.max(0.00001, toNumber(merged.spreadPointSize, 0.01)),
    rejectIfSpreadUnavailable: toBoolean(merged.rejectIfSpreadUnavailable, false),
    cooldownMinutes: Math.max(0, toInteger(merged.cooldownMinutes, 10)),
    maxTradesPerDay: Math.max(0, toInteger(merged.maxTradesPerDay, 5)),
    maxConsecutiveLossesPerDay: Math.max(0, toInteger(merged.maxConsecutiveLossesPerDay, 2)),
    maxRollingConsecutiveLosses: Math.max(0, toInteger(merged.maxRollingConsecutiveLosses, 0)),
    rollingLossCooldownMinutes: Math.max(0, toInteger(merged.rollingLossCooldownMinutes, 1440)),
    minConfidence: clamp(toNumber(merged.minConfidence, 65), 1, 100),
    debugSignal: toBoolean(merged.debugSignal, true),
  };
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function symbolMatchesConfigured(symbol, configuredSymbols = []) {
  const normalized = normalizeSymbol(symbol);
  return configuredSymbols.some((configured) => {
    const base = normalizeSymbol(configured);
    return normalized === base || (base === 'XAUUSD' && /^XAUUSD[A-Z0-9._-]*$/.test(normalized));
  });
}

function getCandleTime(candle = {}) {
  return candle.time || candle.timestamp || candle.date || null;
}

function toEpoch(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toUtcDateKey(value) {
  const epoch = toEpoch(value);
  return epoch == null ? null : new Date(epoch).toISOString().slice(0, 10);
}

function toUtcHour(value) {
  const epoch = toEpoch(value);
  return epoch == null ? null : new Date(epoch).getUTCHours();
}

function isUtcHourWithinRanges(hour, ranges = []) {
  if (!Number.isFinite(hour)) return false;
  return ranges.some(([start, end]) => (
    start < end
      ? hour >= start && hour < end
      : hour >= start || hour < end
  ));
}

function getClose(candle = {}) {
  return toNumber(candle.close, null);
}

function resolveVolume(candle = {}) {
  return Math.max(0, toNumber(candle.volume ?? candle.tickVolume ?? candle.tick_volume ?? candle.realVolume, 0));
}

function calculateEma(candles = [], period = 20) {
  const safePeriod = Math.max(1, toInteger(period, 20));
  const source = Array.isArray(candles) ? candles : [];
  let stateByPeriod = emaStateBySeries.get(source);
  if (!stateByPeriod) {
    stateByPeriod = new Map();
    emaStateBySeries.set(source, stateByPeriod);
  }

  let state = stateByPeriod.get(safePeriod);
  if (
    !state
    || state.processedLength > source.length
    || (state.processedLength > 0 && state.lastCandle !== source[state.processedLength - 1])
  ) {
    state = {
      processedLength: 0,
      lastCandle: null,
      seedCloses: [],
      ema: null,
    };
  }

  const multiplier = 2 / (safePeriod + 1);
  for (let index = state.processedLength; index < source.length; index += 1) {
    const close = getClose(source[index]);
    if (Number.isFinite(close)) {
      if (state.seedCloses.length < safePeriod) {
        state.seedCloses.push(close);
        if (state.seedCloses.length === safePeriod) {
          state.ema = state.seedCloses.reduce((sum, value) => sum + value, 0) / safePeriod;
        }
      } else {
        state.ema = ((close - state.ema) * multiplier) + state.ema;
      }
    }
    state.processedLength = index + 1;
    state.lastCandle = source[index];
  }

  stateByPeriod.set(safePeriod, state);
  return state.seedCloses.length >= safePeriod ? state.ema : null;
}

function calculateAtr(candles = [], period = 14) {
  const safePeriod = Math.max(1, toInteger(period, 14));
  const source = Array.isArray(candles) ? candles : [];
  if (source.length < safePeriod + 1) return null;
  const values = [];
  const start = Math.max(1, source.length - safePeriod);
  for (let index = start; index < source.length; index += 1) {
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

function calculateRvol(candles = [], volumeAvgPeriod = 20) {
  const source = Array.isArray(candles) ? candles : [];
  if (source.length < volumeAvgPeriod + 1) return null;
  const current = resolveVolume(source[source.length - 1]);
  const history = source.slice(-(volumeAvgPeriod + 1), -1).map(resolveVolume);
  const valid = history.filter((value) => Number.isFinite(value));
  if (valid.length < volumeAvgPeriod) return null;
  const average = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  if (!Number.isFinite(average) || average <= 0) return null;
  return current / average;
}

function calculateVwapFromCandles(candles = []) {
  const usable = Array.isArray(candles) ? candles : [];
  let weightedSum = 0;
  let volumeSum = 0;
  usable.forEach((candle) => {
    const high = toNumber(candle.high, null);
    const low = toNumber(candle.low, null);
    const close = getClose(candle);
    if (![high, low, close].every(Number.isFinite)) return;
    const volume = Math.max(1, resolveVolume(candle));
    const typical = (high + low + close) / 3;
    weightedSum += typical * volume;
    volumeSum += volume;
  });
  return volumeSum > 0 ? weightedSum / volumeSum : null;
}

function calculateVwap(candles = [], currentBar = {}) {
  const source = Array.isArray(candles) ? candles : [];
  if (!source.length) return null;

  const currentTime = getCandleTime(currentBar);
  const dateKey = toUtcDateKey(currentTime);
  const lastCandle = source[source.length - 1];
  const canUseIncrementalState = dateKey && getCandleTime(lastCandle) === currentTime;
  if (!canUseIncrementalState) {
    const intraday = dateKey
      ? source.filter((candle) => toUtcDateKey(getCandleTime(candle)) === dateKey)
      : source.slice(-120);
    return calculateVwapFromCandles(intraday.length >= 5 ? intraday : source.slice(-120));
  }

  let state = vwapStateBySeries.get(source);
  if (
    !state
    || state.processedLength > source.length
    || (state.processedLength > 0 && state.lastCandle !== source[state.processedLength - 1])
  ) {
    state = {
      processedLength: 0,
      lastCandle: null,
      dateKey: null,
      intradayCount: 0,
      weightedSum: 0,
      volumeSum: 0,
    };
  }

  for (let index = state.processedLength; index < source.length; index += 1) {
    const candle = source[index];
    const candleDateKey = toUtcDateKey(getCandleTime(candle));
    if (candleDateKey !== state.dateKey) {
      state.dateKey = candleDateKey;
      state.intradayCount = 0;
      state.weightedSum = 0;
      state.volumeSum = 0;
    }

    const high = toNumber(candle.high, null);
    const low = toNumber(candle.low, null);
    const close = getClose(candle);
    if ([high, low, close].every(Number.isFinite)) {
      const volume = Math.max(1, resolveVolume(candle));
      state.weightedSum += ((high + low + close) / 3) * volume;
      state.volumeSum += volume;
    }
    state.intradayCount += 1;
    state.processedLength = index + 1;
    state.lastCandle = candle;
  }

  vwapStateBySeries.set(source, state);
  if (state.dateKey === dateKey && state.intradayCount >= 5 && state.volumeSum > 0) {
    return state.weightedSum / state.volumeSum;
  }
  return calculateVwapFromCandles(source.slice(-120));
}

function calculatePriceRange(candles = []) {
  const source = Array.isArray(candles) ? candles : [];
  const highs = source.map((candle) => toNumber(candle.high, null)).filter(Number.isFinite);
  const lows = source.map((candle) => toNumber(candle.low, null)).filter(Number.isFinite);
  return {
    high: highs.length ? Math.max(...highs) : null,
    low: lows.length ? Math.min(...lows) : null,
  };
}

function calculateCandleStructure(candle = {}, atr = null) {
  const open = toNumber(candle.open, null);
  const high = toNumber(candle.high, null);
  const low = toNumber(candle.low, null);
  const close = getClose(candle);
  if (![open, high, low, close].every(Number.isFinite)) return null;
  const body = Math.abs(close - open);
  const upperWick = high - Math.max(open, close);
  const lowerWick = Math.min(open, close) - low;
  const range = Math.max(0, high - low);
  return {
    open,
    high,
    low,
    close,
    body,
    upperWick,
    lowerWick,
    range,
    bodyAtrRatio: Number.isFinite(atr) && atr > 0 ? body / atr : null,
    rangeAtrRatio: Number.isFinite(atr) && atr > 0 ? range / atr : null,
  };
}

function resolveSpreadInfo(currentBar = {}, parameters = {}, atr = null) {
  const rawPriceSpread = currentBar.spreadPrice ?? currentBar.currentSpreadPrice;
  const rawPointSpread = currentBar.spreadPoints ?? currentBar.currentSpreadPoints ?? currentBar.spread ?? currentBar.currentSpread;
  let spreadPrice = null;
  let spreadPoints = null;
  let spreadSource = null;

  if (rawPriceSpread !== undefined && rawPriceSpread !== null && rawPriceSpread !== '') {
    spreadPrice = toNumber(rawPriceSpread, null);
    spreadPoints = Number.isFinite(spreadPrice) && parameters.spreadPointSize > 0
      ? spreadPrice / parameters.spreadPointSize
      : null;
    spreadSource = 'price';
  } else if (rawPointSpread !== undefined && rawPointSpread !== null && rawPointSpread !== '') {
    spreadPoints = toNumber(rawPointSpread, null);
    spreadPrice = Number.isFinite(spreadPoints) ? spreadPoints * parameters.spreadPointSize : null;
    spreadSource = 'points';
  }

  const spreadUnavailable = !Number.isFinite(spreadPoints);
  if (spreadUnavailable) {
    return {
      passed: !parameters.rejectIfSpreadUnavailable,
      reasonCode: parameters.rejectIfSpreadUnavailable ? 'SPREAD_UNAVAILABLE' : null,
      spreadPrice,
      spreadPoints,
      spreadAtr: null,
      spreadSource,
      spreadUnavailable: true,
    };
  }

  const spreadAtr = Number.isFinite(spreadPrice) && Number.isFinite(atr) && atr > 0 ? spreadPrice / atr : null;
  if (parameters.maxSpreadPoints > 0 && spreadPoints > parameters.maxSpreadPoints) {
    return {
      passed: false,
      reasonCode: 'SPREAD_TOO_WIDE',
      spreadPrice,
      spreadPoints,
      spreadAtr,
      spreadSource,
      spreadUnavailable: false,
    };
  }

  return {
    passed: true,
    reasonCode: null,
    spreadPrice,
    spreadPoints,
    spreadAtr,
    spreadSource,
    spreadUnavailable: false,
  };
}

function logVolumeProfileDecision(reasonCode, message, details = {}) {
  const logKey = [
    reasonCode,
    details.symbol || '',
    details.side || '',
    details.moduleName || '',
  ].join(':');
  const now = Date.now();
  const previous = decisionLogStateByKey.get(logKey);
  if (
    !ALWAYS_LOG_REASON_CODES.has(reasonCode)
    && previous
    && now - previous.lastLoggedAt < DECISION_LOG_THROTTLE_MS
  ) {
    previous.suppressedCount += 1;
    return;
  }

  const suppressedCount = previous?.suppressedCount || 0;
  decisionLogStateByKey.set(logKey, { lastLoggedAt: now, suppressedCount: 0 });
  const loggedDetails = suppressedCount > 0
    ? { ...details, suppressedRepeatedDecisions: suppressedCount }
    : details;
  const suffix = Object.keys(loggedDetails).length ? ` ${JSON.stringify(loggedDetails)}` : '';
  console.log(`[SymbolCustom][${STRATEGY_NAME}] ${reasonCode}: ${message}${suffix}`);
}

function tradeBelongsToStrategy(trade = {}, symbol, logicName, symbolCustomName) {
  const tradeSymbol = normalizeSymbol(trade.symbol || symbol);
  if (tradeSymbol && symbol && tradeSymbol !== normalizeSymbol(symbol)) return false;
  const names = [
    trade.logicName,
    trade.symbolCustomName,
    trade.strategyName,
    trade.strategy,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  if (!names.length) return true;
  return names.includes(logicName) || names.includes(symbolCustomName) || names.includes(STRATEGY_NAME);
}

function getScopedTrades(context = {}, fieldName, parameters = {}) {
  const source = Array.isArray(context[fieldName]) ? context[fieldName] : [];
  return source.filter((trade) => tradeBelongsToStrategy(
    trade,
    context.symbol,
    context.logicName || XAUUSD_VOLUME_PROFILE_STRATEGY_V1,
    context.symbolCustomName || XAUUSD_VOLUME_PROFILE_STRATEGY_V1
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

function isSideAllowed(side, parameters = {}) {
  return side === 'BUY' ? parameters.allowBuySignals : parameters.allowSellSignals;
}

function getLastTradeEntryTime(context = {}, parameters = {}) {
  let lastEntryTime = null;
  let lastEntryEpoch = null;
  ['closedTrades', 'todayTrades'].forEach((fieldName) => {
    const source = Array.isArray(context[fieldName]) ? context[fieldName] : [];
    for (let index = source.length - 1; index >= 0; index -= 1) {
      const trade = source[index];
      if (!tradeBelongsToStrategy(
        trade,
        context.symbol,
        context.logicName || XAUUSD_VOLUME_PROFILE_STRATEGY_V1,
        context.symbolCustomName || XAUUSD_VOLUME_PROFILE_STRATEGY_V1
      )) {
        continue;
      }
      const candidate = trade.entryTime || trade.openTime || trade.timestamp;
      const candidateEpoch = toEpoch(candidate);
      if (candidateEpoch != null && (lastEntryEpoch == null || candidateEpoch > lastEntryEpoch)) {
        lastEntryEpoch = candidateEpoch;
        lastEntryTime = candidate;
      }
      break;
    }
  });
  return lastEntryTime;
}

function hasExternalOpenPositionForSymbol(context = {}) {
  const symbol = normalizeSymbol(context.symbol);
  const openPosition = context.openPosition;
  if (openPosition && normalizeSymbol(openPosition.symbol || context.symbol) === symbol) {
    return true;
  }
  const collections = [context.openPositions, context.positions, context.activePositions];
  return collections.some((collection) => Array.isArray(collection) && collection.some((position) => {
    const positionSymbol = normalizeSymbol(position.symbol || position.instrument);
    const status = String(position.status || position.state || 'OPEN').toUpperCase();
    return positionSymbol === symbol && !['CLOSED', 'CLOSE', 'EXITED'].includes(status);
  }));
}

function checkOpenPositionExit(context = {}, parameters = {}) {
  const openPosition = context.openPosition;
  if (!openPosition) return null;
  const currentEpoch = toEpoch(getCandleTime(context.currentBar || {}));
  const entryEpoch = toEpoch(openPosition.entryTime || openPosition.openTime);
  if (currentEpoch != null && entryEpoch != null) {
    const holdingMinutes = (currentEpoch - entryEpoch) / (60 * 1000);
    if (holdingMinutes >= parameters.maxHoldingMinutes) {
      return {
        signal: 'CLOSE',
        status: 'TRIGGERED',
        reason: 'MAX_HOLDING_TIME_EXIT',
        reasonCode: 'MAX_HOLDING_TIME_EXIT',
        strategyName: STRATEGY_NAME,
        moduleName: 'POSITION_MONITOR',
        metadata: {
          source: 'symbolCustom',
          symbolCustomName: XAUUSD_VOLUME_PROFILE_STRATEGY_V1,
          logicName: XAUUSD_VOLUME_PROFILE_STRATEGY_V1,
          strategyName: STRATEGY_NAME,
          moduleName: 'POSITION_MONITOR',
          exitRule: 'MAX_HOLDING_TIME_EXIT',
          holdingMinutes,
          maxHoldingMinutes: parameters.maxHoldingMinutes,
        },
      };
    }
  }

  return {
    signal: 'NONE',
    status: 'NO_SETUP',
    reason: 'Open XAUUSD Volume Profile position is managed by fixed SL/TP/time guard',
    reasonCode: 'OPEN_POSITION_MANAGED',
    metadata: {
      source: 'symbolCustom',
      symbolCustomName: XAUUSD_VOLUME_PROFILE_STRATEGY_V1,
      logicName: XAUUSD_VOLUME_PROFILE_STRATEGY_V1,
      strategyName: STRATEGY_NAME,
      moduleName: 'POSITION_MONITOR',
      hasSignal: false,
    },
  };
}

function checkTradeGuards(context = {}, parameters = {}) {
  const currentTime = getCandleTime(context.currentBar || {});
  const todayTrades = getScopedTrades(context, 'todayTrades', parameters);
  if (parameters.maxTradesPerDay > 0 && todayTrades.length >= parameters.maxTradesPerDay) {
    return {
      blocked: true,
      reasonCode: 'MAX_TRADES_PER_DAY_REACHED',
      reason: `XAUUSD Volume Profile maxTradesPerDay reached for ${context.symbol}`,
      debug: { todayTradeCount: todayTrades.length, maxTradesPerDay: parameters.maxTradesPerDay },
    };
  }

  const todayClosedTrades = getScopedTrades(context, 'todayClosedTrades', parameters);
  const consecutiveLosses = getConsecutiveLosses(todayClosedTrades);
  if (parameters.maxConsecutiveLossesPerDay > 0 && consecutiveLosses >= parameters.maxConsecutiveLossesPerDay) {
    return {
      blocked: true,
      reasonCode: 'CONSECUTIVE_LOSS_GUARD_ACTIVE',
      reason: `XAUUSD Volume Profile halted for ${context.symbol} today due to ${consecutiveLosses} consecutive losses`,
      debug: { consecutiveLosses, maxConsecutiveLossesPerDay: parameters.maxConsecutiveLossesPerDay },
    };
  }

  const closedTrades = getScopedTrades(context, 'closedTrades', parameters);
  const rollingConsecutiveLosses = getConsecutiveLosses(closedTrades);
  const lastClosedTrade = closedTrades.length ? closedTrades[closedTrades.length - 1] : null;
  const lastLossExitTime = lastClosedTrade?.exitTime || lastClosedTrade?.closeTime || lastClosedTrade?.timestamp || null;
  const currentEpoch = toEpoch(currentTime);
  const lastLossExitEpoch = toEpoch(lastLossExitTime);
  if (
    parameters.maxRollingConsecutiveLosses > 0
    && parameters.rollingLossCooldownMinutes > 0
    && rollingConsecutiveLosses >= parameters.maxRollingConsecutiveLosses
    && currentEpoch != null
    && lastLossExitEpoch != null
    && (currentEpoch - lastLossExitEpoch) / (60 * 1000) < parameters.rollingLossCooldownMinutes
  ) {
    const elapsedMinutes = (currentEpoch - lastLossExitEpoch) / (60 * 1000);
    return {
      blocked: true,
      reasonCode: 'ROLLING_CONSECUTIVE_LOSS_GUARD_ACTIVE',
      reason: `XAUUSD Volume Profile rolling loss cooldown active for ${context.symbol}`,
      debug: {
        rollingConsecutiveLosses,
        maxRollingConsecutiveLosses: parameters.maxRollingConsecutiveLosses,
        elapsedMinutes,
        rollingLossCooldownMinutes: parameters.rollingLossCooldownMinutes,
        lastLossExitTime,
      },
    };
  }

  const lastEntryTime = getLastTradeEntryTime(context, parameters);
  const lastEntryEpoch = toEpoch(lastEntryTime);
  if (
    parameters.cooldownMinutes > 0
    && currentEpoch != null
    && lastEntryEpoch != null
    && (currentEpoch - lastEntryEpoch) / (60 * 1000) < parameters.cooldownMinutes
  ) {
    const elapsedMinutes = (currentEpoch - lastEntryEpoch) / (60 * 1000);
    return {
      blocked: true,
      reasonCode: 'COOLDOWN_ACTIVE',
      reason: `XAUUSD Volume Profile cooldown active for ${context.symbol}`,
      debug: { elapsedMinutes, cooldownMinutes: parameters.cooldownMinutes, lastEntryTime },
    };
  }

  return {
    blocked: false,
    debug: {
      todayTradeCount: todayTrades.length,
      consecutiveLosses,
      rollingConsecutiveLosses,
      lastEntryTime,
    },
  };
}

function buildNoSignal({ reasonCode, reason, status = 'NO_SETUP', side = null, moduleName = null, indicators = {}, parameters = {} }) {
  const metadata = {
    source: 'symbolCustom',
    symbolCustomName: XAUUSD_VOLUME_PROFILE_STRATEGY_V1,
    logicName: XAUUSD_VOLUME_PROFILE_STRATEGY_V1,
    strategyName: STRATEGY_NAME,
    strategyType: 'SymbolCustom',
    setupType: 'volume_profile_strategy',
    moduleName,
    candidatePreset: CANDIDATE_PRESET,
    hasSignal: false,
    side,
    reasonCode,
    filterReason: reason,
    indicators: parameters.debugSignal === false ? undefined : indicators,
  };

  return {
    signal: 'NONE',
    hasSignal: false,
    status,
    reason,
    reasonCode,
    filterReason: reason,
    strategyName: STRATEGY_NAME,
    moduleName,
    indicators,
    metadata,
  };
}

function buildSignal({
  symbol,
  side,
  moduleName,
  entry,
  stopLoss,
  takeProfit,
  score,
  reason,
  indicators,
  parameters,
  context,
}) {
  const confidence = round(score / 100, 4);
  const metadata = {
    source: 'symbolCustom',
    symbolCustomName: XAUUSD_VOLUME_PROFILE_STRATEGY_V1,
    logicName: XAUUSD_VOLUME_PROFILE_STRATEGY_V1,
    strategyName: STRATEGY_NAME,
    strategyType: 'SymbolCustom',
    setupType: 'volume_profile_strategy',
    moduleName,
    module: moduleName,
    candidatePreset: CANDIDATE_PRESET,
    scope: context.scope || 'backtest',
    symbol,
    hasSignal: true,
    side,
    entry,
    entryPrice: entry,
    sl: stopLoss,
    tp: takeProfit,
    stopLoss,
    takeProfit,
    riskReward: parameters.riskReward,
    confidence,
    confidenceScore: score,
    score,
    timeframe: parameters.entryTimeframe,
    setupTimeframe: parameters.setupTimeframe,
    entryTimeframe: parameters.entryTimeframe,
    higherTimeframe: parameters.higherTimeframe,
    maxHoldingMinutes: parameters.maxHoldingMinutes,
    noBreakeven: true,
    indicators,
    parameterSnapshot: cloneValue(parameters),
  };

  return {
    signal: side,
    hasSignal: true,
    symbol,
    side,
    strategyName: STRATEGY_NAME,
    moduleName,
    timeframe: parameters.entryTimeframe,
    setupTimeframe: parameters.setupTimeframe,
    entryTimeframe: parameters.entryTimeframe,
    higherTimeframe: parameters.higherTimeframe,
    status: 'TRIGGERED',
    entry,
    sl: stopLoss,
    tp: takeProfit,
    stopLoss,
    takeProfit,
    riskReward: parameters.riskReward,
    confidence,
    rawConfidence: confidence,
    confidenceScore: score,
    score,
    marketQualityScore: score,
    marketQualityThreshold: parameters.minConfidence,
    reason,
    indicators,
    metadata,
  };
}

function buildIndicators({ entryCandles, setupCandles, currentBar, parameters }) {
  const setupWindow = setupCandles.slice(-Math.max(parameters.emaSlow + 30, 80));
  const entryWindow = entryCandles.slice(-Math.max(parameters.volumeAvgPeriod + parameters.breakoutLookback + 20, parameters.atrPeriod + 20, 100));
  const atr = calculateAtr(entryWindow, parameters.atrPeriod);
  const rvol = calculateRvol(entryWindow, parameters.volumeAvgPeriod);
  const emaFast = calculateEma(setupWindow, parameters.emaFast);
  const emaSlow = calculateEma(setupWindow, parameters.emaSlow);
  const setupAtr = calculateAtr(setupWindow, parameters.atrPeriod);
  const trendEmaSeparation = Number.isFinite(emaFast) && Number.isFinite(emaSlow)
    ? Math.abs(emaFast - emaSlow)
    : null;
  const trendEmaSeparationAtr = Number.isFinite(trendEmaSeparation) && Number.isFinite(setupAtr) && setupAtr > 0
    ? trendEmaSeparation / setupAtr
    : null;
  const vwap = calculateVwap(entryCandles, currentBar);
  const candle = calculateCandleStructure(currentBar, atr);
  const previousWindow = entryCandles.slice(-(parameters.breakoutLookback + 1), -1);
  const structure = calculatePriceRange(previousWindow);
  const spread = resolveSpreadInfo(currentBar, parameters, atr);

  return {
    atr,
    rvol,
    emaFast,
    emaSlow,
    setupAtr,
    trendEmaSeparationAtr,
    vwap,
    candle,
    structureHigh: structure.high,
    structureLow: structure.low,
    spread,
    breakoutLookback: parameters.breakoutLookback,
    bullishTrend: Number.isFinite(emaFast) && Number.isFinite(emaSlow) && emaFast > emaSlow,
    bearishTrend: Number.isFinite(emaFast) && Number.isFinite(emaSlow) && emaFast < emaSlow,
    trendStrengthPassed: parameters.minTrendEmaSeparationAtr <= 0
      || (Number.isFinite(trendEmaSeparationAtr) && trendEmaSeparationAtr >= parameters.minTrendEmaSeparationAtr),
  };
}

function snapshotIndicators(indicators = {}) {
  const candle = indicators.candle || {};
  return {
    rvol: round(indicators.rvol, 4),
    atr: round(indicators.atr, 4),
    emaFast: round(indicators.emaFast, 4),
    emaSlow: round(indicators.emaSlow, 4),
    setupAtr: round(indicators.setupAtr, 4),
    trendEmaSeparationAtr: round(indicators.trendEmaSeparationAtr, 4),
    vwap: round(indicators.vwap, 4),
    bodyAtrRatio: round(candle.bodyAtrRatio, 4),
    spreadPoints: round(indicators.spread?.spreadPoints, 4),
    spreadAtr: round(indicators.spread?.spreadAtr, 4),
    breakoutLookback: indicators.breakoutLookback,
    structureHigh: round(indicators.structureHigh, 4),
    structureLow: round(indicators.structureLow, 4),
    upperWick: round(candle.upperWick, 4),
    lowerWick: round(candle.lowerWick, 4),
  };
}

function calculateStop({ side, entry, previousWindow, atr, parameters }) {
  const range = calculatePriceRange(previousWindow);
  const minStop = atr * parameters.minStopAtr;
  const maxStop = atr * parameters.maxStopAtr;

  if (side === 'BUY') {
    if (!Number.isFinite(range.low)) return { valid: false, reasonCode: 'STRUCTURE_STOP_UNAVAILABLE' };
    const rawStopLoss = range.low - (atr * parameters.slAtrBuffer);
    const rawDistance = entry - rawStopLoss;
    const stopLoss = rawDistance < minStop ? entry - minStop : rawStopLoss;
    const stopDistance = entry - stopLoss;
    if (!Number.isFinite(stopDistance) || stopDistance <= 0) return { valid: false, reasonCode: 'STOP_DISTANCE_INVALID' };
    if (stopDistance > maxStop) {
      return { valid: false, reasonCode: 'STOP_DISTANCE_TOO_LARGE', stopDistance, maxStop };
    }
    return { valid: true, stopLoss, stopDistance, rawStopLoss, structurePrice: range.low, maxStop };
  }

  if (!Number.isFinite(range.high)) return { valid: false, reasonCode: 'STRUCTURE_STOP_UNAVAILABLE' };
  const rawStopLoss = range.high + (atr * parameters.slAtrBuffer);
  const rawDistance = rawStopLoss - entry;
  const stopLoss = rawDistance < minStop ? entry + minStop : rawStopLoss;
  const stopDistance = stopLoss - entry;
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) return { valid: false, reasonCode: 'STOP_DISTANCE_INVALID' };
  if (stopDistance > maxStop) {
    return { valid: false, reasonCode: 'STOP_DISTANCE_TOO_LARGE', stopDistance, maxStop };
  }
  return { valid: true, stopLoss, stopDistance, rawStopLoss, structurePrice: range.high, maxStop };
}

function calculateContinuationScore({ side, indicators, stopDistance, parameters }) {
  const candle = indicators.candle || {};
  const atr = indicators.atr;
  let score = 50;
  const breakdown = { base: 50 };

  breakdown.trend = side === 'BUY' ? (indicators.bullishTrend ? 10 : 0) : (indicators.bearishTrend ? 10 : 0);
  score += breakdown.trend;
  breakdown.rvol = indicators.rvol >= parameters.rvolContinuation ? 10 : 0;
  score += breakdown.rvol;
  breakdown.rvolExpansion = indicators.rvol >= parameters.rvolContinuation * 1.3 ? 5 : 0;
  score += breakdown.rvolExpansion;
  breakdown.body = candle.bodyAtrRatio >= parameters.bodyAtrThreshold ? 10 : 0;
  score += breakdown.body;
  const vwapSide = side === 'BUY'
    ? candle.close >= indicators.vwap
    : candle.close <= indicators.vwap;
  breakdown.vwap = vwapSide ? 10 : 0;
  score += breakdown.vwap;
  const breakoutDistanceAtr = side === 'BUY'
    ? (candle.close - indicators.structureHigh) / atr
    : (indicators.structureLow - candle.close) / atr;
  breakdown.breakoutDistance = breakoutDistanceAtr >= 0.03 && breakoutDistanceAtr <= 1.2 ? 5 : 0;
  score += breakdown.breakoutDistance;

  const spreadPoints = indicators.spread?.spreadPoints;
  breakdown.spreadPenalty = Number.isFinite(spreadPoints)
    && parameters.maxSpreadPoints > 0
    && spreadPoints >= parameters.maxSpreadPoints * 0.8
    ? -10
    : 0;
  score += breakdown.spreadPenalty;

  const wick = side === 'BUY' ? candle.upperWick : candle.lowerWick;
  breakdown.wickPenalty = candle.body > 0 && wick > candle.body * parameters.wickRatioThreshold * 0.75 ? -10 : 0;
  score += breakdown.wickPenalty;
  breakdown.stopPenalty = stopDistance > atr * parameters.maxStopAtr * 0.8 ? -5 : 0;
  score += breakdown.stopPenalty;
  breakdown.extremeCandlePenalty = candle.rangeAtrRatio > 2.8 || candle.bodyAtrRatio > 1.8 ? -10 : 0;
  score += breakdown.extremeCandlePenalty;

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    breakdown,
    breakoutDistanceAtr,
  };
}

function rejectSetup({ reasonCode, reason, side, moduleName, indicators, parameters }) {
  logVolumeProfileDecision(reasonCode, reason, {
    side,
    moduleName,
    indicators: snapshotIndicators(indicators),
  });
  return buildNoSignal({
    reasonCode,
    reason,
    status: 'FILTERED',
    side,
    moduleName,
    indicators: snapshotIndicators(indicators),
    parameters,
  });
}

function evaluateBreakoutSide({ side, symbol, entryCandles, currentBar, indicators, parameters, context }) {
  const candle = indicators.candle;
  if (!candle) {
    return buildNoSignal({
      reasonCode: 'CANDLE_STRUCTURE_UNAVAILABLE',
      reason: 'XAUUSD Volume Profile candle structure unavailable',
      side,
      moduleName: MODULE_BREAKOUT_CONTINUATION,
      parameters,
    });
  }
  if (!Number.isFinite(indicators.rvol) || indicators.rvol < parameters.rvolContinuation) {
    return rejectSetup({
      reasonCode: 'RVOL_TOO_LOW',
      reason: `XAUUSD Volume Profile ${side} breakout rejected: RVOL below threshold`,
      side,
      moduleName: MODULE_BREAKOUT_CONTINUATION,
      indicators,
      parameters,
    });
  }
  if (!Number.isFinite(candle.bodyAtrRatio) || candle.bodyAtrRatio < parameters.bodyAtrThreshold) {
    return rejectSetup({
      reasonCode: 'BODY_ATR_TOO_LOW',
      reason: `XAUUSD Volume Profile ${side} breakout rejected: body ATR ratio below threshold`,
      side,
      moduleName: MODULE_BREAKOUT_CONTINUATION,
      indicators,
      parameters,
    });
  }
  const vwapOk = side === 'BUY'
    ? candle.close >= indicators.vwap - indicators.atr * parameters.vwapToleranceAtr
    : candle.close <= indicators.vwap + indicators.atr * parameters.vwapToleranceAtr;
  if (Number.isFinite(indicators.vwap) && !vwapOk) {
    return rejectSetup({
      reasonCode: 'VWAP_FILTERED',
      reason: `XAUUSD Volume Profile ${side} breakout rejected: price is not on VWAP continuation side`,
      side,
      moduleName: MODULE_BREAKOUT_CONTINUATION,
      indicators,
      parameters,
    });
  }
  if (side === 'BUY' && candle.body > 0 && candle.upperWick > candle.body * parameters.wickRatioThreshold) {
    return rejectSetup({
      reasonCode: 'FAKE_BREAKOUT_WICK_FILTERED',
      reason: 'XAUUSD Volume Profile BUY breakout rejected: upper wick suggests failed breakout',
      side,
      moduleName: MODULE_BREAKOUT_CONTINUATION,
      indicators,
      parameters,
    });
  }
  if (side === 'SELL' && candle.body > 0 && candle.lowerWick > candle.body * parameters.wickRatioThreshold) {
    return rejectSetup({
      reasonCode: 'FAKE_BREAKOUT_WICK_FILTERED',
      reason: 'XAUUSD Volume Profile SELL breakout rejected: lower wick suggests failed breakout',
      side,
      moduleName: MODULE_BREAKOUT_CONTINUATION,
      indicators,
      parameters,
    });
  }

  const previousWindow = entryCandles.slice(-(parameters.breakoutLookback + 1), -1);
  const stop = calculateStop({
    side,
    entry: candle.close,
    previousWindow,
    atr: indicators.atr,
    parameters,
  });
  if (!stop.valid) {
    const reason = stop.reasonCode === 'STOP_DISTANCE_TOO_LARGE'
      ? `XAUUSD Volume Profile ${side} breakout rejected: stopDistance too large`
      : `XAUUSD Volume Profile ${side} breakout rejected: invalid structure stop`;
    return rejectSetup({
      reasonCode: stop.reasonCode,
      reason,
      side,
      moduleName: MODULE_BREAKOUT_CONTINUATION,
      indicators: {
        ...indicators,
        stopDistance: stop.stopDistance,
        maxStop: stop.maxStop,
      },
      parameters,
    });
  }

  const scoreModel = calculateContinuationScore({
    side,
    indicators,
    stopDistance: stop.stopDistance,
    parameters,
  });
  if (scoreModel.score < parameters.minConfidence) {
    return rejectSetup({
      reasonCode: 'CONFIDENCE_TOO_LOW',
      reason: `XAUUSD Volume Profile ${side} breakout rejected: confidence ${scoreModel.score} < ${parameters.minConfidence}`,
      side,
      moduleName: MODULE_BREAKOUT_CONTINUATION,
      indicators: {
        ...indicators,
        confidenceScore: scoreModel.score,
        scoreBreakdown: scoreModel.breakdown,
      },
      parameters,
    });
  }

  const takeProfit = side === 'BUY'
    ? candle.close + stop.stopDistance * parameters.riskReward
    : candle.close - stop.stopDistance * parameters.riskReward;
  const vwapText = side === 'BUY' ? 'close above VWAP' : 'close below VWAP';
  const reason = `${MODULE_BREAKOUT_CONTINUATION} ${side}: M5 EMA${parameters.emaFast} `
    + `${side === 'BUY' ? '>' : '<'} EMA${parameters.emaSlow}, M1 close broke `
    + `${parameters.breakoutLookback}-bar ${side === 'BUY' ? 'high' : 'low'}, `
    + `RVOL=${round(indicators.rvol, 2)}, body=${round(candle.bodyAtrRatio, 2)}ATR, `
    + `${vwapText}, RR=${parameters.riskReward}`;

  const snapshot = {
    ...snapshotIndicators(indicators),
    breakoutDistanceAtr: round(scoreModel.breakoutDistanceAtr, 4),
    stopDistance: round(stop.stopDistance, 4),
    structureStop: round(stop.structurePrice, 4),
    confidenceScore: scoreModel.score,
    scoreBreakdown: scoreModel.breakdown,
  };
  logVolumeProfileDecision('SIGNAL_TRIGGERED', reason, { symbol, side, score: scoreModel.score, moduleName: MODULE_BREAKOUT_CONTINUATION });
  return buildSignal({
    symbol,
    side,
    moduleName: MODULE_BREAKOUT_CONTINUATION,
    entry: candle.close,
    stopLoss: stop.stopLoss,
    takeProfit,
    score: scoreModel.score,
    reason,
    indicators: snapshot,
    parameters,
    context,
  });
}

function checkBreakoutContinuation({ symbol, entryCandles, currentBar, indicators, parameters, context }) {
  if (!parameters.enableBreakoutContinuation) {
    return buildNoSignal({
      reasonCode: 'BREAKOUT_CONTINUATION_DISABLED',
      reason: 'XAUUSD Volume Profile breakout continuation module disabled',
      status: 'FILTERED',
      moduleName: MODULE_BREAKOUT_CONTINUATION,
      parameters,
    });
  }
  const candle = indicators.candle;
  if (!candle || ![indicators.atr, indicators.structureHigh, indicators.structureLow].every(Number.isFinite)) {
    return buildNoSignal({
      reasonCode: 'INDICATORS_UNAVAILABLE',
      reason: 'XAUUSD Volume Profile breakout indicators unavailable',
      moduleName: MODULE_BREAKOUT_CONTINUATION,
      indicators: snapshotIndicators(indicators),
      parameters,
    });
  }

  const breakoutHigh = candle.close > indicators.structureHigh;
  const breakoutLow = candle.close < indicators.structureLow;
  if (indicators.bullishTrend && breakoutHigh) {
    if (!parameters.allowBuySignals) {
      logVolumeProfileDecision('DIRECTION_FILTERED', 'XAUUSD Volume Profile BUY signals are disabled', {
        symbol,
        side: 'BUY',
        moduleName: MODULE_BREAKOUT_CONTINUATION,
      });
      return buildNoSignal({
        reasonCode: 'DIRECTION_FILTERED',
        reason: 'XAUUSD Volume Profile BUY signals are disabled',
        status: 'FILTERED',
        side: 'BUY',
        moduleName: MODULE_BREAKOUT_CONTINUATION,
        indicators: snapshotIndicators(indicators),
        parameters,
      });
    }
    if (!indicators.trendStrengthPassed) {
      logVolumeProfileDecision('RANGE_FILTERED', 'XAUUSD Volume Profile BUY breakout rejected by EMA separation filter', {
        symbol,
        side: 'BUY',
        moduleName: MODULE_BREAKOUT_CONTINUATION,
        trendEmaSeparationAtr: round(indicators.trendEmaSeparationAtr, 4),
        minTrendEmaSeparationAtr: parameters.minTrendEmaSeparationAtr,
      });
      return buildNoSignal({
        reasonCode: 'RANGE_FILTERED',
        reason: 'XAUUSD Volume Profile BUY breakout rejected: EMA separation is below trend threshold',
        status: 'FILTERED',
        side: 'BUY',
        moduleName: MODULE_BREAKOUT_CONTINUATION,
        indicators: snapshotIndicators(indicators),
        parameters,
      });
    }
    return evaluateBreakoutSide({
      side: 'BUY',
      symbol,
      entryCandles,
      currentBar,
      indicators,
      parameters,
      context,
    });
  }
  if (indicators.bearishTrend && breakoutLow) {
    if (!parameters.allowSellSignals) {
      logVolumeProfileDecision('DIRECTION_FILTERED', 'XAUUSD Volume Profile SELL signals are disabled', {
        symbol,
        side: 'SELL',
        moduleName: MODULE_BREAKOUT_CONTINUATION,
      });
      return buildNoSignal({
        reasonCode: 'DIRECTION_FILTERED',
        reason: 'XAUUSD Volume Profile SELL signals are disabled',
        status: 'FILTERED',
        side: 'SELL',
        moduleName: MODULE_BREAKOUT_CONTINUATION,
        indicators: snapshotIndicators(indicators),
        parameters,
      });
    }
    if (!indicators.trendStrengthPassed) {
      logVolumeProfileDecision('RANGE_FILTERED', 'XAUUSD Volume Profile SELL breakout rejected by EMA separation filter', {
        symbol,
        side: 'SELL',
        moduleName: MODULE_BREAKOUT_CONTINUATION,
        trendEmaSeparationAtr: round(indicators.trendEmaSeparationAtr, 4),
        minTrendEmaSeparationAtr: parameters.minTrendEmaSeparationAtr,
      });
      return buildNoSignal({
        reasonCode: 'RANGE_FILTERED',
        reason: 'XAUUSD Volume Profile SELL breakout rejected: EMA separation is below trend threshold',
        status: 'FILTERED',
        side: 'SELL',
        moduleName: MODULE_BREAKOUT_CONTINUATION,
        indicators: snapshotIndicators(indicators),
        parameters,
      });
    }
    return evaluateBreakoutSide({
      side: 'SELL',
      symbol,
      entryCandles,
      currentBar,
      indicators,
      parameters,
      context,
    });
  }

  return buildNoSignal({
    reasonCode: 'NO_BREAKOUT_CONTINUATION_SETUP',
    reason: 'No XAUUSD Volume Profile breakout continuation setup',
    moduleName: MODULE_BREAKOUT_CONTINUATION,
    indicators: snapshotIndicators(indicators),
    parameters,
  });
}

function calculateReversalScore({ side, indicators, parameters }) {
  const candle = indicators.candle || {};
  let score = 50;
  score += indicators.rvol >= parameters.rvolReversal ? 15 : 0;
  score += side === 'BUY' ? (candle.lowerWick >= Math.max(candle.body, indicators.atr * 0.05) * parameters.wickRatioThreshold ? 15 : 0)
    : (candle.upperWick >= Math.max(candle.body, indicators.atr * 0.05) * parameters.wickRatioThreshold ? 15 : 0);
  score += 10;
  score += side === 'BUY'
    ? (candle.close >= indicators.vwap - indicators.atr * parameters.vwapToleranceAtr ? 10 : 0)
    : (candle.close <= indicators.vwap + indicators.atr * parameters.vwapToleranceAtr ? 10 : 0);
  return Math.max(0, Math.min(100, Math.round(score)));
}

function checkExhaustionReversal({ symbol, entryCandles, indicators, parameters, context }) {
  if (!parameters.enableExhaustionReversal) {
    return buildNoSignal({
      reasonCode: 'EXHAUSTION_REVERSAL_DISABLED',
      reason: 'XAUUSD Volume Profile exhaustion reversal module disabled',
      status: 'FILTERED',
      moduleName: MODULE_EXHAUSTION_REVERSAL,
      parameters,
    });
  }

  const sourceIndex = parameters.conservativeConfirm ? entryCandles.length - 2 : entryCandles.length - 1;
  const sourceCandle = entryCandles[sourceIndex];
  const confirmCandle = entryCandles[entryCandles.length - 1];
  const previousWindow = entryCandles.slice(Math.max(0, sourceIndex - parameters.breakoutLookback), sourceIndex);
  if (!sourceCandle || previousWindow.length < parameters.breakoutLookback) {
    return buildNoSignal({
      reasonCode: 'NOT_ENOUGH_REVERSAL_CANDLES',
      reason: 'Not enough candles for XAUUSD Volume Profile exhaustion reversal',
      moduleName: MODULE_EXHAUSTION_REVERSAL,
      parameters,
    });
  }

  const sourceIndicators = {
    ...indicators,
    candle: calculateCandleStructure(sourceCandle, indicators.atr),
    ...calculatePriceRange(previousWindow),
  };
  sourceIndicators.structureHigh = calculatePriceRange(previousWindow).high;
  sourceIndicators.structureLow = calculatePriceRange(previousWindow).low;
  const candle = sourceIndicators.candle;
  if (!candle || !Number.isFinite(sourceIndicators.rvol) || sourceIndicators.rvol < parameters.rvolReversal) {
    return buildNoSignal({
      reasonCode: 'NO_EXHAUSTION_REVERSAL_SETUP',
      reason: 'No XAUUSD Volume Profile exhaustion reversal setup',
      moduleName: MODULE_EXHAUSTION_REVERSAL,
      indicators: snapshotIndicators(sourceIndicators),
      parameters,
    });
  }

  const minBody = Math.max(candle.body, indicators.atr * 0.05);
  const longSweep = candle.low < sourceIndicators.structureLow
    && candle.close > sourceIndicators.structureLow
    && candle.lowerWick >= minBody * parameters.wickRatioThreshold
    && !(candle.close < candle.open && candle.bodyAtrRatio >= parameters.bodyAtrThreshold)
    && confirmCandle.low >= candle.low
    && getClose(confirmCandle) >= indicators.vwap - indicators.atr * parameters.vwapToleranceAtr;
  const shortSweep = candle.high > sourceIndicators.structureHigh
    && candle.close < sourceIndicators.structureHigh
    && candle.upperWick >= minBody * parameters.wickRatioThreshold
    && !(candle.close > candle.open && candle.bodyAtrRatio >= parameters.bodyAtrThreshold)
    && confirmCandle.high <= candle.high
    && getClose(confirmCandle) <= indicators.vwap + indicators.atr * parameters.vwapToleranceAtr;

  const side = longSweep ? 'BUY' : (shortSweep ? 'SELL' : null);
  if (!side) {
    return buildNoSignal({
      reasonCode: 'NO_EXHAUSTION_REVERSAL_SETUP',
      reason: 'No XAUUSD Volume Profile exhaustion reversal setup',
      moduleName: MODULE_EXHAUSTION_REVERSAL,
      indicators: snapshotIndicators(sourceIndicators),
      parameters,
    });
  }
  if (!isSideAllowed(side, parameters)) {
    logVolumeProfileDecision('DIRECTION_FILTERED', `XAUUSD Volume Profile ${side} signals are disabled`, {
      symbol,
      side,
      moduleName: MODULE_EXHAUSTION_REVERSAL,
    });
    return buildNoSignal({
      reasonCode: 'DIRECTION_FILTERED',
      reason: `XAUUSD Volume Profile ${side} signals are disabled`,
      status: 'FILTERED',
      side,
      moduleName: MODULE_EXHAUSTION_REVERSAL,
      indicators: snapshotIndicators(sourceIndicators),
      parameters,
    });
  }

  const entry = getClose(confirmCandle);
  const stopLoss = side === 'BUY'
    ? candle.low - indicators.atr * parameters.slAtrBuffer
    : candle.high + indicators.atr * parameters.slAtrBuffer;
  const stopDistance = side === 'BUY' ? entry - stopLoss : stopLoss - entry;
  if (!Number.isFinite(stopDistance) || stopDistance <= 0 || stopDistance > indicators.atr * parameters.maxStopAtr) {
    return rejectSetup({
      reasonCode: 'STOP_DISTANCE_TOO_LARGE',
      reason: `XAUUSD Volume Profile ${side} reversal rejected: stopDistance too large`,
      side,
      moduleName: MODULE_EXHAUSTION_REVERSAL,
      indicators: sourceIndicators,
      parameters,
    });
  }

  const score = calculateReversalScore({ side, indicators: sourceIndicators, parameters });
  if (score < parameters.minConfidence) {
    return rejectSetup({
      reasonCode: 'CONFIDENCE_TOO_LOW',
      reason: `XAUUSD Volume Profile ${side} reversal rejected: confidence ${score} < ${parameters.minConfidence}`,
      side,
      moduleName: MODULE_EXHAUSTION_REVERSAL,
      indicators: sourceIndicators,
      parameters,
    });
  }

  const takeProfit = side === 'BUY'
    ? entry + stopDistance * parameters.riskReward
    : entry - stopDistance * parameters.riskReward;
  const reason = `${MODULE_EXHAUSTION_REVERSAL} ${side}: M1 sweep reclaimed structure with RVOL=${round(sourceIndicators.rvol, 2)}, RR=${parameters.riskReward}`;
  const snapshot = {
    ...snapshotIndicators(sourceIndicators),
    stopDistance: round(stopDistance, 4),
    confidenceScore: score,
  };
  logVolumeProfileDecision('SIGNAL_TRIGGERED', reason, { symbol, side, score, moduleName: MODULE_EXHAUSTION_REVERSAL });
  return buildSignal({
    symbol,
    side,
    moduleName: MODULE_EXHAUSTION_REVERSAL,
    entry,
    stopLoss,
    takeProfit,
    score,
    reason,
    indicators: snapshot,
    parameters,
    context,
  });
}

class XauusdVolumeProfileStrategyV1 extends BaseSymbolCustom {
  constructor() {
    super({
      name: XAUUSD_VOLUME_PROFILE_STRATEGY_V1,
      symbol: 'XAUUSD',
      description: 'XAUUSD M1/M5 SymbolCustom volume-confirmed price-action strategy named XAUUSD Volume Profile.',
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
        strategyName: STRATEGY_NAME,
      };
    }
    if (!['backtest', 'paper'].includes(scope)) {
      return buildNoSignal({
        reasonCode: 'SCOPE_NOT_SUPPORTED',
        reason: 'XAUUSD Volume Profile SymbolCustom supports backtest and paper scopes only',
        status: 'BLOCKED',
        parameters: { debugSignal: true },
      });
    }

    const parameters = normalizeParameters(context.parameters || {});
    if (!parameters.enabled) {
      return buildNoSignal({
        reasonCode: 'STRATEGY_DISABLED',
        reason: 'XAUUSD Volume Profile parameter enabled=false',
        status: 'FILTERED',
        parameters,
      });
    }

    const symbol = normalizeSymbol(context.symbol || this.symbol);
    if (!symbolMatchesConfigured(symbol, parameters.symbols)) {
      return buildNoSignal({
        reasonCode: 'SYMBOL_NOT_CONFIGURED',
        reason: `XAUUSD Volume Profile is not configured for ${symbol || 'UNKNOWN'}`,
        status: 'FILTERED',
        parameters,
      });
    }

    const entryCandles = Array.isArray(context.candles?.entry) ? context.candles.entry : [];
    const setupCandles = Array.isArray(context.candles?.setup) && context.candles.setup.length ? context.candles.setup : entryCandles;
    const currentBar = context.currentBar || entryCandles[entryCandles.length - 1] || {};

    const openPositionExit = checkOpenPositionExit({ ...context, currentBar }, parameters);
    if (openPositionExit) {
      if (openPositionExit.signal === 'CLOSE') {
        logVolumeProfileDecision('MAX_HOLDING_TIME_EXIT', 'XAUUSD Volume Profile position exceeded maxHoldingMinutes', {
          symbol,
          maxHoldingMinutes: parameters.maxHoldingMinutes,
          holdingMinutes: round(openPositionExit.metadata?.holdingMinutes, 2),
        });
      }
      return openPositionExit;
    }

    if (hasExternalOpenPositionForSymbol({ ...context, currentBar })) {
      logVolumeProfileDecision('OPEN_POSITION_EXISTS', 'XAUUSD Volume Profile skipped because an open position exists for symbol', { symbol });
      return buildNoSignal({
        reasonCode: 'OPEN_POSITION_EXISTS',
        reason: 'XAUUSD Volume Profile avoids duplicate open positions on the same symbol',
        status: 'FILTERED',
        parameters,
      });
    }

    const guard = checkTradeGuards({ ...context, currentBar }, parameters);
    if (guard.blocked) {
      logVolumeProfileDecision(guard.reasonCode, guard.reason, { symbol, ...guard.debug });
      return buildNoSignal({
        reasonCode: guard.reasonCode,
        reason: guard.reason,
        status: 'FILTERED',
        indicators: guard.debug,
        parameters,
      });
    }

    const currentUtcHour = Number.isFinite(context.currentUtcHour)
      ? context.currentUtcHour
      : toUtcHour(getCandleTime(currentBar));
    if (
      parameters.restrictEntrySessionUtc
      && !isUtcHourWithinRanges(currentUtcHour, parameters.entrySessionRangesUtc)
    ) {
      logVolumeProfileDecision('ENTRY_SESSION_FILTERED', 'XAUUSD Volume Profile skipped outside configured UTC entry sessions', {
        symbol,
        currentUtcHour,
        entrySessionRangesUtc: parameters.entrySessionRangesUtc,
      });
      return buildNoSignal({
        reasonCode: 'ENTRY_SESSION_FILTERED',
        reason: 'XAUUSD Volume Profile entry skipped outside configured UTC sessions',
        status: 'FILTERED',
        indicators: { currentUtcHour, entrySessionRangesUtc: parameters.entrySessionRangesUtc },
        parameters,
      });
    }

    const minEntryBars = Math.max(parameters.volumeAvgPeriod + 1, parameters.atrPeriod + 1, parameters.breakoutLookback + 2);
    const minSetupBars = Math.max(parameters.emaFast + 2, parameters.emaSlow + 2);
    if (entryCandles.length < minEntryBars || setupCandles.length < minSetupBars) {
      return buildNoSignal({
        reasonCode: 'NOT_ENOUGH_CANDLES',
        reason: 'Not enough M1/M5 candles for XAUUSD Volume Profile analysis',
        status: 'NO_SETUP',
        indicators: { entryCandles: entryCandles.length, setupCandles: setupCandles.length, minEntryBars, minSetupBars },
        parameters,
      });
    }

    const indicators = buildIndicators({ entryCandles, setupCandles, currentBar, parameters });
    if (![indicators.atr, indicators.emaFast, indicators.emaSlow].every(Number.isFinite) || indicators.atr <= 0) {
      return buildNoSignal({
        reasonCode: 'INDICATORS_UNAVAILABLE',
        reason: 'XAUUSD Volume Profile indicators unavailable',
        status: 'NO_SETUP',
        indicators: snapshotIndicators(indicators),
        parameters,
      });
    }

    if (!indicators.spread.passed) {
      logVolumeProfileDecision(indicators.spread.reasonCode || 'SPREAD_TOO_WIDE', 'XAUUSD Volume Profile rejected by spread filter', {
        symbol,
        spreadPoints: round(indicators.spread.spreadPoints, 2),
        maxSpreadPoints: parameters.maxSpreadPoints,
      });
      return buildNoSignal({
        reasonCode: indicators.spread.reasonCode || 'SPREAD_TOO_WIDE',
        reason: 'XAUUSD Volume Profile spread filter rejected the setup',
        status: 'FILTERED',
        indicators: snapshotIndicators(indicators),
        parameters,
      });
    }

    if (parameters.enableExhaustionReversal) {
      const reversalSignal = checkExhaustionReversal({ symbol, entryCandles, indicators, parameters, context });
      if (reversalSignal.signal === 'BUY' || reversalSignal.signal === 'SELL') return reversalSignal;
    }

    if (parameters.enableBreakoutContinuation) {
      const breakoutSignal = checkBreakoutContinuation({
        symbol,
        entryCandles,
        currentBar,
        indicators,
        parameters,
        context,
      });
      if (breakoutSignal.signal === 'BUY' || breakoutSignal.signal === 'SELL') return breakoutSignal;
      return breakoutSignal;
    }

    return buildNoSignal({
      reasonCode: 'MODULES_DISABLED',
      reason: 'XAUUSD Volume Profile modules are disabled',
      status: 'FILTERED',
      indicators: snapshotIndicators(indicators),
      parameters,
    });
  }
}

XauusdVolumeProfileStrategyV1.XAUUSD_VOLUME_PROFILE_STRATEGY_V1 = XAUUSD_VOLUME_PROFILE_STRATEGY_V1;
XauusdVolumeProfileStrategyV1.XAUUSD_VOLUME_PROFILE_STRATEGY_V1_VERSION = XAUUSD_VOLUME_PROFILE_STRATEGY_V1_VERSION;
XauusdVolumeProfileStrategyV1.STRATEGY_NAME = STRATEGY_NAME;
XauusdVolumeProfileStrategyV1.MODULE_BREAKOUT_CONTINUATION = MODULE_BREAKOUT_CONTINUATION;
XauusdVolumeProfileStrategyV1.MODULE_EXHAUSTION_REVERSAL = MODULE_EXHAUSTION_REVERSAL;
XauusdVolumeProfileStrategyV1.CANDIDATE_PRESET = CANDIDATE_PRESET;
XauusdVolumeProfileStrategyV1.LIVE_BLOCKED_REASON = LIVE_BLOCKED_REASON;
XauusdVolumeProfileStrategyV1.DEFAULT_PARAMETER_SCHEMA = DEFAULT_PARAMETER_SCHEMA;
XauusdVolumeProfileStrategyV1.normalizeParameters = normalizeParameters;
XauusdVolumeProfileStrategyV1.calculateAtr = calculateAtr;
XauusdVolumeProfileStrategyV1.calculateEma = calculateEma;
XauusdVolumeProfileStrategyV1.calculateRvol = calculateRvol;
XauusdVolumeProfileStrategyV1.calculateVwap = calculateVwap;
XauusdVolumeProfileStrategyV1.calculatePriceRange = calculatePriceRange;

module.exports = XauusdVolumeProfileStrategyV1;
