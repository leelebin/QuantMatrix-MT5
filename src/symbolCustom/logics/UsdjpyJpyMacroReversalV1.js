const BaseSymbolCustom = require('../BaseSymbolCustom');

const USDJPY_JPY_MACRO_REVERSAL_V1 = 'USDJPY_JPY_MACRO_REVERSAL_V1';
const USDJPY_JPY_MACRO_REVERSAL_V1_VERSION = 3;
const BACKTEST_ONLY_REASON = 'USDJPY_JPY_MACRO_REVERSAL_V1 is backtest-only in Phase 2D';

const DEFAULT_PARAMETER_SCHEMA = Object.freeze([
  { key: 'lookbackBars', label: 'Lookback Bars', type: 'number', defaultValue: 36, min: 24, max: 72, step: 6 },
  { key: 'impulseAtrMultiplier', label: 'Impulse ATR Multiplier', type: 'number', defaultValue: 1.8, min: 1.2, max: 2.8, step: 0.2 },
  { key: 'reversalConfirmBars', label: 'Reversal Confirm Bars', type: 'number', defaultValue: 2, min: 1, max: 4, step: 1 },
  { key: 'rsiPeriod', label: 'RSI Period', type: 'number', defaultValue: 14, min: 8, max: 21, step: 1 },
  { key: 'rsiOverbought', label: 'RSI Overbought', type: 'number', defaultValue: 68, min: 62, max: 78, step: 2 },
  { key: 'rsiOversold', label: 'RSI Oversold', type: 'number', defaultValue: 32, min: 22, max: 38, step: 2 },
  { key: 'atrPeriod', label: 'ATR Period', type: 'number', defaultValue: 14, min: 10, max: 24, step: 1 },
  { key: 'slAtrMultiplier', label: 'SL ATR Multiplier', type: 'number', defaultValue: 1.2, min: 0.8, max: 2, step: 0.1 },
  { key: 'tpAtrMultiplier', label: 'TP ATR Multiplier', type: 'number', defaultValue: 1.8, min: 1, max: 3, step: 0.2 },
  { key: 'maxBarsInTrade', label: 'Max Bars In Trade', type: 'number', defaultValue: 18, min: 6, max: 36, step: 3 },
  { key: 'minAtr', label: 'Minimum ATR', type: 'number', defaultValue: 0, min: 0, max: 1, step: 0.01 },
  { key: 'cooldownBars', label: 'Cooldown Bars', type: 'number', defaultValue: 6, min: 0, max: 24, step: 3 },
  { key: 'enableBuy', label: 'Enable BUY', type: 'boolean', defaultValue: true },
  { key: 'enableSell', label: 'Enable SELL', type: 'boolean', defaultValue: true },
  { key: 'allowedUtcHours', label: 'Allowed UTC Hours', type: 'string', defaultValue: '' },
  { key: 'blockedUtcHours', label: 'Blocked UTC Hours', type: 'string', defaultValue: '' },
  { key: 'cooldownBarsAfterAnyExit', label: 'Cooldown Bars After Any Exit', type: 'number', defaultValue: 0, min: 0, max: 48, step: 3 },
  { key: 'cooldownBarsAfterSL', label: 'Cooldown Bars After SL', type: 'number', defaultValue: 0, min: 0, max: 96, step: 3 },
  { key: 'maxDailyLosses', label: 'Max Daily Losses', type: 'number', defaultValue: 0, min: 0, max: 10, step: 1 },
  { key: 'maxDailyTrades', label: 'Max Daily Trades', type: 'number', defaultValue: 0, min: 0, max: 50, step: 1 },
]);

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function toNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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

function getCandleTime(candle = {}) {
  return candle.time || candle.timestamp || candle.date || null;
}

function parseUtcHours(value) {
  if (value == null || String(value).trim() === '') return [];
  return String(value)
    .split(',')
    .map((item) => Number(String(item).trim()))
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
}

function getUtcHourFromContext(context = {}, currentBar = {}) {
  const explicit = Number(context.currentUtcHour);
  if (Number.isInteger(explicit) && explicit >= 0 && explicit <= 23) return explicit;
  const time = getCandleTime(currentBar);
  const date = time ? new Date(time) : null;
  return date && Number.isFinite(date.getTime()) ? date.getUTCHours() : null;
}

