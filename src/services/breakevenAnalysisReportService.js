const { tradeLogDb, tradesDb } = require('../config/db');
const { normalizeDateStart, normalizeDateValue } = require('../utils/tradeTime');

const DEFAULT_REPORT_SINCE = '2026-04-27';
const DEFAULT_SCOPE = 'paper';
const UNKNOWN_SETUP_TYPE = 'unknown_legacy';
const UNKNOWN_BE_STYLE = 'unknown_legacy';
const VALID_SCOPES = new Set(['paper', 'live']);
const BREAKEVEN_EPSILON_R = 0.05;
const CLEARLY_GREATER_MULTIPLE = 1.5;

function createBadRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeScope(scope = DEFAULT_SCOPE) {
  const normalized = String(scope || DEFAULT_SCOPE).trim().toLowerCase();
  if (!VALID_SCOPES.has(normalized)) {
    throw createBadRequest(`Unsupported breakeven report scope: ${scope}`);
  }
  return normalized;
}

function normalizeSince(since = DEFAULT_REPORT_SINCE) {
  const normalized = normalizeDateStart(since || DEFAULT_REPORT_SINCE);
  if (!normalized) {
    throw createBadRequest(`Invalid breakeven report since date: ${since}`);
  }
  return normalized;
}

function getDbForScope(scope) {
  return scope === 'live' ? tradesDb : tradeLogDb;
}

function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundNumber(value, digits = 4) {
  const number = toFiniteNumber(value);
  return number == null ? null : parseFloat(number.toFixed(digits));
}

function asObject(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }
  return null;
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

function getPositionSnapshot(trade = {}) {
  return asObject(trade.positionSnapshot || trade.position_snapshot) || {};
}

function getManagementEvents(trade = {}) {
  const positionSnapshot = getPositionSnapshot(trade);
  return [
    ...asArray(trade.managementEvents || trade.management_events),
    ...asArray(positionSnapshot.managementEvents || positionSnapshot.management_events),
  ];
}

function eventText(event = {}) {
  return JSON.stringify(event || {}).toUpperCase();
}

function isStopLikeReason(reason) {
  const normalized = String(reason || '').toUpperCase();
  return normalized.includes('SL') || normalized.includes('STOP');
}

function hasBreakevenExitReason(trade = {}) {
  const positionSnapshot = getPositionSnapshot(trade);
  const reason = String(
    trade.exitReason
    || trade.exit_reason
    || trade.exitReasonDetail
    || trade.exit_reason_detail
    || positionSnapshot.exitReason
    || ''
  ).toUpperCase();
  return reason.includes('BREAKEVEN') || reason === 'BE' || reason === 'BE_HIT';
}

function getProtectivePhase(trade = {}) {
  const positionSnapshot = getPositionSnapshot(trade);
  const protectiveState = asObject(trade.protectiveStopState || trade.protective_stop_state)
    || asObject(positionSnapshot.protectiveStopState || positionSnapshot.protective_stop_state)
    || {};
  return String(protectiveState.phase || protectiveState.type || '').toUpperCase();
}

function getLastAppliedStopPhase(events = []) {
  const stopEvents = events.filter((event) => {
    const text = eventText(event);
    return text.includes('BREAKEVEN') || text.includes('TRAILING');
  });

  for (let index = stopEvents.length - 1; index >= 0; index -= 1) {
    const event = stopEvents[index];
    const status = String(event.status || '').toUpperCase();
    if (status && !['APPLIED', 'EXECUTED'].includes(status)) continue;
    const text = eventText(event);
    if (text.includes('TRAILING')) return 'TRAILING';
    if (text.includes('BREAKEVEN')) return 'BREAKEVEN';
  }

  return null;
}

