/**
 * Position Monitor
 * Syncs MT5 positions with local DB, manages exits, detects external closures,
 * and runs a light/heavy dual scan loop that is independent from signal cadence.
 */

const mt5Service = require('./mt5Service');
const trailingStopService = require('./trailingStopService');
const riskManager = require('./riskManager');
const websocketService = require('./websocketService');
const notificationService = require('./notificationService');
const breakevenService = require('./breakevenService');
const economicCalendarService = require('./economicCalendarService');
const { positionsDb, tradesDb } = require('../config/db');
const { buildClosedTradeSnapshot } = require('../utils/mt5Reconciliation');
const auditService = require('./auditService');
const { getStrategyInstance } = require('./strategyInstanceService');
const { getInstrument } = require('../config/instruments');
const RiskProfile = require('../models/RiskProfile');
const indicatorService = require('./indicatorService');
const tradeManagementService = require('./tradeManagementService');
const { resolveTradeManagementPolicy } = require('./tradeManagementConfig');
const {
  getPositionCadenceProfile,
  getScanReason,
  resolveCategoryContext,
  toIsoOrNull,
} = require('./assignmentRuntimeService');

const BASE_MONITOR_TICK_MS = 15 * 1000;
const JUST_OPENED_WINDOW_MS = 5 * 60 * 1000;

class PositionMonitor {
  constructor() {
    this.monitorInterval = null;
    this.running = false;
    this.processing = false;
    this.baseTickMs = BASE_MONITOR_TICK_MS;
    this.pendingSyncReason = null;
    this.lastLightScanAt = new Map();
    this.lastHeavyScanAt = new Map();
    this.knownPositionKeys = new Set();
    this.lastStatus = this._buildEmptyStatus();
  }

  _buildEmptyStatus() {
    return {
      running: false,
      intervalMs: 0,
      baseTickMs: this.baseTickMs,
      lightCadenceMs: 0,
      heavyCadenceMs: 0,
      lightDuePositions: [],
      heavyDuePositions: [],
      fastModePositions: [],
      lastScanAt: null,
      lastForcedSyncAt: null,
    };
  }

  _getPositionKey(position) {
    return String(position?._id || position?.mt5PositionId || `${position?.symbol || 'unknown'}:${position?.strategy || 'unknown'}`);
  }

  _cleanupScanMaps(positions) {
    const activeKeys = new Set(positions.map((position) => this._getPositionKey(position)));
    for (const key of [...this.lastLightScanAt.keys()]) {
      if (!activeKeys.has(key)) this.lastLightScanAt.delete(key);
    }
    for (const key of [...this.lastHeavyScanAt.keys()]) {
      if (!activeKeys.has(key)) this.lastHeavyScanAt.delete(key);
    }
  }

  _didPositionsChange(positions) {
    const nextKeys = new Set(positions.map((position) => this._getPositionKey(position)));
    if (nextKeys.size !== this.knownPositionKeys.size) {
      this.knownPositionKeys = nextKeys;
      return true;
    }

    for (const key of nextKeys) {
      if (!this.knownPositionKeys.has(key)) {
        this.knownPositionKeys = nextKeys;
        return true;
      }
    }

    this.knownPositionKeys = nextKeys;
    return false;
  }

  _isPositionProtected(position, instrument) {
    if (!instrument) return false;

    const entryPrice = Number(position?.entryPrice);
    const currentSl = Number(position?.currentSl);
    if (!Number.isFinite(entryPrice) || !Number.isFinite(currentSl)) {
      return false;
    }

    const plan = breakevenService.getPositionExitPlan(position);
    const spreadCompensation = plan?.breakeven?.includeSpreadCompensation
      ? Number(instrument.spread || 0) * Number(instrument.pipSize || 0)
      : 0;
    const bufferDistance = Number(plan?.breakeven?.extraBufferPips || 0) * Number(instrument.pipSize || 0);
    const threshold = String(position?.type || '').toUpperCase() === 'SELL'
      ? entryPrice - spreadCompensation - bufferDistance
      : entryPrice + spreadCompensation + bufferDistance;

    if (String(position?.type || '').toUpperCase() === 'SELL') {
      return currentSl <= threshold;
    }
    return currentSl >= threshold;
  }

