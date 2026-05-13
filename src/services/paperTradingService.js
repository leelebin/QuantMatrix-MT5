/**
 * Paper Trading Service
 * Connects to MT5 demo account, runs strategies with risk management,
 * executes trades on demo, and logs everything to trade_log.
 */

const mt5Module = require('./mt5Service');
const mt5Service = typeof mt5Module.getScopedService === 'function'
  ? mt5Module.getScopedService('paper')
  : mt5Module;
const strategyEngine = require('./strategyEngine');
const riskManager = require('./riskManager');
const websocketService = require('./websocketService');
const notificationService = require('./notificationService');
const tradeNotificationService = require('./tradeNotificationService');
const trailingStopService = require('./trailingStopService');
const breakevenService = require('./breakevenService');
const economicCalendarService = require('./economicCalendarService');
const TradeLog = require('../models/TradeLog');
const ExecutionAudit = require('../models/ExecutionAudit');
const RiskProfile = require('../models/RiskProfile');
const { paperPositionsDb } = require('../config/db');
const { getInstrument, INSTRUMENT_CATEGORIES } = require('../config/instruments');
const Strategy = require('../models/Strategy');
const { buildClosedTradeSnapshot } = require('../utils/mt5Reconciliation');
const { buildBrokerComment, buildTradeComment, parseStrategyFromBrokerComment } = require('../utils/tradeComment');
const {
  appendManagementEvent,
  buildManagedPositionState,
  createManagerAction,
} = require('../utils/positionExitState');
const {
  buildOpenTradeCapture,
  buildPositionExportSnapshot,
  buildSignalPlaybookTradeFields,
} = require('../utils/tradeDataCapture');
const auditService = require('./auditService');
const strategyDailyStopService = require('./strategyDailyStopService');
const { getStrategyInstance } = require('./strategyInstanceService');
const {
  buildSignalScanBucketStatus,
  CadenceScheduler,
  buildAssignmentStats,
  getPositionCadenceProfile,
  getScanReason,
  listActiveAssignments,
  resolveCategoryContext,
  toIsoOrNull,
} = require('./assignmentRuntimeService');

const BASE_MONITOR_TICK_MS = 15 * 1000;
const JUST_OPENED_WINDOW_MS = 5 * 60 * 1000;
const PAPER_OPEN_SYNC_GRACE_MS = 2 * 60 * 1000;
const MARKET_STOP_STALE_TICK_MS = 30 * 60 * 1000;
const MARKET_STOP_UNTRADEABLE_MODES = new Set(['DISABLED', 'CLOSEONLY']);

function isCryptoSymbol(symbol) {
  const instrument = getInstrument(symbol);
  if (instrument?.category === INSTRUMENT_CATEGORIES.CRYPTO) {
    return true;
  }

  const normalized = String(symbol || '').toUpperCase();
  return /^(BTC|ETH|LTC|XRP|BCH|SOL|ADA|DOGE).*(USD|USDT)/.test(normalized);
}

function toEpochMs(value) {
  if (value == null) return null;

  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value > 1e12 ? value : value * 1000;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getPriceTickEpochMs(priceData = {}) {
  const candidates = [
    priceData.timeMsc,
    priceData.time_msc,
    priceData.tick?.timeMsc,
    priceData.tick?.time_msc,
    priceData.time,
    priceData.tick?.time,
  ];

  for (const candidate of candidates) {
    const timestamp = toEpochMs(candidate);
    if (timestamp) return timestamp;
  }
  return null;
}

function getTradeModeName(source = {}) {
  return String(
    source.tradeModeName
    || source.symbolInfo?.tradeModeName
    || source.info?.tradeModeName
    || source.tick?.tradeModeName
    || ''
  ).toUpperCase();
}

function getMarketStopReasonFromError(err) {
  const retcodeName = String(
    err?.retcodeName
    || err?.codeName
    || err?.details?.retcodeName
    || err?.details?.codeName
    || ''
  ).toUpperCase();
  const numericCode = Number(
    err?.retcode
    ?? err?.code
    ?? err?.details?.retcode
    ?? err?.details?.code
  );
  const message = String(err?.message || err?.error || '').toLowerCase();

  if (retcodeName.includes('MARKET_CLOSED') || numericCode === 10018 || message.includes('market closed')) {
    return 'MARKET_CLOSED';
  }
  if (retcodeName.includes('TRADE_DISABLED') || numericCode === 10017 || message.includes('trade disabled')) {
    return 'TRADE_DISABLED';
  }
  return null;
}

function valuesEqualForSnapshot(left, right) {
  if (left == null && right == null) return true;

  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return Math.abs(leftNumber - rightNumber) <= 1e-10;
  }

  return left === right;
}

function normalizeComparableText(value) {
  return String(value || '').trim();
}

function brokerCommentsMatch(left, right) {
  const a = normalizeComparableText(left);
  const b = normalizeComparableText(right);
  if (!a || !b) return false;
  return a === b
    || a.startsWith(b)
    || b.startsWith(a)
    || a.slice(0, 28) === b.slice(0, 28);
}

function volumesMatch(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return true;
  return Math.abs(leftNumber - rightNumber) <= 1e-8;
}

function isAdoptablePaperMt5Position(mt5Position = {}) {
  const comment = normalizeComparableText(mt5Position.comment);
  return comment.startsWith('PT|');
}

function buildDefaultValidation() {
  return { ok: false, warnings: [], errors: [] };
}

function withModeAlias(account = null) {
  if (!account) return null;
  return {
    ...account,
    mode: account.mode || account.tradeModeName || 'UNKNOWN',
  };
}

function getPaperPublicConfig() {
  try {
    return typeof mt5Service.getPublicConnectionConfig === 'function'
      ? mt5Service.getPublicConnectionConfig()
      : null;
  } catch (_) {
    return null;
  }
}

function buildPaperRuntimeStatus(runtimeIdentity = null, running = false) {
  const config = getPaperPublicConfig();
  const account = withModeAlias(runtimeIdentity?.account || null);
  const connected = Boolean(runtimeIdentity?.connected);
  const validation = runtimeIdentity?.validation || buildDefaultValidation();
  const configured = Boolean(
    runtimeIdentity?.mt5Path
    || config?.pathConfigured
    || config?.login
    || config?.server
  );

  let message = null;
  if (account?.isReal) {
    message = 'Paper runtime is connected to REAL account. Paper trading is blocked.';
  } else if (!connected) {
    message = configured
      ? 'Paper runtime is not connected.'
      : 'Paper runtime not configured or not connected.';
  }

  return {
    scope: 'paper',
    enabled: process.env.PAPER_TRADING_ENABLED === 'true' || running,
    running,
    connected,
    mt5Path: runtimeIdentity?.mt5Path || null,
    account,
    validation,
    message,
  };
}

class PaperTradingService {
  constructor() {
    this.running = false;
    this.scheduler = null;
    this.monitorInterval = null;
    this.monitorIntervalMs = BASE_MONITOR_TICK_MS;
    this.monitorBaseTickMs = BASE_MONITOR_TICK_MS;
    this.monitorProcessing = false;
    this.pendingMonitorSyncReason = null;
    this.lastLightScanAt = new Map();
    this.lastHeavyScanAt = new Map();
    this.knownPositionKeys = new Set();
    this.monitorStatus = this._buildEmptyMonitorStatus();
    this.startedAt = null;
  }

  async _recordAudit(stage, status, signal, extra = {}) {
    const audit = await ExecutionAudit.create({
      scope: 'paper',
      stage,
      status,
      symbol: signal?.symbol || extra.symbol || null,
      type: signal?.signal || extra.type || null,
      strategy: signal?.strategy || null,
      volume: extra.volume ?? null,
      code: extra.code ?? null,
      codeName: extra.codeName || null,
      message: extra.message || '',
      accountMode: extra.accountInfo ? mt5Service.getAccountModeName(extra.accountInfo) : null,
      accountLogin: extra.accountInfo?.login || null,
      accountServer: extra.accountInfo?.server || null,
      source: 'paper_trading',
      details: extra.details || null,
      createdAt: extra.createdAt || new Date(),
    });

    websocketService.broadcast('status', 'execution_audit', audit);
    return audit;
  }

