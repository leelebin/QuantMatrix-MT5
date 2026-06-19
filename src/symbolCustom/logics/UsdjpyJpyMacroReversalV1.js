const BaseSymbolCustom = require('../BaseSymbolCustom');

const USDJPY_JPY_MACRO_REVERSAL_V1 = 'USDJPY_JPY_MACRO_REVERSAL_V1';
const USDJPY_JPY_MACRO_REVERSAL_V1_VERSION = 7;
const CANDIDATE_PRESET = 'buy_session_conservative';
const PAPER_AND_BACKTEST_ONLY_REASON = 'USDJPY_JPY_MACRO_REVERSAL_V1 supports paper/backtest only in Phase 2 trial';
const LIVE_BLOCKED_REASON = 'USDJPY_JPY_MACRO_REVERSAL_V1 live execution is blocked';
const BACKTEST_ONLY_REASON = PAPER_AND_BACKTEST_ONLY_REASON;

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
  { key: 'maxRollingConsecutiveLosses', label: 'Max Rolling Consecutive Losses', type: 'number', defaultValue: 0, min: 0, max: 20, step: 1 },
  { key: 'rollingLossCooldownBars', label: 'Rolling Loss Cooldown Bars', type: 'number', defaultValue: 0, min: 0, max: 2000, step: 6 },
  { key: 'useHigherTrendFilter', label: 'Use Higher Trend Filter', type: 'boolean', defaultValue: false },
  { key: 'higherTrendSmaPeriod', label: 'Higher Trend SMA Period', type: 'number', defaultValue: 100, min: 20, max: 240, step: 10 },
  { key: 'higherTrendAtrPeriod', label: 'Higher Trend ATR Period', type: 'number', defaultValue: 14, min: 10, max: 48, step: 1 },
  { key: 'minHigherTrendDistanceAtr', label: 'Minimum Higher Trend Distance ATR', type: 'number', defaultValue: 0, min: -10, max: 10, step: 0.5 },
  { key: 'useHigherDriftFilter', label: 'Use Higher Drift Filter', type: 'boolean', defaultValue: false },
  { key: 'higherDriftLookbackBars', label: 'Higher Drift Lookback Bars', type: 'number', defaultValue: 72, min: 12, max: 240, step: 12 },
  { key: 'minHigherDriftAtr', label: 'Minimum Higher Drift ATR', type: 'number', defaultValue: 0, min: -12, max: 12, step: 0.5 },
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

