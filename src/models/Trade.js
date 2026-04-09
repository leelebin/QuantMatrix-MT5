const { tradesDb } = require('../config/db');

const Trade = {
  async findAll(query = {}, limit = 100) {
    return await tradesDb.find(query).sort({ openedAt: -1 }).limit(limit);
  },

  async findById(id) {
    return await tradesDb.findOne({ _id: id });
  },

  async getStats() {
    const allTrades = await tradesDb.find({ status: 'CLOSED' });
    if (allTrades.length === 0) {
      return { totalTrades: 0, winRate: 0, totalProfit: 0, averageProfit: 0 };
    }

    const winners = allTrades.filter((t) => t.profitLoss > 0);
    const totalProfit = allTrades.reduce((s, t) => s + (t.profitLoss || 0), 0);
    const totalPips = allTrades.reduce((s, t) => s + (t.profitPips || 0), 0);

    // By strategy
    const byStrategy = {};
    for (const t of allTrades) {
      if (!byStrategy[t.strategy]) {
        byStrategy[t.strategy] = { trades: 0, wins: 0, profit: 0, pips: 0 };
      }
      byStrategy[t.strategy].trades++;
      if (t.profitLoss > 0) byStrategy[t.strategy].wins++;
      byStrategy[t.strategy].profit += t.profitLoss || 0;
      byStrategy[t.strategy].pips += t.profitPips || 0;
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
