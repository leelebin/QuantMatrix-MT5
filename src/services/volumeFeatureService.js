/**
 * Volume Feature Service
 * Centralized helpers for volume / order-flow driven strategies.
 *
 * Scope:
 *   - Used primarily by VolumeFlowHybridStrategy.
 *   - Does NOT modify any existing indicator APIs.
 *   - Safe on MT5 broker data where `real_volume` may be zero on CFDs.
 *
 * Volume source priority (per mt5_bridge.py):
 *   1. `volume` (MT5 real volume) when > 0
 *   2. `tickVolume` as a fallback
 *
 * Everything in here is side-effect free and returns numbers (never NaN)
 * so strategies can consume the results without extra guarding.
 */

const indicatorService = require('./indicatorService');

const MS_IN_DAY = 24 * 60 * 60 * 1000;

/**
 * Extract a normalized volume scalar for a single candle. Mirrors the
 * fallback rule from indicatorService.candleVolume(); duplicated here so
 * consumers can import a single cohesive helper module.
 */
function resolveVolume(candle) {
  return indicatorService.candleVolume(candle);
}

/**
 * Classify a bar as BULL / BEAR / NEUTRAL using close vs open. A tiny
 * doji tolerance avoids noisy classification on flat bars.
 */
function classifyBar(candle) {
  if (!candle) return 'NEUTRAL';
  const range = Math.max(1e-9, Math.abs(candle.high - candle.low));
  const body = candle.close - candle.open;
  if (Math.abs(body) / range < 0.08) return 'NEUTRAL';
  return body > 0 ? 'BULL' : 'BEAR';
}

/**
 * Build a signed-volume series (aka delta proxy): bullish bars contribute
 * positive volume, bearish bars negative. Doji bars contribute 0.
 *
 * Returns an array aligned 1:1 with `candles`.
 */
function signedVolumeSeries(candles = []) {
  return candles.map((candle) => {
    const vol = resolveVolume(candle);
    const kind = classifyBar(candle);
    if (kind === 'BULL') return vol;
    if (kind === 'BEAR') return -vol;
    return 0;
  });
}

/**
 * Cumulative delta is the running sum of signed volume. Useful as a
 * simple order-flow proxy: rising = buyers dominant, falling = sellers.
 */
function cumulativeDeltaSeries(candles = []) {
  const signed = signedVolumeSeries(candles);
  const out = new Array(signed.length);
  let running = 0;
  for (let i = 0; i < signed.length; i++) {
    running += signed[i];
    out[i] = running;
  }
  return out;
}

/**
 * Smooth a delta series with a simple trailing mean. Returns an array
 * the same length as the input (the first `period-1` entries are just
 * progressive means so callers never have to worry about alignment).
 */
function smoothDeltaSeries(series = [], period = 8) {
  if (!Array.isArray(series) || series.length === 0) return [];
  const smoothed = new Array(series.length);
  const window = [];
  let sum = 0;
  for (let i = 0; i < series.length; i++) {
    window.push(series[i]);
    sum += series[i];
    if (window.length > period) {
      sum -= window.shift();
    }
    smoothed[i] = sum / window.length;
  }
  return smoothed;
}

/**
 * Relative Volume (RVOL) = current candle volume / trailing average
 * volume over the last `period` candles (excluding the current candle).
 * Returns null if not enough history.
 */
function relativeVolume(candles, period = 20) {
  if (!Array.isArray(candles) || candles.length <= period) return null;
  const current = resolveVolume(candles[candles.length - 1]);
  if (current <= 0) return 0;
  const history = candles.slice(-1 - period, -1);
  let sum = 0;
  for (const c of history) sum += resolveVolume(c);
  const avg = sum / period;
  if (avg <= 0) return 0;
  return current / avg;
}

/**
 * Classify a single RVOL reading into coarse buckets used by the
 * hybrid strategy for signal annotation / logging.
 */
function classifyVolumeSpike(rvol) {
  if (!Number.isFinite(rvol) || rvol <= 0) return 'low';
  if (rvol < 0.8) return 'low';
  if (rvol < 1.3) return 'normal';
  if (rvol < 2.0) return 'high';
  return 'extreme';
}