  async _buildPositionContexts(positions, now, forcedSyncReason = null) {
    const contexts = [];
    const strategyInstanceCache = new Map();
    let ensuredCalendar = false;

    const getCachedStrategyInstance = async (position) => {
      const strategyName = position?.strategy;
      if (!strategyName) return null;
      const cacheKey = `${position.symbol}:${strategyName}`;
      if (!strategyInstanceCache.has(cacheKey)) {
        strategyInstanceCache.set(cacheKey, getStrategyInstance(position.symbol, strategyName).catch(() => null));
      }
      return strategyInstanceCache.get(cacheKey);
    };

    for (const position of positions) {
      const key = this._getPositionKey(position);
      const instrument = getInstrument(position.symbol);
      const categoryContext = resolveCategoryContext(position.symbol, instrument?.category, { warnSource: 'position_monitor' });
      const strategyInstance = await getCachedStrategyInstance(position);
      const newsConfig = strategyInstance?.newsBlackout || null;

      let state = 'normal';
      let blackoutEvent = null;
      if (newsConfig?.enabled) {
        if (!ensuredCalendar) {
          await economicCalendarService.ensureCalendar();
          ensuredCalendar = true;
        }
        const blackout = economicCalendarService.isInBlackout(position.symbol, now, newsConfig);
        if (blackout.blocked) {
          state = 'news_fast_mode';
          blackoutEvent = blackout.event || null;
        }
      }

      if (state !== 'news_fast_mode') {
        const openedAt = position?.openedAt ? new Date(position.openedAt) : null;
        if (openedAt && !Number.isNaN(openedAt.getTime()) && (now.getTime() - openedAt.getTime()) < JUST_OPENED_WINDOW_MS) {
          state = 'just_opened';
        } else if (this._isPositionProtected(position, instrument)) {
          state = 'protected';
        }
      }

      const cadenceProfile = getPositionCadenceProfile(categoryContext.category, state);
      const lastLightScanAt = this.lastLightScanAt.get(key) || null;
      const lastHeavyScanAt = this.lastHeavyScanAt.get(key) || null;
      const forcedSync = Boolean(forcedSyncReason);
      const dueLight = forcedSync
        || !lastLightScanAt
        || (now.getTime() - lastLightScanAt.getTime()) >= cadenceProfile.lightCadenceMs;
      const dueHeavy = forcedSync
        || !lastHeavyScanAt
        || (now.getTime() - lastHeavyScanAt.getTime()) >= cadenceProfile.heavyCadenceMs;
      const scanReason = getScanReason(state, forcedSync);

      contexts.push({
        key,
        position,
        category: categoryContext.category,
        rawCategory: categoryContext.rawCategory,
        categoryFallback: categoryContext.categoryFallback,
        state,
        blackoutEvent,
        lightCadenceMs: cadenceProfile.lightCadenceMs,
        heavyCadenceMs: cadenceProfile.heavyCadenceMs,
        dueLight,
        dueHeavy,
        scanReason,
      });
    }

    return contexts;
  }