  _broadcastRejection(signal, reason, extra = {}) {
    websocketService.broadcast('signals', 'paper_trade_rejected', {
      symbol: signal.symbol,
      type: signal.signal,
      reason,
      stage: extra.stage || null,
      code: extra.code ?? null,
      codeName: extra.codeName || null,
      scope: 'paper',
    });
  }

  async _getActiveAssignments(activeProfile = null) {
    await Strategy.initDefaults(strategyEngine.getStrategiesInfo());
    return listActiveAssignments({ activeProfile, scope: 'paper' });
  }

  _buildEmptyMonitorStatus() {
    return {
      running: false,
      intervalMs: 0,
      baseTickMs: this.monitorBaseTickMs,
      lightCadenceMs: 0,
      heavyCadenceMs: 0,
      lightDuePositions: [],
      heavyDuePositions: [],
      fastModePositions: [],
      marketStoppedPositions: [],
      lastScanAt: null,
      lastForcedSyncAt: null,
    };
  }

  _getPositionKey(position) {
    return String(position?._id || position?.mt5PositionId || `${position?.symbol || 'unknown'}:${position?.strategy || 'unknown'}`);
  }

  _cleanupMonitorMaps(positions) {
    const activeKeys = new Set(positions.map((position) => this._getPositionKey(position)));
    for (const key of [...this.lastLightScanAt.keys()]) {
      if (!activeKeys.has(key)) this.lastLightScanAt.delete(key);
    }
    for (const key of [...this.lastHeavyScanAt.keys()]) {
      if (!activeKeys.has(key)) this.lastHeavyScanAt.delete(key);
    }
  }

