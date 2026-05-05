/**
 * Trade Management Service
 *
 * Conservative-by-default position-monitoring layer that complements (does
 * NOT replace) trailingStopService + breakevenService. For each open
 * position the monitor calls evaluatePosition() once per scan; the service:
 *
 *   - Computes unrealizedR from entry/initialSl/currentPrice
 *   - Detects EARLY_ADVERSE_MOVE inside the first N minutes after entry
 *   - Suggests / moves SL to breakeven at configured R thresholds
 *   - Suggests / executes partial take-profit at the configured R threshold
 *     (with broker minLot/lotStep guards — never partial-closes to an
 *     illegal volume)
 *   - Detects setup invalidation (trend flip, EMA cross, opposite signal)
 *     during heavy scans
 *   - Reacts to news blackout state with audit / optional protective BE
 *
 * Every event is appended to position.managementEvents and broadcast over
 * websocket. Important events also fire a Telegram notification.
 *
 * Defaults: ALL automated actions are gated behind explicit policy flags.
 * Without configuration the service only logs — it never modifies SL,
 * partial-closes, or closes the position.
 */

const websocketService = require('./websocketService');
const notificationService = require('./notificationService');
const breakevenService = require('./breakevenService');
const economicCalendarService = require('./economicCalendarService');
const tradeManagementConfig = require('./tradeManagementConfig');
const { getInstrument } = require('../config/instruments');
const instrumentValuation = require('../utils/instrumentValuation');
const { positionsDb } = require('../config/db');
const auditService = require('./auditService');

const EVENT = Object.freeze({
  EARLY_PROTECTION_MONITORING: 'EARLY_PROTECTION_MONITORING',
  EARLY_ADVERSE_MOVE: 'EARLY_ADVERSE_MOVE',
  EARLY_ADVERSE_EXIT: 'EARLY_ADVERSE_EXIT',
  R_THRESHOLD_REACHED: 'R_THRESHOLD_REACHED',
  BREAKEVEN_SUGGESTED: 'BREAKEVEN_SUGGESTED',
  BREAKEVEN_MOVED: 'BREAKEVEN_MOVED',
  PARTIAL_TP_SUGGESTED: 'PARTIAL_TP_SUGGESTED',
  PARTIAL_TP_EXECUTED: 'PARTIAL_TP_EXECUTED',
  PARTIAL_TP_SKIPPED_INVALID_VOLUME: 'PARTIAL_TP_SKIPPED_INVALID_VOLUME',
  SETUP_INVALIDATED: 'SETUP_INVALIDATED',
  INVALIDATION_EXIT: 'INVALIDATION_EXIT',
  INVALIDATION_CHECK_SKIPPED: 'INVALIDATION_CHECK_SKIPPED',
  NEWS_RISK_DETECTED: 'NEWS_RISK_DETECTED',
  NEWS_FAST_MONITORING: 'NEWS_FAST_MONITORING',
  NEWS_PROTECTIVE_BREAKEVEN: 'NEWS_PROTECTIVE_BREAKEVEN',
  NEWS_PROTECTION_SKIPPED: 'NEWS_PROTECTION_SKIPPED',
});

const TELEGRAM_NOTIFY_TYPES = new Set([
  EVENT.BREAKEVEN_MOVED,
  EVENT.PARTIAL_TP_EXECUTED,
  EVENT.EARLY_ADVERSE_EXIT,
  EVENT.NEWS_PROTECTIVE_BREAKEVEN,
  EVENT.INVALIDATION_EXIT,
]);

/**
 * Compute current floating R-multiple. Negative when the trade is offside.
 * Returns null when initial-risk distance can't be derived (e.g. legacy
 * positions without initialSl).
 */
function calculateUnrealizedR({ position, currentPrice }) {
  // Treat missing fields as missing (Number(null) === 0 would mask absent SL).
  if (position?.entryPrice == null || position?.initialSl == null || currentPrice == null) {
    return null;
  }
  const entryPrice = Number(position.entryPrice);
  const initialSl = Number(position.initialSl);
  const price = Number(currentPrice);
  const type = String(position?.type || '').toUpperCase();

  if (!Number.isFinite(entryPrice) || !Number.isFinite(initialSl) || !Number.isFinite(price)) {
    return null;
  }

  const initialRisk = Math.abs(entryPrice - initialSl);
  if (initialRisk <= 0) return null;

  const direction = type === 'SELL' ? -1 : 1;
  const moved = (price - entryPrice) * direction;
  return parseFloat((moved / initialRisk).toFixed(4));
}

