const { tradesDb } = require('../config/db');
const mt5Service = require('./mt5Service');
const { buildClosedTradeSnapshot } = require('../utils/mt5Reconciliation');
const { buildTradeComment, parseStrategyFromBrokerComment } = require('../utils/tradeComment');

class TradeHistoryService {
  _normalizeDate(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  _unique(values = []) {
    return [...new Set(values.filter(Boolean).map((value) => String(value)))];
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

  _buildTradeUpdate(trade, resolved) {
    const { positionId, summary, source } = resolved;
    const fallbackClosedAt = this._normalizeDate(trade.closedAt) || new Date();
    const closedSnapshot = buildClosedTradeSnapshot(trade, summary, {
      exitPrice: trade.exitPrice,
      reason: trade.exitReason || 'EXTERNAL',
      closedAt: fallbackClosedAt,
    });

    return {
      entryPrice: closedSnapshot.entryPrice,
      exitPrice: closedSnapshot.exitPrice,
      exitReason: closedSnapshot.exitReason,
      profitLoss: closedSnapshot.profitLoss,
      profitPips: closedSnapshot.profitPips,
      commission: closedSnapshot.commission,
      swap: closedSnapshot.swap,
      fee: closedSnapshot.fee,
      openedAt: summary.entryTime ? new Date(summary.entryTime) : (this._normalizeDate(trade.openedAt) || trade.openedAt),
      closedAt: summary.exitTime ? new Date(summary.exitTime) : closedSnapshot.closedAt,
      mt5PositionId: positionId || trade.mt5PositionId || null,
      mt5EntryDealId: summary.entryDeals?.[0]?.id || trade.mt5EntryDealId || null,
      mt5CloseDealId: summary.lastExitDeal?.id || trade.mt5CloseDealId || null,
      mt5Comment: summary.entryDeals?.[0]?.comment || trade.mt5Comment || null,
      comment: buildTradeComment({
        strategy: trade.strategy || parseStrategyFromBrokerComment(summary.entryDeals?.[0]?.comment),
        signal: trade.type,
        confidence: trade.confidence,
        reason: trade.reason,
      }, summary.entryDeals?.[0]?.comment || trade.mt5Comment || ''),
      brokerSyncedAt: new Date(),
      brokerSyncSource: source,
    };
  }

  _hasMeaningfulChanges(trade, update) {
    return (
      this._numberChanged(trade.entryPrice, update.entryPrice)
      || this._numberChanged(trade.exitPrice, update.exitPrice)
      || this._numberChanged(trade.profitLoss, update.profitLoss)
      || this._numberChanged(trade.profitPips, update.profitPips)
      || this._numberChanged(trade.commission, update.commission)
      || this._numberChanged(trade.swap, update.swap)
      || this._numberChanged(trade.fee, update.fee)
      || this._stringChanged(trade.exitReason, update.exitReason)
      || this._stringChanged(trade.mt5PositionId, update.mt5PositionId)
      || this._stringChanged(trade.mt5EntryDealId, update.mt5EntryDealId)
      || this._stringChanged(trade.mt5CloseDealId, update.mt5CloseDealId)
      || this._stringChanged(trade.mt5Comment, update.mt5Comment)
      || this._stringChanged(trade.comment, update.comment)
      || this._dateChanged(trade.openedAt, update.openedAt)
      || this._dateChanged(trade.closedAt, update.closedAt)
    );
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
      await tradesDb.update({ _id: trade._id }, { $set: update });
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

  async reconcileClosedTrades({ limit = 100, symbol } = {}) {
    const query = { status: 'CLOSED' };
    if (symbol) query.symbol = symbol;

    const wasConnected = mt5Service.isConnected();
    if (!wasConnected) {
      await mt5Service.connect();
    }

    try {
      const trades = await tradesDb.find(query).sort({ openedAt: -1 }).limit(limit);
      const results = [];

      for (const trade of trades) {
        results.push(await this.reconcileTrade(trade));
      }

      return {
        checked: trades.length,
        updated: results.filter((result) => result.updated).length,
        results,
      };
    } finally {
      if (!wasConnected) {
        await mt5Service.disconnect().catch(() => {});
      }
    }
  }
}

module.exports = new TradeHistoryService();
