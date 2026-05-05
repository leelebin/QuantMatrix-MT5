/**
 * Risk Manager
 * Controls position sizing, validates trades against risk rules
 */

const { getInstrument } = require('../config/instruments');
const { positionsDb, paperPositionsDb, riskStateDb, tradesDb, tradeLogDb } = require('../config/db');
const RiskProfile = require('../models/RiskProfile');
const auditService = require('./auditService');
const mt5Service = require('./mt5Service');
const strategyDailyStopService = require('./strategyDailyStopService');
const { calculateExecutionScore, DEFAULT_EXECUTION_POLICY } = require('./executionPolicyService');
const { estimateBarDistance } = require('../utils/timeframe');

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

  _getTradesStore(scope = 'live', overrideStore = null) {
    if (overrideStore) return overrideStore;
    const store = this._normalizeScope(scope) === 'paper' ? tradeLogDb : tradesDb;
    return store && typeof store.find === 'function' ? store : null;
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

  _getSignalRiskPercent(signal, instrument, settings) {
    const strategyRiskPercent = Number(signal?.strategyParams?.riskPercent);
    const signalRiskPercent = Number(signal?.riskPercent);
    const instrumentRiskPercent = Number(instrument?.riskParams?.riskPercent);
    const requestedRiskPercent = strategyRiskPercent || signalRiskPercent || instrumentRiskPercent || settings.maxRiskPerTrade;
    return Math.min(settings.maxRiskPerTrade, requestedRiskPercent || settings.maxRiskPerTrade);
  }

  _normalizeLotSize(value, lotStep) {
    const normalizedStep = Number(lotStep) > 0 ? Number(lotStep) : 0.01;
    const floored = Math.floor((Number(value) || 0) / normalizedStep) * normalizedStep;
    return parseFloat(Math.max(floored, 0).toFixed(4));
  }

  _resolveLotPrecision(minLot, lotStep) {
    const raw = String(lotStep || minLot || '0.01');
    if (raw.includes('e-')) {
      return parseInt(raw.split('e-')[1], 10);
    }

    const decimalPart = raw.split('.')[1];
    return decimalPart ? decimalPart.length : 2;
  }

  async _getBrokerSizingContext(signal, instrument, brokerService = mt5Service) {
    if (!brokerService || !brokerService.isConnected()) {
      return null;
    }

    const entryPrice = Number(signal?.entryPrice) || 0;
    const stopLoss = Number(signal?.sl) || 0;
    const type = String(signal?.signal || '').toUpperCase();
    if (entryPrice <= 0 || stopLoss <= 0 || entryPrice === stopLoss || (type !== 'BUY' && type !== 'SELL')) {
      return null;
    }

    try {
      const [symbolInfo, profitEstimate] = await Promise.all([
        brokerService.getResolvedSymbolInfo(signal.symbol),
        brokerService.calculateOrderProfit(signal.symbol, type, 1.0, entryPrice, stopLoss),
      ]);

      const riskPerLot = Math.abs(Number(profitEstimate?.profit));
      if (!(riskPerLot > 0)) {
        return null;
      }

      return {
        riskPerLot,
        minLot: Number(symbolInfo?.volumeMin) > 0 ? Number(symbolInfo.volumeMin) : Number(instrument?.minLot),
        lotStep: Number(symbolInfo?.volumeStep) > 0 ? Number(symbolInfo.volumeStep) : Number(instrument?.lotStep),
        sizingMethod: 'broker_order_profit',
        brokerSymbolInfo: symbolInfo || null,
      };
    } catch (error) {
      return null;
    }
  }

  calculateLotSizeDetails(signal, instrument, balance, settings, sizingContext = null) {
    const effectiveRiskPercent = this._getSignalRiskPercent(signal, instrument, settings);
    const riskAmount = balance * effectiveRiskPercent;
    const currentPrice = Number(signal.entryPrice) || Number(signal.tp) || 0;
    const stopLoss = Number(signal.sl) || 0;
    const slDistance = Math.abs(currentPrice - stopLoss);
    const minLot = Number(sizingContext?.minLot) > 0 ? Number(sizingContext.minLot) : Number(instrument.minLot) || 0.01;
    const lotStep = Number(sizingContext?.lotStep) > 0 ? Number(sizingContext.lotStep) : Number(instrument.lotStep) || 0.01;
    const lotPrecision = this._resolveLotPrecision(minLot, lotStep);
    const brokerRiskPerLot = Number(sizingContext?.riskPerLot) || 0;
    const slPips = instrument.pipSize > 0 ? slDistance / instrument.pipSize : 0;

    if (currentPrice <= 0 || stopLoss <= 0 || slDistance <= 0 || (brokerRiskPerLot <= 0 && slPips <= 0)) {
      return {
        allowed: false,
        reason: 'Invalid stop loss distance for risk sizing',
        finalLotSize: 0,
        theoreticalLotSize: 0,
        effectiveRiskPercent,
        riskAmount,
        overrideApplied: false,
        auditMessage: null,
        sizingMethod: sizingContext?.sizingMethod || 'config_pip_value',
        minLot,
        lotStep,
      };
    }

    const riskPerLot = brokerRiskPerLot > 0
      ? brokerRiskPerLot
      : slPips * Number(instrument.pipValue || 0);

    if (!(riskPerLot > 0)) {
      return {
        allowed: false,
        reason: 'Instrument risk specification is invalid for position sizing',
        finalLotSize: 0,
        theoreticalLotSize: 0,
        effectiveRiskPercent,
        riskAmount,
        overrideApplied: false,
        auditMessage: null,
        sizingMethod: sizingContext?.sizingMethod || 'config_pip_value',
        minLot,
        lotStep,
      };
    }

    let theoreticalLotSize = this._normalizeLotSize(riskAmount / riskPerLot, lotStep);

    const cappedLotSize = Math.min(theoreticalLotSize, 5.0);

    if (cappedLotSize < minLot) {
      if (settings.allowAggressiveMinLot) {
        const finalLotSize = parseFloat(minLot.toFixed(lotPrecision));
        return {
          allowed: true,
          reason: 'All risk checks passed',
        finalLotSize,
        theoreticalLotSize: cappedLotSize,
        effectiveRiskPercent,
        riskAmount,
        plannedRiskAmount: parseFloat((riskPerLot * finalLotSize).toFixed(4)),
        overrideApplied: true,
        auditMessage: `Aggressive min-lot override applied: theoretical ${cappedLotSize.toFixed(4)} < minimum ${minLot.toFixed(lotPrecision)}. Using ${finalLotSize.toFixed(lotPrecision)}.`,
        sizingMethod: sizingContext?.sizingMethod || 'config_pip_value',
        minLot,
        lotStep,
        };
      }

      return {
        allowed: false,
        reason: `Calculated lot size ${cappedLotSize.toFixed(4)} below minimum ${minLot.toFixed(lotPrecision)}. Enable aggressive min-lot mode to allow the minimum lot.`,
        finalLotSize: 0,
        theoreticalLotSize: cappedLotSize,
        effectiveRiskPercent,
        riskAmount,
        overrideApplied: false,
        auditMessage: null,
        sizingMethod: sizingContext?.sizingMethod || 'config_pip_value',
        minLot,
        lotStep,
      };
    }

    return {
      allowed: true,
      reason: 'All risk checks passed',
      finalLotSize: parseFloat(cappedLotSize.toFixed(lotPrecision)),
      theoreticalLotSize: cappedLotSize,
      effectiveRiskPercent,
      riskAmount,
      plannedRiskAmount: parseFloat((riskPerLot * cappedLotSize).toFixed(4)),
      overrideApplied: false,
      auditMessage: null,
      sizingMethod: sizingContext?.sizingMethod || 'config_pip_value',
      minLot,
      lotStep,
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
    const executionPolicy = signal.executionPolicy || DEFAULT_EXECUTION_POLICY;

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
    const tradesStore = this._getTradesStore(scope, options.tradesStore);
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

    const strategyStopTimeframe = signal?.setupTimeframe || signal?.entryTimeframe || null;
    if (signal?.strategy && signal?.symbol && strategyStopTimeframe && settings?.strategyDailyStop?.enabled !== false) {
      try {
        const gateResult = await strategyDailyStopService.isEntryBlocked({
          scope,
          strategy: signal.strategy,
          symbol: signal.symbol,
          timeframe: strategyStopTimeframe,
        }, settings.strategyDailyStop);
        if (gateResult.blocked) {
          const record = gateResult.record || {};
          const reasonText = `Strategy daily stop active for ${gateResult.key} (tradingDay=${gateResult.tradingDay})`;
          strategyDailyStopService.recordBlockedEntry({
            scope,
            strategy: signal.strategy,
            symbol: signal.symbol,
            timeframe: strategyStopTimeframe,
            tradingDay: gateResult.tradingDay,
            record,
            details: { scope, signal: signal?.signal || null },
          });
          return {
            allowed: false,
            reason: reasonText,
            reasonCode: auditService.REASON.STRATEGY_DAILY_STOP_ACTIVE,
            lotSize: 0,
          };
        }
      } catch (_) {
        // Never fail the trade path when the stop service itself errors.
      }
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

    const openPositionsByDirection = await positionsStore.find({});
    const sameDirectionSymbolPositions = openPositionsByDirection.filter((position) => (
      position.symbol === signal.symbol
      && String(position.type || '').toUpperCase() === String(signal.signal || '').toUpperCase()
    )).length;
    if (sameDirectionSymbolPositions >= executionPolicy.maxSameDirectionPositionsPerSymbol) {
      const reasonText = `Max same-direction positions for ${signal.symbol} reached: ${sameDirectionSymbolPositions} >= ${executionPolicy.maxSameDirectionPositionsPerSymbol}`;
      emitReject(auditService.REASON.SAME_DIRECTION_SYMBOL_LIMIT, reasonText, {
        sameDirectionSymbolPositions,
        limit: executionPolicy.maxSameDirectionPositionsPerSymbol,
      });
      return {
        allowed: false,
        reason: reasonText,
        reasonCode: auditService.REASON.SAME_DIRECTION_SYMBOL_LIMIT,
        lotSize: 0,
      };
    }

    const sameDirectionCategoryPositions = openPositionsByDirection.filter((position) => {
      if (String(position.type || '').toUpperCase() !== String(signal.signal || '').toUpperCase()) {
        return false;
      }
      const positionInstrument = getInstrument(position.symbol);
      return positionInstrument && positionInstrument.category === instrument.category;
    }).length;
    if (sameDirectionCategoryPositions >= executionPolicy.maxSameDirectionPositionsPerCategory) {
      const reasonText = `Max same-direction positions for ${instrument.category} reached: ${sameDirectionCategoryPositions} >= ${executionPolicy.maxSameDirectionPositionsPerCategory}`;
      emitReject(auditService.REASON.SAME_DIRECTION_CATEGORY_LIMIT, reasonText, {
        sameDirectionCategoryPositions,
        limit: executionPolicy.maxSameDirectionPositionsPerCategory,
        category: instrument.category,
      });
      return {
        allowed: false,
        reason: reasonText,
        reasonCode: auditService.REASON.SAME_DIRECTION_CATEGORY_LIMIT,
        lotSize: 0,
      };
    }

    const signalCandleTime = signal.entryCandleTime || signal.setupCandleTime || signal.timestamp || new Date().toISOString();
    const entryWindowBars = Number(executionPolicy.duplicateEntryWindowBars) || 0;
    const cooldownBarsAfterLoss = Number(executionPolicy.cooldownBarsAfterLoss) || 0;
    const comparableTimeframe = signal.setupTimeframe || signal.entryTimeframe || '1h';
    const historicalTrades = tradesStore
      ? await tradesStore.find({
          symbol: signal.symbol,
          strategy: signal.strategy,
          type: signal.signal,
        })
      : [];
    const orderedTrades = [...historicalTrades].sort((left, right) => {
      const leftTime = new Date(left.closedAt || left.openedAt || 0).getTime();
      const rightTime = new Date(right.closedAt || right.openedAt || 0).getTime();
      return rightTime - leftTime;
    });

    const duplicateReference = orderedTrades.find((trade) => {
      const referenceTime = trade.entryCandleTime || trade.setupCandleTime || trade.openedAt;
      if (!referenceTime) return false;
      return estimateBarDistance(referenceTime, signalCandleTime, comparableTimeframe) <= entryWindowBars;
    });
    if (duplicateReference && entryWindowBars > 0) {
      const reasonText = `Duplicate entry blocked within ${entryWindowBars} bar(s) for ${signal.symbol}/${signal.strategy}`;
      emitReject(auditService.REASON.DUPLICATE_ENTRY_WINDOW, reasonText, {
        duplicateEntryWindowBars: entryWindowBars,
        previousTradeId: duplicateReference._id || duplicateReference.positionDbId || null,
      });
      return {
        allowed: false,
        reason: reasonText,
        reasonCode: auditService.REASON.DUPLICATE_ENTRY_WINDOW,
        lotSize: 0,
      };
    }

    const lastLossTrade = orderedTrades.find((trade) => (
      trade.status === 'CLOSED'
      && Number(trade.profitLoss) < 0
      && trade.closedAt
    ));
    if (
      lastLossTrade
      && cooldownBarsAfterLoss > 0
      && estimateBarDistance(lastLossTrade.closedAt, signalCandleTime, comparableTimeframe) <= cooldownBarsAfterLoss
    ) {
      const reasonText = `Cooldown active after losing trade for ${signal.symbol}/${signal.strategy}`;
      emitReject(auditService.REASON.COOLDOWN_AFTER_LOSS, reasonText, {
        cooldownBarsAfterLoss,
        previousTradeId: lastLossTrade._id || lastLossTrade.positionDbId || null,
      });
      return {
        allowed: false,
        reason: reasonText,
        reasonCode: auditService.REASON.COOLDOWN_AFTER_LOSS,
        lotSize: 0,
      };
    }

    const executionScore = calculateExecutionScore(signal, executionPolicy, {
      sameDirectionSymbolPositions,
      sameDirectionCategoryPositions,
      duplicatePenalty: Boolean(duplicateReference && entryWindowBars > 0),
    });
    if (executionScore.score < executionPolicy.minExecutionScore) {
      const reasonText = `Execution score too low: ${executionScore.score.toFixed(2)} < ${executionPolicy.minExecutionScore.toFixed(2)}`;
      emitReject(auditService.REASON.EXECUTION_SCORE_TOO_LOW, reasonText, {
        executionScore,
      });
      return {
        allowed: false,
        reason: reasonText,
        reasonCode: auditService.REASON.EXECUTION_SCORE_TOO_LOW,
        lotSize: 0,
        executionScore: executionScore.score,
        executionScoreDetails: executionScore.details,
        executionPolicy,
      };
    }

    const brokerSizingContext = await this._getBrokerSizingContext(
      signal,
      instrument,
      options.mt5Service || mt5Service
    );
    const sizing = this.calculateLotSizeDetails(signal, instrument, balance, settings, brokerSizingContext);
    if (!sizing.allowed) {
      const reasonCode = /below minimum/i.test(sizing.reason)
        ? auditService.REASON.LOT_BELOW_MIN
        : auditService.REASON.INVALID_SL;
      emitReject(reasonCode, sizing.reason, {
        theoreticalLotSize: sizing.theoreticalLotSize,
        minLot: sizing.minLot,
        effectiveRiskPercent: sizing.effectiveRiskPercent,
        sizingMethod: sizing.sizingMethod,
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
        sizingMethod: sizing.sizingMethod,
        executionScore: executionScore.score,
        executionScoreDetails: executionScore.details,
        executionPolicy,
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
      sizingMethod: sizing.sizingMethod,
      plannedRiskAmount: sizing.plannedRiskAmount,
      executionScore: executionScore.score,
      executionScoreDetails: executionScore.details,
      executionPolicy,
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