function toEpoch(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function buildSignalMetadata({ parameters, scope, atr = null, rsi = null, recentMove = null, extra = {} }) {
  return {
    source: 'symbolCustom',
    symbolCustomName: USDJPY_JPY_MACRO_REVERSAL_V1,
    logicName: USDJPY_JPY_MACRO_REVERSAL_V1,
    strategyType: 'SymbolCustom',
    setup: 'jpy_macro_reversal',
    setupType: 'jpy_macro_reversal',
    candidatePreset: CANDIDATE_PRESET,
    scope,
    enableBuy: parameters.enableBuy,
    enableSell: parameters.enableSell,
    allowedUtcHours: parameters.allowedUtcHours,
    blockedUtcHours: parameters.blockedUtcHours,
    cooldownBarsAfterAnyExit: parameters.cooldownBarsAfterAnyExit,
    cooldownBarsAfterSL: parameters.cooldownBarsAfterSL,
    maxDailyLosses: parameters.maxDailyLosses,
    maxDailyTrades: parameters.maxDailyTrades,
    maxRollingConsecutiveLosses: parameters.maxRollingConsecutiveLosses,
    rollingLossCooldownBars: parameters.rollingLossCooldownBars,
    atr,
    rsi,
    recentMove,
    impulseAtrMultiplier: parameters.impulseAtrMultiplier,
    slAtrMultiplier: parameters.slAtrMultiplier,
    tpAtrMultiplier: parameters.tpAtrMultiplier,
    ...extra,
  };
}

function calculateHigherRegime(candles = [], parameters = {}) {
  const higherCandles = Array.isArray(candles) ? candles : [];
  const trendPeriod = Math.max(1, Math.floor(toNumber(parameters.higherTrendSmaPeriod, 100)));
  const atrPeriod = Math.max(1, Math.floor(toNumber(parameters.higherTrendAtrPeriod, 14)));
  const driftLookbackBars = Math.max(1, Math.floor(toNumber(parameters.higherDriftLookbackBars, 72)));
  const requiredBars = Math.max(trendPeriod, atrPeriod + 1, driftLookbackBars + 1);

  if (higherCandles.length < requiredBars) {
    return {
      available: false,
      reason: 'Not enough higher timeframe candles for regime filter',
      requiredBars,
      candleCount: higherCandles.length,
    };
  }

  const currentClose = getClose(higherCandles[higherCandles.length - 1]);
  const trendSma = calculateSMA(higherCandles, trendPeriod);
  const higherAtr = calculateATR(higherCandles, atrPeriod);
  const driftClose = getClose(higherCandles[higherCandles.length - 1 - driftLookbackBars]);

  if (
    !Number.isFinite(currentClose)
    || !Number.isFinite(trendSma)
    || !Number.isFinite(higherAtr)
    || higherAtr <= 0
    || !Number.isFinite(driftClose)
  ) {
    return {
      available: false,
      reason: 'Higher timeframe regime values unavailable',
      trendPeriod,
      atrPeriod,
      driftLookbackBars,
    };
  }

  const trendDistanceAtr = (currentClose - trendSma) / higherAtr;
  const driftAtr = (currentClose - driftClose) / higherAtr;

  return {
    available: true,
    trendPeriod,
    atrPeriod,
    driftLookbackBars,
    currentClose,
    trendSma,
    higherAtr,
    trendDistanceAtr,
    driftAtr,
  };
}

function shouldBlockByHigherRegime({ side, parameters, higherRegime = {} }) {
  const useTrend = parameters.useHigherTrendFilter === true;
  const useDrift = parameters.useHigherDriftFilter === true;
  if (!useTrend && !useDrift) return null;

  if (!higherRegime.available) {
    return higherRegime.reason || 'Higher timeframe regime unavailable';
  }

  if (useTrend) {
    const threshold = toNumber(parameters.minHigherTrendDistanceAtr, 0);
    if (side === 'BUY' && higherRegime.trendDistanceAtr < threshold) {
      return 'Higher trend filter blocked BUY';
    }
    if (side === 'SELL' && higherRegime.trendDistanceAtr > -threshold) {
      return 'Higher trend filter blocked SELL';
    }
  }

  if (useDrift) {
    const threshold = toNumber(parameters.minHigherDriftAtr, 0);
    if (side === 'BUY' && higherRegime.driftAtr < threshold) {
      return 'Higher drift filter blocked BUY';
    }
    if (side === 'SELL' && higherRegime.driftAtr > -threshold) {
      return 'Higher drift filter blocked SELL';
    }
  }

  return null;
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function roundConfidence(value) {
  return Number(Math.max(0, Math.min(1, value)).toFixed(4));
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

function calculateRejectionQuality(candles = [], side = 'BUY') {
  const values = candles.map((candle) => {
    const high = toNumber(candle.high, null);
    const low = toNumber(candle.low, null);
    const close = toNumber(candle.close, null);
    const range = getRange(candle);
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close) || !range) return null;
    if (side === 'BUY') return clamp01((close - low) / range);
    return clamp01((high - close) / range);
  }).filter(Number.isFinite);
  return values.length ? Math.max(...values) : 0;
}

function calculateSignalConfidence({ side, parameters, atr, rsi, recentMove, confirmBars }) {
  const impulseThreshold = parameters.impulseAtrMultiplier * atr;
  const impulseRatio = impulseThreshold > 0 ? Math.abs(recentMove) / impulseThreshold : 1;
  const impulseScore = clamp01((impulseRatio - 1) / 1.25);
  const rsiDistance = side === 'BUY'
    ? parameters.rsiOversold - rsi
    : rsi - parameters.rsiOverbought;
  const rsiScore = clamp01(rsiDistance / 18);
  const rejectionScore = clamp01((calculateRejectionQuality(confirmBars, side) - 0.5) / 0.5);

  // Conditions already prove the setup is valid; confidence reflects how far
  // the impulse, RSI extreme, and rejection close are beyond their thresholds.
  return roundConfidence(0.6 + (impulseScore * 0.22) + (rsiScore * 0.13) + (rejectionScore * 0.05));
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

function tradeBelongsToStrategy(trade = {}, context = {}) {
  const expectedSymbol = String(context.symbol || 'USDJPY').trim().toUpperCase();
  const tradeSymbol = String(trade.symbol || expectedSymbol).trim().toUpperCase();
  if (tradeSymbol && expectedSymbol && tradeSymbol !== expectedSymbol) return false;

  const expectedLogicName = context.logicName || USDJPY_JPY_MACRO_REVERSAL_V1;
  const tradeLogicName = trade.logicName || trade.executionSignal?.logicName || trade.executionSignal?.metadata?.logicName;
  if (tradeLogicName && tradeLogicName !== expectedLogicName) return false;

  const expectedName = context.symbolCustomName || USDJPY_JPY_MACRO_REVERSAL_V1;
  const tradeName = trade.symbolCustomName || trade.strategy || trade.executionSignal?.symbolCustomName;
  if (tradeName && tradeName !== expectedName) return false;

  return true;
}

function getScopedTrades(context = {}, fieldName) {
  const source = Array.isArray(context[fieldName]) ? context[fieldName] : [];
  return source.filter((trade) => tradeBelongsToStrategy(trade, context));
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

function getBarsSinceTradeExit(context = {}, trade = {}) {
  const currentIndex = toNumber(context.currentIndex, null);
  const exitIndex = toNumber(trade.exitIndex, null);
  if (Number.isFinite(currentIndex) && Number.isFinite(exitIndex)) {
    return Math.max(0, currentIndex - exitIndex);
  }

  const currentEpoch = toEpoch(getCandleTime(context.currentBar || {}));
  const exitEpoch = toEpoch(trade.exitTime || trade.closeTime || trade.timestamp);
  if (currentEpoch != null && exitEpoch != null) {
    return Math.max(0, Math.floor((currentEpoch - exitEpoch) / (5 * 60 * 1000)));
  }

  return null;
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

  const lastClosedTrade = context.lastClosedTrade || null;
  const rawBarsSinceLastExit = context.barsSinceLastExit;
  const barsSinceLastExit = rawBarsSinceLastExit === null || rawBarsSinceLastExit === undefined
    ? null
    : toNumber(rawBarsSinceLastExit, null);
  if (
    lastClosedTrade
    && Number.isFinite(barsSinceLastExit)
    && parameters.cooldownBarsAfterAnyExit > 0
    && barsSinceLastExit < parameters.cooldownBarsAfterAnyExit
  ) {
    return 'Cooldown after any exit active';
  }
  if (
    lastClosedTrade
    && lastClosedTrade.exitReason === 'SL'
    && Number.isFinite(barsSinceLastExit)
    && parameters.cooldownBarsAfterSL > 0
    && barsSinceLastExit < parameters.cooldownBarsAfterSL
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

  const closedTrades = getScopedTrades(context, 'closedTrades');
  const rollingConsecutiveLosses = getConsecutiveLosses(closedTrades);
  const rollingLastClosedTrade = closedTrades.length ? closedTrades[closedTrades.length - 1] : null;
  const barsSinceRollingLossExit = rollingLastClosedTrade ? getBarsSinceTradeExit(context, rollingLastClosedTrade) : null;
  if (
    parameters.maxRollingConsecutiveLosses > 0
    && parameters.rollingLossCooldownBars > 0
    && rollingConsecutiveLosses >= parameters.maxRollingConsecutiveLosses
    && Number.isFinite(barsSinceRollingLossExit)
    && barsSinceRollingLossExit < parameters.rollingLossCooldownBars
  ) {
    return 'Rolling loss cooldown active';
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
    const parameters = mergeParameters(context.parameters || {});

    if (scope === 'live') {
      return {
        signal: 'NONE',
        status: 'BLOCKED',
        reason: LIVE_BLOCKED_REASON,
        reasonCode: 'SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_2',
        symbolCustomName: this.name,
        symbol,
        metadata: buildSignalMetadata({ parameters, scope }),
      };
    }

    if (scope !== 'backtest' && scope !== 'paper') {
      return {
        signal: 'NONE',
        reason: PAPER_AND_BACKTEST_ONLY_REASON,
        symbolCustomName: this.name,
        symbol,
        metadata: buildSignalMetadata({ parameters, scope }),
      };
    }

    const entryCandles = Array.isArray(context.candles?.entry) ? context.candles.entry : [];

    if (context.openPosition) {
      const barsInTrade = countBarsInTrade(entryCandles, context.openPosition, context.currentIndex || 0);
      if (barsInTrade >= parameters.maxBarsInTrade) {
        return {
          signal: 'CLOSE',
          reason: 'Max bars in trade reached',
          symbolCustomName: this.name,
          symbol,
          metadata: buildSignalMetadata({
            parameters,
            scope,
            extra: {
              barsInTrade,
              maxBarsInTrade: parameters.maxBarsInTrade,
            },
          }),
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
    const higherRegime = calculateHigherRegime(context.candles?.higher || [], parameters);
    const metadata = buildSignalMetadata({
      parameters,
      scope,
      atr,
      rsi,
      recentMove,
      extra: { higherRegime },
    });

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

      const regimeBlockReason = shouldBlockByHigherRegime({ side: 'BUY', parameters, higherRegime });
      if (regimeBlockReason) {
        return {
          signal: 'NONE',
          reason: regimeBlockReason,
          symbolCustomName: this.name,
          symbol,
          metadata,
        };
      }

      const confidence = calculateSignalConfidence({
        side: 'BUY',
        parameters,
        atr,
        rsi,
        recentMove,
        confirmBars,
      });

      return {
        signal: 'BUY',
        confidence,
        sl: currentClose - (parameters.slAtrMultiplier * atr),
        tp: currentClose + (parameters.tpAtrMultiplier * atr),
        reason: 'USDJPY downside impulse with oversold bullish rejection',
        symbolCustomName: this.name,
        symbol,
        metadata: {
          ...metadata,
          confidence,
        },
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

      const regimeBlockReason = shouldBlockByHigherRegime({ side: 'SELL', parameters, higherRegime });
      if (regimeBlockReason) {
        return {
          signal: 'NONE',
          reason: regimeBlockReason,
          symbolCustomName: this.name,
          symbol,
          metadata,
        };
      }

      const confidence = calculateSignalConfidence({
        side: 'SELL',
        parameters,
        atr,
        rsi,
        recentMove,
        confirmBars,
      });

      return {
        signal: 'SELL',
        confidence,
        sl: currentClose + (parameters.slAtrMultiplier * atr),
        tp: currentClose - (parameters.tpAtrMultiplier * atr),
        reason: 'USDJPY upside impulse with overbought bearish rejection',
        symbolCustomName: this.name,
        symbol,
        metadata: {
          ...metadata,
          confidence,
        },
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
module.exports.PAPER_AND_BACKTEST_ONLY_REASON = PAPER_AND_BACKTEST_ONLY_REASON;
module.exports.LIVE_BLOCKED_REASON = LIVE_BLOCKED_REASON;
module.exports.CANDIDATE_PRESET = CANDIDATE_PRESET;
module.exports.DEFAULT_PARAMETER_SCHEMA = DEFAULT_PARAMETER_SCHEMA;
module.exports._internals = {
  calculateATR,
  calculatePriceRange,
  calculateRSI,
  calculateSMA,
  calculateHigherRegime,
  shouldBlockByHigherRegime,
  buildSignalMetadata,
  calculateSignalConfidence,
  parseUtcHours,
  getConsecutiveLosses,
  getScopedTrades,
};
