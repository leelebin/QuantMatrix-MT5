const Trade = require('../models/Trade');
const { UNKNOWN_STRATEGY } = require('../models/Trade');
const mt5Service = require('./mt5Service');
const { buildClosedTradeSnapshot } = require('../utils/mt5Reconciliation');
const { buildTradeComment, parseStrategyFromBrokerComment } = require('../utils/tradeComment');
const { normalizeDateStart, normalizeDateEnd } = require('../utils/tradeExport');

const FULL_HISTORY_START = new Date('2020-01-01T00:00:00.000Z');
const INCREMENTAL_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const VOLUME_TOLERANCE = 1e-8;

class TradeHistoryService {
  _normalizeDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  _coerceNumber(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  _unique(values = []) {
    return [...new Set(values.filter(Boolean).map((value) => String(value)))];
  }

  _isTradeDeal(deal = {}) {
    const typeName = String(deal.typeName || deal.type || '').toUpperCase();
    return typeName.includes('BUY') || typeName.includes('SELL');
  }

  _getGroupKey(deal = {}) {
    return String(deal.positionId || deal.orderId || deal.id || '').trim();
  }

  _groupDealsByTrade(deals = []) {
    const groups = new Map();

    deals.filter((deal) => this._isTradeDeal(deal)).forEach((deal) => {
      const key = this._getGroupKey(deal);
      if (!key) return;

      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(deal);
    });

    return groups;
  }

  _buildTradeQuery({ symbol, startDate, endDate, status } = {}) {
    const query = {};
    if (symbol) query.symbol = symbol;
    if (status) query.status = status;

    const start = normalizeDateStart(startDate);
    const end = normalizeDateEnd(endDate);
    if (start || end) {
      query.openedAt = {};
      if (start) query.openedAt.$gte = start;
      if (end) query.openedAt.$lte = end;
    }

    return query;
  }

  _getReferencePayload(summary = {}, deals = []) {
    const entryDeal = summary.entryDeals?.[0] || null;
    const lastDeal = deals[deals.length - 1] || null;

    return {
      positionId: String(summary.positionId || entryDeal?.positionId || lastDeal?.positionId || '').trim() || null,
      entryDealId: String(entryDeal?.id || '').trim() || null,
      closeDealId: String(summary.lastExitDeal?.id || '').trim() || null,
      orderId: String(entryDeal?.orderId || lastDeal?.orderId || '').trim() || null,
    };
  }

  _getActivityTime(summary = {}, deals = []) {
    return (
      this._normalizeDate(summary.exitTime)
      || this._normalizeDate(summary.entryTime)
      || this._normalizeDate(deals[deals.length - 1]?.time)
      || null
    );
  }

  _isClosedSummary(summary = {}) {
    const entryVolume = this._coerceNumber(
      summary.entryVolume,
      (summary.entryDeals || []).reduce((sum, deal) => sum + (Number(deal.volume) || 0), 0)
    );
    const exitVolume = this._coerceNumber(
      summary.exitVolume,
      (summary.exitDeals || []).reduce((sum, deal) => sum + (Number(deal.volume) || 0), 0)
    );

    if (entryVolume <= 0 && exitVolume <= 0) {
      return Array.isArray(summary.exitDeals) && summary.exitDeals.length > 0;
    }

    return exitVolume > 0 && (entryVolume <= 0 || exitVolume + VOLUME_TOLERANCE >= entryVolume);
  }

  _parseConfidenceFromBrokerComment(comment = '') {
    const parts = String(comment || '').split('|').map((part) => part.trim()).filter(Boolean);
    if (parts.length < 4) return null;
    const confidence = Number(parts[3]);
    return Number.isFinite(confidence) ? confidence : null;
  }

  _parseSideFromDeal(deal = {}) {
    const typeName = String(deal.typeName || deal.type || '').toUpperCase();
    if (typeName.includes('BUY')) return 'BUY';
    if (typeName.includes('SELL')) return 'SELL';
    return null;
  }

  _resolveStrategy(existingTrade = null, brokerComment = '') {
    const existingStrategy = String(existingTrade?.strategy || '').trim();
    if (existingStrategy) return existingStrategy;
    return parseStrategyFromBrokerComment(brokerComment) || UNKNOWN_STRATEGY;
  }

  async _resolveSyncWindow({ mode = 'incremental', symbol, startDate, endDate } = {}) {
    const explicitStart = normalizeDateStart(startDate);
    const explicitEnd = normalizeDateEnd(endDate);

    if (explicitStart || explicitEnd) {
      return {
        start: explicitStart || FULL_HISTORY_START,
        end: explicitEnd || new Date(),
      };
    }

    if (mode === 'full') {
      return { start: FULL_HISTORY_START, end: new Date() };
    }

    const latestTrade = await Trade.findLatestBrokerTrade({ symbol });
    const latestTimestamp = [latestTrade?.closedAt, latestTrade?.openedAt, latestTrade?.brokerSyncedAt]
      .map((value) => this._normalizeDate(value))
      .filter(Boolean)
      .reduce((latest, current) => (
        !latest || current.getTime() > latest.getTime() ? current : latest
      ), null);

    if (!latestTimestamp) {
      return { start: FULL_HISTORY_START, end: new Date() };
    }

    return {
      start: new Date(Math.max(FULL_HISTORY_START.getTime(), latestTimestamp.getTime() - INCREMENTAL_LOOKBACK_MS)),
      end: new Date(),
    };
  }

  _buildBrokerTradeRecord(summary, deals = [], existingTrade = null, source = 'history_sync') {
    const orderedDeals = summary?.deals?.length ? summary.deals : deals;
    const entryDeal = summary?.entryDeals?.[0] || null;

    if (!existingTrade && !entryDeal) {
      return null;
    }

    const brokerComment = entryDeal?.comment
      || existingTrade?.mt5Comment
      || orderedDeals.find((deal) => deal.comment)?.comment
      || '';
    const symbol = existingTrade?.symbol || entryDeal?.symbol || orderedDeals[0]?.symbol || null;
    const type = existingTrade?.type || this._parseSideFromDeal(entryDeal);
    const lotSize = this._coerceNumber(summary?.entryVolume, 0)
      || this._coerceNumber(existingTrade?.lotSize, 0)
      || this._coerceNumber(entryDeal?.volume, 0);
    const openedAt = this._normalizeDate(summary?.entryTime)
      || this._normalizeDate(existingTrade?.openedAt)
      || this._normalizeDate(entryDeal?.time);

    if (!symbol || !type || lotSize <= 0 || !openedAt) {
      return null;
    }

    const refs = this._getReferencePayload(summary, orderedDeals);
    const strategy = this._resolveStrategy(existingTrade, brokerComment);
    const confidence = existingTrade?.confidence ?? this._parseConfidenceFromBrokerComment(brokerComment);
    const reason = String(existingTrade?.reason || '').trim();
    const status = this._isClosedSummary(summary) ? 'CLOSED' : 'OPEN';

    const record = {
      symbol,
      type,
      entryPrice: this._coerceNumber(summary?.entryPrice, existingTrade?.entryPrice ?? null),
      sl: existingTrade?.sl ?? null,
      tp: existingTrade?.tp ?? null,
      lotSize,
      strategy,
      confidence,
      reason,
      entryReason: existingTrade?.entryReason || null,
      setupReason: existingTrade?.setupReason || null,
      triggerReason: existingTrade?.triggerReason || null,
      indicatorsSnapshot: existingTrade?.indicatorsSnapshot || {},
      executionScore: existingTrade?.executionScore ?? null,
      executionScoreDetails: existingTrade?.executionScoreDetails || null,
      initialSl: existingTrade?.initialSl ?? existingTrade?.sl ?? null,
      initialTp: existingTrade?.initialTp ?? existingTrade?.tp ?? null,
      finalSl: existingTrade?.finalSl ?? existingTrade?.sl ?? null,
      finalTp: existingTrade?.finalTp ?? existingTrade?.tp ?? null,
      plannedRiskAmount: existingTrade?.plannedRiskAmount ?? null,
      realizedRMultiple: existingTrade?.realizedRMultiple ?? null,
      targetRMultiple: existingTrade?.targetRMultiple ?? null,
      targetRMultipleCaptured: existingTrade?.targetRMultipleCaptured ?? null,
      managementEvents: Array.isArray(existingTrade?.managementEvents) ? existingTrade.managementEvents : [],
      maxFavourableR: existingTrade?.maxFavourableR ?? null,
      maxAdverseR: existingTrade?.maxAdverseR ?? null,
      spreadAtEntry: existingTrade?.spreadAtEntry ?? null,
      slippageEstimate: existingTrade?.slippageEstimate ?? null,
      brokerRetcodeOpen: existingTrade?.brokerRetcodeOpen ?? null,
      brokerRetcodeClose: existingTrade?.brokerRetcodeClose ?? null,
      brokerRetcodeModify: existingTrade?.brokerRetcodeModify ?? null,
      positionSnapshot: existingTrade?.positionSnapshot || null,
      commission: this._coerceNumber(summary?.commission, existingTrade?.commission ?? 0),
      swap: this._coerceNumber(summary?.swap, existingTrade?.swap ?? 0),
      fee: this._coerceNumber(summary?.fee, existingTrade?.fee ?? 0),
      mt5PositionId: refs.positionId || existingTrade?.mt5PositionId || null,
      mt5OrderId: refs.orderId || existingTrade?.mt5OrderId || null,
      mt5EntryDealId: refs.entryDealId || existingTrade?.mt5EntryDealId || null,
      mt5CloseDealId: status === 'CLOSED' ? (refs.closeDealId || existingTrade?.mt5CloseDealId || null) : null,
      mt5Comment: brokerComment || existingTrade?.mt5Comment || null,
      positionDbId: existingTrade?.positionDbId || null,
      status,
      openedAt,
      brokerSyncedAt: new Date(),
      brokerSyncSource: source,
    };

    if (status === 'CLOSED') {
      const closedSnapshot = buildClosedTradeSnapshot({
        symbol,
        type,
        entryPrice: record.entryPrice,
        currentPrice: summary?.exitPrice,
        lotSize,
      }, summary, {
        exitPrice: this._coerceNumber(summary?.exitPrice, existingTrade?.exitPrice ?? null),
        reason: existingTrade?.exitReason || 'EXTERNAL',
        closedAt: this._normalizeDate(existingTrade?.closedAt) || new Date(),
      });

      record.entryPrice = closedSnapshot.entryPrice;
      record.exitPrice = closedSnapshot.exitPrice;
      record.closedAt = closedSnapshot.closedAt;
      record.exitReason = closedSnapshot.exitReason;
      record.profitLoss = closedSnapshot.profitLoss;
      record.grossProfitLoss = closedSnapshot.grossProfitLoss;
      record.profitPips = closedSnapshot.profitPips;
      record.commission = closedSnapshot.commission;
      record.swap = closedSnapshot.swap;
      record.fee = closedSnapshot.fee;
      record.realizedRMultiple = existingTrade?.realizedRMultiple ?? closedSnapshot.realizedRMultiple;
      record.targetRMultipleCaptured = existingTrade?.targetRMultipleCaptured ?? closedSnapshot.targetRMultipleCaptured;
    } else {
      record.exitPrice = null;
      record.closedAt = null;
      record.exitReason = null;
      record.profitLoss = existingTrade?.status === 'OPEN' ? existingTrade.profitLoss ?? null : null;
      record.profitPips = existingTrade?.status === 'OPEN' ? existingTrade.profitPips ?? null : null;
    }

    record.comment = buildTradeComment({
      strategy: record.strategy,
      signal: record.type,
      confidence: record.confidence,
      reason: record.reason,
    }, record.mt5Comment || '');

    return record;
  }

  _mergeTradeRecord(existingTrade, brokerTrade) {
    const existingStrategy = String(existingTrade?.strategy || '').trim();
    const brokerStrategy = String(brokerTrade?.strategy || '').trim();
    const keepClosedState = existingTrade?.status === 'CLOSED' && brokerTrade?.status !== 'CLOSED';

    const merged = {
      symbol: brokerTrade.symbol || existingTrade.symbol,
      type: brokerTrade.type || existingTrade.type,
      entryPrice: brokerTrade.entryPrice ?? existingTrade.entryPrice ?? null,
      sl: existingTrade.sl ?? brokerTrade.sl ?? null,
      tp: existingTrade.tp ?? brokerTrade.tp ?? null,
      lotSize: brokerTrade.lotSize ?? existingTrade.lotSize ?? 0,
      strategy: existingStrategy && existingStrategy !== UNKNOWN_STRATEGY
        ? existingStrategy
        : (brokerStrategy || UNKNOWN_STRATEGY),
      confidence: existingTrade.confidence ?? brokerTrade.confidence ?? null,
      reason: String(existingTrade.reason || brokerTrade.reason || '').trim(),
      entryReason: existingTrade.entryReason || brokerTrade.entryReason || null,
      setupReason: existingTrade.setupReason || brokerTrade.setupReason || null,
      triggerReason: existingTrade.triggerReason || brokerTrade.triggerReason || null,
      indicatorsSnapshot: existingTrade.indicatorsSnapshot
        && Object.keys(existingTrade.indicatorsSnapshot).length > 0
        ? existingTrade.indicatorsSnapshot
        : (brokerTrade.indicatorsSnapshot || {}),
      executionScore: existingTrade.executionScore ?? brokerTrade.executionScore ?? null,
      executionScoreDetails: existingTrade.executionScoreDetails || brokerTrade.executionScoreDetails || null,
      initialSl: existingTrade.initialSl ?? existingTrade.sl ?? brokerTrade.initialSl ?? brokerTrade.sl ?? null,
      initialTp: existingTrade.initialTp ?? existingTrade.tp ?? brokerTrade.initialTp ?? brokerTrade.tp ?? null,
      finalSl: brokerTrade.finalSl ?? existingTrade.finalSl ?? existingTrade.currentSl ?? existingTrade.sl ?? null,
      finalTp: brokerTrade.finalTp ?? existingTrade.finalTp ?? existingTrade.currentTp ?? existingTrade.tp ?? null,
      plannedRiskAmount: existingTrade.plannedRiskAmount ?? brokerTrade.plannedRiskAmount ?? null,
      realizedRMultiple: existingTrade.realizedRMultiple ?? brokerTrade.realizedRMultiple ?? null,
      targetRMultiple: existingTrade.targetRMultiple ?? brokerTrade.targetRMultiple ?? null,
      targetRMultipleCaptured: existingTrade.targetRMultipleCaptured ?? brokerTrade.targetRMultipleCaptured ?? null,
      managementEvents: Array.isArray(existingTrade.managementEvents)
        ? existingTrade.managementEvents
        : (Array.isArray(brokerTrade.managementEvents) ? brokerTrade.managementEvents : []),
      maxFavourableR: existingTrade.maxFavourableR ?? brokerTrade.maxFavourableR ?? null,
      maxAdverseR: existingTrade.maxAdverseR ?? brokerTrade.maxAdverseR ?? null,
      spreadAtEntry: existingTrade.spreadAtEntry ?? brokerTrade.spreadAtEntry ?? null,
      slippageEstimate: existingTrade.slippageEstimate ?? brokerTrade.slippageEstimate ?? null,
      brokerRetcodeOpen: existingTrade.brokerRetcodeOpen ?? brokerTrade.brokerRetcodeOpen ?? null,
      brokerRetcodeClose: existingTrade.brokerRetcodeClose ?? brokerTrade.brokerRetcodeClose ?? null,
      brokerRetcodeModify: existingTrade.brokerRetcodeModify ?? brokerTrade.brokerRetcodeModify ?? null,
      positionSnapshot: existingTrade.positionSnapshot || brokerTrade.positionSnapshot || null,
      commission: brokerTrade.commission ?? existingTrade.commission ?? 0,
      swap: brokerTrade.swap ?? existingTrade.swap ?? 0,
      fee: brokerTrade.fee ?? existingTrade.fee ?? 0,
      mt5PositionId: brokerTrade.mt5PositionId || existingTrade.mt5PositionId || null,
      mt5OrderId: brokerTrade.mt5OrderId || existingTrade.mt5OrderId || null,
      mt5EntryDealId: brokerTrade.mt5EntryDealId || existingTrade.mt5EntryDealId || null,
      mt5CloseDealId: brokerTrade.mt5CloseDealId || existingTrade.mt5CloseDealId || null,
      mt5Comment: brokerTrade.mt5Comment || existingTrade.mt5Comment || null,
      positionDbId: existingTrade.positionDbId || brokerTrade.positionDbId || null,
      status: keepClosedState ? 'CLOSED' : (brokerTrade.status || existingTrade.status || 'OPEN'),
      openedAt: brokerTrade.openedAt || existingTrade.openedAt || null,
      brokerSyncedAt: brokerTrade.brokerSyncedAt || new Date(),
      brokerSyncSource: brokerTrade.brokerSyncSource || existingTrade.brokerSyncSource || 'history_sync',
    };

    if (merged.status === 'CLOSED') {
      merged.exitPrice = keepClosedState
        ? (existingTrade.exitPrice ?? null)
        : (brokerTrade.exitPrice ?? existingTrade.exitPrice ?? null);
      merged.closedAt = keepClosedState
        ? (existingTrade.closedAt || null)
        : (brokerTrade.closedAt || existingTrade.closedAt || null);
      merged.exitReason = keepClosedState
        ? (existingTrade.exitReason || null)
        : (brokerTrade.exitReason || existingTrade.exitReason || 'EXTERNAL');
      merged.profitLoss = keepClosedState
        ? (existingTrade.profitLoss ?? null)
        : (brokerTrade.profitLoss ?? existingTrade.profitLoss ?? null);
      merged.grossProfitLoss = keepClosedState
        ? (existingTrade.grossProfitLoss ?? null)
        : (brokerTrade.grossProfitLoss ?? existingTrade.grossProfitLoss ?? null);
      merged.profitPips = keepClosedState
        ? (existingTrade.profitPips ?? null)
        : (brokerTrade.profitPips ?? existingTrade.profitPips ?? null);
      if (keepClosedState) {
        merged.commission = existingTrade.commission ?? merged.commission;
        merged.swap = existingTrade.swap ?? merged.swap;
        merged.fee = existingTrade.fee ?? merged.fee;
      }
    } else {
      merged.exitPrice = null;
      merged.closedAt = null;
      merged.exitReason = null;
      merged.profitLoss = existingTrade.status === 'OPEN' ? existingTrade.profitLoss ?? null : null;
      merged.grossProfitLoss = existingTrade.status === 'OPEN' ? existingTrade.grossProfitLoss ?? null : null;
      merged.profitPips = existingTrade.status === 'OPEN' ? existingTrade.profitPips ?? null : null;
      merged.mt5CloseDealId = null;
    }

    merged.comment = buildTradeComment({
      strategy: merged.strategy,
      signal: merged.type,
      confidence: merged.confidence,
      reason: merged.reason,
    }, merged.mt5Comment || '');

    return merged;
  }

  _numberChanged(current, next, tolerance = 1e-8) {
    if (current == null && next == null) return false;
    if (current == null || next == null) return true;
    return Math.abs(Number(current) - Number(next)) > tolerance;
  }

  _stringChanged(current, next) {
    return String(current ?? '') !== String(next ?? '');
  }

  _dateChanged(current, next) {
    const currentDate = this._normalizeDate(current);
    const nextDate = this._normalizeDate(next);
    if (!currentDate && !nextDate) return false;
    if (!currentDate || !nextDate) return true;
    return currentDate.getTime() !== nextDate.getTime();
  }

  _jsonChanged(current, next) {
    return JSON.stringify(current ?? null) !== JSON.stringify(next ?? null);
  }

  _hasMeaningfulChanges(trade, update) {
    return (
      this._stringChanged(trade.symbol, update.symbol)
      || this._stringChanged(trade.type, update.type)
      || this._stringChanged(trade.strategy, update.strategy)
      || this._stringChanged(trade.reason, update.reason)
      || this._stringChanged(trade.entryReason, update.entryReason)
      || this._stringChanged(trade.setupReason, update.setupReason)
      || this._stringChanged(trade.triggerReason, update.triggerReason)
      || this._stringChanged(trade.status, update.status)
      || this._stringChanged(trade.exitReason, update.exitReason)
      || this._stringChanged(trade.mt5PositionId, update.mt5PositionId)
      || this._stringChanged(trade.mt5OrderId, update.mt5OrderId)
      || this._stringChanged(trade.mt5EntryDealId, update.mt5EntryDealId)
      || this._stringChanged(trade.mt5CloseDealId, update.mt5CloseDealId)
      || this._stringChanged(trade.mt5Comment, update.mt5Comment)
      || this._stringChanged(trade.comment, update.comment)
      || this._numberChanged(trade.entryPrice, update.entryPrice)
      || this._numberChanged(trade.exitPrice, update.exitPrice)
      || this._numberChanged(trade.initialSl, update.initialSl)
      || this._numberChanged(trade.initialTp, update.initialTp)
      || this._numberChanged(trade.finalSl, update.finalSl)
      || this._numberChanged(trade.finalTp, update.finalTp)
      || this._numberChanged(trade.lotSize, update.lotSize)
      || this._numberChanged(trade.confidence, update.confidence)
      || this._numberChanged(trade.profitLoss, update.profitLoss)
      || this._numberChanged(trade.grossProfitLoss, update.grossProfitLoss)
      || this._numberChanged(trade.profitPips, update.profitPips)
      || this._numberChanged(trade.executionScore, update.executionScore)
      || this._numberChanged(trade.plannedRiskAmount, update.plannedRiskAmount)
      || this._numberChanged(trade.realizedRMultiple, update.realizedRMultiple)
      || this._numberChanged(trade.targetRMultiple, update.targetRMultiple)
      || this._numberChanged(trade.targetRMultipleCaptured, update.targetRMultipleCaptured)
      || this._numberChanged(trade.maxFavourableR, update.maxFavourableR)
      || this._numberChanged(trade.maxAdverseR, update.maxAdverseR)
      || this._numberChanged(trade.spreadAtEntry, update.spreadAtEntry)
      || this._numberChanged(trade.slippageEstimate, update.slippageEstimate)
      || this._numberChanged(trade.brokerRetcodeOpen, update.brokerRetcodeOpen)
      || this._numberChanged(trade.brokerRetcodeClose, update.brokerRetcodeClose)
      || this._numberChanged(trade.brokerRetcodeModify, update.brokerRetcodeModify)
      || this._numberChanged(trade.commission, update.commission)
      || this._numberChanged(trade.swap, update.swap)
      || this._numberChanged(trade.fee, update.fee)
      || this._dateChanged(trade.openedAt, update.openedAt)
      || this._dateChanged(trade.closedAt, update.closedAt)
      || this._jsonChanged(trade.indicatorsSnapshot, update.indicatorsSnapshot)
      || this._jsonChanged(trade.executionScoreDetails, update.executionScoreDetails)
      || this._jsonChanged(trade.managementEvents, update.managementEvents)
      || this._jsonChanged(trade.positionSnapshot, update.positionSnapshot)
    );
  }

  _buildSyncResultPayload(action, trade, refs, reason = null) {
    return {
      action,
      tradeId: trade?._id || null,
      symbol: trade?.symbol || null,
      status: trade?.status || null,
      mt5PositionId: refs.positionId,
      mt5OrderId: refs.orderId,
      mt5EntryDealId: refs.entryDealId,
      mt5CloseDealId: refs.closeDealId,
      reason,
    };
  }

  async _syncBrokerTradeGroup({ summary, deals }, mode) {
    const refs = this._getReferencePayload(summary, deals);
    const existingTrade = await Trade.findByBrokerRefs(refs);
    const brokerTrade = this._buildBrokerTradeRecord(
      summary,
      deals,
      existingTrade,
      existingTrade ? 'history_sync' : 'history_import'
    );

    if (!brokerTrade) {
      return this._buildSyncResultPayload(
        'skipped',
        existingTrade,
        refs,
        existingTrade ? 'Broker history was incomplete for this trade' : 'Missing broker entry deal for new import'
      );
    }

    if (!existingTrade) {
      const insertedTrade = await Trade.create(brokerTrade);
      return this._buildSyncResultPayload('imported', insertedTrade, refs);
    }

    const mergedTrade = this._mergeTradeRecord(existingTrade, brokerTrade);
    if (!this._hasMeaningfulChanges(existingTrade, mergedTrade)) {
      return this._buildSyncResultPayload('skipped', existingTrade, refs, 'Already up to date');
    }

    const updatedTrade = await Trade.updateById(existingTrade._id, mergedTrade);
    return this._buildSyncResultPayload('updated', updatedTrade, refs);
  }

  async _fetchSummaryByPositionId(positionId, start, end) {
    const summary = await mt5Service.getPositionDealSummary(positionId, start, end);
    if (summary?.deals?.length) {
      return {
        positionId: String(summary.positionId || positionId),
        summary,
        source: 'position',
      };
    }
    return null;
  }

  async _resolveBrokerSummary(trade) {
    const { start, end } = this._getReconciliationWindow(trade);
    const candidatePositionIds = this._unique([trade.mt5PositionId, trade.mt5OrderId]);

    for (const positionId of candidatePositionIds) {
      try {
        const result = await this._fetchSummaryByPositionId(positionId, start, end);
        if (result) return result;
      } catch (error) {
        // Try the next candidate.
      }
    }

    const candidateOrderIds = this._unique([trade.mt5OrderId]);
    for (const orderId of candidateOrderIds) {
      try {
        const orderDeals = await mt5Service.getDealsByOrder(orderId, start, end);
        const seededPositionId = orderDeals.find((deal) => deal.positionId)?.positionId;
        if (!seededPositionId) continue;

        const result = await this._fetchSummaryByPositionId(seededPositionId, start, end);
        if (result) {
          return {
            ...result,
            source: 'order',
          };
        }
      } catch (error) {
        // Ignore and keep searching.
      }
    }

    return null;
  }

  _getReconciliationWindow(trade = {}) {
    const openedAt = this._normalizeDate(trade.openedAt);
    const closedAt = this._normalizeDate(trade.closedAt);

    return {
      start: openedAt
        ? new Date(openedAt.getTime() - (24 * 60 * 60 * 1000))
        : new Date(Date.now() - (30 * 24 * 60 * 60 * 1000)),
      end: closedAt
        ? new Date(closedAt.getTime() + (24 * 60 * 60 * 1000))
        : new Date(),
    };
  }

  _buildTradeUpdate(trade, resolved) {
    const { positionId, summary, source } = resolved;
    const mergedTrade = this._mergeTradeRecord(trade, this._buildBrokerTradeRecord(summary, summary.deals, trade, source));

    mergedTrade.status = 'CLOSED';
    mergedTrade.mt5PositionId = positionId || trade.mt5PositionId || null;
    mergedTrade.mt5EntryDealId = summary.entryDeals?.[0]?.id || trade.mt5EntryDealId || null;
    mergedTrade.mt5CloseDealId = summary.lastExitDeal?.id || trade.mt5CloseDealId || null;
    mergedTrade.mt5Comment = summary.entryDeals?.[0]?.comment || trade.mt5Comment || null;
    mergedTrade.brokerSyncedAt = new Date();
    mergedTrade.brokerSyncSource = source;
    mergedTrade.comment = buildTradeComment({
      strategy: mergedTrade.strategy,
      signal: mergedTrade.type,
      confidence: mergedTrade.confidence,
      reason: mergedTrade.reason,
    }, mergedTrade.mt5Comment || '');

    return mergedTrade;
  }

  async reconcileTrade(trade) {
    const resolved = await this._resolveBrokerSummary(trade);
    if (!resolved?.summary?.deals?.length) {
      return {
        tradeId: trade._id,
        symbol: trade.symbol,
        updated: false,
        reason: 'No broker deal history found for this trade',
      };
    }

    const update = this._buildTradeUpdate(trade, resolved);
    const changed = this._hasMeaningfulChanges(trade, update);

    if (changed) {
      await Trade.updateById(trade._id, update);
    }

    return {
      tradeId: trade._id,
      symbol: trade.symbol,
      updated: changed,
      profitLoss: update.profitLoss,
      openedAt: update.openedAt,
      closedAt: update.closedAt,
      mt5PositionId: update.mt5PositionId,
      mt5EntryDealId: update.mt5EntryDealId,
      mt5CloseDealId: update.mt5CloseDealId,
      source: resolved.source,
    };
  }

  async syncTradesFromBroker({ mode = 'incremental', limit = 500, symbol, startDate, endDate } = {}) {
    const normalizedMode = mode === 'full' ? 'full' : 'incremental';
    const window = await this._resolveSyncWindow({ mode: normalizedMode, symbol, startDate, endDate });

    const wasConnected = mt5Service.isConnected();
    if (!wasConnected) {
      await mt5Service.connect();
    }

    try {
      const rawDeals = await mt5Service.getDeals(window.start, window.end);
      const groupedTradeHistory = Array.from(this._groupDealsByTrade(rawDeals).values())
        .map((deals) => ({
          deals,
          summary: mt5Service.summarizePositionDeals(deals),
        }))
        .filter(({ summary, deals }) => {
          const groupSymbol = summary.entryDeals?.[0]?.symbol || deals[0]?.symbol || null;
          return !symbol || groupSymbol === symbol;
        })
        .sort((left, right) => {
          const leftTime = this._getActivityTime(left.summary, left.deals)?.getTime() || 0;
          const rightTime = this._getActivityTime(right.summary, right.deals)?.getTime() || 0;
          return rightTime - leftTime;
        });

      const limitedGroups = limit > 0 ? groupedTradeHistory.slice(0, limit) : groupedTradeHistory;
      const results = [];

      for (const tradeGroup of limitedGroups) {
        results.push(await this._syncBrokerTradeGroup(tradeGroup, normalizedMode));
      }

      return {
        mode: normalizedMode,
        checked: limitedGroups.length,
        imported: results.filter((result) => result.action === 'imported').length,
        updated: results.filter((result) => result.action === 'updated').length,
        skipped: results.filter((result) => result.action === 'skipped').length,
        windowStart: window.start,
        windowEnd: window.end,
        results,
      };
    } finally {
      if (!wasConnected) {
        await mt5Service.disconnect().catch(() => {});
      }
    }
  }

  async reconcileClosedTrades(options = {}) {
    return await this.syncTradesFromBroker({
      ...options,
      mode: options.mode || 'full',
    });
  }
}

module.exports = new TradeHistoryService();
