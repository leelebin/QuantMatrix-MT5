/**
 * Risk Manager
 * Controls position sizing, validates trades against risk rules
 */

const { getInstrument } = require('../config/instruments');
const { positionsDb, paperPositionsDb, riskStateDb } = require('../config/db');
const RiskProfile = require('../models/RiskProfile');
const auditService = require('./auditService');

class RiskManager {
  constructor() {
    this.stateByScope = new Map();
    this.stateLoadPromises = new Map();
  }

  _normalizeScope(scope = 'live') {
    return String(scope || 'live').toLowerCase() === 'paper' ? 'paper' : 'live';
  }

  _getState(scope = 'live') {
    const normalizedScope = this._normalizeScope(scope);

    if (!this.stateByScope.has(normalizedScope)) {
      this.stateByScope.set(normalizedScope, {
        dailyLossTracker: {},
        peakBalance: 0,
        peakEquity: 0,
        createdAt: null,
        loaded: false,
      });
    }

    return this.stateByScope.get(normalizedScope);
  }

  _getPositionsStore(scope = 'live', overrideStore = null) {
    if (overrideStore) return overrideStore;
    return this._normalizeScope(scope) === 'paper' ? paperPositionsDb : positionsDb;
  }

  _isTradingEnabled(scope = 'live', override = null) {
    if (typeof override === 'boolean') return override;
    return this._normalizeScope(scope) === 'paper'
      ? process.env.PAPER_TRADING_ENABLED === 'true'
      : process.env.TRADING_ENABLED === 'true';
  }

  async getActiveRiskSettings() {
    const profile = await RiskProfile.getActive();
    return RiskProfile.toRuntimeSettings(profile);
  }

  async ensureLoaded(scope = 'live') {
    const normalizedScope = this._normalizeScope(scope);
    const state = this._getState(normalizedScope);

    if (state.loaded) {
      return state;
    }

    if (!this.stateLoadPromises.has(normalizedScope)) {
      this.stateLoadPromises.set(normalizedScope, (async () => {
        const persistedState = await riskStateDb.findOne({ _id: normalizedScope });
        if (persistedState) {
          state.dailyLossTracker = persistedState.dailyLossTracker || {};
          state.peakBalance = Number(persistedState.peakBalance) || 0;
          state.peakEquity = Number(persistedState.peakEquity) || state.peakBalance || 0;
          state.createdAt = persistedState.createdAt || null;
        }

        state.loaded = true;
        this.stateLoadPromises.delete(normalizedScope);
        return state;
      })().catch((error) => {
        this.stateLoadPromises.delete(normalizedScope);
        throw error;
      }));
    }

    return await this.stateLoadPromises.get(normalizedScope);
  }

  _getDateKey(date = new Date()) {
    return new Date(date).toISOString().split('T')[0];
  }

  _pruneDailyLossTracker(state, maxDays = 45) {
    const cutoff = Date.now() - (maxDays * 24 * 60 * 60 * 1000);

    for (const dateKey of Object.keys(state.dailyLossTracker)) {
      const timestamp = new Date(`${dateKey}T00:00:00.000Z`).getTime();
      if (!Number.isFinite(timestamp) || timestamp < cutoff) {
        delete state.dailyLossTracker[dateKey];
      }
    }
  }

  async _persistState(scope = 'live') {
    const normalizedScope = this._normalizeScope(scope);
    const state = await this.ensureLoaded(normalizedScope);

    this._pruneDailyLossTracker(state);
    if (!state.createdAt) {
      state.createdAt = new Date();
    }

    await riskStateDb.update(
      { _id: normalizedScope },
      {
        _id: normalizedScope,
        scope: normalizedScope,
        dailyLossTracker: state.dailyLossTracker,
        peakBalance: state.peakBalance,
        peakEquity: state.peakEquity,
        createdAt: state.createdAt,
        updatedAt: new Date(),
      },
      { upsert: true }
    );
  }

  async syncAccountState(accountInfo = {}, scope = 'live') {
    const normalizedScope = this._normalizeScope(scope);
    const state = await this.ensureLoaded(normalizedScope);
    const balance = Number(accountInfo.balance) || 0;
    const equity = Number(accountInfo.equity) || balance;
    let changed = false;

    if (balance > state.peakBalance) {
      state.peakBalance = balance;
      changed = true;
    }

    if (state.peakEquity <= 0 && state.peakBalance > 0) {
      state.peakEquity = state.peakBalance;
      changed = true;
    }

    if (equity > state.peakEquity) {
      state.peakEquity = equity;
      changed = true;
    }

    if (changed) {
      await this._persistState(normalizedScope);
    }

    return {
      peakBalance: state.peakBalance,
      peakEquity: state.peakEquity,
      todayLoss: this._getTodayLossSync(normalizedScope),
    };
  }