  _buildMonitorStatus(contexts, now, forcedSyncReason = null) {
    const lightDuePositions = [];
    const heavyDuePositions = [];
    const fastModePositions = [];
    const lightCadenceMs = contexts.length > 0
      ? Math.min(...contexts.map((context) => context.lightCadenceMs))
      : 0;
    const heavyCadenceMs = contexts.length > 0
      ? Math.min(...contexts.map((context) => context.heavyCadenceMs))
      : 0;

    for (const context of contexts) {
      const lightNextScanAt = context.dueLight
        ? new Date(now.getTime() + context.lightCadenceMs)
        : new Date((this.lastLightScanAt.get(context.key) || now).getTime() + context.lightCadenceMs);
      const heavyNextScanAt = context.dueHeavy
        ? new Date(now.getTime() + context.heavyCadenceMs)
        : new Date((this.lastHeavyScanAt.get(context.key) || now).getTime() + context.heavyCadenceMs);

      const basePayload = {
        symbol: context.position.symbol,
        strategy: context.position.strategy || null,
        category: context.category,
        categoryFallback: context.categoryFallback === true,
        state: context.state,
      };

      if (context.dueLight) {
        lightDuePositions.push({
          ...basePayload,
          scanMode: 'light',
          scanReason: context.scanReason,
          nextScanAt: toIsoOrNull(lightNextScanAt),
        });
      }

      if (context.dueHeavy) {
        heavyDuePositions.push({
          ...basePayload,
          scanMode: 'heavy',
          scanReason: context.scanReason,
          nextScanAt: toIsoOrNull(heavyNextScanAt),
        });
      }

      if (context.state === 'news_fast_mode') {
        fastModePositions.push({
          ...basePayload,
          scanMode: 'light',
          scanReason: 'news_fast_mode',
          nextScanAt: toIsoOrNull(lightNextScanAt),
          blackoutEvent: context.blackoutEvent || null,
        });
      }
    }

    return {
      running: this.running,
      intervalMs: this.running ? this.baseTickMs : 0,
      baseTickMs: this.baseTickMs,
      lightCadenceMs,
      heavyCadenceMs,
      lightDuePositions,
      heavyDuePositions,
      fastModePositions,
      lastScanAt: toIsoOrNull(now),
      lastForcedSyncAt: forcedSyncReason ? toIsoOrNull(now) : this.lastStatus.lastForcedSyncAt || null,
    };
  }

  _buildScanMetadataMap(contexts, scanMode, now) {
    const metadata = new Map();
    for (const context of contexts) {
      metadata.set(context.key, {
        symbol: context.position.symbol,
        strategy: context.position.strategy || null,
        category: context.category,
        categoryFallback: context.categoryFallback === true,
        scanMode,
        scanReason: context.scanReason,
        nextScanAt: toIsoOrNull(new Date(now.getTime() + (scanMode === 'light' ? context.lightCadenceMs : context.heavyCadenceMs))),
      });
    }
    return metadata;
  }

