const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const TIMEFRAME_TO_MS = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};

const DEFAULT_WARMUP_BARS = 250;

function getTimeframeMs(timeframe) {
  return TIMEFRAME_TO_MS[timeframe] || TIMEFRAME_TO_MS['1h'];
}

function normalizeDateRange(startDateInput, endDateInput) {
  const defaultStart = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const start = startDateInput ? new Date(startDateInput) : defaultStart;

  if (Number.isNaN(start.getTime())) {
    throw new Error('Invalid startDate');
  }

  let endExclusive;
  if (endDateInput) {
    endExclusive = new Date(endDateInput);
    if (Number.isNaN(endExclusive.getTime())) {
      throw new Error('Invalid endDate');
    }

    if (typeof endDateInput === 'string' && DATE_ONLY_RE.test(endDateInput)) {
      endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
    }
  } else {
    endExclusive = new Date();
  }

  if (endExclusive <= start) {
    throw new Error('endDate must be after startDate');
  }

  return { start, endExclusive };
}

function getWarmupStart(start, timeframe, warmupBars = DEFAULT_WARMUP_BARS) {
  return new Date(start.getTime() - warmupBars * getTimeframeMs(timeframe));
}

function estimateFetchLimit(timeframe, fetchStart, endExclusive, extraBars = 10) {
  const timeframeMs = getTimeframeMs(timeframe);
  const estimatedBars = Math.ceil((endExclusive.getTime() - fetchStart.getTime()) / timeframeMs);
  return Math.max(estimatedBars + extraBars, DEFAULT_WARMUP_BARS + 50);
}

function filterCandlesByRange(candles, start, endExclusive) {
  const startMs = start.getTime();
  const endMs = endExclusive.getTime();

  return candles.filter((candle) => {
    const candleTime = new Date(candle.time).getTime();
    return candleTime >= startMs && candleTime < endMs;
  });
}

function clampDateRangeToNow(start, endExclusive, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(nowDate.getTime())) {
    throw new Error('Invalid current time reference');
  }

  if (start >= nowDate) {
    throw new Error('Selected startDate is in the future');
  }

  if (endExclusive > nowDate) {
    return {
      start,
      endExclusive: nowDate,
      clamped: true,
    };
  }

  return {
    start,
    endExclusive,
    clamped: false,
  };
}

module.exports = {
  clampDateRangeToNow,
  DEFAULT_WARMUP_BARS,
  estimateFetchLimit,
  filterCandlesByRange,
  getTimeframeMs,
  getWarmupStart,
  normalizeDateRange,
};
