const { tradeLogDb } = require('../config/db');

const TradeLog = {
  /**
   * Insert a new trade log entry when a paper trade opens
   */
  async logOpen(trade) {
    return await tradeLogDb.insert({
      symbol: trade.symbol,
      type: trade.type,               // BUY / SELL
      lotSize: trade.lotSize,
      entryPrice: trade.entryPrice,
      exitPrice: null,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
      profitLoss: null,
      profitPips: null,
      commission: trade.commission || 0,
      swap: trade.swap || 0,
      fee: trade.fee || 0,
      holdingTimeMs: null,
      holdingTime: null,
      signalReason: trade.signalReason,
      strategy: trade.strategy,
      confidence: trade.confidence,
      indicatorsSnapshot: trade.indicatorsSnapshot || null,
      mt5PositionId: trade.mt5PositionId || null,
      mt5DealId: trade.mt5DealId || null,
      mt5Comment: trade.mt5Comment || null,
      comment: trade.comment || null,
      positionDbId: trade.positionDbId,
      status: 'OPEN',
      openedAt: trade.openedAt || new Date(),
      closedAt: null,
      exitReason: null,
    });
  },

  /**
   * Update trade log when a paper trade closes
   */
  async logClose(positionDbId, closeData) {
    const holdingTimeMs = closeData.closedAt - closeData.openedAt;
    const holdingTime = TradeLog.formatHoldingTime(holdingTimeMs);

    return await tradeLogDb.update(
      { positionDbId },
      {
        $set: {
          status: 'CLOSED',
          exitPrice: closeData.exitPrice,
          exitReason: closeData.exitReason,
          profitLoss: closeData.profitLoss,
          profitPips: closeData.profitPips,
          commission: closeData.commission || 0,
          swap: closeData.swap || 0,
          fee: closeData.fee || 0,
          holdingTimeMs,
          holdingTime,
          closedAt: closeData.closedAt,
        },
      }
    );
  },

  /**
   * Get all trade logs for a date range
   */
  async findByDateRange(startDate, endDate) {
    return await tradeLogDb
      .find({
        openedAt: { $gte: startDate, $lte: endDate },
      })
      .sort({ openedAt: -1 });
  },

  /**
   * Get today's trade logs
   */
  async findToday() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return await TradeLog.findByDateRange(start, end);
  },

  /**
   * Get all closed trades for a specific date (for daily report)
   */
  async findClosedByDate(date) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);
    return await tradeLogDb
      .find({
        closedAt: { $gte: start, $lte: end },
        status: 'CLOSED',
      })
      .sort({ closedAt: -1 });
  },

  /**
   * Get all trades (open + closed) active during a specific date
   */
  async findActiveByDate(date) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);
    return await tradeLogDb
      .find({
        openedAt: { $lte: end },
        $or: [{ closedAt: null }, { closedAt: { $gte: start } }],
      })
      .sort({ openedAt: -1 });
  },

  /**
   * Get all trade logs
   */
  async findAll(query = {}, limit = 200) {
    return await tradeLogDb.find(query).sort({ openedAt: -1 }).limit(limit);
  },

  /**
   * Get aggregate statistics for closed trades
   */
  async getStats(query = {}) {
    const allTrades = await tradeLogDb.find({ ...query, status: 'CLOSED' });
    if (allTrades.length === 0) {
      return {
        totalTrades: 0,
        winRate: 0,
        totalProfit: 0,
        averageProfit: 0,
        totalPips: 0,
        averageHoldingTimeMs: 0,
        averageHoldingTime: '0m',
        byStrategy: {},
        bySymbol: {},
      };
    }

    const winners = allTrades.filter((t) => t.profitLoss > 0);
    const losers = allTrades.filter((t) => t.profitLoss <= 0);
    const totalProfit = allTrades.reduce((s, t) => s + (t.profitLoss || 0), 0);
    const totalPips = allTrades.reduce((s, t) => s + (t.profitPips || 0), 0);
    const totalHoldingMs = allTrades.reduce((s, t) => s + (t.holdingTimeMs || 0), 0);

    // Profit factor
    const grossProfit = winners.reduce((s, t) => s + t.profitLoss, 0);
    const grossLoss = Math.abs(losers.reduce((s, t) => s + t.profitLoss, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Max drawdown (sequential)
    let peak = 0;
    let maxDrawdown = 0;
    let cumulative = 0;
    for (const t of allTrades.sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt))) {
      cumulative += t.profitLoss || 0;
      if (cumulative > peak) peak = cumulative;
      const dd = peak - cumulative;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // By strategy
    const byStrategy = {};
    for (const t of allTrades) {
      const key = t.strategy || 'Unknown';
      if (!byStrategy[key]) {
        byStrategy[key] = { trades: 0, wins: 0, profit: 0, pips: 0 };
      }
      byStrategy[key].trades++;
      if (t.profitLoss > 0) byStrategy[key].wins++;
      byStrategy[key].profit += t.profitLoss || 0;
      byStrategy[key].pips += t.profitPips || 0;
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

    const avgHoldingMs = totalHoldingMs / allTrades.length;

    return {
      totalTrades: allTrades.length,
      winningTrades: winners.length,
      losingTrades: losers.length,
      winRate: parseFloat((winners.length / allTrades.length).toFixed(4)),
      totalProfit: parseFloat(totalProfit.toFixed(2)),
      totalPips: parseFloat(totalPips.toFixed(1)),
      averageProfit: parseFloat((totalProfit / allTrades.length).toFixed(2)),
      averagePips: parseFloat((totalPips / allTrades.length).toFixed(1)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
      averageHoldingTimeMs: Math.round(avgHoldingMs),
      averageHoldingTime: TradeLog.formatHoldingTime(avgHoldingMs),
      byStrategy,
      bySymbol,
    };
  },

  /**
   * Format milliseconds into human-readable holding time
   */
  formatHoldingTime(ms) {
    if (!ms || ms <= 0) return '0m';
    const totalMinutes = Math.floor(ms / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
    return parts.join(' ');
  },
};

module.exports = TradeLog;
