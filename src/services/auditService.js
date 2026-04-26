/**
 * Audit Service
 *
 * Central entry point for writing decision / execution audit events.
 * - Persists records to nedb (DecisionAudit)
 * - Mirrors to file logs (signal_audit.log / execution_audit.log)
 * - Broadcasts to WebSocket subscribers on the 'diagnostics' topic
 *
 * Designed to be fire-and-forget from callers: never throws.
 */

const DecisionAudit = require('../models/DecisionAudit');
const fileLogger = require('./fileLogger');
let websocketService = null;
try {
  websocketService = require('./websocketService');
} catch (_) {
  websocketService = null;
}

// Known reason codes — callers should use these for consistent filtering,
// but freeform reasonCode is also allowed.
const REASON = Object.freeze({
  // Strategy engine
  NO_SETUP: 'NO_SETUP',
  SETUP_ACTIVE: 'SETUP_ACTIVE',
  FILTERED: 'FILTERED',
  TRIGGERED: 'TRIGGERED',
  DUPLICATE: 'DUPLICATE',

  // Risk manager
  TRADING_DISABLED: 'TRADING_DISABLED',
  DAILY_LOSS_LIMIT: 'DAILY_LOSS_LIMIT',
  MAX_DRAWDOWN: 'MAX_DRAWDOWN',
  MAX_POSITIONS_REACHED: 'MAX_POSITIONS_REACHED',
  SYMBOL_EXPOSURE_LIMIT: 'SYMBOL_EXPOSURE_LIMIT',
  CATEGORY_EXPOSURE_LIMIT: 'CATEGORY_EXPOSURE_LIMIT',
  SAME_DIRECTION_SYMBOL_LIMIT: 'SAME_DIRECTION_SYMBOL_LIMIT',
  SAME_DIRECTION_CATEGORY_LIMIT: 'SAME_DIRECTION_CATEGORY_LIMIT',
  DUPLICATE_ENTRY_WINDOW: 'DUPLICATE_ENTRY_WINDOW',
  COOLDOWN_AFTER_LOSS: 'COOLDOWN_AFTER_LOSS',
  EXECUTION_SCORE_TOO_LOW: 'EXECUTION_SCORE_TOO_LOW',
  LOT_BELOW_MIN: 'LOT_BELOW_MIN',
  INVALID_SL: 'INVALID_SL',
  SL_TOO_CLOSE: 'SL_TOO_CLOSE',
  UNKNOWN_INSTRUMENT: 'UNKNOWN_INSTRUMENT',

  // Strategy-level daily stop (per strategy+symbol+timeframe)
  STRATEGY_DAILY_STOP_ACTIVE: 'STRATEGY_DAILY_STOP_ACTIVE',
  STRATEGY_DAILY_STOP_TRIGGERED: 'STRATEGY_DAILY_STOP_TRIGGERED',
  STRATEGY_DAILY_STOP_RESET: 'STRATEGY_DAILY_STOP_RESET',
  STRATEGY_DAILY_STOP_CLASSIFICATION: 'STRATEGY_DAILY_STOP_CLASSIFICATION',

  // Execution
  PREFLIGHT_REJECTED: 'PREFLIGHT_REJECTED',
  MT5_REQUOTE: 'MT5_REQUOTE',
  MT5_INVALID_PRICE: 'MT5_INVALID_PRICE',
  MT5_MARKET_CLOSED: 'MT5_MARKET_CLOSED',
  MT5_UNKNOWN_ERROR: 'MT5_UNKNOWN_ERROR',
  ORDER_FAILED: 'ORDER_FAILED',
  ORDER_OPENED: 'ORDER_OPENED',

  // Position management
  BREAKEVEN_SET: 'BREAKEVEN_SET',
  TRAILING_UPDATED: 'TRAILING_UPDATED',
  PARTIAL_CLOSE: 'PARTIAL_CLOSE',
  POSITION_REMOVED: 'POSITION_REMOVED',
  NEWS_BLACKOUT: 'NEWS_BLACKOUT',

  // Close
  SL_HIT: 'SL_HIT',
  TP_HIT: 'TP_HIT',
  STOP_OUT: 'STOP_OUT',
  BREAKEVEN: 'BREAKEVEN',
  TRAILING_STOP: 'TRAILING_STOP',
  PARTIAL_TP: 'PARTIAL_TP',
  BROKER_EXTERNAL: 'BROKER_EXTERNAL',
  MANUAL: 'MANUAL',
  EXTERNAL: 'EXTERNAL',
  TIME_EXIT: 'TIME_EXIT',
});