/**
 * Wick / body ratio for rejection detection. Returns an object with
 * separate upper / lower wick ratios plus the max of the two so
 * reversal logic can check "is there a meaningful sweep somewhere?".
 */
function wickBodyRatio(candle) {
  if (!candle) return { upper: 0, lower: 0, max: 0, body: 0 };
  const body = Math.max(1e-9, Math.abs(candle.close - candle.open));
  const upper = Math.max(0, candle.high - Math.max(candle.close, candle.open));
  const lower = Math.max(0, Math.min(candle.close, candle.open) - candle.low);
  return {
    upper: upper / body,
    lower: lower / body,
    max: Math.max(upper, lower) / body,
    body,
  };
}

/**
 * Bar spread efficiency = |close - open| / (high - low). 0 = pure wick,
 * 1 = full-body Marubozu. Useful for filtering noise: low efficiency
 * bars often indicate absorption/indecision even with high volume.
 */
function spreadEfficiency(candle) {
  if (!candle) return 0;
  const range = Math.max(1e-9, candle.high - candle.low);
  return Math.abs(candle.close - candle.open) / range;
}

/**
 * Extract a yyyy-mm-dd session key for a candle. Used for session VWAP.
 * Treats all candle times as UTC — matches mt5_bridge.py which emits
 * ISO timestamps in UTC. Session rollover strictly at 00:00 UTC is a
 * reasonable default for metals/oil CFDs; anchored VWAP lets strategies
 * override per-signal if needed.
 */
function sessionKey(candle) {
  if (!candle || !candle.time) return 'unknown';
  const date = new Date(candle.time);
  if (Number.isNaN(date.getTime())) return String(candle.time).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

/**
 * Compute a session VWAP series that resets at the start of each UTC
 * session. Returns an array aligned with `candles`. Uses typical price
 * weighted by resolved volume (real or tick).
 */
function sessionVwapSeries(candles = []) {
  const out = new Array(candles.length);
  let currentSession = null;
  let cumVolPrice = 0;
  let cumVol = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const key = sessionKey(candle);
    if (key !== currentSession) {
      currentSession = key;
      cumVolPrice = 0;
      cumVol = 0;
    }
    const typical = (candle.high + candle.low + candle.close) / 3;
    const vol = resolveVolume(candle);
    cumVolPrice += typical * vol;
    cumVol += vol;
    out[i] = cumVol > 0 ? cumVolPrice / cumVol : candle.close;
  }
  return out;
}

/**
 * Build an anchored VWAP starting at the candle whose timestamp is
 * closest to (but not after) `anchorTime`. Returns an array aligned
 * with `candles` — indices before the anchor contain the prior close
 * as a harmless stand-in so consumers can still pass an index in.
 */
function anchoredVwapSeries(candles = [], anchorTime = null) {
  const out = new Array(candles.length);
  const anchorMs = anchorTime ? new Date(anchorTime).getTime() : null;
  let anchorIndex = 0;
  if (Number.isFinite(anchorMs)) {
    for (let i = 0; i < candles.length; i++) {
      const t = new Date(candles[i].time).getTime();
      if (t > anchorMs) break;
      anchorIndex = i;
    }
  }

  let cumVolPrice = 0;
  let cumVol = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i < anchorIndex) {
      out[i] = candles[i].close;
      continue;
    }
    const candle = candles[i];
    const typical = (candle.high + candle.low + candle.close) / 3;
    const vol = resolveVolume(candle);
    cumVolPrice += typical * vol;
    cumVol += vol;
    out[i] = cumVol > 0 ? cumVolPrice / cumVol : candle.close;
  }
  return out;
}

/**
 * Precompute a per-candle feature snapshot series for the hybrid
 * strategy so callers can reuse O(n) work instead of rebuilding the
 * same cumulative/VWAP statistics on every bar.
 */