  /**
   * After trailing/breakeven processing, run the conservative trade-management
   * evaluator on each position. All side-effects (close/partialClose/modifySl)
   * are gated inside the policy flags resolved from active profile +
   * strategyInstance — by default this only writes audit events.
   *
   * Wrapped in per-position try/catch so a single failure can never break the
   * monitor loop or the upstream trailing/breakeven flow.
   */
  async _runTradeManagementEvaluation(positions, contexts, scanMode, now) {
    if (!Array.isArray(positions) || positions.length === 0) return;

    let activeProfile = null;
    try {
      activeProfile = await RiskProfile.getActive();
    } catch (_err) {
      activeProfile = null;
    }

    const contextByKey = new Map(contexts.map((ctx) => [ctx.key, ctx]));
    const strategyInstanceCache = new Map();
    const candleCache = new Map();
    const priceCache = new Map();

    const getCachedStrategyInstance = async (position) => {
      const strategyName = position?.strategy;
      if (!strategyName) return null;
      const cacheKey = `${position.symbol}:${strategyName}`;
      if (!strategyInstanceCache.has(cacheKey)) {
        strategyInstanceCache.set(
          cacheKey,
          getStrategyInstance(position.symbol, strategyName, { activeProfile }).catch(() => null)
        );
      }
      return strategyInstanceCache.get(cacheKey);
    };

    const fetchPrice = async (symbol) => {
      if (priceCache.has(symbol)) return priceCache.get(symbol);
      const promise = mt5Service.getPrice(symbol).catch(() => null);
      priceCache.set(symbol, promise);
      return promise;
    };

    const fetchCandles = async (symbol, timeframe) => {
      const key = `${symbol}:${timeframe}`;
      if (candleCache.has(key)) return candleCache.get(key);
      const promise = mt5Service.getCandles(symbol, timeframe, null, 251).catch(() => null);
      candleCache.set(key, promise);
      return promise;
    };

    for (const position of positions) {
      try {
        const ctx = contextByKey.get(this._getPositionKey(position));
        if (!ctx) continue;

        const strategyInstance = await getCachedStrategyInstance(position);
        const policy = resolveTradeManagementPolicy({ activeProfile, strategyInstance });
        const instrument = getInstrument(position.symbol);

        const priceData = await fetchPrice(position.symbol);
        let currentPrice = null;
        if (priceData) {
          currentPrice = String(position.type || '').toUpperCase() === 'BUY'
            ? Number(priceData.bid)
            : Number(priceData.ask);
          if (!Number.isFinite(currentPrice)) {
            currentPrice = Number(priceData.last) || null;
          }
        }
        if (!Number.isFinite(currentPrice) && Number.isFinite(Number(position.currentPrice))) {
          currentPrice = Number(position.currentPrice);
        }

        let invalidationContext = null;
        if (scanMode === 'heavy') {
          const timeframe = position.timeframe || strategyInstance?.timeframe || 'H1';
          const candles = await fetchCandles(position.symbol, timeframe);
          let indicators = null;
          if (Array.isArray(candles) && candles.length >= 50) {
            const closes = candles.map((c) => Number(c.close)).filter(Number.isFinite);
            try {
              indicators = { ema50: indicatorService.ema(closes, 50) };
            } catch (_err) {
              indicators = null;
            }
          }
          invalidationContext = {
            candles: candles || [],
            indicators,
            opposingSignal: false,
            higherTrendChanged: false,
          };
        }

        const actions = {
          modifySlFn: async (pos, newSl) => {
            if (!pos?.mt5PositionId) throw new Error('mt5PositionId missing');
            return mt5Service.modifyPosition(pos.mt5PositionId, newSl, pos.currentTp || null);
          },
          partialCloseFn: async (pos, volume) => {
            if (!pos?.mt5PositionId) throw new Error('mt5PositionId missing');
            if (typeof mt5Service.partialClosePosition !== 'function') {
              throw new Error('partialClosePosition not supported');
            }
            return mt5Service.partialClosePosition(pos.mt5PositionId, volume);
          },
          closePositionFn: async (pos) => {
            if (!pos?.mt5PositionId) throw new Error('mt5PositionId missing');
            return mt5Service.closePosition(pos.mt5PositionId);
          },
        };

        await tradeManagementService.evaluatePosition({
          position,
          instrument,
          policy,
          scanMode,
          scanReason: ctx.scanReason || null,
          newsBlackoutActive: ctx.state === 'news_fast_mode',
          blackoutEvent: ctx.blackoutEvent || null,
          currentPrice,
          now,
          invalidationContext,
          actions,
        });
      } catch (err) {
        console.warn(`[Monitor] Trade management evaluation failed for ${position?.symbol}: ${err.message}`);
      }
    }
  }

