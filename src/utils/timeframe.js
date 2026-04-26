const TIMEFRAME_DURATION_MS = Object.freeze({
  '1m': 1 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
});

const CADENCE_BY_TIMEFRAME_MS = Object.freeze({
  '1m': 15 * 1000,
  '5m': 30 * 1000,
  '15m': 60 * 1000,
  '1h': 3 * 60 * 1000,
  '4h': 3 * 60 * 1000,
  '1d': 15 * 60 * 1000,
});

function normalizeTimeframe(timeframe) {
  const normalized = String(timeframe || '').trim().toLowerCase();
  return TIMEFRAME_DURATION_MS[normalized] ? normalized : null;
}

function getTimeframeDurationMs(timeframe) {
  return TIMEFRAME_DURATION_MS[normalizeTimeframe(timeframe)] || null;
}

function getCadenceMsForTimeframe(timeframe) {
  return CADENCE_BY_TIMEFRAME_MS[normalizeTimeframe(timeframe)] || (3 * 60 * 1000);
}

function getPrimaryExecutionTimeframe(executionConfig = {}) {
  return normalizeTimeframe(
    executionConfig.entryTimeframe
    || executionConfig.timeframe
    || null
  );
}

function estimateBarDistance(fromTime, toTime, timeframe) {
  const durationMs = getTimeframeDurationMs(timeframe);
  if (!durationMs) return null;

  const start = fromTime instanceof Date ? fromTime.getTime() : new Date(fromTime).getTime();
  const end = toTime instanceof Date ? toTime.getTime() : new Date(toTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }

  return Math.floor((end - start) / durationMs);
}

module.exports = {
  TIMEFRAME_DURATION_MS,
  CADENCE_BY_TIMEFRAME_MS,
  normalizeTimeframe,
  getTimeframeDurationMs,
  getCadenceMsForTimeframe,
  getPrimaryExecutionTimeframe,
  estimateBarDistance,
};