function buildFeatureSeries(candles = [], {
  volumeAvgPeriod = 20,
  deltaSmoothing = 8,
} = {}) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return [];
  }

  const minCandles = Math.max(volumeAvgPeriod + 2, 5);
  const out = new Array(candles.length).fill(null);
  const volumes = new Array(candles.length);
  const cumulative = new Array(candles.length);
  const signed = new Array(candles.length);

  let rollingVolumeSum = 0;
  let rollingCumulativeSum = 0;
  let rollingSignedRecentSum = 0;
  let cumulativeDelta = 0;

  let currentSession = null;
  let sessionCumVolPrice = 0;
  let sessionCumVol = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    const vol = resolveVolume(candle);
    const direction = classifyBar(candle);
    const signedVolume = direction === 'BULL' ? vol : direction === 'BEAR' ? -vol : 0;

    volumes[i] = vol;
    signed[i] = signedVolume;
    cumulativeDelta += signedVolume;
    cumulative[i] = cumulativeDelta;

    const trailingAvgExcludingCurrent = i >= volumeAvgPeriod
      ? (rollingVolumeSum / volumeAvgPeriod)
      : null;
    const rvol = trailingAvgExcludingCurrent == null
      ? null
      : trailingAvgExcludingCurrent > 0 ? vol / trailingAvgExcludingCurrent : 0;

    rollingVolumeSum += vol;
    if (i >= volumeAvgPeriod) {
      rollingVolumeSum -= volumes[i - volumeAvgPeriod];
    }
    const averageVolume = i + 1 >= volumeAvgPeriod
      ? (rollingVolumeSum / volumeAvgPeriod)
      : null;

    rollingCumulativeSum += cumulativeDelta;
    if (i >= deltaSmoothing) {
      rollingCumulativeSum -= cumulative[i - deltaSmoothing];
    }
    const cumulativeDeltaSmoothed = rollingCumulativeSum / Math.min(i + 1, deltaSmoothing);

    rollingSignedRecentSum += signedVolume;
    if (i >= 5) {
      rollingSignedRecentSum -= signed[i - 5];
    }

    const key = sessionKey(candle);
    if (key !== currentSession) {
      currentSession = key;
      sessionCumVolPrice = 0;
      sessionCumVol = 0;
    }
    const typical = (candle.high + candle.low + candle.close) / 3;
    sessionCumVolPrice += typical * vol;
    sessionCumVol += vol;
    const sessionVwap = sessionCumVol > 0 ? sessionCumVolPrice / sessionCumVol : candle.close;

    if (i + 1 < minCandles) {
      continue;
    }

    const wick = wickBodyRatio(candle);
    const spread = spreadEfficiency(candle);

    out[i] = {
      latestCandle: candle,
      previousCandle: candles[i - 1] || null,
      volume: vol,
      averageVolume,
      rvol,
      volumeSpikeClass: classifyVolumeSpike(rvol),
      cumulativeDelta,
      cumulativeDeltaSmoothed,
      cumulativeDeltaPrev: cumulative[i - 1] ?? 0,
      signedVolumeLatest: signedVolume,
      signedVolumeRecentSum: rollingSignedRecentSum,
      sessionVwap,
      vwapDistance: candle.close - sessionVwap,
      vwapDistancePct: sessionVwap ? ((candle.close - sessionVwap) / sessionVwap) : 0,
      wickUpperRatio: wick.upper,
      wickLowerRatio: wick.lower,
      wickMaxRatio: wick.max,
      spreadEfficiency: spread,
    };
  }

  return out;
}

/**
 * Compute a compact feature snapshot for the latest closed candle.
 * Returns a plain object; missing inputs are represented as null so
 * the caller can short-circuit cleanly.
 *
 * Params:
 *   - volumeAvgPeriod: RVOL window
 *   - deltaSmoothing:  smoothing window for the cumulative delta proxy
 */
function computeLatestFeatures(candles = [], {
  volumeAvgPeriod = 20,
  deltaSmoothing = 8,
} = {}) {
  const series = buildFeatureSeries(candles, { volumeAvgPeriod, deltaSmoothing });
  return series.length > 0 ? series[series.length - 1] : null;
}

module.exports = {
  resolveVolume,
  classifyBar,
  signedVolumeSeries,
  cumulativeDeltaSeries,
  smoothDeltaSeries,
  relativeVolume,
  classifyVolumeSpike,
  wickBodyRatio,
  spreadEfficiency,
  sessionKey,
  sessionVwapSeries,
  anchoredVwapSeries,
  buildFeatureSeries,
  computeLatestFeatures,
  MS_IN_DAY,
};