  _getCurrentDrawdown(peakEquity, equity) {
    const normalizedPeak = Number(peakEquity) || 0;
    const normalizedEquity = Number(equity) || 0;
    return normalizedPeak > 0 ? (normalizedPeak - normalizedEquity) / normalizedPeak : 0;
  }

  calculateLotSizeDetails(signal, instrument, balance, settings) {
    const instrumentRiskPercent = Number(instrument?.riskParams?.riskPercent) || 0;
    const effectiveRiskPercent = Math.min(settings.maxRiskPerTrade, instrumentRiskPercent || settings.maxRiskPerTrade);
    const riskAmount = balance * effectiveRiskPercent;
    const currentPrice = Number(signal.entryPrice) || Number(signal.tp) || 0;
    const stopLoss = Number(signal.sl) || 0;
    const slDistance = Math.abs(currentPrice - stopLoss);
    const slPips = instrument.pipSize > 0 ? slDistance / instrument.pipSize : 0;

    if (currentPrice <= 0 || stopLoss <= 0 || slPips <= 0) {
      return {
        allowed: false,
        reason: 'Invalid stop loss distance for risk sizing',
        finalLotSize: 0,
        theoreticalLotSize: 0,
        effectiveRiskPercent,
        riskAmount,
        overrideApplied: false,
        auditMessage: null,
      };
    }

    const riskPerPipPerLot = instrument.pipValue;
    let theoreticalLotSize = riskAmount / (slPips * riskPerPipPerLot);
    theoreticalLotSize = Math.floor(theoreticalLotSize / instrument.lotStep) * instrument.lotStep;
    theoreticalLotSize = Math.max(theoreticalLotSize, 0);
    theoreticalLotSize = parseFloat(theoreticalLotSize.toFixed(4));

    const cappedLotSize = Math.min(theoreticalLotSize, 5.0);

    if (cappedLotSize < instrument.minLot) {
      if (settings.allowAggressiveMinLot) {
        const finalLotSize = parseFloat(instrument.minLot.toFixed(2));
        return {
          allowed: true,
          reason: 'All risk checks passed',
          finalLotSize,
          theoreticalLotSize: cappedLotSize,
          effectiveRiskPercent,
          riskAmount,
          overrideApplied: true,
          auditMessage: `Aggressive min-lot override applied: theoretical ${cappedLotSize.toFixed(4)} < minimum ${instrument.minLot.toFixed(2)}. Using ${finalLotSize.toFixed(2)}.`,
        };
      }

      return {
        allowed: false,
        reason: `Calculated lot size ${cappedLotSize.toFixed(4)} below minimum ${instrument.minLot.toFixed(2)}. Enable aggressive min-lot mode to allow the minimum lot.`,
        finalLotSize: 0,
        theoreticalLotSize: cappedLotSize,
        effectiveRiskPercent,
        riskAmount,
        overrideApplied: false,
        auditMessage: null,
      };
    }

    return {
      allowed: true,
      reason: 'All risk checks passed',
      finalLotSize: parseFloat(cappedLotSize.toFixed(2)),
      theoreticalLotSize: cappedLotSize,
      effectiveRiskPercent,
      riskAmount,
      overrideApplied: false,
      auditMessage: null,
    };
  }