function calculateSMA(candles = [], period = 14) {
  const safePeriod = Math.max(1, Math.floor(toNumber(period, 14)));
  if (!Array.isArray(candles) || candles.length < safePeriod) return null;

  const slice = candles.slice(-safePeriod);
  const closes = slice.map(getClose);
  if (closes.some((value) => !Number.isFinite(value))) return null;

  return closes.reduce((sum, value) => sum + value, 0) / closes.length;
}

function calculateATR(candles = [], period = 14) {
  const safePeriod = Math.max(1, Math.floor(toNumber(period, 14)));
  if (!Array.isArray(candles) || candles.length < safePeriod + 1) return null;

  const ranges = [];
  const startIndex = candles.length - safePeriod;
  for (let index = startIndex; index < candles.length; index += 1) {
    const candle = candles[index] || {};
    const previous = candles[index - 1] || {};
    const high = toNumber(candle.high, null);
    const low = toNumber(candle.low, null);
    const previousClose = getClose(previous);
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(previousClose)) {
      return null;
    }

    ranges.push(Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose)
    ));
  }

  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

function calculateRSI(candles = [], period = 14) {
  const safePeriod = Math.max(1, Math.floor(toNumber(period, 14)));
  if (!Array.isArray(candles) || candles.length < safePeriod + 1) return null;

  let gains = 0;
  let losses = 0;
  const startIndex = candles.length - safePeriod;
  for (let index = startIndex; index < candles.length; index += 1) {
    const currentClose = getClose(candles[index]);
    const previousClose = getClose(candles[index - 1]);
    if (!Number.isFinite(currentClose) || !Number.isFinite(previousClose)) return null;

    const change = currentClose - previousClose;
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  const averageGain = gains / safePeriod;
  const averageLoss = losses / safePeriod;
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  const rs = averageGain / averageLoss;
  return 100 - (100 / (1 + rs));
}

function calculatePriceRange(candles = []) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { high: null, low: null, range: null };
  }

  const highs = candles.map((candle) => toNumber(candle.high, null)).filter(Number.isFinite);
  const lows = candles.map((candle) => toNumber(candle.low, null)).filter(Number.isFinite);
  if (!highs.length || !lows.length) {
    return { high: null, low: null, range: null };
  }

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

function hasBullishRejection(candle = {}) {
  const open = toNumber(candle.open, null);
  const close = toNumber(candle.close, null);
  const low = toNumber(candle.low, null);
  const range = getRange(candle);
  if (!Number.isFinite(open) || !Number.isFinite(close) || !Number.isFinite(low) || !range) return false;
  return close > open && close >= low + (range * 0.5);
}

function hasBearishRejection(candle = {}) {
  const open = toNumber(candle.open, null);
  const close = toNumber(candle.close, null);
  const low = toNumber(candle.low, null);
  const range = getRange(candle);
  if (!Number.isFinite(open) || !Number.isFinite(close) || !Number.isFinite(low) || !range) return false;
  return close < open && close <= low + (range * 0.5);
}

function countBarsInTrade(entryCandles = [], openPosition = {}, currentIndex = 0) {
  const entryTime = openPosition.entryTime ? Date.parse(openPosition.entryTime) : null;
  if (Number.isFinite(entryTime)) {
    const entryIndex = entryCandles.findIndex((candle) => {
      const time = Date.parse(getCandleTime(candle));
      return Number.isFinite(time) && time >= entryTime;
    });
    if (entryIndex >= 0) return Math.max(0, entryCandles.length - 1 - entryIndex);
  }

  const explicitEntryIndex = toNumber(openPosition.entryIndex, null);
  if (Number.isFinite(explicitEntryIndex)) {
    return Math.max(0, currentIndex - explicitEntryIndex);
  }

  return 0;
}

