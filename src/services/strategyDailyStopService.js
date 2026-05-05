/**
 * Strategy-level daily stop service.
 *
 * For every `scope + strategy + symbol + timeframe` key, counts consecutive
 * losses inside a single trading day. When the count reaches the configured
 * threshold, blocks any NEW entries for that key for the rest of the day.
 * Existing positions are not affected (exits, break-even, trailing, partial
 * close, time-exit all continue to run).
 *
 * State is persisted per (key, tradingDay) so the stop status survives
 * process restarts. On the next trading day the state is ignored (lazy
 * reset) and new entries are allowed again.
 *
 * This sits alongside — and does NOT replace — the account-level daily
 * loss control implemented in RiskManager.
 */

const RiskProfile = require('../models/RiskProfile');
const { strategyDailyStopsDb } = require('../config/db');
const auditService = require('./auditService');

const DEFAULT_TZ = 'Asia/Kuala_Lumpur';

// Fixed-offset timezones we support with deterministic math. Timezones with
// DST (e.g. America/New_York) fall back to `Asia/Kuala_Lumpur` (+08:00) in
// v1 to avoid day-boundary ambiguity; the full Intl path can be wired in
// later if users request it.
const FIXED_OFFSET_MINUTES = Object.freeze({
  'UTC': 0,
  'Asia/Kuala_Lumpur': 480,
  'Asia/Singapore': 480,
  'Asia/Shanghai': 480,
  'Asia/Hong_Kong': 480,
  'Asia/Tokyo': 540,
  'Asia/Seoul': 540,
  'Australia/Perth': 480,
});