  /**
   * Check all risk rules before placing a trade
   * @param {object} signal - { symbol, signal, sl, tp }
   * @param {object} accountInfo - { balance, equity }
   * @param {object} options - { scope, positionsStore, tradingEnabled }
   * @returns {{ allowed: boolean, reason: string, lotSize: number }}
   */
  async validateTrade(signal, accountInfo, options = {}) {
    const scope = this._normalizeScope(options.scope || 'live');
    const state = await this.syncAccountState(accountInfo, scope);
    const settings = await this.getActiveRiskSettings();
    const instrument = getInstrument(signal.symbol);

    const auditBase = {
      symbol: signal?.symbol || null,
      strategy: signal?.strategy || null,
      module: 'riskManager',
      scope,
      signal: signal?.signal || null,
      confidence: typeof signal?.confidence === 'number' ? signal.confidence : null,
      sl: typeof signal?.sl === 'number' ? signal.sl : null,
      tp: typeof signal?.tp === 'number' ? signal.tp : null,
      setupTimeframe: signal?.setupTimeframe || null,
      entryTimeframe: signal?.entryTimeframe || null,
    };

    const emitReject = (reasonCode, reasonText, extras = {}) => {
      auditService.riskRejected({
        ...auditBase,
        reasonCode,
        reasonText,
        riskCheck: { reasonCode, reasonText, ...extras },
        details: extras,
      });
    };

    if (!instrument) {
      const reasonText = `Unknown instrument: ${signal.symbol}`;
      emitReject(auditService.REASON.UNKNOWN_INSTRUMENT, reasonText);
      return { allowed: false, reason: reasonText, reasonCode: auditService.REASON.UNKNOWN_INSTRUMENT, lotSize: 0 };
    }

    const positionsStore = this._getPositionsStore(scope, options.positionsStore);
    const { balance, equity } = accountInfo;

    if (!this._isTradingEnabled(scope, options.tradingEnabled)) {
      const reasonText = scope === 'paper'
        ? 'Paper trading is disabled'
        : 'Trading is disabled (TRADING_ENABLED=false)';
      emitReject(auditService.REASON.TRADING_DISABLED, reasonText);
      return { allowed: false, reason: reasonText, reasonCode: auditService.REASON.TRADING_DISABLED, lotSize: 0 };
    }

    const todayLoss = this._getTodayLossSync(scope);
    if (todayLoss >= balance * settings.maxDailyLoss) {
      const reasonText = `Daily loss limit reached: ${todayLoss.toFixed(2)} >= ${(balance * settings.maxDailyLoss).toFixed(2)}`;
      emitReject(auditService.REASON.DAILY_LOSS_LIMIT, reasonText, {
        todayLoss,
        limit: balance * settings.maxDailyLoss,
      });
      return { allowed: false, reason: reasonText, reasonCode: auditService.REASON.DAILY_LOSS_LIMIT, lotSize: 0 };
    }

    const currentDrawdown = this._getCurrentDrawdown(state.peakEquity, equity);
    if (currentDrawdown >= settings.maxDrawdown) {
      const reasonText = `Max drawdown reached: ${(currentDrawdown * 100).toFixed(1)}% >= ${(settings.maxDrawdown * 100).toFixed(1)}%`;
      emitReject(auditService.REASON.MAX_DRAWDOWN, reasonText, {
        currentDrawdown,
        limit: settings.maxDrawdown,
      });
      return { allowed: false, reason: reasonText, reasonCode: auditService.REASON.MAX_DRAWDOWN, lotSize: 0 };
    }

    const openPositions = await positionsStore.count({});
    if (openPositions >= settings.maxConcurrentPositions) {
      const reasonText = `Max positions reached: ${openPositions} >= ${settings.maxConcurrentPositions}`;
      emitReject(auditService.REASON.MAX_POSITIONS_REACHED, reasonText, {
        openPositions,
        maxConcurrentPositions: settings.maxConcurrentPositions,
      });
      return { allowed: false, reason: reasonText, reasonCode: auditService.REASON.MAX_POSITIONS_REACHED, lotSize: 0 };
    }

    const symbolPositions = await positionsStore.count({ symbol: signal.symbol });
    if (symbolPositions >= settings.maxPositionsPerSymbol) {
      const reasonText = `Max positions for ${signal.symbol} reached: ${symbolPositions} >= ${settings.maxPositionsPerSymbol}`;
      emitReject(auditService.REASON.SYMBOL_EXPOSURE_LIMIT, reasonText, {
        symbolPositions,
        maxPositionsPerSymbol: settings.maxPositionsPerSymbol,
      });
      return { allowed: false, reason: reasonText, reasonCode: auditService.REASON.SYMBOL_EXPOSURE_LIMIT, lotSize: 0 };
    }

    const categoryPositions = await this._getCategoryPositionCount(instrument.category, positionsStore);
    if (categoryPositions >= 3) {
      const reasonText = `Max correlated positions for ${instrument.category}: ${categoryPositions} >= 3`;
      emitReject(auditService.REASON.CATEGORY_EXPOSURE_LIMIT, reasonText, {
        category: instrument.category,
        categoryPositions,
      });
      return { allowed: false, reason: reasonText, reasonCode: auditService.REASON.CATEGORY_EXPOSURE_LIMIT, lotSize: 0 };
    }

    const sizing = this.calculateLotSizeDetails(signal, instrument, balance, settings);
    if (!sizing.allowed) {
      const reasonCode = /below minimum/i.test(sizing.reason)
        ? auditService.REASON.LOT_BELOW_MIN
        : auditService.REASON.INVALID_SL;
      emitReject(reasonCode, sizing.reason, {
        theoreticalLotSize: sizing.theoreticalLotSize,
        minLot: instrument.minLot,
        effectiveRiskPercent: sizing.effectiveRiskPercent,
      });
      return {
        allowed: false,
        reason: sizing.reason,
        reasonCode,
        lotSize: 0,
        theoreticalLotSize: sizing.theoreticalLotSize,
        effectiveRiskPercent: sizing.effectiveRiskPercent,
        overrideApplied: false,
        profileName: settings.profile?.name || null,
      };
    }

    const entryPrice = Number(signal.entryPrice) || 0;
    if (entryPrice > 0 && Number(signal.sl) > 0) {
      const slDistance = Math.abs(entryPrice - signal.sl);
      const minSlDistance = instrument.spread * instrument.pipSize * 3;
      if (slDistance < minSlDistance) {
        const reasonText = `SL too close: ${slDistance.toFixed(5)} < ${minSlDistance.toFixed(5)} (3x spread)`;
        emitReject(auditService.REASON.SL_TOO_CLOSE, reasonText, {
          slDistance,
          minSlDistance,
        });
        return { allowed: false, reason: reasonText, reasonCode: auditService.REASON.SL_TOO_CLOSE, lotSize: 0 };
      }
    }

    return {
      allowed: true,
      reason: sizing.reason,
      reasonCode: 'RISK_OK',
      lotSize: sizing.finalLotSize,
      theoreticalLotSize: sizing.theoreticalLotSize,
      effectiveRiskPercent: sizing.effectiveRiskPercent,
      overrideApplied: sizing.overrideApplied,
      auditMessage: sizing.auditMessage,
      profileName: settings.profile?.name || null,
      allowAggressiveMinLot: settings.allowAggressiveMinLot,
    };
  }