function _minutesSinceEntry(position, now) {
  const openedAt = position?.openedAt ? new Date(position.openedAt) : null;
  if (!openedAt || Number.isNaN(openedAt.getTime())) return null;
  const ms = (now ? now.getTime() : Date.now()) - openedAt.getTime();
  return ms / (1000 * 60);
}

function _isAlreadyAtBreakeven(position, instrument) {
  if (!position || !instrument) return false;
  const entryPrice = Number(position.entryPrice);
  const currentSl = Number(position.currentSl);
  if (!Number.isFinite(entryPrice) || !Number.isFinite(currentSl)) return false;
  const tolerance = Number(instrument.pipSize || 0.0001) * 0.5;
  if (String(position.type || '').toUpperCase() === 'SELL') {
    return currentSl <= entryPrice + tolerance;
  }
  return currentSl >= entryPrice - tolerance;
}

/**
 * Snap a partial-close volume to broker grid + verify both the closed and
 * remaining legs respect minLot. Returns null when the volume is illegal.
 *
 * Returns: { volume, remaining } — both broker-legal — or null.
 */
function planPartialCloseVolume({ position, ratio, instrument }) {
  const lotSize = Number(position?.lotSize);
  const r = Number(ratio);
  if (!Number.isFinite(lotSize) || !Number.isFinite(r) || r <= 0 || r >= 1) return null;

  const minLot = instrumentValuation.getMinLot(instrument);
  const lotStep = instrumentValuation.getLotStep(instrument);

  const rawVolume = lotSize * r;
  const snappedVolume = Math.floor(rawVolume / lotStep + 1e-9) * lotStep;
  const remaining = parseFloat((lotSize - snappedVolume).toFixed(8));
  const volume = parseFloat(snappedVolume.toFixed(8));

  if (volume < minLot - 1e-9) return null;
  if (remaining < minLot - 1e-9) return null;
  return { volume, remaining };
}

class TradeManagementService {
  constructor() {
    this.EVENT = EVENT;
    this._writer = null; // injected by positionMonitor; falls back to positionsDb
    this._broadcaster = websocketService;
    this._notifier = notificationService;
  }

  /**
   * Optional: positionMonitor can pass an updatePositionFn that already
   * funnels writes through its own DB layer. When not set, we hit
   * positionsDb directly.
   */
  setWriter(writer) {
    this._writer = typeof writer === 'function' ? writer : null;
  }