  async _runPositionManagement(positions, contexts, scanMode, now, cycleState) {
    if (!Array.isArray(positions) || positions.length === 0) {
      return [];
    }

    const hooks = trailingStopService.createPositionManagementHooks({
      getCandlesFn: scanMode === 'heavy'
        ? async (symbol, timeframe) => mt5Service.getCandles(symbol, timeframe, null, 251)
        : null,
      closePositionFn: async (position) => {
        if (!position?.mt5PositionId) {
          throw new Error('Position is missing mt5PositionId');
        }
        return mt5Service.closePosition(position.mt5PositionId);
      },
      partialCloseFn: async (position, volume) => {
        if (!position?.mt5PositionId) {
          throw new Error('Position is missing mt5PositionId');
        }
        if (typeof mt5Service.partialClosePosition !== 'function') {
          throw new Error('partialClosePosition not supported by MT5 bridge');
        }
        return mt5Service.partialClosePosition(position.mt5PositionId, volume);
      },
      updatePositionFn: async (localId, patch) => {
        const query = localId && typeof localId === 'string' && localId.length >= 16
          ? { _id: localId }
          : { mt5PositionId: String(localId) };
        await positionsDb.update(query, { $set: patch });
      },
    });

    const metadataByPosition = this._buildScanMetadataMap(contexts, scanMode, now);
    const updates = await trailingStopService.processPositions(
      positions,
      async (symbol) => mt5Service.getPrice(symbol),
      async (positionId, newSl, newTp) => mt5Service.modifyPosition(positionId, newSl, newTp),
      hooks,
      {
        scanMode,
        cycleState,
        scanMetadataByPosition: metadataByPosition,
      }
    );

    await this._runTradeManagementEvaluation(positions, contexts, scanMode, now);

    if (updates.length === 0) {
      return [];
    }

    const positionsByMt5Id = new Map(
      positions
        .filter((position) => position.mt5PositionId != null)
        .map((position) => [String(position.mt5PositionId), position])
    );

    for (const update of updates) {
      const localPosition = positionsByMt5Id.get(String(update.positionId));
      if (!localPosition) continue;
      if (update.newSl !== undefined) {
        await positionsDb.update(
          { _id: localPosition._id },
          { $set: { currentSl: update.newSl } }
        );
      }

      const actionKind = update.kind || update.action || (update.newSl !== undefined ? 'SL_UPDATE' : null);
      let reasonCode = actionKind;
      if (actionKind === 'SL_UPDATE') {
        reasonCode = update.phase === 'breakeven'
          ? auditService.REASON.BREAKEVEN_SET
          : update.phase === 'trailing'
            ? auditService.REASON.TRAILING_UPDATED
            : 'SL_UPDATE';
      } else if (actionKind === 'PARTIAL_CLOSE') {
        reasonCode = auditService.REASON.PARTIAL_CLOSE;
      } else if (actionKind === 'PARTIAL_TP') {
        reasonCode = auditService.REASON.PARTIAL_TP;
      } else if (actionKind === 'TIME_EXIT') {
        reasonCode = auditService.REASON.TIME_EXIT;
      }

      auditService.positionManaged({
        symbol: localPosition.symbol,
        strategy: localPosition.strategy,
        module: 'positionMonitor',
        scope: 'live',
        signal: localPosition.type,
        positionDbId: localPosition._id,
        reasonCode: reasonCode || 'POSITION_UPDATE',
        reasonText: update.message
          || (actionKind === 'SL_UPDATE'
            ? `SL updated to ${update.newSl}`
            : actionKind === 'PARTIAL_TP'
              ? `Partial close ${update.volume || ''}`
              : 'Position update'),
        details: update,
      });
    }

    const refreshedPositions = await positionsDb.find({});
    websocketService.broadcast('positions', 'positions_sync', refreshedPositions);
    return updates;
  }

  start() {
    if (this.running) return;

    this.running = true;
    this.monitorInterval = setInterval(() => {
      this._tick().catch((err) => {
        console.error('[Monitor] Error:', err.message);
      });
    }, this.baseTickMs);

    if (typeof this.monitorInterval.unref === 'function') {
      this.monitorInterval.unref();
    }

    console.log(`[Monitor] Started (base tick: ${this.baseTickMs / 1000}s)`);
    this.syncNow('forced_sync').catch((err) => {
      console.error('[Monitor] Initial sync error:', err.message);
    });
  }