function broadcastSafe(record) {
  try {
    if (websocketService && typeof websocketService.broadcast === 'function') {
      websocketService.broadcast('diagnostics', 'decision_audit', {
        id: record._id,
        timestamp: record.timestamp,
        symbol: record.symbol,
        strategy: record.strategy,
        module: record.module,
        type: record.type,
        stage: record.stage,
        status: record.status,
        reasonCode: record.reasonCode,
        reasonText: record.reasonText,
        signal: record.signal,
        scope: record.scope,
        details: record.details,
      });
    }
  } catch (_) {}
}

function fileLogSafe(record) {
  try {
    const executionStages = new Set([
      'PREFLIGHT_REJECTED',
      'ORDER_OPENED',
      'ORDER_FAILED',
      'POSITION_MANAGED',
      'ORDER_CLOSED',
    ]);
    if (executionStages.has(record.stage)) {
      fileLogger.executionAudit(record);
    } else {
      fileLogger.signalAudit(record);
    }
  } catch (_) {}
}

async function record(event) {
  try {
    const created = await DecisionAudit.create(event);
    fileLogSafe(created);
    broadcastSafe(created);
    return created;
  } catch (err) {
    try {
      fileLogger.error('[audit] failed to persist decision audit', {
        err: err.message,
        event,
      });
    } catch (_) {}
    return null;
  }
}

// Convenience helpers — each returns a promise but callers can ignore it.

function scan(event) {
  return record({ ...event, stage: 'SCAN', status: event.status || 'INFO' });
}

function noSetup(event) {
  return record({
    ...event,
    stage: 'NO_SETUP',
    status: event.status || 'INFO',
    reasonCode: event.reasonCode || REASON.NO_SETUP,
  });
}

function setupFound(event) {
  return record({
    ...event,
    stage: 'SETUP_FOUND',
    status: event.status || 'OK',
    reasonCode: event.reasonCode || REASON.SETUP_ACTIVE,
  });
}

function filtered(event) {
  return record({
    ...event,
    stage: 'FILTERED',
    status: event.status || 'INFO',
    reasonCode: event.reasonCode || REASON.FILTERED,
  });
}

function signalFiltered(event) {
  return filtered(event);
}

function triggered(event) {
  return record({
    ...event,
    stage: 'TRIGGERED',
    status: event.status || 'OK',
    reasonCode: event.reasonCode || REASON.TRIGGERED,
  });
}

function duplicate(event) {
  return record({
    ...event,
    stage: 'DUPLICATE',
    status: event.status || 'INFO',
    reasonCode: event.reasonCode || REASON.DUPLICATE,
  });
}

function riskRejected(event) {
  return record({
    ...event,
    stage: 'RISK_REJECTED',
    status: event.status || 'REJECTED',
  });
}

function preflightRejected(event) {
  return record({
    ...event,
    stage: 'PREFLIGHT_REJECTED',
    status: event.status || 'REJECTED',
    reasonCode: event.reasonCode || REASON.PREFLIGHT_REJECTED,
  });
}

function orderOpened(event) {
  return record({
    ...event,
    stage: 'ORDER_OPENED',
    status: event.status || 'OK',
    reasonCode: event.reasonCode || REASON.ORDER_OPENED,
  });
}

function orderFailed(event) {
  return record({
    ...event,
    stage: 'ORDER_FAILED',
    status: event.status || 'FAILED',
    reasonCode: event.reasonCode || REASON.ORDER_FAILED,
  });
}

function positionManaged(event) {
  return record({
    ...event,
    stage: 'POSITION_MANAGED',
    status: event.status || 'INFO',
  });
}

function orderClosed(event) {
  return record({
    ...event,
    stage: 'ORDER_CLOSED',
    status: event.status || 'OK',
  });
}

module.exports = {
  REASON,
  STAGES: DecisionAudit.STAGES,
  STATUSES: DecisionAudit.STATUSES,
  record,
  scan,
  noSetup,
  setupFound,
  filtered,
  signalFiltered,
  triggered,
  duplicate,
  riskRejected,
  preflightRejected,
  orderOpened,
  orderFailed,
  positionManaged,
  orderClosed,
};