function shouldBlockByGuardrails({ parameters, context, currentBar }) {
  const currentUtcHour = getUtcHourFromContext(context, currentBar);
  const allowedHours = parseUtcHours(parameters.allowedUtcHours);
  const blockedHours = parseUtcHours(parameters.blockedUtcHours);

  if (currentUtcHour !== null && allowedHours.length > 0 && !allowedHours.includes(currentUtcHour)) {
    return 'UTC hour not in allowedUtcHours';
  }
  if (currentUtcHour !== null && blockedHours.includes(currentUtcHour)) {
    return 'UTC hour blocked by blockedUtcHours';
  }

  const barsSinceLastExit = toNumber(context.barsSinceLastExit, null);
  const lastClosedTrade = context.lastClosedTrade || null;
  if (
    Number.isFinite(barsSinceLastExit)
    && parameters.cooldownBarsAfterAnyExit > 0
    && barsSinceLastExit <= parameters.cooldownBarsAfterAnyExit
  ) {
    return 'Cooldown after any exit active';
  }
  if (
    lastClosedTrade
    && lastClosedTrade.exitReason === 'SL'
    && Number.isFinite(barsSinceLastExit)
    && parameters.cooldownBarsAfterSL > 0
    && barsSinceLastExit <= parameters.cooldownBarsAfterSL
  ) {
    return 'Cooldown after SL active';
  }

  const todayClosedTrades = Array.isArray(context.todayClosedTrades) ? context.todayClosedTrades : [];
  const todayTrades = Array.isArray(context.todayTrades) ? context.todayTrades : [];
  const dailyLosses = todayClosedTrades.filter((trade) => toNumber(trade.pnl, 0) < 0).length;
  if (parameters.maxDailyLosses > 0 && dailyLosses >= parameters.maxDailyLosses) {
    return 'Max daily losses reached';
  }
  if (parameters.maxDailyTrades > 0 && todayTrades.length >= parameters.maxDailyTrades) {
    return 'Max daily trades reached';
  }

  return null;
}

class UsdjpyJpyMacroReversalV1 extends BaseSymbolCustom {
  constructor(meta = {}) {
    super({
      ...meta,
      name: USDJPY_JPY_MACRO_REVERSAL_V1,
      symbol: meta.symbol || 'USDJPY',
      description: meta.description || 'USDJPY M15/M5 macro reversal prototype',
    });
  }

  getDefaultParameterSchema() {
    return cloneValue(DEFAULT_PARAMETER_SCHEMA);
  }

  getDefaultParameters() {
    return buildDefaultParameters();
  }