  stop() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.running = false;
    this.processing = false;
    this.pendingSyncReason = null;
    this.lastLightScanAt.clear();
    this.lastHeavyScanAt.clear();
    this.knownPositionKeys.clear();
    this.lastStatus = this._buildEmptyStatus();
    console.log('[Monitor] Stopped');
  }

  requestSync(reason = 'forced_sync') {
    this.pendingSyncReason = reason || 'forced_sync';
  }

  async syncNow(reason = 'forced_sync') {
    this.requestSync(reason);
    await this._tick();
  }

  async _tick() {
    if (this.processing || (!this.running && !this.pendingSyncReason)) {
      return;
    }

    this.processing = true;
    const now = new Date();
    let forcedSyncReason = this.pendingSyncReason;
    this.pendingSyncReason = null;

    try {
      const syncedPositions = await this.syncPositions({ broadcast: false });
      const positions = Array.isArray(syncedPositions) ? syncedPositions : [];
      const positionsChanged = this._didPositionsChange(positions);
      if (positionsChanged && !forcedSyncReason) {
        forcedSyncReason = 'forced_sync';
      }
      this._cleanupScanMaps(positions);

      const contexts = await this._buildPositionContexts(positions, now, forcedSyncReason);
      const lightContexts = contexts.filter((context) => context.dueLight);
      const heavyContexts = contexts.filter((context) => context.dueHeavy);
      const cycleState = { id: `monitor:${Date.now()}`, fingerprints: new Set() };

      if (lightContexts.length > 0) {
        const lightKeys = new Set(lightContexts.map((context) => context.key));
        const lightPositions = positions.filter((position) => lightKeys.has(this._getPositionKey(position)));
        await this._runPositionManagement(lightPositions, lightContexts, 'light', now, cycleState);
        lightContexts.forEach((context) => {
          this.lastLightScanAt.set(context.key, now);
        });
      }

      if (heavyContexts.length > 0) {
        const refreshedPositions = lightContexts.length > 0 ? await positionsDb.find({}) : positions;
        const heavyKeys = new Set(heavyContexts.map((context) => context.key));
        const heavyPositions = refreshedPositions.filter((position) => heavyKeys.has(this._getPositionKey(position)));
        await this._runPositionManagement(heavyPositions, heavyContexts, 'heavy', now, cycleState);
        heavyContexts.forEach((context) => {
          this.lastHeavyScanAt.set(context.key, now);
        });
      }

      this.lastStatus = this._buildMonitorStatus(contexts, now, forcedSyncReason);
    } catch (err) {
      console.error('[Monitor] Error:', err.message);
      this.lastStatus = {
        ...this.lastStatus,
        running: this.running,
        intervalMs: this.running ? this.baseTickMs : 0,
        baseTickMs: this.baseTickMs,
        lastScanAt: toIsoOrNull(now),
      };
    } finally {
      this.processing = false;
    }
  }

  async syncPositions(options = {}) {
    const { broadcast = true } = options;
    if (!mt5Service.isConnected()) {
      return await positionsDb.find({});
    }

    const mt5Positions = await mt5Service.getPositions();
    const localPositions = await positionsDb.find({});
    const mt5PositionIds = new Set(mt5Positions.map((p) => String(p.id)));

    for (const localPos of localPositions) {
      if (localPos.mt5PositionId && !mt5PositionIds.has(String(localPos.mt5PositionId))) {
        await this._handleExternalClose(localPos);
      }
    }

    for (const mt5Pos of mt5Positions) {
      const localPos = localPositions.find(
        (lp) => String(lp.mt5PositionId) === String(mt5Pos.id)
      );
      if (localPos) {
        await positionsDb.update({ _id: localPos._id }, {
          $set: {
            currentSl: mt5Pos.stopLoss || localPos.currentSl,
            currentTp: mt5Pos.takeProfit || localPos.currentTp,
            currentPrice: mt5Pos.currentPrice,
            unrealizedPl: mt5Pos.unrealizedProfit || mt5Pos.profit || 0,
          },
        });
      }
    }

    const updatedPositions = await positionsDb.find({});
    if (broadcast) {
      websocketService.broadcast('positions', 'positions_sync', updatedPositions);
    }
    return updatedPositions;
  }

  async _handleExternalClose(localPos) {
    console.log(`[Monitor] Position closed externally: ${localPos.symbol} ${localPos.type}`);
    let dealSummary = null;
    if (localPos.mt5PositionId) {
      const reconciliationStart = localPos.openedAt
        ? new Date(new Date(localPos.openedAt).getTime() - (60 * 60 * 1000))
        : new Date(Date.now() - (7 * 24 * 60 * 60 * 1000));

      try {
        dealSummary = await mt5Service.getPositionDealSummary(
          localPos.mt5PositionId,
          reconciliationStart,
          new Date()
        );
      } catch (reconciliationError) {
        console.warn(`[Monitor] Deal reconciliation failed for ${localPos.symbol}: ${reconciliationError.message}`);
      }
    }

    let fallbackExitPrice = null;
    if (!dealSummary?.exitPrice) {
      try {
        const priceData = await mt5Service.getPrice(localPos.symbol);
        fallbackExitPrice = localPos.type === 'BUY' ? priceData.bid : priceData.ask;
      } catch (priceError) {
        fallbackExitPrice = localPos.currentPrice || localPos.entryPrice;
      }
    }

    const closedSnapshot = buildClosedTradeSnapshot(localPos, dealSummary, {
      exitPrice: fallbackExitPrice,
      reason: 'EXTERNAL',
      pendingExitAction: localPos.pendingExitAction || null,
    });

    await tradesDb.update({ positionDbId: localPos._id }, {
      $set: {
        status: 'CLOSED',
        exitPrice: closedSnapshot.exitPrice,
        exitReason: closedSnapshot.exitReason,
        profitLoss: closedSnapshot.profitLoss,
        profitPips: closedSnapshot.profitPips,
        closedAt: closedSnapshot.closedAt,
        commission: closedSnapshot.commission,
        swap: closedSnapshot.swap,
        fee: closedSnapshot.fee,
        mt5CloseDealId: dealSummary?.lastExitDeal?.id || null,
        exitPlanSnapshot: closedSnapshot.exitPlanSnapshot || null,
        managementEvents: closedSnapshot.managementEvents || [],
        realizedRMultiple: closedSnapshot.realizedRMultiple,
        targetRMultipleCaptured: closedSnapshot.targetRMultipleCaptured,
      },
    });

    if (closedSnapshot.profitLoss < 0) {
      await riskManager.recordLoss(Math.abs(closedSnapshot.profitLoss), closedSnapshot.closedAt);
    }

    await positionsDb.remove({ _id: localPos._id });

    const closedTrade = {
      ...localPos,
      ...closedSnapshot,
    };

    auditService.orderClosed({
      symbol: localPos.symbol,
      strategy: localPos.strategy,
      module: 'positionMonitor',
      scope: 'live',
      signal: localPos.type,
      price: closedSnapshot.exitPrice,
      positionDbId: localPos._id,
      exitReason: closedSnapshot.exitReason,
      pnl: closedSnapshot.profitLoss,
      reasonCode: closedSnapshot.exitReason || 'EXTERNAL',
      reasonText: `Externally closed ${localPos.symbol} ${localPos.type} P/L ${closedSnapshot.profitLoss.toFixed(2)}`,
      details: {
        exitPrice: closedSnapshot.exitPrice,
        profitPips: closedSnapshot.profitPips,
      },
    });

    websocketService.broadcast('trades', 'trade_closed', closedTrade);
    websocketService.broadcast('positions', 'position_update', { action: 'closed', position: closedTrade });
    await notificationService.notifyTradeClosed(closedTrade);
  }

  getStatus() {
    return {
      ...this.lastStatus,
      running: this.running,
      intervalMs: this.running ? this.baseTickMs : 0,
      baseTickMs: this.baseTickMs,
    };
  }
}

const positionMonitor = new PositionMonitor();

module.exports = positionMonitor;