function isBreakevenExit(trade = {}) {
  if (hasBreakevenExitReason(trade)) return true;

  const positionSnapshot = getPositionSnapshot(trade);
  const reason = String(trade.exitReason || trade.exit_reason || positionSnapshot.exitReason || '').toUpperCase();
  const protectivePhase = getProtectivePhase(trade);
  if (protectivePhase === 'BREAKEVEN' && isStopLikeReason(reason)) return true;

  const lastStopPhase = getLastAppliedStopPhase(getManagementEvents(trade));
  return lastStopPhase === 'BREAKEVEN' && isStopLikeReason(reason);
}

function getRMultiple(trade = {}) {
  const realized = toFiniteNumber(trade.realizedRMultiple);
  if (realized != null) return realized;

  const tradeR = toFiniteNumber(trade.tradeR);
  if (tradeR != null) return tradeR;

  const profitLoss = toFiniteNumber(trade.profitLoss);
  const plannedRiskAmount = toFiniteNumber(trade.plannedRiskAmount);
  if (profitLoss != null && plannedRiskAmount != null && plannedRiskAmount > 0) {
    return profitLoss / plannedRiskAmount;
  }

  return null;
}

function getProtectedLossEstimate(trade = {}) {
  if (!isBreakevenExit(trade)) return null;
  const plannedRiskAmount = toFiniteNumber(trade.plannedRiskAmount);
  return plannedRiskAmount != null && plannedRiskAmount > 0 ? plannedRiskAmount : null;
}

function getExplicitMissedProfitAfterBEEstimate(trade = {}) {
  const direct = toFiniteNumber(
    trade.missedProfitAfterBEEstimate
    ?? trade.missedProfitAfterBreakeven
    ?? trade.postBEMissedProfit
    ?? trade.postBreakevenMissedProfit
  );
  if (direct != null) return direct;

  const plannedRiskAmount = toFiniteNumber(trade.plannedRiskAmount);
  const postBeR = toFiniteNumber(
    trade.postBeMaxFavourableR
    ?? trade.postBEMaxFavourableR
    ?? trade.maxFavourableAfterBER
    ?? trade.maxFavourableAfterBreakevenR
  );

  if (plannedRiskAmount != null && plannedRiskAmount > 0 && postBeR != null && postBeR > 0) {
    const realizedR = getRMultiple(trade) || 0;
    return Math.max(0, (postBeR - realizedR) * plannedRiskAmount);
  }

  return null;
}

function getGroupKey(trade = {}) {
  const snapshot = asObject(trade.symbolPlaybookSnapshot) || {};
  const symbol = String(trade.symbol || 'UNKNOWN').trim() || 'UNKNOWN';
  const strategy = String(trade.strategy || 'Unknown').trim() || 'Unknown';
  const setupType = String(trade.setupType || UNKNOWN_SETUP_TYPE).trim() || UNKNOWN_SETUP_TYPE;
  const beStyle = String(trade.beStyle || snapshot.beStyle || UNKNOWN_BE_STYLE).trim() || UNKNOWN_BE_STYLE;
  return { symbol, strategy, setupType, beStyle };
}

function sameGroup(left, right) {
  return left.symbol === right.symbol
    && left.strategy === right.strategy
    && left.setupType === right.setupType
    && left.beStyle === right.beStyle;
}

function isClosedTradeSince(trade = {}, since) {
  if (String(trade.status || '').toUpperCase() !== 'CLOSED') return false;
  const closedAt = normalizeDateValue(trade.closedAt);
  const openedAt = normalizeDateValue(trade.openedAt);
  const referenceDate = closedAt || openedAt;
  return Boolean(referenceDate && referenceDate >= since);
}

function clearlyGreater(left, right) {
  const leftNumber = toFiniteNumber(left);
  const rightNumber = toFiniteNumber(right);
  if (leftNumber == null || rightNumber == null) return false;
  if (leftNumber <= 0) return false;
  return leftNumber > rightNumber * CLEARLY_GREATER_MULTIPLE;
}