function tzOffsetMinutes(tz) {
  if (tz && Object.prototype.hasOwnProperty.call(FIXED_OFFSET_MINUTES, tz)) {
    return FIXED_OFFSET_MINUTES[tz];
  }
  return FIXED_OFFSET_MINUTES[DEFAULT_TZ];
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function normalizeScope(scope = 'live') {
  const normalized = String(scope || 'live').trim().toLowerCase();
  if (normalized === 'live' || normalized === 'paper') {
    return normalized;
  }
  throw new Error(`Invalid strategy daily stop scope: ${scope}`);
}

function buildKey(scopeOrArgs, maybeStrategy, maybeSymbol, maybeTimeframe) {
  let scope = 'live';
  let strategy = scopeOrArgs;
  let symbol = maybeStrategy;
  let timeframe = maybeSymbol;

  if (scopeOrArgs && typeof scopeOrArgs === 'object') {
    scope = scopeOrArgs.scope || 'live';
    strategy = scopeOrArgs.strategy;
    symbol = scopeOrArgs.symbol;
    timeframe = scopeOrArgs.timeframe;
  } else if (arguments.length >= 4) {
    scope = scopeOrArgs || 'live';
    strategy = maybeStrategy;
    symbol = maybeSymbol;
    timeframe = maybeTimeframe;
  }

  return [
    normalizeScope(scope),
    String(strategy || '').trim(),
    String(symbol || '').trim(),
    String(timeframe || '').trim(),
  ].join(':');
}

/**
 * Given a wall-clock moment, compute which "trading day" it belongs to and
 * the UTC instant at which that day ends (= reset boundary).
 *
 * Trading day D spans
 *   [D @ resetHour:resetMinute in tz, D+1 @ resetHour:resetMinute in tz)
 *
 * The returned `tradingDay` is formatted `YYYY-MM-DD` and is the local date
 * of the START of the window. `resetAt` is the UTC ISO string of the END.
 */
function resolveTradingDay(nowDate, config) {
  const date = nowDate instanceof Date ? nowDate : new Date(nowDate || Date.now());
  const tz = (config && config.resetTimezone) || DEFAULT_TZ;
  const resetHour = config && Number.isFinite(config.resetHour) ? config.resetHour : 0;
  const resetMinute = config && Number.isFinite(config.resetMinute) ? config.resetMinute : 0;
  const offsetMinutes = tzOffsetMinutes(tz);

  const tzLocalMs = date.getTime() + offsetMinutes * 60_000;
  const tzLocal = new Date(tzLocalMs);
  const y = tzLocal.getUTCFullYear();
  const mo = tzLocal.getUTCMonth();
  const d = tzLocal.getUTCDate();
  const h = tzLocal.getUTCHours();
  const m = tzLocal.getUTCMinutes();

  const afterReset = (h > resetHour) || (h === resetHour && m >= resetMinute);

  let dayY = y;
  let dayMo = mo;
  let dayD = d;
  if (!afterReset) {
    const prev = new Date(Date.UTC(y, mo, d - 1));
    dayY = prev.getUTCFullYear();
    dayMo = prev.getUTCMonth();
    dayD = prev.getUTCDate();
  }

  const tradingDay = `${dayY}-${pad2(dayMo + 1)}-${pad2(dayD)}`;

  const resetUtcMs = Date.UTC(
    dayY,
    dayMo,
    dayD + 1,
    resetHour,
    resetMinute
  ) - offsetMinutes * 60_000;

  return {
    tradingDay,
    resetAt: new Date(resetUtcMs).toISOString(),
  };
}

function computeTradeR({ tradeR, realizedRMultiple, profitLoss, plannedRiskAmount }) {
  if (Number.isFinite(Number(tradeR))) return Number(tradeR);
  if (Number.isFinite(Number(realizedRMultiple))) return Number(realizedRMultiple);

  const pl = Number(profitLoss);
  const risk = Number(plannedRiskAmount);
  if (Number.isFinite(pl) && Number.isFinite(risk) && risk > 0) {
    return pl / risk;
  }

  // Fall back to sign-only classification from raw P&L.
  if (Number.isFinite(pl)) {
    if (pl > 0) return Number.POSITIVE_INFINITY;
    if (pl < 0) return Number.NEGATIVE_INFINITY;
    return 0;
  }

  return null;
}

function classify(tradeR, config) {
  const epsilon = Number(config.breakevenEpsilonR) || 0;
  const smallLossFloor = Number(config.smallLossThresholdR);

  if (!Number.isFinite(tradeR)) {
    if (tradeR === Number.POSITIVE_INFINITY) return 'win';
    if (tradeR === Number.NEGATIVE_INFINITY) return 'loss';
    return 'unknown';
  }

  if (tradeR > epsilon) return 'win';
  if (tradeR >= -epsilon) return 'breakeven';
  if (Number.isFinite(smallLossFloor) && tradeR >= smallLossFloor) return 'small_loss';
  return 'loss';
}

// In-memory counter — resets when tradingDay changes.
const blockedEntryCounterState = {
  tradingDay: null,
  countsByKey: Object.create(null),
  totalByScope: Object.create(null),
};

function ensureBlockedCounterFresh(tradingDay) {
  if (blockedEntryCounterState.tradingDay !== tradingDay) {
    blockedEntryCounterState.tradingDay = tradingDay;
    blockedEntryCounterState.countsByKey = Object.create(null);
    blockedEntryCounterState.totalByScope = Object.create(null);
  }
}

async function getActiveConfig() {
  try {
    const profile = await RiskProfile.getActive();
    return RiskProfile.getStrategyDailyStop(profile);
  } catch (_) {
    return RiskProfile.getDefaultStrategyDailyStop();
  }
}

function buildDocId(key, tradingDay) {
  return `${key}|${tradingDay}`;
}

async function findRecord(key, tradingDay) {
  try {
    return await strategyDailyStopsDb.findOne({ _id: buildDocId(key, tradingDay) });
  } catch (_) {
    return null;
  }
}

async function upsertRecord(doc) {
  const _id = buildDocId(doc.key, doc.tradingDay);
  const payload = { ...doc, _id, updatedAt: new Date().toISOString() };
  try {
    await strategyDailyStopsDb.update({ _id }, payload, { upsert: true });
  } catch (_) {
    // Never throw from this path — accounting failures must not block trading.
  }
  return payload;
}

/**
 * True if a new entry for this {strategy, symbol, timeframe} is currently
 * blocked by the strategy-daily-stop. Reading only — does not mutate state.
 *
 * Also returns the underlying record so callers can surface details in audit
 * logs.
 */
async function isEntryBlocked({ scope = 'live', strategy, symbol, timeframe, now = new Date() }, configOverride = null) {
  const normalizedScope = normalizeScope(scope);
  const config = configOverride || await getActiveConfig();
  if (!config || config.enabled === false) {
    return { blocked: false, config, record: null, scope: normalizedScope };
  }

  const key = buildKey({ scope: normalizedScope, strategy, symbol, timeframe });
  const { tradingDay, resetAt } = resolveTradingDay(now, config);
  const record = await findRecord(key, tradingDay);

  if (!record || !record.stopped) {
    return { blocked: false, config, record: record || null, key, scope: normalizedScope, tradingDay, resetAt };
  }

  if (record.resetAt && new Date(record.resetAt).getTime() <= new Date(now).getTime()) {
    return { blocked: false, config, record, key, scope: normalizedScope, tradingDay, resetAt, expired: true };
  }

  return { blocked: true, config, record, key, scope: normalizedScope, tradingDay, resetAt };
}

/**
 * Called from the risk gate when a new-entry attempt is blocked. Tracks the
 * counter shown on the status endpoint and emits an audit event.
 */
function recordBlockedEntry({ scope = 'live', strategy, symbol, timeframe, tradingDay, record = null, details = null }) {
  const normalizedScope = normalizeScope(scope);
  const key = buildKey({ scope: normalizedScope, strategy, symbol, timeframe });
  ensureBlockedCounterFresh(tradingDay);
  blockedEntryCounterState.countsByKey[key] = (blockedEntryCounterState.countsByKey[key] || 0) + 1;
  blockedEntryCounterState.totalByScope[normalizedScope] = (blockedEntryCounterState.totalByScope[normalizedScope] || 0) + 1;

  try {
    auditService.riskRejected({
      symbol,
      strategy,
      module: 'strategyDailyStopService',
      scope: normalizedScope,
      setupTimeframe: timeframe,
      reasonCode: auditService.REASON.STRATEGY_DAILY_STOP_ACTIVE,
      reasonText: `Strategy daily stop active for ${key} (tradingDay=${tradingDay})`,
      riskCheck: {
        reasonCode: auditService.REASON.STRATEGY_DAILY_STOP_ACTIVE,
        blockReason: 'strategy_daily_stop',
      },
      details: {
        blockReason: 'strategy_daily_stop',
        scope: normalizedScope,
        key,
        tradingDay,
        consecutiveLossCountAtStop: record?.consecutiveLossCountAtStop || null,
        stoppedAt: record?.stoppedAt || null,
        resetAt: record?.resetAt || null,
        ...(details || {}),
      },
    });
  } catch (_) {}
}

function getBlockedEntriesToday(tradingDay, scope = 'live') {
  const normalizedScope = normalizeScope(scope);
  if (tradingDay && blockedEntryCounterState.tradingDay !== tradingDay) {
    return 0;
  }
  return blockedEntryCounterState.totalByScope[normalizedScope] || 0;
}

/**
 * Called on every trade close. Applies classification and, if the threshold
 * is reached, flips the record to `stopped=true`.
 *
 * Accepts raw trade fields; any of `tradeR`, `realizedRMultiple`, or
 * `(profitLoss + plannedRiskAmount)` are sufficient.
 */
async function recordTradeOutcome({
  scope = 'live',
  strategy,
  symbol,
  timeframe,
  tradeR,
  realizedRMultiple,
  profitLoss,
  plannedRiskAmount,
  closedAt,
}, configOverride = null) {
  const normalizedScope = normalizeScope(scope);
  const config = configOverride || await getActiveConfig();
  if (!config || config.enabled === false) return null;
  if (!strategy || !symbol || !timeframe) return null;

  const resolvedTradeR = computeTradeR({ tradeR, realizedRMultiple, profitLoss, plannedRiskAmount });
  const classification = classify(resolvedTradeR, config);
  if (classification === 'unknown') return null;

  const now = closedAt ? new Date(closedAt) : new Date();
  const { tradingDay, resetAt } = resolveTradingDay(now, config);
  const key = buildKey({ scope: normalizedScope, strategy, symbol, timeframe });
  const existing = await findRecord(key, tradingDay);

  // Seed a new per-day doc when none exists.
  const doc = existing || {
    key,
    scope: normalizedScope,
    strategy,
    symbol,
    timeframe,
    tradingDay,
    consecutiveLossCount: 0,
    stopped: false,
    stoppedAt: null,
    stopReason: null,
    consecutiveLossCountAtStop: null,
    resetAt,
    lastClassification: null,
    lastTradeR: null,
    lastTradeTime: null,
    createdAt: new Date().toISOString(),
  };

  const wasStopped = Boolean(doc.stopped);
  const beforeCount = doc.consecutiveLossCount || 0;
  let afterCount = beforeCount;

  // Apply classification → counter transition.
  if (classification === 'win') {
    afterCount = 0;
  } else if (classification === 'loss') {
    afterCount = beforeCount + 1;
  } else if (classification === 'breakeven') {
    if (config.countBreakEvenAsLoss) afterCount = beforeCount + 1;
    // otherwise count unchanged — explicit: BE does not reset the streak either.
  } else if (classification === 'small_loss') {
    if (config.countSmallLossAsLoss) afterCount = beforeCount + 1;
  }

  doc.consecutiveLossCount = afterCount;
  doc.lastClassification = classification;
  doc.lastTradeR = Number.isFinite(resolvedTradeR) ? Number(resolvedTradeR) : null;
  doc.lastTradeTime = now.toISOString();
  doc.resetAt = resetAt;

  let triggered = false;
  if (!wasStopped && afterCount >= config.consecutiveLossesToStop) {
    doc.stopped = true;
    doc.stoppedAt = now.toISOString();
    doc.stopReason = 'CONSECUTIVE_LOSSES';
    doc.consecutiveLossCountAtStop = afterCount;
    triggered = true;
  }

  const saved = await upsertRecord(doc);

  try {
    auditService.signalFiltered({
      symbol,
      strategy,
      module: 'strategyDailyStopService',
      scope: normalizedScope,
      setupTimeframe: timeframe,
      reasonCode: auditService.REASON.STRATEGY_DAILY_STOP_CLASSIFICATION,
      reasonText: `Trade classified as ${classification} (tradeR=${
        Number.isFinite(resolvedTradeR) ? resolvedTradeR.toFixed(3) : 'n/a'
      }) → consecutiveLossCount=${afterCount}`,
      details: {
        tradeR: Number.isFinite(resolvedTradeR) ? resolvedTradeR : null,
        classification,
        scope: normalizedScope,
        consecutiveLossCountBefore: beforeCount,
        consecutiveLossCountAfter: afterCount,
        tradingDay,
      },
    });
  } catch (_) {}

  if (triggered) {
    try {
      auditService.riskRejected({
        symbol,
        strategy,
        module: 'strategyDailyStopService',
        scope: normalizedScope,
        setupTimeframe: timeframe,
        reasonCode: auditService.REASON.STRATEGY_DAILY_STOP_TRIGGERED,
        reasonText: `Strategy daily stop triggered for ${key} after ${afterCount} consecutive loss(es)`,
        riskCheck: {
          reasonCode: auditService.REASON.STRATEGY_DAILY_STOP_TRIGGERED,
          stopReason: 'CONSECUTIVE_LOSSES',
        },
        details: {
          blockReason: 'strategy_daily_stop',
          scope: normalizedScope,
          key,
          tradingDay,
          consecutiveLossCountAtStop: afterCount,
          stoppedAt: doc.stoppedAt,
          resetAt: doc.resetAt,
        },
      });
    } catch (_) {}
  }

  return { record: saved, classification, triggered, consecutiveLossCount: afterCount, scope: normalizedScope };
}

async function getTodayStoppedStrategies({ scope = 'live', now = new Date() } = {}, configOverride = null) {
  const normalizedScope = normalizeScope(scope);
  const config = configOverride || await getActiveConfig();
  const { tradingDay } = resolveTradingDay(now, config);
  const nowMs = new Date(now).getTime();

  let records = [];
  try {
    records = await strategyDailyStopsDb.find({ tradingDay, stopped: true, scope: normalizedScope });
  } catch (_) {
    records = [];
  }

  // Legacy records created before runtime scope isolation have no `scope`
  // and use unscoped keys. New runtime checks query scoped keys only, so old
  // records are intentionally ignored rather than allowed to cross-block.
  return records
    .filter((r) => !r.resetAt || new Date(r.resetAt).getTime() > nowMs)
    .map((r) => ({
      key: r.key,
      scope: r.scope || normalizedScope,
      strategy: r.strategy,
      symbol: r.symbol,
      timeframe: r.timeframe,
      stopped: Boolean(r.stopped),
      stopReason: r.stopReason,
      stoppedAt: r.stoppedAt,
      tradingDay: r.tradingDay,
      resetAt: r.resetAt,
      consecutiveLossCountAtStop: r.consecutiveLossCountAtStop,
      lastClassification: r.lastClassification || null,
      lastTradeR: r.lastTradeR != null ? r.lastTradeR : null,
    }));
}

async function manualReset({ scope = 'live', strategy, symbol, timeframe, now = new Date(), actor = null }) {
  const normalizedScope = normalizeScope(scope);
  const config = await getActiveConfig();
  const key = buildKey({ scope: normalizedScope, strategy, symbol, timeframe });
  const { tradingDay } = resolveTradingDay(now, config);
  const record = await findRecord(key, tradingDay);
  if (!record) return { cleared: false, key, scope: normalizedScope, tradingDay };

  try {
    await strategyDailyStopsDb.remove({ _id: buildDocId(key, tradingDay) });
  } catch (_) {}

  try {
    auditService.signalFiltered({
      symbol,
      strategy,
      module: 'strategyDailyStopService',
      scope: normalizedScope,
      setupTimeframe: timeframe,
      reasonCode: auditService.REASON.STRATEGY_DAILY_STOP_RESET,
      reasonText: `Strategy daily stop manually reset for ${key}`,
      details: {
        key,
        scope: normalizedScope,
        tradingDay,
        actor: actor || null,
        previousRecord: {
          stopped: Boolean(record.stopped),
          stoppedAt: record.stoppedAt || null,
          consecutiveLossCountAtStop: record.consecutiveLossCountAtStop || null,
        },
      },
    });
  } catch (_) {}

  return { cleared: true, key, scope: normalizedScope, tradingDay };
}

/**
 * Used by tests to wipe in-memory counters so one test does not leak state
 * into the next.
 */
function _resetInMemoryCountersForTests() {
  blockedEntryCounterState.tradingDay = null;
  blockedEntryCounterState.countsByKey = Object.create(null);
  blockedEntryCounterState.totalByScope = Object.create(null);
}

module.exports = {
  buildKey,
  normalizeScope,
  computeTradeR,
  classify,
  resolveTradingDay,
  getActiveConfig,
  isEntryBlocked,
  recordBlockedEntry,
  recordTradeOutcome,
  getTodayStoppedStrategies,
  getBlockedEntriesToday,
  manualReset,
  _resetInMemoryCountersForTests,
};
