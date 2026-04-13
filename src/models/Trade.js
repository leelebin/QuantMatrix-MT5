const { tradesDb } = require('../config/db');
const { normalizeDateStart, normalizeDateEnd } = require('../utils/tradeExport');

const UNKNOWN_STRATEGY = 'Unknown';

function normalizeStrategy(strategy) {
  return String(strategy || '').trim() || UNKNOWN_STRATEGY;
}

function getLatestTimestamp(trade = null) {
  if (!trade) return null;
  const candidates = [trade.closedAt, trade.openedAt, trade.brokerSyncedAt]
    .map((value) => (value instanceof Date ? value : new Date(value)))
    .filter((value) => !Number.isNaN(value.getTime()));

  if (candidates.length === 0) return null;
  return candidates.reduce((latest, current) => (
    !latest || current.getTime() > latest.getTime() ? current : latest
  ), null);
}

const Trade = {
  buildQuery(filters = {}) {
    const query = {};

    if (filters.symbol) query.symbol = filters.symbol;
    if (filters.strategy) query.strategy = filters.strategy;
    if (filters.status) query.status = filters.status;

    const startDate = normalizeDateStart(filters.startDate);
    const endDate = normalizeDateEnd(filters.endDate);

    if (startDate || endDate) {
      query.openedAt = {};
      if (startDate) query.openedAt.$gte = startDate;
      if (endDate) query.openedAt.$lte = endDate;
    }

    return query;
  },

  async findAll(query = {}, limit = 100) {
    return await tradesDb.find(query).sort({ openedAt: -1 }).limit(limit);
  },

  async findByFilters(filters = {}, limit = 100) {
    const query = Trade.buildQuery(filters);
    return await tradesDb.find(query).sort({ openedAt: -1 }).limit(limit);
  },

  async findForExport(filters = {}) {
    const query = Trade.buildQuery(filters);
    return await tradesDb.find(query).sort({ openedAt: -1 });
  },

  async findById(id) {
    return await tradesDb.findOne({ _id: id });
  },

  async create(trade) {
    return await tradesDb.insert(trade);
  },

  async updateById(id, fields) {
    await tradesDb.update({ _id: id }, { $set: fields });
    return await Trade.findById(id);
  },

  async findBrokerLinked(filters = {}) {
    const query = {
      $or: [
        { mt5PositionId: { $exists: true, $ne: null } },
        { mt5EntryDealId: { $exists: true, $ne: null } },
        { mt5CloseDealId: { $exists: true, $ne: null } },
        { mt5OrderId: { $exists: true, $ne: null } },
      ],
    };

    if (filters.symbol) query.symbol = filters.symbol;

    return await tradesDb.find(query);
  },

  async findLatestBrokerTrade(filters = {}) {
    const brokerTrades = await Trade.findBrokerLinked(filters);
    if (!brokerTrades.length) return null;

    return brokerTrades.reduce((latestTrade, trade) => {
      const latestTimestamp = getLatestTimestamp(latestTrade);
      const tradeTimestamp = getLatestTimestamp(trade);

      if (!latestTimestamp) return trade;
      if (!tradeTimestamp) return latestTrade;
      return tradeTimestamp.getTime() > latestTimestamp.getTime() ? trade : latestTrade;
    }, null);
  },

  async findByBrokerRefs({ positionId, entryDealId, closeDealId, orderId } = {}) {
    const candidates = [
      positionId ? { mt5PositionId: String(positionId) } : null,
      entryDealId ? { mt5EntryDealId: String(entryDealId) } : null,
      closeDealId ? { mt5CloseDealId: String(closeDealId) } : null,
      orderId ? { mt5OrderId: String(orderId) } : null,
    ].filter(Boolean);

    for (const candidate of candidates) {
      const trade = await tradesDb.findOne(candidate);
      if (trade) return trade;
    }

    return null;
  },

  async getStats(filters = {}) {
    const baseQuery = Trade.buildQuery(filters);
    if (baseQuery.status && baseQuery.status !== 'CLOSED') {
      return {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalProfit: 0,
        totalPips: 0,
        averageProfit: 0,
        averagePips: 0,
        byStrategy: {},
        bySymbol: {},
      };
    }
    const allTrades = await tradesDb.find({ ...baseQuery, status: 'CLOSED' });
    if (allTrades.length === 0) {
      return { totalTrades: 0, winRate: 0, totalProfit: 0, averageProfit: 0 };
    }

    const winners = allTrades.filter((t) => t.profitLoss > 0);
    const totalProfit = allTrades.reduce((s, t) => s + (t.profitLoss || 0), 0);
    const totalPips = allTrades.reduce((s, t) => s + (t.profitPips || 0), 0);

    // By strategy
    const byStrategy = {};
    for (const t of allTrades) {
      const strategy = normalizeStrategy(t.strategy);
      if (!byStrategy[strategy]) {
        byStrategy[strategy] = { trades: 0, wins: 0, profit: 0, pips: 0 };
      }
      byStrategy[strategy].trades++;
      if (t.profitLoss > 0) byStrategy[strategy].wins++;
      byStrategy[strategy].profit += t.profitLoss || 0;
      byStrategy[strategy].pips += t.profitPips || 0;
    }

    // By symbol
    const bySymbol = {};
    for (const t of allTrades) {
      if (!bySymbol[t.symbol]) {
        bySymbol[t.symbol] = { trades: 0, wins: 0, profit: 0, pips: 0 };
      }
      bySymbol[t.symbol].trades++;
      if (t.profitLoss > 0) bySymbol[t.symbol].wins++;
      bySymbol[t.symbol].profit += t.profitLoss || 0;
      bySymbol[t.symbol].pips += t.profitPips || 0;
    }

    return {
      totalTrades: allTrades.length,
      winningTrades: winners.length,
      losingTrades: allTrades.length - winners.length,
      winRate: parseFloat((winners.length / allTrades.length).toFixed(4)),
      totalProfit: parseFloat(totalProfit.toFixed(2)),
      totalPips: parseFloat(totalPips.toFixed(1)),
      averageProfit: parseFloat((totalProfit / allTrades.length).toFixed(2)),
      averagePips: parseFloat((totalPips / allTrades.length).toFixed(1)),
      byStrategy,
      bySymbol,
    };
  },
};

module.exports = Trade;
module.exports.UNKNOWN_STRATEGY = UNKNOWN_STRATEGY;