  /**
   * Main entry — called once per scan per position.
   *
   * @param {object} ctx
   * @param {object} ctx.position - latest position document
   * @param {object} ctx.instrument - getInstrument(symbol) result
   * @param {object} ctx.policy - resolved tradeManagementConfig policy
   * @param {string} ctx.scanMode - 'light' | 'heavy'
   * @param {string} ctx.scanReason - state-derived reason (just_opened, ...)
   * @param {boolean} ctx.newsBlackoutActive - blackout in effect for symbol
   * @param {object|null} ctx.blackoutEvent - news event triggering blackout
   * @param {number} ctx.currentPrice - latest mid/quote
   * @param {Date} ctx.now - scan time
   * @param {object} ctx.invalidationContext - heavy-scan helper data
   *   { candles, indicators, opposingSignal, strategyType }
   * @param {object} ctx.actions - injected MT5 ops:
   *   { closePositionFn, partialCloseFn, modifySlFn }
   * @returns {Promise<Array<object>>} events appended this turn
   */
  async evaluatePosition(ctx = {}) {
    const events = [];
    const {
      position,
      instrument: providedInstrument,
      policy,
      scanMode = 'light',
      scanReason = null,
      newsBlackoutActive = false,
      blackoutEvent = null,
      currentPrice,
      now = new Date(),
      invalidationContext = null,
      actions = {},
    } = ctx;

    if (!position || !position.mt5PositionId) {
      return events;
    }
    if (!policy) {
      return events;
    }

    const instrument = providedInstrument || getInstrument(position.symbol) || null;
    if (!instrument) {
      return events;
    }

    const unrealizedR = calculateUnrealizedR({ position, currentPrice });
    const baseDetails = {
      currentPrice: Number.isFinite(Number(currentPrice)) ? Number(currentPrice) : null,
      unrealizedR,
      scanMode,
      scanReason,
      oldSl: Number(position.currentSl) || null,
    };

    // === A. Early protection ===
    const minutesSinceEntry = _minutesSinceEntry(position, now);
    if (
      minutesSinceEntry !== null
      && minutesSinceEntry >= 0
      && minutesSinceEntry < Number(policy.earlyProtectionMinutes)
    ) {
      events.push(await this._record(position, EVENT.EARLY_PROTECTION_MONITORING, {
        ...baseDetails,
        action: 'AUDIT_ONLY',
        reason: `within first ${policy.earlyProtectionMinutes} minutes`,
        minutesSinceEntry: parseFloat(minutesSinceEntry.toFixed(2)),
        success: true,
      }));

      if (Number.isFinite(unrealizedR) && unrealizedR <= Number(policy.earlyAdverseR)) {
        events.push(await this._record(position, EVENT.EARLY_ADVERSE_MOVE, {
          ...baseDetails,
          action: 'AUDIT_ONLY',
          reason: `unrealizedR=${unrealizedR} <= earlyAdverseR=${policy.earlyAdverseR}`,
          minutesSinceEntry: parseFloat(minutesSinceEntry.toFixed(2)),
          success: true,
        }));

        if (policy.enableEarlyAdverseExit) {
          const closeResult = await this._tryClose({
            position, actions, reason: 'EARLY_ADVERSE_EXIT',
          });
          events.push(await this._record(position, EVENT.EARLY_ADVERSE_EXIT, {
            ...baseDetails,
            action: 'CLOSE_POSITION',
            reason: 'enableEarlyAdverseExit=true',
            success: closeResult.success,
            error: closeResult.error || null,
            mt5Result: closeResult.result || null,
          }));
          if (closeResult.success) return events;
        }
      }
    }

    // === B. R-multiple management ===
    if (Number.isFinite(unrealizedR)) {
      const atBreakeven = _isAlreadyAtBreakeven(position, instrument);

      if (
        unrealizedR >= Number(policy.breakevenSuggestR)
        && unrealizedR < Number(policy.moveToBreakevenR)
        && !atBreakeven
      ) {
        events.push(await this._record(position, EVENT.R_THRESHOLD_REACHED, {
          ...baseDetails,
          action: 'AUDIT_ONLY',
          reason: `unrealizedR=${unrealizedR} >= breakevenSuggestR=${policy.breakevenSuggestR}`,
          success: true,
        }));
        events.push(await this._record(position, EVENT.BREAKEVEN_SUGGESTED, {
          ...baseDetails,
          action: 'AUDIT_ONLY',
          reason: 'price reached breakeven-suggest threshold; SL not yet at BE',
          success: true,
        }));
      }

      if (unrealizedR >= Number(policy.moveToBreakevenR) && !atBreakeven) {
        events.push(await this._record(position, EVENT.R_THRESHOLD_REACHED, {
          ...baseDetails,
          action: policy.allowMoveToBreakeven ? 'MOVE_SL_TO_BREAKEVEN' : 'AUDIT_ONLY',
          reason: `unrealizedR=${unrealizedR} >= moveToBreakevenR=${policy.moveToBreakevenR}`,
          success: true,
        }));

        if (policy.allowMoveToBreakeven) {
          const newSl = Number(position.entryPrice);
          const moveResult = await this._tryModifySl({
            position, actions, newSl,
          });
          events.push(await this._record(position, EVENT.BREAKEVEN_MOVED, {
            ...baseDetails,
            action: 'MOVE_SL_TO_BREAKEVEN',
            reason: 'allowMoveToBreakeven=true',
            newSl,
            success: moveResult.success,
            error: moveResult.error || null,
            mt5Result: moveResult.result || null,
          }));
        }
      }

      if (
        unrealizedR >= Number(policy.partialTakeProfitR)
        && !this._partialAlreadyTakenByService(position)
      ) {
        events.push(await this._record(position, EVENT.R_THRESHOLD_REACHED, {
          ...baseDetails,
          action: policy.allowPartialTakeProfit ? 'PARTIAL_TAKE_PROFIT' : 'AUDIT_ONLY',
          reason: `unrealizedR=${unrealizedR} >= partialTakeProfitR=${policy.partialTakeProfitR}`,
          success: true,
        }));
        events.push(await this._record(position, EVENT.PARTIAL_TP_SUGGESTED, {
          ...baseDetails,
          action: policy.allowPartialTakeProfit ? 'PARTIAL_TAKE_PROFIT' : 'AUDIT_ONLY',
          reason: `partialCloseRatio=${policy.partialCloseRatio}`,
          ratio: policy.partialCloseRatio,
          success: true,
        }));

        if (policy.allowPartialTakeProfit) {
          const plan = planPartialCloseVolume({
            position, ratio: policy.partialCloseRatio, instrument,
          });
          if (!plan) {
            events.push(await this._record(position, EVENT.PARTIAL_TP_SKIPPED_INVALID_VOLUME, {
              ...baseDetails,
              action: 'AUDIT_ONLY',
              reason: 'partial-close volume below minLot or remaining < minLot',
              ratio: policy.partialCloseRatio,
              currentLotSize: Number(position.lotSize) || null,
              minLot: instrumentValuation.getMinLot(instrument),
              lotStep: instrumentValuation.getLotStep(instrument),
              success: true,
            }));
          } else {
            const partialResult = await this._tryPartialClose({
              position, actions, volume: plan.volume,
              remaining: plan.remaining,
            });
            events.push(await this._record(position, EVENT.PARTIAL_TP_EXECUTED, {
              ...baseDetails,
              action: 'PARTIAL_TAKE_PROFIT',
              reason: 'allowPartialTakeProfit=true',
              ratio: policy.partialCloseRatio,
              volume: plan.volume,
              remaining: plan.remaining,
              success: partialResult.success,
              error: partialResult.error || null,
              mt5Result: partialResult.result || null,
            }));
          }
        }
      }
    }

    // === C. Setup invalidation (heavy scan only) ===
    if (scanMode === 'heavy') {
      const invalidation = this._detectInvalidation({
        position, invalidationContext,
      });
      if (invalidation.skipped) {
        events.push(await this._record(position, EVENT.INVALIDATION_CHECK_SKIPPED, {
          ...baseDetails,
          action: 'AUDIT_ONLY',
          reason: invalidation.reason,
          success: true,
        }));
      } else if (invalidation.invalidated) {
        events.push(await this._record(position, EVENT.SETUP_INVALIDATED, {
          ...baseDetails,
          action: policy.enableExitOnInvalidation ? 'CLOSE_POSITION' : 'AUDIT_ONLY',
          reason: invalidation.reason,
          invalidationSignals: invalidation.signals,
          success: true,
        }));

        if (policy.enableExitOnInvalidation) {
          const closeResult = await this._tryClose({
            position, actions, reason: 'INVALIDATION_EXIT',
          });
          events.push(await this._record(position, EVENT.INVALIDATION_EXIT, {
            ...baseDetails,
            action: 'CLOSE_POSITION',
            reason: 'enableExitOnInvalidation=true',
            success: closeResult.success,
            error: closeResult.error || null,
            mt5Result: closeResult.result || null,
          }));
          if (closeResult.success) return events;
        }
      }
    }

    // === D. News risk ===
    if (newsBlackoutActive) {
      const protectedAlready = _isAlreadyAtBreakeven(position, instrument);
      events.push(await this._record(position, EVENT.NEWS_RISK_DETECTED, {
        ...baseDetails,
        action: 'AUDIT_ONLY',
        reason: 'symbol in news blackout',
        blackoutEvent,
        protected: protectedAlready,
        success: true,
      }));
      events.push(await this._record(position, EVENT.NEWS_FAST_MONITORING, {
        ...baseDetails,
        action: 'AUDIT_ONLY',
        reason: 'fast scan cadence active',
        blackoutEvent,
        success: true,
      }));

      if (policy.enableNewsProtectiveBreakeven && !protectedAlready) {
        if (Number.isFinite(unrealizedR) && unrealizedR <= 0) {
          events.push(await this._record(position, EVENT.NEWS_PROTECTION_SKIPPED, {
            ...baseDetails,
            action: 'AUDIT_ONLY',
            reason: 'underwater — moving SL to BE would lock in a loss',
            success: true,
          }));
        } else {
          const newSl = Number(position.entryPrice);
          const moveResult = await this._tryModifySl({
            position, actions, newSl,
          });
          events.push(await this._record(position, EVENT.NEWS_PROTECTIVE_BREAKEVEN, {
            ...baseDetails,
            action: 'MOVE_SL_TO_BREAKEVEN',
            reason: 'enableNewsProtectiveBreakeven=true',
            blackoutEvent,
            newSl,
            success: moveResult.success,
            error: moveResult.error || null,
            mt5Result: moveResult.result || null,
          }));
        }
      } else if (protectedAlready) {
        events.push(await this._record(position, EVENT.NEWS_PROTECTION_SKIPPED, {
          ...baseDetails,
          action: 'AUDIT_ONLY',
          reason: 'position already at breakeven',
          success: true,
        }));
      }
    }

    return events;
  }