function buildRecommendation(summary = {}) {
  if ((summary.beExitCount || 0) < 3) return 'NEED_MORE_DATA';
  if (clearlyGreater(summary.missedProfitAfterBEEstimate, summary.protectedLossEstimate)) {
    return 'CONSIDER_LOOSEN_BE';
  }
  if (clearlyGreater(summary.protectedLossEstimate, summary.missedProfitAfterBEEstimate)) {
    return 'KEEP_TIGHT_BE';
  }
  return 'NEUTRAL';
}

function summarizeGroup(group, trades) {
  const totalTrades = trades.length;
  const beExitTrades = trades.filter(isBreakevenExit);
  const protectedValues = beExitTrades
    .map(getProtectedLossEstimate)
    .filter((value) => value != null);
  const missedValues = beExitTrades
    .map(getExplicitMissedProfitAfterBEEstimate)
    .filter((value) => value != null);
  const rValues = trades
    .map(getRMultiple)
    .filter((value) => value != null);

  const summary = {
    ...group,
    totalTrades,
    beExitCount: beExitTrades.length,
    beExitRate: totalTrades > 0 ? roundNumber(beExitTrades.length / totalTrades, 4) : null,
    protectedLossEstimate: protectedValues.length > 0
      ? roundNumber(protectedValues.reduce((sum, value) => sum + value, 0), 2)
      : null,
    missedProfitAfterBEEstimate: missedValues.length > 0
      ? roundNumber(missedValues.reduce((sum, value) => sum + value, 0), 2)
      : null,
    avgRealizedR: rValues.length > 0
      ? roundNumber(rValues.reduce((sum, value) => sum + value, 0) / rValues.length, 4)
      : null,
    availableMetrics: {
      realizedRCount: rValues.length,
      protectedLossEstimateCount: protectedValues.length,
      missedProfitAfterBEEstimateCount: missedValues.length,
      beExitCount: beExitTrades.length,
    },
  };

  return {
    ...summary,
    recommendation: buildRecommendation(summary),
  };
}

function buildBreakevenAnalysisReportFromTrades(trades = [], { scope = DEFAULT_SCOPE, since = normalizeSince() } = {}) {
  const groups = [];
  for (const trade of trades) {
    const group = getGroupKey(trade);
    const existing = groups.find((candidate) => sameGroup(candidate.group, group));
    if (existing) {
      existing.trades.push(trade);
    } else {
      groups.push({ group, trades: [trade] });
    }
  }

  const rows = groups
    .map(({ group, trades: groupTrades }) => summarizeGroup(group, groupTrades))
    .sort((left, right) => (
      right.beExitCount - left.beExitCount
      || right.totalTrades - left.totalTrades
      || left.symbol.localeCompare(right.symbol)
      || left.strategy.localeCompare(right.strategy)
      || left.setupType.localeCompare(right.setupType)
      || left.beStyle.localeCompare(right.beStyle)
    ));

  return {
    scope,
    since: since.toISOString(),
    count: rows.length,
    totalTrades: trades.length,
    groups: rows,
  };
}

async function getBreakevenAnalysisReport(options = {}) {
  const scope = normalizeScope(options.scope);
  const since = normalizeSince(options.since);
  const db = getDbForScope(scope);
  const trades = await db.find({
    status: 'CLOSED',
    $or: [
      { closedAt: { $gte: since } },
      { openedAt: { $gte: since } },
    ],
  }).sort({ closedAt: -1 });

  return buildBreakevenAnalysisReportFromTrades(
    trades.filter((trade) => isClosedTradeSince(trade, since)),
    { scope, since }
  );
}

module.exports = {
  BREAKEVEN_EPSILON_R,
  DEFAULT_REPORT_SINCE,
  UNKNOWN_BE_STYLE,
  UNKNOWN_SETUP_TYPE,
  buildBreakevenAnalysisReportFromTrades,
  buildRecommendation,
  getBreakevenAnalysisReport,
  isBreakevenExit,
};
