const { backtestsDb } = require('../config/db');

const Backtest = {
  async findAll(limit = 50) {
    const results = await backtestsDb.find({}).sort({ createdAt: -1 }).limit(limit);
    return results.map((r) => ({
      _id: r._id,
      symbol: r.symbol,
      strategy: r.strategy,
      timeframe: r.timeframe,
      period: r.period,
      summary: r.summary,
      createdAt: r.createdAt,
    }));
  },

  async findById(id) {
    return await backtestsDb.findOne({ _id: id });
  },

  async delete(id) {
    return await backtestsDb.remove({ _id: id });
  },
};

module.exports = Backtest;
