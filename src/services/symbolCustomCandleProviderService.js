const mt5Service = require('./mt5Service');
const {
  estimateFetchLimit,
  filterCandlesByRange,
  normalizeDateRange,
} = require('../utils/candleRange');

const SYMBOL_CUSTOM_ENTRY_TIMEFRAME_REQUIRED = 'SYMBOL_CUSTOM_ENTRY_TIMEFRAME_REQUIRED';
const SYMBOL_CUSTOM_BACKTEST_DATE_RANGE_REQUIRED = 'SYMBOL_CUSTOM_BACKTEST_DATE_RANGE_REQUIRED';
const SYMBOL_CUSTOM_BACKTEST_CANDLES_NOT_FOUND = 'SYMBOL_CUSTOM_BACKTEST_CANDLES_NOT_FOUND';
const SYMBOL_CUSTOM_MT5_NOT_CONNECTED = 'SYMBOL_CUSTOM_MT5_NOT_CONNECTED';
const SYMBOL_CUSTOM_MT5_NOT_CONNECTED_MESSAGE = 'MT5 is not connected. Please connect MT5 first before running historical SymbolCustom backtest.';
const SYMBOL_CUSTOM_MT5_NOT_CONNECTED_HINT = 'Go to Dashboard/Diagnostics and connect MT5, then retry.';

const TIMEFRAME_ALIASES = Object.freeze({
  m1: '1m',
  m5: '5m',
  m15: '15m',
  m30: '30m',
  h1: '1h',
  h2: '2h',
  h4: '4h',
  h6: '6h',
  h8: '8h',
  h12: '12h',
  d1: '1d',
  w1: '1w',
});

let mt5ConnectPromise = null;

function buildHttpError(message, statusCode, details = undefined) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

function isMt5NotConnectedError(error) {
  const message = String(error?.message || error || '');
  return /MT5 not connected/i.test(message)
    || /MT5 is not connected/i.test(message)
    || (/connect\(\) first/i.test(message) && /MT5/i.test(message));
}

function buildMt5NotConnectedError() {
  const error = buildHttpError(SYMBOL_CUSTOM_MT5_NOT_CONNECTED_MESSAGE, 503, [
    {
      field: 'mt5',
      message: SYMBOL_CUSTOM_MT5_NOT_CONNECTED_MESSAGE,
      reasonCode: SYMBOL_CUSTOM_MT5_NOT_CONNECTED,
      hint: SYMBOL_CUSTOM_MT5_NOT_CONNECTED_HINT,
    },
  ]);
  error.reasonCode = SYMBOL_CUSTOM_MT5_NOT_CONNECTED;
  error.hint = SYMBOL_CUSTOM_MT5_NOT_CONNECTED_HINT;
  return error;
}

async function ensureMt5ConnectedForHistoricalCandles() {
  if (typeof mt5Service.isConnected === 'function' && mt5Service.isConnected()) {
    return;
  }

  if (typeof mt5Service.connect !== 'function') {
    return;
  }

  if (!mt5ConnectPromise) {
    mt5ConnectPromise = mt5Service.connect()
      .catch(() => {
        throw buildMt5NotConnectedError();
      })
      .finally(() => {
        mt5ConnectPromise = null;
      });
  }

  await mt5ConnectPromise;
}

function normalizeTimeframe(timeframe) {
  const raw = String(timeframe || '').trim();
  if (!raw) return '';

  const lower = raw.toLowerCase().replace(/\s+/g, '');
  if (TIMEFRAME_ALIASES[lower]) return TIMEFRAME_ALIASES[lower];

  const compact = lower.match(/^(\d+)(m|min|minute|minutes|h|hr|hour|hours|d|day|days|w|week|weeks)$/);
  if (!compact) return lower;

  const amount = compact[1];
  const unit = compact[2];
  if (unit.startsWith('m')) return `${amount}m`;
  if (unit.startsWith('h')) return `${amount}h`;
  if (unit.startsWith('d')) return `${amount}d`;
  if (unit.startsWith('w')) return `${amount}w`;
  return lower;
}