  calculateLotSize(signal, instrument, balance, settingsOverride = null) {
    const settings = settingsOverride || {
      maxRiskPerTrade: Number(instrument?.riskParams?.riskPercent) || 0,
      allowAggressiveMinLot: true,
    };
    return this.calculateLotSizeDetails(signal, instrument, balance, settings).finalLotSize;
  }

  async recordLoss(amount, recordedAt = new Date(), scope = 'live') {
    const normalizedScope = this._normalizeScope(scope);
    const state = await this.ensureLoaded(normalizedScope);
    const normalizedAmount = Math.abs(Number(amount) || 0);

    if (normalizedAmount <= 0) {
      return;
    }

    const dateKey = this._getDateKey(recordedAt);
    if (!state.dailyLossTracker[dateKey]) {
      state.dailyLossTracker[dateKey] = 0;
    }
    state.dailyLossTracker[dateKey] += normalizedAmount;
    await this._persistState(normalizedScope);
  }

  _getTodayLossSync(scope = 'live', date = new Date()) {
    const state = this._getState(scope);
    const today = this._getDateKey(date);
    return state.dailyLossTracker[today] || 0;
  }

  async getTodayLoss(date = new Date(), scope = 'live') {
    await this.ensureLoaded(scope);
    return this._getTodayLossSync(scope, date);
  }

  async getPeakBalance(scope = 'live') {
    const state = await this.ensureLoaded(scope);
    return state.peakBalance;
  }

  async getPeakEquity(scope = 'live') {
    const state = await this.ensureLoaded(scope);
    return state.peakEquity;
  }

  async _getCategoryPositionCount(category, positionsStore = positionsDb) {
    const allPositions = await positionsStore.find({});
    return allPositions.filter((position) => {
      const instrument = getInstrument(position.symbol);
      return instrument && instrument.category === category;
    }).length;
  }

  async getRiskStatus(accountInfo, options = {}) {
    const scope = this._normalizeScope(options.scope || 'live');
    const settings = await this.getActiveRiskSettings();
    const state = await this.syncAccountState(accountInfo, scope);
    const positionsStore = this._getPositionsStore(scope, options.positionsStore);
    const { balance, equity } = accountInfo;
    const todayLoss = this._getTodayLossSync(scope);
    const currentDrawdown = this._getCurrentDrawdown(state.peakEquity, equity);
    const openPositions = await positionsStore.count({});

    return {
      balance,
      equity,
      peakBalance: state.peakBalance,
      peakEquity: state.peakEquity,
      todayLoss,
      dailyLossLimit: balance * settings.maxDailyLoss,
      dailyLossPercent: balance > 0 ? (todayLoss / balance) * 100 : 0,
      currentDrawdown: currentDrawdown * 100,
      maxDrawdownLimit: settings.maxDrawdown * 100,
      openPositions,
      maxPositions: settings.maxConcurrentPositions,
      maxPositionsPerSymbol: settings.maxPositionsPerSymbol,
      tradingEnabled: this._isTradingEnabled(scope, options.tradingEnabled),
      dailyLossReached: todayLoss >= balance * settings.maxDailyLoss,
      drawdownReached: currentDrawdown >= settings.maxDrawdown,
      activeRiskProfileName: settings.profile?.name || null,
      allowAggressiveMinLot: settings.allowAggressiveMinLot,
      maxRiskPerTradePct: settings.profile?.maxRiskPerTradePct || 0,
      maxDailyLossPct: settings.profile?.maxDailyLossPct || 0,
      maxDrawdownPct: settings.profile?.maxDrawdownPct || 0,
    };
  }
}

const riskManager = new RiskManager();

module.exports = riskManager;
