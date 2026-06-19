const DEFAULT_TIMEFRAMES = Object.freeze(['M1', 'M5', 'M15']);
const DEFAULT_MAX_BARS_BY_TIMEFRAME = Object.freeze({
  M1: 60,
  M5: 12,
  M15: 4,
});
const DEFAULT_POST_EXIT_WINDOW_MINUTES = 60;
const DEFAULT_MINIMUM_CANDLES_BY_TIMEFRAME = Object.freeze({
  M1: 5,
  M5: 2,
  M15: 1,
});
const DEFAULT_CLASSIFICATION_THRESHOLDS = Object.freeze({
  continuedMinR: 0.5,
  missedRunnerMinR: 1,
  protectedGoodAdverseR: -0.5,
  noValueAbsR: 0.25,
});
const POST_EXIT_STATUSES = Object.freeze({
  PENDING: 'pending',
  COLLECTING: 'collecting',
  COMPLETED: 'completed',
  INSUFFICIENT: 'insufficient',
  FAILED: 'failed',
});
const EXIT_PROTECTION_TYPES = Object.freeze({
  BREAKEVEN: 'BREAKEVEN',
  TRAILING: 'TRAILING',
  PROTECTIVE_SL: 'PROTECTIVE_SL',
  UNKNOWN_PROTECTIVE: 'UNKNOWN_PROTECTIVE',
});
const CAPTURE_THROTTLE_MS = Object.freeze({
  M1: 60 * 1000,
  M5: 5 * 60 * 1000,
  M15: 15 * 60 * 1000,
});

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundNumber(value, digits = 4) {
  const number = toFiniteNumber(value);
  return number == null ? null : parseFloat(number.toFixed(digits));
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIso(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }
  return {};
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

function normalizeTradeSide(value) {
  const raw = typeof value === 'object' && value !== null
    ? (value.type || value.side || value.direction || value.signal)
    : value;
  const side = String(raw || '').trim().toUpperCase();
  if (side === 'BUY' || side === 'LONG') return 'BUY';
  if (side === 'SELL' || side === 'SHORT') return 'SELL';
  return null;
}

function normalizeSide(position = {}) {
  return normalizeTradeSide(position) || 'BUY';
}

function getPositionSnapshot(trade = {}) {
  return asObject(trade.positionSnapshot || trade.position_snapshot);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function firstFinite(...values) {
  for (const value of values) {
    const number = toFiniteNumber(value);
    if (number != null) return number;
  }
  return null;
}

function getEntryPrice(position = {}) {
  return firstFinite(position.entryPrice, position.openPrice);
}

function getInitialSl(position = {}) {
  return firstFinite(position.originalSl, position.initialSl, position.initialSL, position.sl, position.stopLoss);
}

function getOriginalTp(position = {}) {
  return firstFinite(position.originalTp, position.initialTp, position.initialTP, position.tp, position.takeProfit);
}

function isStopAtOrBeyondBreakeven(position = {}, stopPrice) {
  const entryPrice = getEntryPrice(position);
  const stop = toFiniteNumber(stopPrice);
  if (entryPrice == null || stop == null) return false;

  const epsilon = Math.max(Math.abs(entryPrice) * 1e-8, 1e-10);
  return normalizeSide(position) === 'SELL'
    ? stop <= entryPrice + epsilon
    : stop >= entryPrice - epsilon;
}

function hasActiveOrCompletedCapture(position = {}) {
  const capture = position.postBreakevenCandleCapture;
  return Boolean(capture && (capture.active === true || capture.completedAt));
}

function buildEmptyCandlesByTimeframe(timeframes) {
  return timeframes.reduce((acc, timeframe) => {
    acc[timeframe] = [];
    return acc;
  }, {});
}

function buildEmptyLastCaptured(timeframes) {
  return timeframes.reduce((acc, timeframe) => {
    acc[timeframe] = null;
    return acc;
  }, {});
}

function buildZeroCountsByTimeframe(timeframes) {
  return timeframes.reduce((acc, timeframe) => {
    acc[timeframe] = 0;
    return acc;
  }, {});
}

function createEmptySummary() {
  return {
    maxFavourableAfterBePrice: null,
    maxAdverseAfterBePrice: null,
    maxFavourableAfterBeR: null,
    maxAdverseAfterBeR: null,
    sweptBeThenContinued: null,
    movedToTpAfterBe: null,
    classification: null,
  };
}

function normalizeTimeframes(timeframes) {
  return Array.isArray(timeframes) && timeframes.length > 0
    ? timeframes.map((timeframe) => String(timeframe).toUpperCase()).filter(Boolean)
    : [...DEFAULT_TIMEFRAMES];
}

function createInitialPostBeCaptureState({
  position = {},
  triggerEventId = null,
  triggerType = 'BREAKEVEN_MOVED',
  triggerPrice = null,
  startedAt = null,
  timeframes = DEFAULT_TIMEFRAMES,
  maxBarsByTimeframe = DEFAULT_MAX_BARS_BY_TIMEFRAME,
} = {}) {
  const captureTimeframes = normalizeTimeframes(timeframes);
  const maxBars = {
    ...DEFAULT_MAX_BARS_BY_TIMEFRAME,
    ...(maxBarsByTimeframe || {}),
  };
  const nowIso = toIso(startedAt) || new Date().toISOString();

  return {
    active: true,
    startedAt: nowIso,
    completedAt: null,
    triggerEventId: triggerEventId || null,
    triggerType: triggerType || 'BREAKEVEN_MOVED',
    triggerPrice: toFiniteNumber(triggerPrice),
    entryPrice: getEntryPrice(position),
    side: normalizeSide(position),
    timeframes: captureTimeframes,
    maxBarsByTimeframe: maxBars,
    candlesByTimeframe: buildEmptyCandlesByTimeframe(captureTimeframes),
    lastCapturedAtByTimeframe: buildEmptyLastCaptured(captureTimeframes),
    summary: createEmptySummary(),
  };
}

function normalizeCandle(raw = {}) {
  const time = toIso(raw.time ?? raw.timestamp ?? raw.openTime ?? raw.date);
  if (!time) return null;

  const candle = {
    time,
    open: toFiniteNumber(raw.open),
    high: toFiniteNumber(raw.high),
    low: toFiniteNumber(raw.low),
    close: toFiniteNumber(raw.close),
  };

  if (raw.tickVolume != null || raw.tick_volume != null) {
    candle.tickVolume = toFiniteNumber(raw.tickVolume ?? raw.tick_volume);
  }
  if (raw.volume != null) {
    candle.volume = toFiniteNumber(raw.volume);
  }

  if ([candle.open, candle.high, candle.low, candle.close].some((value) => value == null)) {
    return null;
  }

  return candle;
}

function normalizeValidPostExitCandle(raw = {}, closedAt = null, endAt = null) {
  const candle = normalizeCandle(raw);
  if (!candle || candle.high < candle.low) return null;
  const candleTime = toDate(candle.time)?.getTime();
  const closedAtMs = toDate(closedAt)?.getTime();
  const endAtMs = toDate(endAt)?.getTime();
  if (!Number.isFinite(candleTime)) return null;
  if (Number.isFinite(closedAtMs) && candleTime <= closedAtMs) return null;
  if (Number.isFinite(endAtMs) && candleTime > endAtMs) return null;
  return candle;
}

function shouldCaptureTimeframe(capture = {}, timeframe, now = new Date()) {
  if (!capture || capture.active !== true) return false;
  const tf = String(timeframe || '').toUpperCase();
  if (!tf) return false;

  const maxBars = Number(capture.maxBarsByTimeframe?.[tf] ?? DEFAULT_MAX_BARS_BY_TIMEFRAME[tf] ?? 0);
  const existing = Array.isArray(capture.candlesByTimeframe?.[tf])
    ? capture.candlesByTimeframe[tf]
    : [];
  if (maxBars > 0 && existing.length >= maxBars) return false;

  const lastCapturedAt = toDate(capture.lastCapturedAtByTimeframe?.[tf]);
  if (!lastCapturedAt) return true;

  const throttleMs = CAPTURE_THROTTLE_MS[tf] ?? 5 * 60 * 1000;
  const nowDate = toDate(now) || new Date();
  return nowDate.getTime() - lastCapturedAt.getTime() >= throttleMs;
}

function getAllCapturedCandles(capture = {}) {
  const candlesByTimeframe = capture.candlesByTimeframe || {};
  const byTime = new Map();
  Object.values(candlesByTimeframe).forEach((candles) => {
    if (!Array.isArray(candles)) return;
    candles.forEach((candle) => {
      const normalized = normalizeCandle(candle);
      if (normalized && !byTime.has(normalized.time)) {
        byTime.set(normalized.time, normalized);
      }
    });
  });
  return [...byTime.values()].sort((left, right) => (
    new Date(left.time).getTime() - new Date(right.time).getTime()
  ));
}

function computePriceSummary(candles = [], side) {
  if (!candles.length) {
    return {
      maxFavourableAfterBePrice: null,
      maxAdverseAfterBePrice: null,
    };
  }

  if (side === 'SELL') {
    return {
      maxFavourableAfterBePrice: candles.reduce((min, candle) => Math.min(min, candle.low), candles[0].low),
      maxAdverseAfterBePrice: candles.reduce((max, candle) => Math.max(max, candle.high), candles[0].high),
    };
  }

  return {
    maxFavourableAfterBePrice: candles.reduce((max, candle) => Math.max(max, candle.high), candles[0].high),
    maxAdverseAfterBePrice: candles.reduce((min, candle) => Math.min(min, candle.low), candles[0].low),
  };
}

function hasTouchedTakeProfit(candles = [], position = {}, side) {
  const takeProfit = firstFinite(
    position.currentTp,
    position.finalTp,
    position.initialTp,
    position.initialTP,
    position.tp,
    position.takeProfit
  );
  if (takeProfit == null) return null;
  return candles.some((candle) => (
    side === 'SELL' ? candle.low <= takeProfit : candle.high >= takeProfit
  ));
}

function detectSweptBeThenContinued(candles = [], position = {}, capture = {}, side, initialRisk) {
  if (!(initialRisk > 0)) return null;

  const entryPrice = toFiniteNumber(capture.entryPrice ?? position.entryPrice);
  const triggerPrice = toFiniteNumber(capture.triggerPrice ?? entryPrice);
  if (entryPrice == null || triggerPrice == null) return null;

  const targetPrice = side === 'SELL'
    ? entryPrice - initialRisk
    : entryPrice + initialRisk;
  let swept = false;

  for (const candle of candles) {
    if (!swept) {
      swept = side === 'SELL'
        ? candle.high >= triggerPrice
        : candle.low <= triggerPrice;
    }
    if (swept) {
      const continued = side === 'SELL'
        ? candle.low <= targetPrice
        : candle.high >= targetPrice;
      if (continued) return true;
    }
  }

  return false;
}

function normalizeReasonText(value) {
  return String(value || '').trim().toUpperCase();
}

function managementEventsContainProtection(events = []) {
  const flags = {
    breakeven: false,
    trailing: false,
    protective: false,
  };
  asArray(events).forEach((event) => {
    const typeText = normalizeReasonText(
      event?.type
      || event?.reasonCode
      || event?.action
      || event?.eventType
      || ''
    );
    const text = `${typeText} ${normalizeReasonText(event?.triggerType)} ${normalizeReasonText(event?.details?.reason)}`;
    if (
      text.includes('BREAKEVEN_SET')
      || text.includes('BREAKEVEN_MOVED')
      || text.includes('TRAILING_TO_BE')
      || text.includes('NEWS_PROTECTIVE_BREAKEVEN')
    ) {
      flags.breakeven = true;
    }
    if (text.includes('TRAILING_UPDATED') || text.includes('TRAILING')) {
      flags.trailing = true;
    }
    if (text.includes('PROTECTIVE_SL_HIT') || text.includes('PROTECTIVE')) {
      flags.protective = true;
    }
  });
  return flags;
}

function getAllManagementEvents(trade = {}) {
  const snapshot = getPositionSnapshot(trade);
  return [
    ...asArray(trade.managementEvents || trade.management_events),
    ...asArray(snapshot.managementEvents || snapshot.management_events),
  ];
}

function detectExitProtection(tradeOrPosition = {}) {
  const snapshot = getPositionSnapshot(tradeOrPosition);
  const reason = normalizeReasonText(
    tradeOrPosition.exitReason
    || tradeOrPosition.reason
    || tradeOrPosition.exitReasonDetail
    || tradeOrPosition.pendingExitAction?.type
    || snapshot.exitReason
    || snapshot.reason
    || ''
  );
  const side = normalizeTradeSide(tradeOrPosition) || normalizeTradeSide(snapshot);
  const originalSl = firstFinite(
    tradeOrPosition.originalSl,
    tradeOrPosition.initialSl,
    tradeOrPosition.initialSL,
    tradeOrPosition.sl,
    tradeOrPosition.stopLoss,
    snapshot.originalSl,
    snapshot.initialSl,
    snapshot.initialSL,
    snapshot.sl,
    snapshot.stopLoss
  );
  const finalSl = firstFinite(
    tradeOrPosition.finalSl,
    tradeOrPosition.finalSL,
    tradeOrPosition.currentSl,
    tradeOrPosition.currentSL,
    tradeOrPosition.stopLossCurrent,
    snapshot.finalSl,
    snapshot.finalSL,
    snapshot.currentSl,
    snapshot.currentSL
  );
  const directBreakeven = tradeOrPosition.breakevenActivated === true
    || snapshot.breakevenActivated === true
    || reason === 'BREAKEVEN'
    || reason === 'BREAKEVEN_SL_HIT'
    || reason.includes('BREAKEVEN');
  const directTrailing = tradeOrPosition.trailingActivated === true
    || snapshot.trailingActivated === true
    || reason === 'TRAILING_SL_HIT'
    || reason.includes('TRAILING');
  const directProtective = reason === 'PROTECTIVE_SL_HIT'
    || reason.includes('PROTECTIVE');
  const eventFlags = managementEventsContainProtection(getAllManagementEvents(tradeOrPosition));
  const protectiveSlMoved = side === 'BUY'
    ? (finalSl != null && originalSl != null && finalSl > originalSl)
    : (side === 'SELL' && finalSl != null && originalSl != null && finalSl < originalSl);

  const trailing = directTrailing || eventFlags.trailing;
  const breakeven = directBreakeven || eventFlags.breakeven;
  const protective = directProtective || eventFlags.protective;
  const eligible = Boolean(trailing || breakeven || protective || protectiveSlMoved);

  let exitProtectionType = null;
  if (trailing) exitProtectionType = EXIT_PROTECTION_TYPES.TRAILING;
  else if (breakeven) exitProtectionType = EXIT_PROTECTION_TYPES.BREAKEVEN;
  else if (protective) exitProtectionType = EXIT_PROTECTION_TYPES.PROTECTIVE_SL;
  else if (protectiveSlMoved) exitProtectionType = EXIT_PROTECTION_TYPES.UNKNOWN_PROTECTIVE;

  return {
    eligible,
    exitProtectionType,
    reasons: {
      reason,
      breakeven,
      trailing,
      protective,
      protectiveSlMoved,
    },
  };
}

function isBreakevenOrProtectiveExit(tradeOrPosition = {}) {
  return detectExitProtection(tradeOrPosition).eligible === true;
}

function isProtectiveStopExit(position = {}) {
  return isBreakevenOrProtectiveExit(position);
}

function classifyPostBeOutcome({ summary = {}, position = {}, candleCount = 0 } = {}) {
  if (candleCount < 2) return 'BE_DATA_INSUFFICIENT';

  const favR = toFiniteNumber(summary.maxFavourableAfterBeR);
  const adverseR = toFiniteNumber(summary.maxAdverseAfterBeR);
  if (favR == null || adverseR == null) return 'BE_DATA_INSUFFICIENT';

  const realizedR = toFiniteNumber(position.realizedRMultiple);
  if (summary.sweptBeThenContinued === true || (adverseR >= 0.05 && favR >= 1)) {
    return 'BE_TOO_EARLY_CONTINUED';
  }
  if (favR >= 1.5 && realizedR != null && realizedR < 0.5) {
    return 'BE_MISSED_RUNNER';
  }
  if (adverseR >= 0.25 && (isProtectiveStopExit(position) || (realizedR != null && realizedR <= 0.3))) {
    return 'BE_PROTECTED_GOOD';
  }
  if (favR < 0.7 && adverseR < 0.7) {
    return 'BE_NO_VALUE';
  }

  return null;
}

function summarizePostBeCandles(capture = {}, position = {}) {
  const side = normalizeSide({ ...position, type: capture.side || position.type });
  const entryPrice = toFiniteNumber(capture.entryPrice ?? position.entryPrice);
  const initialSl = getInitialSl(position);
  const initialRisk = entryPrice != null && initialSl != null ? Math.abs(entryPrice - initialSl) : null;
  const candles = getAllCapturedCandles(capture);
  const priceSummary = computePriceSummary(candles, side);
  const favPrice = priceSummary.maxFavourableAfterBePrice;
  const adversePrice = priceSummary.maxAdverseAfterBePrice;

  let favR = null;
  let adverseR = null;
  if (entryPrice != null && initialRisk > 0 && favPrice != null && adversePrice != null) {
    const favDistance = side === 'SELL' ? entryPrice - favPrice : favPrice - entryPrice;
    const adverseDistance = side === 'SELL' ? adversePrice - entryPrice : entryPrice - adversePrice;
    favR = roundNumber(Math.max(0, favDistance) / initialRisk);
    adverseR = roundNumber(Math.max(0, adverseDistance) / initialRisk);
  }

  const summary = {
    maxFavourableAfterBePrice: favPrice,
    maxAdverseAfterBePrice: adversePrice,
    maxFavourableAfterBeR: favR,
    maxAdverseAfterBeR: adverseR,
    sweptBeThenContinued: detectSweptBeThenContinued(candles, position, capture, side, initialRisk),
    movedToTpAfterBe: hasTouchedTakeProfit(candles, position, side),
    classification: null,
  };

  summary.classification = classifyPostBeOutcome({
    summary,
    position,
    candleCount: candles.length,
  });

  return summary;
}

function buildPostExitAnalysisContext(trade = {}) {
  const snapshot = getPositionSnapshot(trade);
  const side = normalizeTradeSide(firstDefined(
    trade.type,
    trade.side,
    trade.direction,
    trade.signal,
    snapshot.type,
    snapshot.side,
    snapshot.direction,
    snapshot.signal
  ));
  const entryPrice = firstFinite(trade.entryPrice, trade.openPrice, snapshot.entryPrice, snapshot.openPrice);
  const exitPrice = firstFinite(trade.exitPrice, trade.closePrice, snapshot.exitPrice, snapshot.closePrice);
  const originalSl = firstFinite(
    trade.originalSl,
    trade.initialSl,
    trade.initialSL,
    trade.sl,
    trade.stopLoss,
    snapshot.originalSl,
    snapshot.initialSl,
    snapshot.initialSL,
    snapshot.sl,
    snapshot.stopLoss
  );
  const originalTp = firstFinite(
    trade.originalTp,
    trade.initialTp,
    trade.initialTP,
    trade.tp,
    trade.takeProfit,
    snapshot.originalTp,
    snapshot.initialTp,
    snapshot.initialTP,
    snapshot.tp,
    snapshot.takeProfit
  );
  const closedAt = toIso(firstDefined(trade.closedAt, trade.closed_at, trade.exitTime, trade.closeTime, snapshot.closedAt, snapshot.exitTime));
  const symbol = String(firstDefined(trade.symbol, snapshot.symbol, '') || '').trim() || null;
  const riskDistance = entryPrice != null && originalSl != null ? Math.abs(entryPrice - originalSl) : null;

  let insufficientReason = null;
  if (!side) insufficientReason = 'missing_side';
  else if (entryPrice == null) insufficientReason = 'missing_entry_price';
  else if (exitPrice == null) insufficientReason = 'missing_exit_price';
  else if (originalSl == null) insufficientReason = 'missing_original_sl';
  else if (!closedAt) insufficientReason = 'missing_closed_at';
  else if (!symbol) insufficientReason = 'missing_symbol';
  else if (!(riskDistance > 0)) insufficientReason = 'invalid_risk_distance';

  return {
    valid: !insufficientReason,
    insufficientReason,
    side,
    entryPrice,
    exitPrice,
    originalSl,
    originalTp,
    closedAt,
    symbol,
    riskDistance,
    exitProtectionType: detectExitProtection(trade).exitProtectionType || EXIT_PROTECTION_TYPES.UNKNOWN_PROTECTIVE,
  };
}

function createPendingPostExitCapture({
  trade = {},
  closedAt = null,
  now = new Date(),
  timeframes = DEFAULT_TIMEFRAMES,
  maxBarsByTimeframe = DEFAULT_MAX_BARS_BY_TIMEFRAME,
  minimumCandlesByTimeframe = DEFAULT_MINIMUM_CANDLES_BY_TIMEFRAME,
  windowMinutes = DEFAULT_POST_EXIT_WINDOW_MINUTES,
} = {}) {
  const captureTimeframes = normalizeTimeframes(timeframes);
  const startIso = toIso(closedAt) || buildPostExitAnalysisContext(trade).closedAt || toIso(now) || new Date().toISOString();
  const startDate = toDate(startIso) || new Date();
  const endAt = new Date(startDate.getTime() + windowMinutes * 60 * 1000);
  const maxBars = {
    ...DEFAULT_MAX_BARS_BY_TIMEFRAME,
    ...(maxBarsByTimeframe || {}),
  };
  const minimumCandles = {
    ...DEFAULT_MINIMUM_CANDLES_BY_TIMEFRAME,
    ...(minimumCandlesByTimeframe || {}),
  };
  const protection = detectExitProtection(trade);

  return {
    active: true,
    status: POST_EXIT_STATUSES.PENDING,
    startedAt: startIso,
    endAt: endAt.toISOString(),
    timeframes: captureTimeframes,
    maxBarsByTimeframe: maxBars,
    minimumCandlesByTimeframe: minimumCandles,
    candlesByTimeframe: buildEmptyCandlesByTimeframe(captureTimeframes),
    summary: null,
    classification: 'BE_DATA_INSUFFICIENT',
    coverage: {
      hasPostExit: true,
      capturedTimeframes: [],
      missingTimeframes: captureTimeframes,
      validCandleCounts: buildZeroCountsByTimeframe(captureTimeframes),
      coverageComplete: false,
    },
    exitProtectionType: protection.exitProtectionType || EXIT_PROTECTION_TYPES.UNKNOWN_PROTECTIVE,
    windowMinutes,
    attemptCount: 0,
    lastAttemptAt: null,
    lastError: null,
    completedAt: null,
  };
}

function mergePostExitCandlesByTimeframe(postExit = {}, timeframe, candles = []) {
  const tf = String(timeframe || '').toUpperCase();
  if (!tf) return postExit;
  const maxBars = Number(postExit.maxBarsByTimeframe?.[tf] ?? DEFAULT_MAX_BARS_BY_TIMEFRAME[tf] ?? 0);
  const existing = Array.isArray(postExit.candlesByTimeframe?.[tf])
    ? postExit.candlesByTimeframe[tf]
    : [];
  const byTime = new Map();
  existing
    .map((candle) => normalizeValidPostExitCandle(candle, postExit.startedAt, postExit.endAt))
    .filter(Boolean)
    .forEach((candle) => byTime.set(candle.time, candle));
  (Array.isArray(candles) ? candles : [])
    .map((candle) => normalizeValidPostExitCandle(candle, postExit.startedAt, postExit.endAt))
    .filter(Boolean)
    .forEach((candle) => byTime.set(candle.time, candle));

  const sorted = [...byTime.values()].sort((left, right) => (
    new Date(left.time).getTime() - new Date(right.time).getTime()
  ));
  return {
    ...postExit,
    candlesByTimeframe: {
      ...(postExit.candlesByTimeframe || {}),
      [tf]: maxBars > 0 ? sorted.slice(0, maxBars) : sorted,
    },
  };
}

function buildCoverage(postExit = {}, context = null) {
  const timeframes = normalizeTimeframes(postExit.timeframes);
  const minimum = {
    ...DEFAULT_MINIMUM_CANDLES_BY_TIMEFRAME,
    ...(postExit.minimumCandlesByTimeframe || {}),
  };
  const validCandleCounts = {};
  const capturedTimeframes = [];
  const missingTimeframes = [];
  timeframes.forEach((timeframe) => {
    const candles = Array.isArray(postExit.candlesByTimeframe?.[timeframe])
      ? postExit.candlesByTimeframe[timeframe]
      : [];
    const validCandles = candles
      .map((candle) => normalizeValidPostExitCandle(
        candle,
        context?.closedAt || postExit.startedAt,
        postExit.endAt
      ))
      .filter(Boolean);
    validCandleCounts[timeframe] = validCandles.length;
    if (validCandles.length >= Number(minimum[timeframe] || 1)) {
      capturedTimeframes.push(timeframe);
    } else {
      missingTimeframes.push(timeframe);
    }
  });

  return {
    hasPostExit: true,
    capturedTimeframes,
    missingTimeframes,
    validCandleCounts,
    coverageComplete: missingTimeframes.length === 0,
  };
}

function summarizeTimeframePostExit({ candles = [], context, timeframe, minimumCount }) {
  const validCandles = candles
    .map((candle) => normalizeValidPostExitCandle(candle, context.closedAt, context.endAt))
    .filter(Boolean);
  const valid = validCandles.length >= minimumCount;
  if (!valid) {
    return {
      timeframe,
      valid: false,
      candleCount: validCandles.length,
      minimumCount,
      maxFavourablePriceAfterExit: null,
      maxAdversePriceAfterExit: null,
      favourableAfterExitR: null,
      adverseAfterExitR: null,
      reachedOriginalTp: null,
      reachedOriginalSl: null,
    };
  }

  const priceSummary = computePriceSummary(validCandles, context.side);
  const favPrice = priceSummary.maxFavourableAfterBePrice;
  const adversePrice = priceSummary.maxAdverseAfterBePrice;
  const favourableAfterExitR = context.side === 'SELL'
    ? (context.exitPrice - favPrice) / context.riskDistance
    : (favPrice - context.exitPrice) / context.riskDistance;
  const adverseAfterExitR = context.side === 'SELL'
    ? (context.exitPrice - adversePrice) / context.riskDistance
    : (adversePrice - context.exitPrice) / context.riskDistance;
  const reachedOriginalTp = context.originalTp == null
    ? null
    : validCandles.some((candle) => (
        context.side === 'SELL' ? candle.low <= context.originalTp : candle.high >= context.originalTp
      ));
  const reachedOriginalSl = validCandles.some((candle) => (
    context.side === 'SELL' ? candle.high >= context.originalSl : candle.low <= context.originalSl
  ));

  return {
    timeframe,
    valid: true,
    candleCount: validCandles.length,
    minimumCount,
    maxFavourablePriceAfterExit: favPrice,
    maxAdversePriceAfterExit: adversePrice,
    favourableAfterExitR: roundNumber(favourableAfterExitR),
    adverseAfterExitR: roundNumber(adverseAfterExitR),
    reachedOriginalTp,
    reachedOriginalSl,
  };
}

function classifyPostExitSummary(summary = {}, thresholds = DEFAULT_CLASSIFICATION_THRESHOLDS) {
  if (!summary || summary.insufficientReason) return 'BE_DATA_INSUFFICIENT';
  const favR = toFiniteNumber(summary.favourableAfterExitR);
  const adverseR = toFiniteNumber(summary.adverseAfterExitR);
  if (favR == null || adverseR == null) return 'BE_DATA_INSUFFICIENT';
  if (favR >= thresholds.missedRunnerMinR || summary.reachedOriginalTp === true) return 'BE_MISSED_RUNNER';
  if (favR >= thresholds.continuedMinR) return 'BE_TOO_EARLY_CONTINUED';
  if (adverseR <= thresholds.protectedGoodAdverseR) return 'BE_PROTECTED_GOOD';
  if (Math.abs(favR) < thresholds.noValueAbsR && Math.abs(adverseR) < thresholds.noValueAbsR) return 'BE_NO_VALUE';
  return 'BE_NO_VALUE';
}

function summarizePostExitCandles(postExit = {}, trade = {}) {
  const context = buildPostExitAnalysisContext(trade);
  const coverage = buildCoverage(postExit, context.valid ? context : null);
  const windowMinutes = Number(postExit.windowMinutes || DEFAULT_POST_EXIT_WINDOW_MINUTES);
  const baseSummary = {
    side: context.side,
    entryPrice: context.entryPrice,
    exitPrice: context.exitPrice,
    originalSl: context.originalSl,
    originalTp: context.originalTp,
    riskDistance: context.riskDistance,
    maxFavourablePriceAfterExit: null,
    maxAdversePriceAfterExit: null,
    favourableAfterExitR: null,
    adverseAfterExitR: null,
    reachedOriginalTp: null,
    reachedOriginalSl: null,
    candlesCapturedByTimeframe: coverage.validCandleCounts,
    validTimeframes: coverage.capturedTimeframes,
    coverage,
    windowMinutes,
    exitProtectionType: postExit.exitProtectionType || context.exitProtectionType,
    perTimeframe: {},
    classificationThresholds: {
      ...DEFAULT_CLASSIFICATION_THRESHOLDS,
      ...(postExit.classificationThresholds || {}),
    },
  };

  if (!context.valid) {
    const summary = {
      ...baseSummary,
      insufficientReason: context.insufficientReason,
      classification: 'BE_DATA_INSUFFICIENT',
    };
    return { summary, classification: summary.classification, coverage };
  }

  const enrichedContext = {
    ...context,
    endAt: postExit.endAt,
  };
  const minimum = {
    ...DEFAULT_MINIMUM_CANDLES_BY_TIMEFRAME,
    ...(postExit.minimumCandlesByTimeframe || {}),
  };
  const timeframes = normalizeTimeframes(postExit.timeframes);
  const perTimeframe = {};
  timeframes.forEach((timeframe) => {
    perTimeframe[timeframe] = summarizeTimeframePostExit({
      candles: postExit.candlesByTimeframe?.[timeframe] || [],
      context: enrichedContext,
      timeframe,
      minimumCount: Number(minimum[timeframe] || 1),
    });
  });

  const validSummaries = Object.values(perTimeframe).filter((summary) => summary.valid);
  if (validSummaries.length === 0) {
    const summary = {
      ...baseSummary,
      perTimeframe,
      insufficientReason: 'insufficient_valid_post_exit_candles',
      classification: 'BE_DATA_INSUFFICIENT',
    };
    return { summary, classification: summary.classification, coverage };
  }

  const favourableSummary = validSummaries.reduce((best, item) => (
    best == null || item.favourableAfterExitR > best.favourableAfterExitR ? item : best
  ), null);
  const adverseSummary = validSummaries.reduce((worst, item) => (
    worst == null || item.adverseAfterExitR < worst.adverseAfterExitR ? item : worst
  ), null);
  const reachedOriginalTp = validSummaries.some((summary) => summary.reachedOriginalTp === true);
  const reachedOriginalSl = validSummaries.some((summary) => summary.reachedOriginalSl === true);
  const summary = {
    ...baseSummary,
    maxFavourablePriceAfterExit: favourableSummary?.maxFavourablePriceAfterExit ?? null,
    maxAdversePriceAfterExit: adverseSummary?.maxAdversePriceAfterExit ?? null,
    favourableAfterExitR: favourableSummary?.favourableAfterExitR ?? null,
    adverseAfterExitR: adverseSummary?.adverseAfterExitR ?? null,
    reachedOriginalTp,
    reachedOriginalSl,
    perTimeframe,
  };
  summary.classification = classifyPostExitSummary(summary, summary.classificationThresholds);
  return { summary, classification: summary.classification, coverage };
}

function areAllTimeframesComplete(capture = {}) {
  const timeframes = Array.isArray(capture.timeframes) ? capture.timeframes : DEFAULT_TIMEFRAMES;
  return timeframes.every((timeframe) => {
    const tf = String(timeframe).toUpperCase();
    const maxBars = Number(capture.maxBarsByTimeframe?.[tf] ?? DEFAULT_MAX_BARS_BY_TIMEFRAME[tf] ?? 0);
    const candles = Array.isArray(capture.candlesByTimeframe?.[tf])
      ? capture.candlesByTimeframe[tf]
      : [];
    return maxBars > 0 && candles.length >= maxBars;
  });
}

function mergeCandlesIntoCapture(capture = {}, candles = [], timeframe, position = {}, now = new Date()) {
  const tf = String(timeframe || '').toUpperCase();
  const next = {
    ...clone(capture),
    candlesByTimeframe: {
      ...(capture.candlesByTimeframe || {}),
    },
    lastCapturedAtByTimeframe: {
      ...(capture.lastCapturedAtByTimeframe || {}),
    },
    maxBarsByTimeframe: {
      ...DEFAULT_MAX_BARS_BY_TIMEFRAME,
      ...(capture.maxBarsByTimeframe || {}),
    },
  };

  const startedAtMs = toDate(next.startedAt)?.getTime() ?? 0;
  const existing = Array.isArray(next.candlesByTimeframe[tf])
    ? next.candlesByTimeframe[tf].map(normalizeCandle).filter(Boolean)
    : [];
  const seenTimes = new Set(existing.map((candle) => candle.time));
  const incoming = Array.isArray(candles) ? candles : [];
  let changed = false;

  incoming
    .map(normalizeCandle)
    .filter(Boolean)
    .filter((candle) => new Date(candle.time).getTime() >= startedAtMs)
    .forEach((candle) => {
      if (seenTimes.has(candle.time)) return;
      seenTimes.add(candle.time);
      existing.push(candle);
      changed = true;
    });

  const maxBars = Number(next.maxBarsByTimeframe[tf] ?? DEFAULT_MAX_BARS_BY_TIMEFRAME[tf] ?? 0);
  const sorted = existing.sort((left, right) => (
    new Date(left.time).getTime() - new Date(right.time).getTime()
  ));
  next.candlesByTimeframe[tf] = maxBars > 0 ? sorted.slice(0, maxBars) : sorted;
  next.lastCapturedAtByTimeframe[tf] = toIso(now) || new Date().toISOString();
  next.summary = summarizePostBeCandles(next, position);

  if (next.active === true && areAllTimeframesComplete(next)) {
    next.active = false;
    next.completedAt = next.completedAt || (toIso(now) || new Date().toISOString());
    next.summary = summarizePostBeCandles(next, position);
    changed = true;
  }

  return {
    capture: next,
    changed: changed || next.lastCapturedAtByTimeframe[tf] !== capture.lastCapturedAtByTimeframe?.[tf],
  };
}

function markCaptureAttempt(capture = {}, timeframe, now = new Date()) {
  const tf = String(timeframe || '').toUpperCase();
  const next = {
    ...clone(capture),
    lastCapturedAtByTimeframe: {
      ...(capture.lastCapturedAtByTimeframe || {}),
      [tf]: toIso(now) || new Date().toISOString(),
    },
  };
  return next;
}

function ensurePendingPostExitCapture(capture = {}, trade = {}, options = {}) {
  const next = {
    ...(capture ? clone(capture) : {}),
  };
  const existingPostExit = next.postExit && typeof next.postExit === 'object' ? next.postExit : null;
  if (existingPostExit?.status === POST_EXIT_STATUSES.COMPLETED && options.force !== true) {
    return next;
  }
  next.postExit = existingPostExit || createPendingPostExitCapture({
    trade,
    closedAt: options.closedAt,
    now: options.now,
  });
  return next;
}

function finalizePostBeCaptureForClose(position = {}, closedData = {}) {
  const existingCapture = position.postBreakevenCandleCapture;
  const closedAt = toIso(closedData.closedAt) || new Date().toISOString();
  const tradeContext = {
    ...position,
    ...closedData,
    closedAt,
    exitReason: closedData.exitReason ?? position.exitReason,
    exitPrice: closedData.exitPrice ?? position.exitPrice ?? position.currentPrice ?? position.entryPrice,
    realizedRMultiple: closedData.realizedRMultiple ?? position.realizedRMultiple,
    finalSl: position.currentSl ?? position.finalSl ?? position.sl ?? null,
    finalTp: position.currentTp ?? position.finalTp ?? position.tp ?? null,
  };
  const protection = detectExitProtection(tradeContext);
  if (!existingCapture && !protection.eligible) return null;

  const next = existingCapture
    ? {
        ...clone(existingCapture),
        active: false,
        completedAt: existingCapture.completedAt || closedAt,
      }
    : {
        active: false,
        startedAt: closedAt,
        completedAt: closedAt,
        timeframes: [...DEFAULT_TIMEFRAMES],
        maxBarsByTimeframe: { ...DEFAULT_MAX_BARS_BY_TIMEFRAME },
        candlesByTimeframe: buildEmptyCandlesByTimeframe(DEFAULT_TIMEFRAMES),
        lastCapturedAtByTimeframe: buildEmptyLastCaptured(DEFAULT_TIMEFRAMES),
        summary: createEmptySummary(),
      };

  next.summary = summarizePostBeCandles(next, tradeContext);
  if (protection.eligible) {
    next.postExit = next.postExit || createPendingPostExitCapture({
      trade: tradeContext,
      closedAt,
    });
  }
  return next;
}

function getPostBeCaptureCounts(capture = {}) {
  const candlesByTimeframe = capture?.candlesByTimeframe || {};
  return {
    M1: Array.isArray(candlesByTimeframe.M1) ? candlesByTimeframe.M1.length : 0,
    M5: Array.isArray(candlesByTimeframe.M5) ? candlesByTimeframe.M5.length : 0,
    M15: Array.isArray(candlesByTimeframe.M15) ? candlesByTimeframe.M15.length : 0,
  };
}

module.exports = {
  CAPTURE_THROTTLE_MS,
  DEFAULT_CLASSIFICATION_THRESHOLDS,
  DEFAULT_MAX_BARS_BY_TIMEFRAME,
  DEFAULT_MINIMUM_CANDLES_BY_TIMEFRAME,
  DEFAULT_POST_EXIT_WINDOW_MINUTES,
  DEFAULT_TIMEFRAMES,
  EXIT_PROTECTION_TYPES,
  POST_EXIT_STATUSES,
  buildCoverage,
  buildPostExitAnalysisContext,
  classifyPostBeOutcome,
  classifyPostExitSummary,
  createInitialPostBeCaptureState,
  createPendingPostExitCapture,
  detectExitProtection,
  ensurePendingPostExitCapture,
  finalizePostBeCaptureForClose,
  getPostBeCaptureCounts,
  hasActiveOrCompletedCapture,
  isBreakevenOrProtectiveExit,
  isStopAtOrBeyondBreakeven,
  markCaptureAttempt,
  mergeCandlesIntoCapture,
  mergePostExitCandlesByTimeframe,
  normalizeCandle,
  normalizeTradeSide,
  normalizeValidPostExitCandle,
  shouldCaptureTimeframe,
  summarizePostBeCandles,
  summarizePostExitCandles,
};
