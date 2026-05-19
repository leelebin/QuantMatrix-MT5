const mt5Service = require('./mt5Service');

const DEFAULT_PAPER_CANDLE_LIMIT = 500;

let connectPromise = null;

function normalizeLimit(limit) {
  const parsed = Number(limit || process.env.SYMBOL_CUSTOM_PAPER_CANDLE_LIMIT);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_PAPER_CANDLE_LIMIT;
}

function resolvePaperTimeframes(timeframes = {}) {
  const entry = timeframes.entryTimeframe || timeframes.setupTimeframe || '5m';
  const setup = timeframes.setupTimeframe || entry;
  const higher = timeframes.higherTimeframe || setup;
  return { setup, entry, higher };
}

function normalizeCandle(candle = {}) {
  return {
    time: candle.time,
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

async function ensureMt5ConnectedForSymbolCustomPaperCandles() {
  if (typeof mt5Service.isConnected === 'function' && mt5Service.isConnected()) {
    return;
  }

  if (typeof mt5Service.connect !== 'function') {
    throw new Error('MT5 candle provider is not available for SymbolCustom paper runtime');
  }

  if (!connectPromise) {
    connectPromise = mt5Service.connect().finally(() => {
      connectPromise = null;
    });
  }

  await connectPromise;
}

async function getSymbolCustomPaperCandles({
  symbol,
  timeframes,
  limit,
} = {}) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  if (!normalizedSymbol) {
    throw new Error('Symbol is required for SymbolCustom paper candles');
  }

  await ensureMt5ConnectedForSymbolCustomPaperCandles();

  const resolvedTimeframes = resolvePaperTimeframes(timeframes || {});
  const candleLimit = normalizeLimit(limit);
  const cache = new Map();

  async function fetchByTimeframe(timeframe) {
    const key = `${normalizedSymbol}:${timeframe}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        mt5Service.getCandles(normalizedSymbol, timeframe, null, candleLimit)
          .then(normalizeCandles)
      );
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

module.exports = {
  DEFAULT_PAPER_CANDLE_LIMIT,
  ensureMt5ConnectedForSymbolCustomPaperCandles,
  getSymbolCustomPaperCandles,
  resolvePaperTimeframes,
};