function resolveTimeframes(timeframes = {}) {
  const entry = normalizeTimeframe(timeframes.entryTimeframe);
  if (!entry) {
    throw buildHttpError(SYMBOL_CUSTOM_ENTRY_TIMEFRAME_REQUIRED, 400, [
      { field: 'timeframes.entryTimeframe', message: SYMBOL_CUSTOM_ENTRY_TIMEFRAME_REQUIRED },
    ]);
  }

  const setup = normalizeTimeframe(timeframes.setupTimeframe) || entry;
  const higher = normalizeTimeframe(timeframes.higherTimeframe) || setup;
  return { setup, entry, higher };
}

function normalizeDateRangeForSymbolCustom(startDate, endDate) {
  if (!startDate || !endDate) {
    throw buildHttpError(SYMBOL_CUSTOM_BACKTEST_DATE_RANGE_REQUIRED, 400, [
      { field: 'startDate', message: 'startDate is required when using historical candles' },
      { field: 'endDate', message: 'endDate is required when using historical candles' },
    ]);
  }

  try {
    return normalizeDateRange(startDate, endDate);
  } catch (error) {
    throw buildHttpError(error.message || SYMBOL_CUSTOM_BACKTEST_DATE_RANGE_REQUIRED, 400);
  }
}

function normalizeCandle(candle = {}) {
  const time = candle.time || candle.datetime || candle.timestamp || candle.date || null;
  return {
    time,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume ?? candle.tickVolume ?? candle.tick_volume ?? 0),
  };
}

function isValidCandle(candle = {}) {
  return candle.time
    && Number.isFinite(candle.open)
    && Number.isFinite(candle.high)
    && Number.isFinite(candle.low)
    && Number.isFinite(candle.close);
}

function normalizeCandles(candles = []) {
  if (!Array.isArray(candles)) return [];
  return candles
    .map(normalizeCandle)
    .filter(isValidCandle)
    .sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime());
}

async function fetchHistoricalCandles({ symbol, timeframe, start, endExclusive, limit }) {
  const fetchLimit = limit || estimateFetchLimit(timeframe, start, endExclusive, 10);
  let rawCandles;
  try {
    await ensureMt5ConnectedForHistoricalCandles();
    rawCandles = await mt5Service.getCandles(symbol, timeframe, start, fetchLimit, endExclusive);
  } catch (error) {
    if (isMt5NotConnectedError(error)) {
      throw buildMt5NotConnectedError();
    }
    throw error;
  }
  const normalized = normalizeCandles(rawCandles);
  return filterCandlesByRange(normalized, start, endExclusive);
}

async function getSymbolCustomCandles({
  symbol,
  timeframes,
  startDate,
  endDate,
  limit,
} = {}) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const resolvedTimeframes = resolveTimeframes(timeframes || {});
  const { start, endExclusive } = normalizeDateRangeForSymbolCustom(startDate, endDate);

  const cache = new Map();
  async function fetchByTimeframe(timeframe) {
    const key = `${normalizedSymbol}:${timeframe}`;
    if (!cache.has(key)) {
      cache.set(key, fetchHistoricalCandles({
        symbol: normalizedSymbol,
        timeframe,
        start,
        endExclusive,
        limit,
      }));
    }
    return cache.get(key);
  }

  const [setup, entry, higher] = await Promise.all([
    fetchByTimeframe(resolvedTimeframes.setup),
    fetchByTimeframe(resolvedTimeframes.entry),
    fetchByTimeframe(resolvedTimeframes.higher),
  ]);

  return { setup, entry, higher };
}

function buildCandleProviderForSymbolCustom(symbolCustom = {}) {
  return async function symbolCustomHistoricalCandleProvider({
    symbol = symbolCustom.symbol,
    timeframes = symbolCustom.timeframes || {},
    startDate,
    endDate,
    limit,
  } = {}) {
    return getSymbolCustomCandles({
      symbol,
      timeframes,
      startDate,
      endDate,
      limit,
    });
  };
}

module.exports = {
  SYMBOL_CUSTOM_ENTRY_TIMEFRAME_REQUIRED,
  SYMBOL_CUSTOM_BACKTEST_DATE_RANGE_REQUIRED,
  SYMBOL_CUSTOM_BACKTEST_CANDLES_NOT_FOUND,
  SYMBOL_CUSTOM_MT5_NOT_CONNECTED,
  SYMBOL_CUSTOM_MT5_NOT_CONNECTED_MESSAGE,
  SYMBOL_CUSTOM_MT5_NOT_CONNECTED_HINT,
  buildCandleProviderForSymbolCustom,
  getSymbolCustomCandles,
  normalizeTimeframe,
};