  /**
   * Heuristic invalidation detector. Conservative: returns invalidated=true
   * only when at least two independent signals agree. When the heavy-scan
   * helper hasn't supplied candles/indicators, we skip rather than
   * speculate.
   */
  _detectInvalidation({ position, invalidationContext }) {
    if (!invalidationContext) {
      return { skipped: true, reason: 'no invalidation context provided' };
    }

    const { candles, indicators, opposingSignal, higherTrendChanged } = invalidationContext;
    if (!Array.isArray(candles) || candles.length < 5) {
      return { skipped: true, reason: 'insufficient candles for invalidation check' };
    }

    const signals = [];
    const direction = String(position.type || '').toUpperCase();

    // 1) Opposite signal published by strategy on same/higher TF
    if (opposingSignal === true) signals.push('opposite_signal');

    // 2) Higher-timeframe trend flipped
    if (higherTrendChanged === true) signals.push('higher_trend_changed');

    // 3) Price crossed key MA (EMA50 if present)
    const ema50 = indicators && Array.isArray(indicators.ema50) && indicators.ema50.length > 0
      ? indicators.ema50[indicators.ema50.length - 1]
      : null;
    const lastClose = candles[candles.length - 1].close;
    if (Number.isFinite(ema50) && Number.isFinite(lastClose)) {
      if (direction === 'BUY' && lastClose < ema50) signals.push('price_below_ema50');
      else if (direction === 'SELL' && lastClose > ema50) signals.push('price_above_ema50');
    }

    if (signals.length === 0) {
      return { invalidated: false, signals: [], reason: 'no invalidation signals' };
    }

    if (signals.length >= 2) {
      return {
        invalidated: true,
        signals,
        reason: `multi-signal invalidation: ${signals.join(', ')}`,
      };
    }

    return {
      invalidated: false,
      signals,
      reason: `weak invalidation signal (${signals.join(', ')}); not enough confirmation`,
    };
  }