  analyze(context = {}) {
    const scope = context.scope || 'paper';
    const symbol = context.symbol || this.symbol;
    if (scope !== 'backtest') {
      return {
        signal: 'NONE',
        reason: BACKTEST_ONLY_REASON,
        symbolCustomName: this.name,
        symbol,
      };
    }

    const parameters = mergeParameters(context.parameters || {});
    const entryCandles = Array.isArray(context.candles?.entry) ? context.candles.entry : [];

    if (context.openPosition) {
      const barsInTrade = countBarsInTrade(entryCandles, context.openPosition, context.currentIndex || 0);
      if (barsInTrade >= parameters.maxBarsInTrade) {
        return {
          signal: 'CLOSE',
          reason: 'Max bars in trade reached',
          symbolCustomName: this.name,
          symbol,
          metadata: {
            symbolCustomName: this.name,
            setup: 'jpy_macro_reversal',
            barsInTrade,
            maxBarsInTrade: parameters.maxBarsInTrade,
            scope,
          },
        };
      }

      return {
        signal: 'NONE',
        reason: 'Open position managed by runner SL/TP',
        symbolCustomName: this.name,
        symbol,
      };
    }

    const requiredBars = Math.max(
      parameters.lookbackBars + 1,
      parameters.rsiPeriod + 1,
      parameters.atrPeriod + 1
    );
    if (entryCandles.length < requiredBars) {
      return {
        signal: 'NONE',
        reason: 'Not enough candles for USDJPY macro reversal analysis',
        symbolCustomName: this.name,
        symbol,
      };
    }

    const currentBar = context.currentBar || entryCandles[entryCandles.length - 1] || {};
    const guardrailReason = shouldBlockByGuardrails({ parameters, context, currentBar });
    if (guardrailReason) {
      return {
        signal: 'NONE',
        reason: guardrailReason,
        symbolCustomName: this.name,
        symbol,
      };
    }

    const currentClose = getClose(currentBar);
    const lookbackClose = getClose(entryCandles[entryCandles.length - 1 - parameters.lookbackBars]);
    const atr = calculateATR(entryCandles, parameters.atrPeriod);
    const rsi = calculateRSI(entryCandles, parameters.rsiPeriod);
    if (!Number.isFinite(currentClose) || !Number.isFinite(lookbackClose) || !Number.isFinite(atr) || !Number.isFinite(rsi)) {
      return {
        signal: 'NONE',
        reason: 'Indicator values unavailable',
        symbolCustomName: this.name,
        symbol,
      };
    }

    if (atr < parameters.minAtr) {
      return {
        signal: 'NONE',
        reason: 'ATR below minimum threshold',
        symbolCustomName: this.name,
        symbol,
      };
    }

    const recentMove = currentClose - lookbackClose;
    const confirmBars = entryCandles.slice(-Math.max(1, Math.floor(parameters.reversalConfirmBars)));
    const hasBullishConfirm = confirmBars.some(hasBullishRejection);
    const hasBearishConfirm = confirmBars.some(hasBearishRejection);
    const impulseThreshold = parameters.impulseAtrMultiplier * atr;
    const metadata = {
      symbolCustomName: this.name,
      setup: 'jpy_macro_reversal',
      atr,
      rsi,
      recentMove,
      impulseAtrMultiplier: parameters.impulseAtrMultiplier,
      slAtrMultiplier: parameters.slAtrMultiplier,
      tpAtrMultiplier: parameters.tpAtrMultiplier,
      scope,
    };

    if (
      recentMove < -impulseThreshold
      && rsi <= parameters.rsiOversold
      && hasBullishConfirm
    ) {
      if (parameters.enableBuy === false) {
        return {
          signal: 'NONE',
          reason: 'BUY disabled by enableBuy=false',
          symbolCustomName: this.name,
          symbol,
          metadata,
        };
      }

      return {
        signal: 'BUY',
        sl: currentClose - (parameters.slAtrMultiplier * atr),
        tp: currentClose + (parameters.tpAtrMultiplier * atr),
        reason: 'USDJPY downside impulse with oversold bullish rejection',
        symbolCustomName: this.name,
        symbol,
        metadata,
      };
    }

    if (
      recentMove > impulseThreshold
      && rsi >= parameters.rsiOverbought
      && hasBearishConfirm
    ) {
      if (parameters.enableSell === false) {
        return {
          signal: 'NONE',
          reason: 'SELL disabled by enableSell=false',
          symbolCustomName: this.name,
          symbol,
          metadata,
        };
      }

      return {
        signal: 'SELL',
        sl: currentClose + (parameters.slAtrMultiplier * atr),
        tp: currentClose - (parameters.tpAtrMultiplier * atr),
        reason: 'USDJPY upside impulse with overbought bearish rejection',
        symbolCustomName: this.name,
        symbol,
        metadata,
      };
    }

    return {
      signal: 'NONE',
      reason: 'No USDJPY macro reversal setup',
      symbolCustomName: this.name,
      symbol,
      metadata: {
        ...metadata,
        priceRange: calculatePriceRange(entryCandles.slice(-parameters.lookbackBars)),
        sma: calculateSMA(entryCandles, Math.min(parameters.lookbackBars, entryCandles.length)),
      },
    };
  }
}

module.exports = UsdjpyJpyMacroReversalV1;
module.exports.USDJPY_JPY_MACRO_REVERSAL_V1 = USDJPY_JPY_MACRO_REVERSAL_V1;
module.exports.USDJPY_JPY_MACRO_REVERSAL_V1_VERSION = USDJPY_JPY_MACRO_REVERSAL_V1_VERSION;
module.exports.BACKTEST_ONLY_REASON = BACKTEST_ONLY_REASON;
module.exports.DEFAULT_PARAMETER_SCHEMA = DEFAULT_PARAMETER_SCHEMA;
module.exports._internals = {
  calculateATR,
  calculatePriceRange,
  calculateRSI,
  calculateSMA,
  parseUtcHours,
};