  _didPaperPositionsChange(positions) {
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

  _isMarketStoppedPosition(position) {
    return position?.marketStop?.active === true;
  }

  _hasSnapshotChanges(position, patch) {
    return Object.entries(patch).some(([key, value]) => !valuesEqualForSnapshot(position?.[key], value));
  }

  _isWithinPaperOpenSyncGrace(position, now = new Date()) {
    const openedAt = toEpochMs(position?.openedAt || position?.createdAt);
    if (!openedAt) return false;

    const ageMs = now.getTime() - openedAt;
    return ageMs >= -PAPER_OPEN_SYNC_GRACE_MS && ageMs <= PAPER_OPEN_SYNC_GRACE_MS;
  }

  _findMatchingPaperPosition(mt5Position, localPositions, matchedLocalIds = new Set()) {
    const directMatch = localPositions.find((localPos) => (
      !matchedLocalIds.has(localPos._id)
      && localPos.mt5PositionId
      && String(localPos.mt5PositionId) === String(mt5Position.id)
    ));
    if (directMatch) return directMatch;

    return localPositions.find((localPos) => {
      if (matchedLocalIds.has(localPos._id)) return false;
      if (String(localPos.symbol || '').toUpperCase() !== String(mt5Position.symbol || '').toUpperCase()) return false;
      if (String(localPos.type || '').toUpperCase() !== String(mt5Position.type || '').toUpperCase()) return false;
      if (!volumesMatch(localPos.lotSize ?? localPos.originalLotSize, mt5Position.volume)) return false;
      return brokerCommentsMatch(localPos.mt5Comment, mt5Position.comment)
        || brokerCommentsMatch(localPos.comment, mt5Position.comment);
    });
  }

  async _adoptPaperPositionFromMt5(mt5Position, now = new Date()) {
    const side = String(mt5Position?.type || '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') return null;

    const symbol = String(mt5Position?.symbol || '').trim();
    if (!symbol || !mt5Position?.id) return null;

    const entryPrice = Number(mt5Position.openPrice ?? mt5Position.currentPrice);
    const currentPrice = Number(mt5Position.currentPrice ?? entryPrice);
    const openedAtMs = toEpochMs(mt5Position.time);
    const openedAt = openedAtMs ? new Date(openedAtMs) : now;
    const mt5Comment = normalizeComparableText(mt5Position.comment);
    const strategy = parseStrategyFromBrokerComment(mt5Comment) || 'Unknown';
    const lotSize = Number(mt5Position.volume) || 0;
    const currentSl = Number(mt5Position.stopLoss) || null;
    const currentTp = Number(mt5Position.takeProfit) || null;
    const unrealizedPl = Number(mt5Position.unrealizedProfit ?? mt5Position.profit) || 0;

    const position = await paperPositionsDb.insert({
      symbol,
      type: side,
      entryPrice: Number.isFinite(entryPrice) ? entryPrice : currentPrice,
      currentSl,
      currentTp,
      lotSize,
      originalLotSize: lotSize,
      mt5PositionId: String(mt5Position.id),
      mt5Comment,
      strategy,
      comment: buildTradeComment({ symbol, signal: side, strategy, reason: 'Adopted from MT5 paper position' }, mt5Comment),
      confidence: null,
      rawConfidence: null,
      reason: 'Adopted from MT5 paper position',
      atrAtEntry: 0,
      currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
      unrealizedPl,
      maxFavourablePrice: Number.isFinite(entryPrice) ? entryPrice : currentPrice,
      openedAt,
      status: 'OPEN',
      syncSource: 'mt5_orphan_adoption',
      adoptedAt: now,
    });

    try {
      await TradeLog.logOpen({
        symbol,
        type: side,
        lotSize,
        entryPrice: Number.isFinite(entryPrice) ? entryPrice : currentPrice,
        stopLoss: currentSl,
        takeProfit: currentTp,
        signalReason: 'Adopted from MT5 paper position',
        strategy,
        confidence: null,
        rawConfidence: null,
        indicatorsSnapshot: null,
        mt5PositionId: String(mt5Position.id),
        mt5Comment,
        comment: position.comment,
        positionDbId: position._id,
        openedAt,
      });
    } catch (err) {
      console.warn(`[PaperTrading] Failed to log adopted paper position ${symbol}: ${err.message}`);
    }

    auditService.orderOpened({
      symbol,
      strategy,
      module: 'paperTradingService',
      scope: 'paper',
      signal: side,
      calculatedLot: lotSize,
      price: Number.isFinite(entryPrice) ? entryPrice : currentPrice,
      sl: currentSl,
      tp: currentTp,
      positionDbId: position._id,
      reasonText: `Adopted existing MT5 paper position ${side} ${lotSize} ${symbol}`,
      details: {
        mt5PositionId: String(mt5Position.id),
        mt5Comment,
        syncSource: 'mt5_orphan_adoption',
      },
    });

    return position;
  }

  _isProtectedPosition(position, instrument) {
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

  async _resolvePaperMarketStopState(position, mt5Position, now = new Date()) {
    const symbol = position?.symbol || mt5Position?.symbol;
    if (!symbol) {
      return { active: false, reason: 'NO_SYMBOL' };
    }

    const crypto = isCryptoSymbol(symbol);

    try {
      const priceData = await mt5Service.getPrice(symbol);
      const tradeModeName = getTradeModeName(priceData);
      if (MARKET_STOP_UNTRADEABLE_MODES.has(tradeModeName)) {
        return {
          active: true,
          reason: `TRADE_MODE_${tradeModeName}`,
          details: { symbol, tradeModeName, crypto },
        };
      }

      const side = String(position?.type || '').toUpperCase();
      const quote = side === 'SELL' ? Number(priceData.ask) : Number(priceData.bid);
      const fallbackQuote = Number(mt5Position?.currentPrice ?? position?.currentPrice);
      if (!crypto && !Number.isFinite(quote) && !Number.isFinite(fallbackQuote)) {
        return {
          active: true,
          reason: 'PRICE_UNAVAILABLE',
          details: { symbol, crypto },
        };
      }

      const tickEpochMs = getPriceTickEpochMs(priceData);
      if (!crypto && tickEpochMs) {
        const tickAgeMs = now.getTime() - tickEpochMs;
        if (tickAgeMs > MARKET_STOP_STALE_TICK_MS) {
          return {
            active: true,
            reason: 'STALE_TICK',
            details: {
              symbol,
              crypto,
              tickTime: new Date(tickEpochMs).toISOString(),
              tickAgeSeconds: Math.round(tickAgeMs / 1000),
            },
          };
        }
      }

      return { active: false, reason: 'MARKET_OPEN', details: { symbol, crypto } };
    } catch (err) {
      const explicitReason = getMarketStopReasonFromError(err);
      if (explicitReason) {
        return {
          active: true,
          reason: explicitReason,
          details: {
            symbol,
            crypto,
            message: err.message,
          },
        };
      }

      if (!crypto) {
        return {
          active: true,
          reason: 'PRICE_UNAVAILABLE',
          details: {
            symbol,
            crypto,
            message: err.message,
          },
        };
      }

      return {
        active: false,
        reason: 'CRYPTO_PRICE_UNAVAILABLE_IGNORED',
        details: {
          symbol,
          crypto,
          message: err.message,
        },
      };
    }
  }

  async _applyPaperMarketStopState(position, marketState, now = new Date()) {
    const existing = position?.marketStop || null;
    const active = marketState?.active === true;
    const existingActive = existing?.active === true;
    const nowDate = now instanceof Date ? now : new Date(now);

    if (active) {
      const nextMarketStop = {
        active: true,
        startedAt: existingActive && existing?.startedAt ? existing.startedAt : nowDate,
        endedAt: null,
        reason: marketState.reason || 'MARKET_STOP',
        detectedAt: existingActive && existing?.detectedAt ? existing.detectedAt : nowDate,
        updatedAt: nowDate,
        details: marketState.details || null,
      };

      const reasonChanged = existingActive && existing?.reason !== nextMarketStop.reason;
      if (existingActive && !reasonChanged) {
        return { active: true, changed: false, position };
      }

      await paperPositionsDb.update(
        { _id: position._id },
        { $set: { marketStop: nextMarketStop } }
      );

      return {
        active: true,
        changed: true,
        position: { ...position, marketStop: nextMarketStop },
      };
    }

    if (existingActive) {
      const nextMarketStop = {
        ...existing,
        active: false,
        endedAt: nowDate,
        resolvedAt: nowDate,
        resolvedReason: marketState?.reason || 'MARKET_OPEN',
      };

      await paperPositionsDb.update(
        { _id: position._id },
        { $set: { marketStop: nextMarketStop } }
      );

      return {
        active: false,
        changed: true,
        position: { ...position, marketStop: nextMarketStop },
      };
    }

    return { active: false, changed: false, position };
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
        strategyInstanceCache.set(cacheKey, getStrategyInstance(position.symbol, strategyName, {
          scope: 'paper',
        }).catch(() => null));
      }
      return strategyInstanceCache.get(cacheKey);
    };

    for (const position of positions) {
      const key = this._getPositionKey(position);
      const instrument = getInstrument(position.symbol);
      const categoryContext = resolveCategoryContext(position.symbol, instrument?.category, { warnSource: 'paper_position_monitor' });

      if (this._isMarketStoppedPosition(position)) {
        const cadenceProfile = getPositionCadenceProfile(categoryContext.category, 'normal');
        contexts.push({
          key,
          position,
          category: categoryContext.category,
          rawCategory: categoryContext.rawCategory,
          categoryFallback: categoryContext.categoryFallback,
          state: 'market_stopped',
          blackoutEvent: null,
          marketStop: position.marketStop,
          lightCadenceMs: cadenceProfile.lightCadenceMs,
          heavyCadenceMs: cadenceProfile.heavyCadenceMs,
          dueLight: false,
          dueHeavy: false,
          scanReason: 'market_stopped',
        });
        continue;
      }

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
        } else if (this._isProtectedPosition(position, instrument)) {
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
        scanReason: getScanReason(state, forcedSync),
      });
    }

    return contexts;
  }

  _buildMonitorStatus(contexts, now, forcedSyncReason = null) {
    const lightDuePositions = [];
    const heavyDuePositions = [];
    const fastModePositions = [];
    const marketStoppedPositions = [];
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

      if (context.state === 'market_stopped') {
        marketStoppedPositions.push({
          ...basePayload,
          scanReason: 'market_stopped',
          marketStop: context.marketStop || context.position.marketStop || null,
        });
      }
    }

    return {
      running: this.running,
      intervalMs: this.running ? this.monitorBaseTickMs : 0,
      baseTickMs: this.monitorBaseTickMs,
      lightCadenceMs,
      heavyCadenceMs,
      lightDuePositions,
      heavyDuePositions,
      fastModePositions,
      marketStoppedPositions,
      lastScanAt: toIsoOrNull(now),
      lastForcedSyncAt: forcedSyncReason ? toIsoOrNull(now) : this.monitorStatus.lastForcedSyncAt || null,
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

  _getScheduler() {
    if (!this.scheduler) {
      this.scheduler = new CadenceScheduler({
        name: 'paper-trading',
        buildAssignments: async (bucket) => {
          const assignments = await this._getActiveAssignments();
          return assignments
            .filter((assignment) => assignment.cadenceMs === bucket.cadenceMs)
            .map((assignment) => ({
              symbol: assignment.symbol,
              strategyType: assignment.strategyType,
              strategyInstance: assignment.strategyInstance,
              category: assignment.category,
              categoryFallback: assignment.categoryFallback,
              scanMode: 'signal',
              scanReason: 'cadence',
            }));
        },
        runAssignments: async (analysisTasks) => {
          await this._runAnalysisCycle(analysisTasks);
          await this.syncMonitorNow('forced_sync');
        },
        onError: (error, bucket) => {
          console.error(`[PaperTrading ${bucket.timeframe}] Trading loop error:`, error.message);
        },
      });
    }

    return this.scheduler;
  }

  /**
   * Start paper trading mode
   * Connects to MT5 demo account and begins the analysis/execution loop
   */
  async start() {
    if (this.running) {
      return { success: false, message: 'Paper trading is already running' };
    }

    try {
      // Connect to MT5 (demo account configured in .env)
      if (!mt5Service.isConnected()) {
        await mt5Service.connect();
      }

      // Verify it's a demo account
      const accountInfo = await mt5Service.getAccountInfo();
      if (typeof mt5Service.validateRuntimeAccountIdentity === 'function') {
        mt5Service.validateRuntimeAccountIdentity(accountInfo);
      }
      mt5Service.ensurePaperTradingAccount(accountInfo);
      console.log(`[PaperTrading] Connected to account: ${accountInfo.login} | Server: ${accountInfo.server}`);
      console.log(`[PaperTrading] Balance: ${accountInfo.balance} ${accountInfo.currency} | Leverage: 1:${accountInfo.leverage}`);
      const runtimeIdentity = typeof mt5Service.buildRuntimeIdentityStatus === 'function'
        ? mt5Service.buildRuntimeIdentityStatus(accountInfo)
        : null;

      // Initialize strategy configs in DB
      await Strategy.initDefaults(strategyEngine.getStrategiesInfo());

      // Enable trading flag for risk manager
      process.env.PAPER_TRADING_ENABLED = 'true';

      // Start position monitor (sync MT5 demo positions with local DB)
      this.running = true;
      this.startedAt = new Date();
      this._startPositionMonitor();
      this._startTradingLoop();

      // Notify via Telegram
      await notificationService.notifySystem('start',
        `Paper Trading started\n`
        + `Account: ${accountInfo.login}\n`
        + `Balance: ${accountInfo.balance} ${accountInfo.currency}\n`
        + `Leverage: 1:${accountInfo.leverage}`
      );

      // Broadcast via WebSocket
      websocketService.broadcast('status', 'paper_trading_started', {
        account: accountInfo.login,
        balance: accountInfo.balance,
        currency: accountInfo.currency,
      });

      return {
        success: true,
        message: 'Paper trading started',
        data: {
          account: {
            login: accountInfo.login,
            balance: accountInfo.balance,
            equity: accountInfo.equity,
            currency: accountInfo.currency,
            leverage: accountInfo.leverage,
            mode: mt5Service.getAccountModeName(accountInfo),
          },
          runtimeIdentity,
        },
      };
    } catch (err) {
      console.error('[PaperTrading] Start error:', err.message);
      this.running = false;
      return { success: false, message: err.message };
    }
  }

  /**
   * Stop paper trading mode
   */
  async stop() {
    if (!this.running) {
      return { success: false, message: 'Paper trading is not running' };
    }

    process.env.PAPER_TRADING_ENABLED = 'false';

    if (this.scheduler) {
      this.scheduler.stop();
      this.scheduler = null;
    }

    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.monitorProcessing = false;
    this.pendingMonitorSyncReason = null;
    this.lastLightScanAt.clear();
    this.lastHeavyScanAt.clear();
    this.knownPositionKeys.clear();
    this.monitorStatus = this._buildEmptyMonitorStatus();

    this.running = false;
    const runtime = this.startedAt ? TradeLog.formatHoldingTime(Date.now() - this.startedAt.getTime()) : 'N/A';
    this.startedAt = null;

    await notificationService.notifySystem('stop', `Paper Trading stopped\nRuntime: ${runtime}`);

    websocketService.broadcast('status', 'paper_trading_stopped', { runtime });

    console.log(`[PaperTrading] Stopped (runtime: ${runtime})`);
    return { success: true, message: 'Paper trading stopped', runtime };
  }

  /**
   * Start the strategy analysis and trade execution loop
   */
  _startTradingLoop() {
    this._getScheduler().start();
    console.log('[PaperTrading] Multi-cadence trading loop started');
  }

  /**
   * Run one full analysis cycle across all enabled symbols
   */
  async _runAnalysisCycle(analysisTasks = null) {
    if (!mt5Service.isConnected()) return;

    const resolvedTasks = Array.isArray(analysisTasks) ? analysisTasks : await this._getActiveAssignments();
    const activeAssignments = Array.isArray(resolvedTasks) ? resolvedTasks.length : 0;

    if (activeAssignments === 0) {
      console.log('[PaperTrading] No enabled strategy assignments to analyze');
      return;
    }

    // Run strategy engine analysis
    await strategyEngine.analyzeAll(
      // Candle data fetcher — request the latest `count` bars (no startTime)
      async (symbol, timeframe, count) => {
        const candles = await mt5Service.getCandles(symbol, timeframe, null, count);
        if (candles && candles.length > 0) {
          console.log(
            `[PaperTrading] Candles fetched: ${symbol} ${timeframe} `
            + `| requested=${count} received=${candles.length} `
            + `| first=${candles[0].time} last=${candles[candles.length - 1].time}`
          );
        } else {
          console.log(
            `[PaperTrading] Candles fetched: ${symbol} ${timeframe} `
            + `| requested=${count} received=0`
          );
        }
        return candles;
      },
      // Signal handler — execute paper trade
      async (signal) => {
        await this._executePaperTrade(signal);
      },
      null,
      { scope: 'paper', mode: 'paper', analysisTasks: resolvedTasks }
    );
  }

  /**
   * Execute a paper trade on MT5 demo account with full logging
   * @param {object} signal - Strategy signal
   */
  async _executePaperTrade(signal) {
    if (signal.signal === 'NONE') return;

    let preflight = null;

    try {
      const accountInfo = await mt5Service.getAccountInfo();
      mt5Service.ensurePaperTradingAccount(accountInfo);
      const priceData = await mt5Service.getPrice(signal.symbol);
      const quotedEntryPrice = signal.signal === 'BUY' ? priceData.ask : priceData.bid;
      signal.entryPrice = quotedEntryPrice;

      // Validate through risk manager (uses paper positions DB)
      const riskCheck = await this._validatePaperTrade(signal, accountInfo);
      if (!riskCheck.allowed) {
        await this._recordAudit('risk', 'BLOCKED', signal, {
          message: riskCheck.reason,
          code: 'RISK_RULE',
          codeName: 'RISK_RULE',
          volume: riskCheck.lotSize || null,
          accountInfo,
          details: { riskCheck },
        });
        console.log(`[PaperTrading] Trade rejected: ${signal.symbol} - ${riskCheck.reason}`);
        this._broadcastRejection(signal, riskCheck.reason, {
          stage: 'risk',
          code: 'RISK_RULE',
          codeName: 'RISK_RULE',
        });
        return;
      }

      if (riskCheck.overrideApplied && riskCheck.auditMessage) {
        await this._recordAudit('risk', 'INFO', signal, {
          message: riskCheck.auditMessage,
          code: 'AGGRESSIVE_MIN_LOT',
          codeName: 'AGGRESSIVE_MIN_LOT',
          volume: riskCheck.lotSize,
          accountInfo,
          details: { riskCheck },
        });
      }

      signal.executionScore = riskCheck.executionScore ?? signal.executionScore ?? null;
      signal.executionScoreDetails = riskCheck.executionScoreDetails || signal.executionScoreDetails || null;
      signal.executionPolicy = riskCheck.executionPolicy || signal.executionPolicy || null;

      // Execute on MT5 demo account
      const brokerComment = buildBrokerComment(signal, 'PT');
      const tradeComment = buildTradeComment(signal, brokerComment);
      preflight = await mt5Service.preflightOrder(
        signal.symbol,
        signal.signal,
        riskCheck.lotSize,
        signal.sl,
        signal.tp,
        brokerComment
      );
      if (!mt5Service.isOrderAllowed(preflight)) {
        const preflightMessage = mt5Service.getPreflightMessage(preflight);
        await this._recordAudit('preflight', 'BLOCKED', signal, {
          message: preflightMessage,
          code: preflight.retcode,
          codeName: preflight.retcodeName,
          volume: riskCheck.lotSize,
          accountInfo,
          details: {
            ...preflight,
            preflightAllowed: preflight.allowed,
            preflightRetcode: preflight.retcode,
            preflightRetcodeName: preflight.retcodeName,
          },
        });
        auditService.preflightRejected({
          symbol: signal.symbol,
          strategy: signal.strategy,
          module: 'paperTradingService',
          scope: 'paper',
          signal: signal.signal,
          calculatedLot: riskCheck.lotSize,
          mt5Retcode: preflight.retcode,
          preflightMessage,
          reasonCode: preflight.retcodeName || 'PREFLIGHT_REJECTED',
          reasonText: preflightMessage,
          details: preflight,
        });
        this._broadcastRejection(signal, preflightMessage, {
          stage: 'preflight',
          code: preflight.retcode,
          codeName: preflight.retcodeName,
        });
        return;
      }
      const result = await mt5Service.placeOrder(
        signal.symbol,
        signal.signal,
        riskCheck.lotSize,
        signal.sl,
        signal.tp,
        brokerComment
      );

      const atrAtEntry = signal.indicatorsSnapshot?.atr || 0;
      const entryPrice = result.entryDeal?.price || result.price || quotedEntryPrice;
      const openedAt = result.entryDeal?.time ? new Date(result.entryDeal.time) : new Date();
      const mt5PositionId = result.positionId || result.orderId || null;
      const mt5OrderId = result.orderId || result.entryDeal?.orderId || null;
      const mt5DealId = result.entryDeal?.id || result.dealId || null;
      const mt5Comment = result.entryDeal?.comment || brokerComment;
      const entryCommission = Number(result.entryDeal?.commission) || 0;
      const entrySwap = Number(result.entryDeal?.swap) || 0;
      const entryFee = Number(result.entryDeal?.fee) || 0;
      const activeProfile = await RiskProfile.getActive();
      const strategyRecord = signal.strategy ? await Strategy.findByName(signal.strategy) : null;
      const breakevenConfig = signal.effectiveBreakeven
        || signal.effectiveTradeManagement?.breakeven
        || breakevenService.resolveEffectiveBreakeven(activeProfile, strategyRecord);
      const exitPlan = signal.effectiveExitPlan
        || breakevenService.resolveEffectiveExitPlan(
          activeProfile,
          strategyRecord,
          signal.exitPlan || null
        );
      const managedPositionState = buildManagedPositionState({
        signal,
        lotSize: riskCheck.lotSize,
        entryPrice,
        breakevenConfig,
        exitPlan,
        plannedRiskAmount: riskCheck.plannedRiskAmount,
      });
      const openCapture = buildOpenTradeCapture(signal, managedPositionState);
      const playbookTradeFields = buildSignalPlaybookTradeFields(signal);
      const spreadAtEntry = Number.isFinite(Number(priceData.ask)) && Number.isFinite(Number(priceData.bid))
        ? Math.abs(Number(priceData.ask) - Number(priceData.bid))
        : null;
      const slippageEstimate = Number.isFinite(Number(entryPrice)) && Number.isFinite(Number(quotedEntryPrice))
        ? parseFloat((Number(entryPrice) - Number(quotedEntryPrice)).toFixed(10))
        : null;

      // Save to paper positions DB
      const position = await paperPositionsDb.insert({
        symbol: signal.symbol,
        type: signal.signal,
        entryPrice,
        currentSl: signal.sl,
        currentTp: signal.tp,
        lotSize: riskCheck.lotSize,
        mt5PositionId,
        mt5OrderId,
        mt5EntryDealId: mt5DealId,
        mt5Comment,
        strategy: signal.strategy,
        comment: tradeComment,
        confidence: signal.confidence,
        rawConfidence: signal.rawConfidence ?? signal.confidence,
        reason: openCapture.signalReason || signal.reason,
        atrAtEntry,
        ...managedPositionState,
        ...openCapture,
        ...playbookTradeFields,
        requestedEntryPrice: quotedEntryPrice,
        spreadAtEntry,
        slippageEstimate,
        brokerRetcodeOpen: result.retcode ?? null,
        indicatorsSnapshot: openCapture.indicatorsSnapshot,
        openedAt,
        status: 'OPEN',
      });

      // Log to trade_log with all required fields
      await TradeLog.logOpen({
        symbol: signal.symbol,
        type: signal.signal,
        lotSize: riskCheck.lotSize,
        entryPrice,
        stopLoss: signal.sl,
        takeProfit: signal.tp,
        signalReason: openCapture.signalReason || signal.reason,
        entryReason: openCapture.entryReason,
        setupReason: openCapture.setupReason,
        triggerReason: openCapture.triggerReason,
        strategy: signal.strategy,
        confidence: signal.confidence,
        rawConfidence: signal.rawConfidence ?? signal.confidence,
        indicatorsSnapshot: openCapture.indicatorsSnapshot,
        commission: entryCommission,
        swap: entrySwap,
        fee: entryFee,
        mt5PositionId,
        mt5OrderId,
        mt5DealId,
        mt5Comment,
        comment: tradeComment,
        positionDbId: position._id,
        executionPolicy: signal.executionPolicy || null,
        executionScore: managedPositionState.executionScore,
        executionScoreDetails: managedPositionState.executionScoreDetails,
        plannedRiskAmount: managedPositionState.plannedRiskAmount,
        targetRMultiple: managedPositionState.targetRMultiple,
        exitPlanSnapshot: managedPositionState.exitPlanSnapshot,
        managementEvents: managedPositionState.managementEvents,
        setupTimeframe: managedPositionState.setupTimeframe,
        entryTimeframe: managedPositionState.entryTimeframe,
        setupCandleTime: managedPositionState.setupCandleTime,
        entryCandleTime: managedPositionState.entryCandleTime,
        ...playbookTradeFields,
        initialSl: openCapture.initialSl,
        initialTp: openCapture.initialTp,
        finalSl: openCapture.finalSl,
        finalTp: openCapture.finalTp,
        requestedEntryPrice: quotedEntryPrice,
        spreadAtEntry,
        slippageEstimate,
        brokerRetcodeOpen: result.retcode ?? null,
        openedAt,
      });

      console.log(
        `[PaperTrading] Trade executed: ${signal.signal} ${riskCheck.lotSize} ${signal.symbol} `
        + `@ ${entryPrice} | SL: ${signal.sl} TP: ${signal.tp} | ${signal.reason}`
      );

      auditService.orderOpened({
        symbol: signal.symbol,
        strategy: signal.strategy,
        module: 'paperTradingService',
        scope: 'paper',
        signal: signal.signal,
        calculatedLot: riskCheck.lotSize,
        price: entryPrice,
        sl: signal.sl,
        tp: signal.tp,
        positionDbId: position._id,
        reasonText: `Paper opened ${signal.signal} ${riskCheck.lotSize} ${signal.symbol} @ ${entryPrice}`,
        details: {
          mt5PositionId,
          mt5DealId,
          orderId: result.orderId || null,
          preflightAllowed: preflight.allowed,
          preflightRetcode: preflight.retcode,
          preflightRetcodeName: preflight.retcodeName,
          sendRetcode: result.retcode ?? null,
        },
      });

      // Broadcast + notify
      const openPaperPositions = await paperPositionsDb.find({ status: 'OPEN' });
      websocketService.broadcast('positions', 'paper_positions_sync', openPaperPositions);
      websocketService.broadcast('positions', 'paper_position_update', { action: 'opened', position });
      websocketService.broadcast('trades', 'paper_trade_opened', position);
      await tradeNotificationService.notifyTradeOpened({
        scope: 'paper',
        ...position,
        symbol: position.symbol || signal.symbol,
        type: position.type || signal.signal,
        side: position.type || signal.signal,
        entryPrice: position.entryPrice ?? entryPrice,
        stopLoss: position.currentSl ?? signal.sl,
        takeProfit: position.currentTp ?? signal.tp,
        volume: position.lotSize ?? riskCheck.lotSize,
        strategy: position.strategy || signal.strategy,
        confidence: position.confidence ?? signal.confidence,
        reason: position.reason || openCapture.signalReason || signal.reason,
        openedAt: position.openedAt || openedAt,
        mt5OrderId: position.mt5OrderId || mt5OrderId,
        mt5PositionId: position.mt5PositionId || mt5PositionId,
      }, { immediate: true });

      try {
        await this.syncMonitorNow('forced_sync');
      } catch (syncError) {
        console.warn(`[PaperTrading] Post-open monitor sync failed for ${signal.symbol}: ${syncError.message}`);
      }

    } catch (err) {
      console.error(`[PaperTrading] Execute error for ${signal.symbol}:`, err.message);
      try {
        const accountInfo = mt5Service.isConnected() ? await mt5Service.getAccountInfo() : null;
        const auditCode = err.code ?? err.details?.retcode ?? null;
        const auditCodeName = err.codeName ?? err.details?.retcodeName ?? null;
        const auditStage = err.method === 'placeOrder'
          ? 'order_send'
          : err.method === 'preflightOrder'
            ? 'preflight'
            : 'execution';

        await this._recordAudit(auditStage, 'ERROR', signal, {
          message: err.message,
          code: auditCode,
          codeName: auditCodeName,
          accountInfo,
          details: {
            ...(err.details || { method: err.method || null }),
            preflightAllowed: preflight?.allowed ?? null,
            preflightRetcode: preflight?.retcode ?? null,
            preflightRetcodeName: preflight?.retcodeName ?? null,
            sendRetcode: err.details?.retcode ?? err.code ?? null,
            sendRetcodeName: err.details?.retcodeName ?? err.codeName ?? null,
          },
        });
        auditService.orderFailed({
          symbol: signal.symbol,
          strategy: signal.strategy,
          module: 'paperTradingService',
          scope: 'paper',
          signal: signal.signal,
          mt5Retcode: typeof auditCode === 'number' ? auditCode : null,
          reasonCode: auditCodeName || `ORDER_FAILED:${auditStage}`,
          reasonText: err.message,
          details: {
            ...(err.details || { method: err.method || null, stage: auditStage }),
            preflightAllowed: preflight?.allowed ?? null,
            preflightRetcode: preflight?.retcode ?? null,
            preflightRetcodeName: preflight?.retcodeName ?? null,
            sendRetcode: err.details?.retcode ?? err.code ?? null,
            sendRetcodeName: err.details?.retcodeName ?? err.codeName ?? null,
          },
        });
        this._broadcastRejection(signal, err.message, {
          stage: auditStage,
          code: auditCode,
          codeName: auditCodeName,
        });
      } catch (auditError) {
        console.error('[PaperTrading] Failed to record execution audit:', auditError.message);
      }
    }
  }

  /**
   * Risk validation for paper trades (uses paperPositionsDb instead of positionsDb)
   */
  async _validatePaperTrade(signal, accountInfo) {
    return await riskManager.validateTrade(signal, accountInfo, {
      scope: 'paper',
      positionsStore: paperPositionsDb,
      tradingEnabled: process.env.PAPER_TRADING_ENABLED === 'true',
      mt5Service,
    });
  }

  /**
   * Start position monitor for paper trading
   * Syncs MT5 demo positions, detects closures, logs to trade_log
   */
  _startPositionMonitor() {
    if (this.monitorInterval) {
      return;
    }

    this.monitorIntervalMs = this.monitorBaseTickMs;
    this.monitorInterval = setInterval(async () => {
      try {
        await this._runMonitorCycle();
      } catch (err) {
        console.error('[PaperTrading] Monitor error:', err.message);
      }
    }, this.monitorBaseTickMs);

    if (typeof this.monitorInterval.unref === 'function') {
      this.monitorInterval.unref();
    }

    console.log(`[PaperTrading] Position monitor started (base tick: ${this.monitorBaseTickMs / 1000}s)`);
    this.syncMonitorNow('forced_sync').catch((err) => {
      console.error('[PaperTrading] Initial monitor sync error:', err.message);
    });
  }

  requestMonitorSync(reason = 'forced_sync') {
    this.pendingMonitorSyncReason = reason || 'forced_sync';
  }

  async syncMonitorNow(reason = 'forced_sync') {
    this.requestMonitorSync(reason);
    await this._runMonitorCycle();
  }

  /**
   * Sync MT5 demo positions with paper positions DB
   * Detect externally closed positions (SL/TP hit) and log them
   */
  async _syncPaperPositions({ broadcast = true, now = new Date() } = {}) {
    if (!mt5Service.isConnected()) {
      return [];
    }

    const mt5Positions = await mt5Service.getPositions();
    const localPositions = await paperPositionsDb.find({});
    const matchedLocalIds = new Set();
    const matchedPairs = [];

    for (const mt5Pos of mt5Positions) {
      const localPos = this._findMatchingPaperPosition(mt5Pos, localPositions, matchedLocalIds);
      if (localPos) {
        matchedLocalIds.add(localPos._id);
        matchedPairs.push({ mt5Pos, localPos });
      } else if (isAdoptablePaperMt5Position(mt5Pos)) {
        const adoptedPosition = await this._adoptPaperPositionFromMt5(mt5Pos, now);
        if (adoptedPosition) {
          matchedLocalIds.add(adoptedPosition._id);
          matchedPairs.push({ mt5Pos, localPos: adoptedPosition });
        }
      }
    }

    // Detect positions closed externally (SL/TP hit or manual close on MT5)
    for (const localPos of localPositions) {
      if (localPos.mt5PositionId && !matchedLocalIds.has(localPos._id)) {
        if (this._isWithinPaperOpenSyncGrace(localPos, now)) {
          continue;
        }
        await this._handlePaperClose(localPos);
      }
    }

    // Update local positions with current MT5 data
    for (const { mt5Pos, localPos } of matchedPairs) {
      if (localPos) {
        const marketState = await this._resolvePaperMarketStopState(localPos, mt5Pos, now);
        const marketStopResult = await this._applyPaperMarketStopState(localPos, marketState, now);
        if (marketStopResult.active) {
          continue;
        }

        const effectiveLocalPos = marketStopResult.position || localPos;
        const snapshotPatch = {
          currentSl: mt5Pos.stopLoss || effectiveLocalPos.currentSl,
          currentTp: mt5Pos.takeProfit || effectiveLocalPos.currentTp,
          currentPrice: mt5Pos.currentPrice ?? effectiveLocalPos.currentPrice ?? null,
          unrealizedPl: mt5Pos.unrealizedProfit ?? mt5Pos.profit ?? 0,
        };
        if (mt5Pos.id && String(effectiveLocalPos.mt5PositionId) !== String(mt5Pos.id)) {
          snapshotPatch.mt5PositionId = String(mt5Pos.id);
          snapshotPatch.mt5PositionIdCorrectedAt = now;
          snapshotPatch.mt5PositionIdCorrectionSource = 'mt5_position_match';
        }

        if (this._hasSnapshotChanges(effectiveLocalPos, snapshotPatch)) {
          await paperPositionsDb.update(
            { _id: effectiveLocalPos._id },
            { $set: snapshotPatch }
          );
        }
      }
    }

    const updatedPositions = await paperPositionsDb.find({});
    if (broadcast) {
      websocketService.broadcast('positions', 'paper_positions_sync', updatedPositions);
    }
    return updatedPositions;
  }

  async _runTrailingStops(
    positions = null,
    contexts = null,
    scanMode = 'heavy',
    now = new Date(),
    cycleState = { id: `paper-monitor:${Date.now()}`, fingerprints: new Set() }
  ) {
    if (!mt5Service.isConnected()) return [];
    const sourcePositions = Array.isArray(positions) ? positions : await paperPositionsDb.find({});
    const effectivePositions = sourcePositions.filter((position) => !this._isMarketStoppedPosition(position));
    if (effectivePositions.length === 0) return [];
    const effectiveKeys = new Set(effectivePositions.map((position) => this._getPositionKey(position)));
    const effectiveContexts = Array.isArray(contexts) && contexts.length > 0
      ? contexts.filter((context) => effectiveKeys.has(context.key) && !this._isMarketStoppedPosition(context.position))
      : (await this._buildPositionContexts(effectivePositions, now, null)).map((context) => ({
          ...context,
          dueLight: true,
          dueHeavy: true,
          scanReason: context.scanReason || 'cadence',
        }));
    const hooks = trailingStopService.createPositionManagementHooks({
      getCandlesFn: scanMode === 'heavy'
        ? async (symbol, timeframe) => mt5Service.getCandles(symbol, timeframe, null, 251)
        : null,
      closePositionFn: async (position, reason) => {
        if (!position?._id) {
          throw new Error('Paper position is missing local _id');
        }
        return this.closePosition(position._id, reason || 'TIME_EXIT');
      },
      partialCloseFn: async (position, volume) => {
        if (!position?.mt5PositionId) {
          throw new Error('Paper position is missing mt5PositionId');
        }
        if (typeof mt5Service.partialClosePosition !== 'function') {
          throw new Error('partialClosePosition not supported by MT5 bridge');
        }
        return mt5Service.partialClosePosition(position.mt5PositionId, volume);
      },
      updatePositionFn: async (localId, patch) => {
        await paperPositionsDb.update({ _id: localId }, { $set: patch });
      },
    });

    const metadataByPosition = this._buildScanMetadataMap(effectiveContexts, scanMode, now);
    const updates = await trailingStopService.processPositions(
      effectivePositions,
      async (symbol) => mt5Service.getPrice(symbol),
      async (positionId, newSl, newTp) => mt5Service.modifyPosition(positionId, newSl, newTp),
      hooks,
      {
        scanMode,
        cycleState,
        scanMetadataByPosition: metadataByPosition,
      }
    );

    if (updates.length === 0) {
      return [];
    }

    const positionsByMt5Id = new Map(
      effectivePositions
        .filter((position) => position.mt5PositionId != null)
        .map((position) => [String(position.mt5PositionId), position])
    );

    for (const update of updates) {
      const localPosition = positionsByMt5Id.get(String(update.positionId));
      if (!localPosition) continue;

      if (update.newSl !== undefined) {
        await paperPositionsDb.update(
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
        module: 'paperTradingService',
        scope: 'paper',
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

    const refreshedPositions = await paperPositionsDb.find({});
    websocketService.broadcast('positions', 'paper_positions_sync', refreshedPositions);
    return updates;
  }

  async _runMonitorCycle() {
    if (this.monitorProcessing || (!this.running && !this.pendingMonitorSyncReason)) {
      return;
    }

    this.monitorProcessing = true;
    const now = new Date();
    let forcedSyncReason = this.pendingMonitorSyncReason;
    this.pendingMonitorSyncReason = null;

    try {
      const syncedPositions = await this._syncPaperPositions({ broadcast: false, now });
      const positions = Array.isArray(syncedPositions) ? syncedPositions : [];
      const positionsChanged = this._didPaperPositionsChange(positions);
      if (positionsChanged && !forcedSyncReason) {
        forcedSyncReason = 'forced_sync';
      }
      this._cleanupMonitorMaps(positions);

      const contexts = await this._buildPositionContexts(positions, now, forcedSyncReason);
      const lightContexts = contexts.filter((context) => context.dueLight);
      const heavyContexts = contexts.filter((context) => context.dueHeavy);
      const cycleState = { id: `paper-monitor:${Date.now()}`, fingerprints: new Set() };

      if (lightContexts.length > 0) {
        const lightKeys = new Set(lightContexts.map((context) => context.key));
        const lightPositions = positions.filter((position) => lightKeys.has(this._getPositionKey(position)));
        await this._runTrailingStops(lightPositions, lightContexts, 'light', now, cycleState);
        lightContexts.forEach((context) => {
          this.lastLightScanAt.set(context.key, now);
        });
      }

      if (heavyContexts.length > 0) {
        const refreshedPositions = lightContexts.length > 0 ? await paperPositionsDb.find({}) : positions;
        const heavyKeys = new Set(heavyContexts.map((context) => context.key));
        const heavyPositions = refreshedPositions.filter((position) => heavyKeys.has(this._getPositionKey(position)));
        await this._runTrailingStops(heavyPositions, heavyContexts, 'heavy', now, cycleState);
        heavyContexts.forEach((context) => {
          this.lastHeavyScanAt.set(context.key, now);
        });
      }

      this.monitorStatus = this._buildMonitorStatus(contexts, now, forcedSyncReason);
    } catch (err) {
      console.error('[PaperTrading] Monitor error:', err.message);
      this.monitorStatus = {
        ...this.monitorStatus,
        running: this.running,
        intervalMs: this.running ? this.monitorBaseTickMs : 0,
        baseTickMs: this.monitorBaseTickMs,
        lastScanAt: toIsoOrNull(now),
      };
    } finally {
      this.monitorProcessing = false;
    }
  }

  /**
   * Handle a paper position that was closed externally
   */
  async _handlePaperClose(localPos) {
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
        console.warn(`[PaperTrading] Deal reconciliation failed for ${localPos.symbol}: ${reconciliationError.message}`);
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

    const openedAt = new Date(localPos.openedAt);

    // Log closure to trade_log
    await TradeLog.logClose(localPos._id, {
      exitPrice: closedSnapshot.exitPrice,
      exitReason: closedSnapshot.exitReason,
      profitLoss: closedSnapshot.profitLoss,
      profitPips: closedSnapshot.profitPips,
      commission: closedSnapshot.commission,
      swap: closedSnapshot.swap,
      fee: closedSnapshot.fee,
      grossProfitLoss: closedSnapshot.grossProfitLoss,
      finalSl: localPos.currentSl ?? localPos.finalSl ?? localPos.sl ?? null,
      finalTp: localPos.currentTp ?? localPos.finalTp ?? localPos.tp ?? null,
      brokerRetcodeModify: localPos.brokerRetcodeModify ?? null,
      positionSnapshot: buildPositionExportSnapshot(localPos),
      openedAt,
      closedAt: closedSnapshot.closedAt,
      realizedRMultiple: closedSnapshot.realizedRMultiple,
      targetRMultipleCaptured: closedSnapshot.targetRMultipleCaptured,
    });

    // Track loss for daily limit
    if (closedSnapshot.profitLoss < 0) {
      await riskManager.recordLoss(Math.abs(closedSnapshot.profitLoss), closedSnapshot.closedAt, 'paper');
    }

    try {
      await strategyDailyStopService.recordTradeOutcome({
        scope: 'paper',
        strategy: localPos.strategy,
        symbol: localPos.symbol,
        timeframe: localPos.setupTimeframe || localPos.timeframe || null,
        realizedRMultiple: closedSnapshot.realizedRMultiple,
        profitLoss: closedSnapshot.profitLoss,
        plannedRiskAmount: localPos.plannedRiskAmount,
        closedAt: closedSnapshot.closedAt,
      });
    } catch (_) {}

    // Remove from paper positions
    await paperPositionsDb.remove({ _id: localPos._id });

    const closedTrade = {
      ...localPos,
      ...closedSnapshot,
      holdingTime: TradeLog.formatHoldingTime(closedSnapshot.closedAt - openedAt),
    };

    console.log(
      `[PaperTrading] Position closed: ${localPos.symbol} ${localPos.type} `
      + `| P/L: ${closedSnapshot.profitLoss.toFixed(2)} (${closedSnapshot.profitPips.toFixed(1)} pips) `
      + `| Reason: ${closedSnapshot.exitReason} | Held: ${closedTrade.holdingTime}`
    );

    auditService.orderClosed({
      symbol: localPos.symbol,
      strategy: localPos.strategy,
      module: 'paperTradingService',
      scope: 'paper',
      signal: localPos.type,
      price: closedSnapshot.exitPrice,
      positionDbId: localPos._id,
      exitReason: closedSnapshot.exitReason,
      pnl: closedSnapshot.profitLoss,
      reasonCode: closedSnapshot.exitReason || 'CLOSED',
      reasonText: `Paper closed ${localPos.symbol} ${localPos.type} P/L ${closedSnapshot.profitLoss.toFixed(2)}`,
      details: {
        exitPrice: closedSnapshot.exitPrice,
        profitPips: closedSnapshot.profitPips,
        holdingTime: closedTrade.holdingTime,
      },
    });

    websocketService.broadcast('trades', 'paper_trade_closed', closedTrade);
    await notificationService.notifyTradeClosed(closedTrade);
    await this.syncMonitorNow('forced_sync');
  }

  /**
   * Manually close a paper position
   */
  async closePosition(positionDbId, reason = 'MANUAL') {
    const position = await paperPositionsDb.findOne({ _id: positionDbId });
    if (!position) {
      return { success: false, message: 'Paper position not found' };
    }

    if (mt5Service.isConnected()) {
      const accountInfo = await mt5Service.getAccountInfo();
      mt5Service.ensurePaperTradingAccount(accountInfo);
    }

    // Close on MT5 demo
    let closeResult = null;
    const closeAction = createManagerAction(reason || 'MANUAL', {
      source: 'paperTradingService.closePosition',
    });
    await paperPositionsDb.update({ _id: positionDbId }, {
      $set: {
        pendingExitAction: closeAction,
        managerActionId: closeAction.id,
        managementEvents: appendManagementEvent(position, closeAction, { status: 'PENDING' }),
      },
    });
    position.pendingExitAction = closeAction;
    position.managerActionId = closeAction.id;
    position.managementEvents = appendManagementEvent(position, closeAction, { status: 'PENDING' });
    if (position.mt5PositionId) {
      try {
        closeResult = await mt5Service.closePosition(position.mt5PositionId);
      } catch (err) {
        console.error(`[PaperTrading] MT5 close error: ${err.message}`);
      }
    }

    let dealSummary = null;
    if (position.mt5PositionId) {
      const reconciliationStart = position.openedAt
        ? new Date(new Date(position.openedAt).getTime() - (60 * 60 * 1000))
        : new Date(Date.now() - (7 * 24 * 60 * 60 * 1000));

      try {
        dealSummary = await mt5Service.getPositionDealSummary(
          position.mt5PositionId,
          reconciliationStart,
          new Date()
        );
      } catch (reconciliationError) {
        console.warn(`[PaperTrading] Deal reconciliation failed for ${position.symbol}: ${reconciliationError.message}`);
      }
    }

    let fallbackExitPrice = closeResult?.closeDeal?.price || closeResult?.price || null;
    if (!dealSummary?.exitPrice && !fallbackExitPrice) {
      const priceData = await mt5Service.getPrice(position.symbol);
      fallbackExitPrice = position.type === 'BUY' ? priceData.bid : priceData.ask;
    }

    const closedSnapshot = buildClosedTradeSnapshot(position, dealSummary, {
      exitPrice: fallbackExitPrice,
      reason,
      pendingExitAction: position.pendingExitAction || null,
    });

    const openedAt = new Date(position.openedAt);

    // Log to trade_log
    await TradeLog.logClose(position._id, {
      exitPrice: closedSnapshot.exitPrice,
      exitReason: closedSnapshot.exitReason,
      profitLoss: closedSnapshot.profitLoss,
      profitPips: closedSnapshot.profitPips,
      commission: closedSnapshot.commission,
      swap: closedSnapshot.swap,
      fee: closedSnapshot.fee,
      grossProfitLoss: closedSnapshot.grossProfitLoss,
      finalSl: position.currentSl ?? position.finalSl ?? position.sl ?? null,
      finalTp: position.currentTp ?? position.finalTp ?? position.tp ?? null,
      brokerRetcodeClose: closeResult?.retcode ?? null,
      brokerRetcodeModify: position.brokerRetcodeModify ?? null,
      positionSnapshot: buildPositionExportSnapshot(position),
      openedAt,
      closedAt: closedSnapshot.closedAt,
      realizedRMultiple: closedSnapshot.realizedRMultiple,
      targetRMultipleCaptured: closedSnapshot.targetRMultipleCaptured,
    });

    if (closedSnapshot.profitLoss < 0) {
      await riskManager.recordLoss(Math.abs(closedSnapshot.profitLoss), closedSnapshot.closedAt, 'paper');
    }

    try {
      await strategyDailyStopService.recordTradeOutcome({
        scope: 'paper',
        strategy: position.strategy,
        symbol: position.symbol,
        timeframe: position.setupTimeframe || position.timeframe || null,
        realizedRMultiple: closedSnapshot.realizedRMultiple,
        profitLoss: closedSnapshot.profitLoss,
        plannedRiskAmount: position.plannedRiskAmount,
        closedAt: closedSnapshot.closedAt,
      });
    } catch (_) {}

    await paperPositionsDb.remove({ _id: positionDbId });

    const closedTrade = {
      ...position,
      ...closedSnapshot,
      holdingTime: TradeLog.formatHoldingTime(closedSnapshot.closedAt - openedAt),
    };

    auditService.orderClosed({
      symbol: position.symbol,
      strategy: position.strategy,
      module: 'paperTradingService',
      scope: 'paper',
      signal: position.type,
      price: closedSnapshot.exitPrice,
      positionDbId: position._id,
      exitReason: closedSnapshot.exitReason,
      pnl: closedSnapshot.profitLoss,
      reasonCode: closedSnapshot.exitReason || reason || 'MANUAL',
      reasonText: `Paper manual close ${position.symbol} ${position.type} P/L ${closedSnapshot.profitLoss.toFixed(2)}`,
      details: {
        exitPrice: closedSnapshot.exitPrice,
        profitPips: closedSnapshot.profitPips,
        holdingTime: closedTrade.holdingTime,
      },
    });

    websocketService.broadcast('trades', 'paper_trade_closed', closedTrade);
    await notificationService.notifyTradeClosed(closedTrade);
    await this.syncMonitorNow('forced_sync');

    return {
      success: true,
      profitLoss: closedSnapshot.profitLoss,
      profitPips: closedSnapshot.profitPips,
      holdingTime: closedTrade.holdingTime,
    };
  }

  /**
   * Get current paper trading status
   */
  async getStatus() {
    const openPositions = await paperPositionsDb.find({});
    const todayTrades = await TradeLog.findToday();
    const allTimeStats = await TradeLog.getStats();
    const assignments = await this._getActiveAssignments();
    const assignmentStats = buildAssignmentStats(assignments);
    const signalScanBuckets = buildSignalScanBucketStatus(
      assignments,
      this.scheduler ? this.scheduler.getBucketStates() : new Map()
    );
    let strategyDailyStopStatus = null;
    try {
      const config = await strategyDailyStopService.getActiveConfig();
      const { tradingDay, resetAt } = strategyDailyStopService.resolveTradingDay(new Date(), config);
      const todayStoppedStrategies = await strategyDailyStopService.getTodayStoppedStrategies({ scope: 'paper' }, config);
      strategyDailyStopStatus = {
        scope: 'paper',
        enabled: config?.enabled !== false,
        tradingDay,
        resetAt,
        todayStoppedStrategies,
        todayStoppedStrategiesCount: todayStoppedStrategies.length,
        blockedEntriesTodayByStrategyDailyStop: strategyDailyStopService.getBlockedEntriesToday(tradingDay, 'paper'),
      };
    } catch (_) {
      strategyDailyStopStatus = null;
    }
    let runtimeIdentity = typeof mt5Service.buildRuntimeIdentityStatus === 'function'
      ? mt5Service.buildRuntimeIdentityStatus()
      : null;

    if (mt5Service.isConnected() && typeof mt5Service.buildRuntimeIdentityStatus === 'function') {
      try {
        const accountInfo = await mt5Service.getAccountInfo();
        runtimeIdentity = mt5Service.buildRuntimeIdentityStatus(accountInfo);
      } catch (err) {
        runtimeIdentity = {
          ...(runtimeIdentity || { scope: 'paper', connected: true, mt5Path: null, account: null }),
          connected: mt5Service.isConnected(),
          validation: {
            ok: false,
            warnings: [],
            errors: [err.message],
          },
        };
      }
    }

    const paperRuntime = buildPaperRuntimeStatus(runtimeIdentity, this.running);

    return {
      scope: 'paper',
      enabled: paperRuntime.enabled,
      running: this.running,
      startedAt: this.startedAt,
      runtime: this.startedAt ? TradeLog.formatHoldingTime(Date.now() - this.startedAt.getTime()) : null,
      connected: paperRuntime.connected,
      mt5Path: paperRuntime.mt5Path,
      account: paperRuntime.account,
      validation: paperRuntime.validation,
      message: paperRuntime.message,
      runtimeIdentity,
      paperRuntime,
      openPositions: openPositions.length,
      positions: openPositions,
      todayTrades: todayTrades.length,
      allTimeStats,
      activeAssignments: assignmentStats.activeAssignments,
      activeSymbols: assignmentStats.activeSymbols,
      signalScanBuckets,
      scanBuckets: signalScanBuckets,
      strategyDailyStop: strategyDailyStopStatus,
      todayStoppedStrategiesCount: strategyDailyStopStatus?.todayStoppedStrategiesCount || 0,
      blockedEntriesTodayByStrategyDailyStop: strategyDailyStopStatus?.blockedEntriesTodayByStrategyDailyStop || 0,
      positionMonitor: {
        ...this.monitorStatus,
        running: this.running,
        intervalMs: this.running ? this.monitorBaseTickMs : 0,
        baseTickMs: this.monitorBaseTickMs,
      },
      monitorIntervalMs: this.monitorIntervalMs,
    };
  }

  /**
   * Get open paper positions
   */
  async getPositions() {
    return await paperPositionsDb.find({});
  }
}

// Singleton
const paperTradingService = new PaperTradingService();

module.exports = paperTradingService;