  _partialAlreadyTakenByService(position) {
    const events = Array.isArray(position?.managementEvents) ? position.managementEvents : [];
    return events.some((event) => event && event.type === EVENT.PARTIAL_TP_EXECUTED && event.status === 'success');
  }

  async _tryModifySl({ position, actions, newSl }) {
    const fn = actions && typeof actions.modifySlFn === 'function' ? actions.modifySlFn : null;
    if (!fn) return { success: false, error: 'modifySlFn not provided' };

    try {
      const stillExists = await this._verifyPositionExists(position);
      if (!stillExists) return { success: false, error: 'position not found before modify' };

      const result = await fn(position, newSl);
      await this._updatePositionFields(position, {
        currentSl: newSl,
        lastTradeManagementSyncAt: new Date().toISOString(),
      });
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  }

  async _tryPartialClose({ position, actions, volume, remaining = null }) {
    const fn = actions && typeof actions.partialCloseFn === 'function' ? actions.partialCloseFn : null;
    if (!fn) return { success: false, error: 'partialCloseFn not provided' };

    try {
      const stillExists = await this._verifyPositionExists(position);
      if (!stillExists) return { success: false, error: 'position not found before partial close' };

      const result = await fn(position, volume);
      const nextLotSize = Number.isFinite(Number(remaining))
        ? Number(remaining)
        : parseFloat((Number(position.lotSize) - Number(volume)).toFixed(8));
      if (Number.isFinite(nextLotSize) && nextLotSize > 0) {
        await this._updatePositionFields(position, {
          lotSize: nextLotSize,
          lastTradeManagementSyncAt: new Date().toISOString(),
        });
      }
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  }

  async _tryClose({ position, actions, reason }) {
    const fn = actions && typeof actions.closePositionFn === 'function' ? actions.closePositionFn : null;
    if (!fn) return { success: false, error: 'closePositionFn not provided' };

    try {
      const stillExists = await this._verifyPositionExists(position);
      if (!stillExists) return { success: false, error: 'position not found before close' };

      const result = await fn(position, reason);
      await this._updatePositionFields(position, {
        pendingExitAction: reason,
        pendingExitRequestedAt: new Date().toISOString(),
        lastTradeManagementSyncAt: new Date().toISOString(),
      });
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err && err.message ? err.message : String(err) };
    }
  }

  async _updatePositionFields(position, patch) {
    if (!position || !position._id || !patch || typeof patch !== 'object') return false;
    try {
      if (this._writer) {
        await this._writer(position._id, patch);
      } else {
        await positionsDb.update({ _id: position._id }, { $set: patch });
      }
      Object.assign(position, patch);
      return true;
    } catch (err) {
      console.warn(`[TradeMgmt] Failed to persist state update for ${position.symbol}: ${err.message}`);
      return false;
    }
  }

  /**
   * Confirm the position is still alive in the local DB. The monitor sync
   * removes externally-closed positions, so a missing record means we must
   * skip the action.
   */
  async _verifyPositionExists(position) {
    try {
      const fresh = await positionsDb.findOne({ _id: position._id });
      return Boolean(fresh && fresh._id);
    } catch (err) {
      return false;
    }
  }

  /**
   * Build, persist, broadcast, and (when important) telegram-notify a
   * single event. Returns the event record.
   */
  async _record(position, type, details = {}) {
    const status = details.success === false ? 'failure' : 'success';
    const event = {
      id: `${type}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      type,
      createdAt: new Date().toISOString(),
      status,
      symbol: position.symbol,
      strategy: position.strategy || null,
      mt5PositionId: position.mt5PositionId || null,
      positionDbId: position._id || null,
      ...details,
    };

    await this._appendToPosition(position, event);
    this._broadcast(event);
    if (TELEGRAM_NOTIFY_TYPES.has(type) && status === 'success') {
      // fire-and-forget — Telegram failures must never break the loop
      this._sendTelegram(event).catch(() => {});
    }
    auditService.positionManaged({
      symbol: position.symbol,
      strategy: position.strategy,
      module: 'tradeManagementService',
      scope: 'live',
      signal: position.type,
      positionDbId: position._id,
      reasonCode: type,
      reasonText: `${type}: ${details.reason || details.action || ''}`.slice(0, 240),
      details: event,
    });
    return event;
  }

  async _appendToPosition(position, event) {
    try {
      const fresh = await positionsDb.findOne({ _id: position._id });
      const existing = Array.isArray(fresh?.managementEvents) ? fresh.managementEvents : [];
      const next = [...existing, event];
      if (this._writer) {
        await this._writer(position._id, { managementEvents: next });
      } else {
        await positionsDb.update({ _id: position._id }, { $set: { managementEvents: next } });
      }
      if (Array.isArray(position.managementEvents)) {
        position.managementEvents.push(event);
      } else {
        position.managementEvents = next;
      }
    } catch (err) {
      // Persistence failure must not break the scan loop.
      console.warn(`[TradeMgmt] Failed to persist event ${event.type}: ${err.message}`);
    }
  }

  _broadcast(event) {
    try {
      if (this._broadcaster && typeof this._broadcaster.broadcast === 'function') {
        this._broadcaster.broadcast('positions', 'position_management_event', event);
      }
    } catch (_err) {
      // ignore
    }
  }

  async _sendTelegram(event) {
    if (!this._notifier || typeof this._notifier.sendTelegram !== 'function') return;
    const lines = [
      `<b>Trade Management:</b> ${event.type}`,
      `<b>Symbol:</b> ${event.symbol}`,
      `<b>Strategy:</b> ${event.strategy || '-'}`,
      `<b>Action:</b> ${event.action || '-'}`,
      `<b>Reason:</b> ${event.reason || '-'}`,
      `<b>unrealizedR:</b> ${event.unrealizedR ?? '-'}`,
      `<b>Status:</b> ${event.status}`,
    ];
    try {
      await this._notifier.sendTelegram(lines.join('\n'));
    } catch (_err) {
      // swallow
    }
  }
}

const tradeManagementService = new TradeManagementService();

module.exports = tradeManagementService;
module.exports.EVENT = EVENT;
module.exports.calculateUnrealizedR = calculateUnrealizedR;
module.exports.planPartialCloseVolume = planPartialCloseVolume;
module.exports.TradeManagementService = TradeManagementService;
