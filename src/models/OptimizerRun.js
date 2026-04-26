const { optimizerRunsDb } = require('../config/db');

const DEFAULT_OPTIMIZER_INITIAL_BALANCE = 10000;

function normalizeInitialBalance(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_OPTIMIZER_INITIAL_BALANCE;
}

function hydrateRun(run) {
  if (!run) return null;
  return {
    ...run,
    initialBalance: normalizeInitialBalance(run.initialBalance),
  };
}

function toSummary(run) {
  const normalized = hydrateRun(run);
  if (!normalized) return null;

  return {
    historyId: normalized._id,
    symbol: normalized.symbol,
    strategy: normalized.strategy,
    timeframe: normalized.timeframe || null,
    initialBalance: normalized.initialBalance,
    optimizeFor: normalized.optimizeFor,
    status: normalized.status || 'completed',
    stopped: Boolean(normalized.stopped),
    workerCount: Number(normalized.workerCount) || 1,
    totalCombinations: Number(normalized.totalCombinations) || 0,
    processedCombinations: Number(normalized.processedCombinations) || 0,
    validResults: Number(normalized.validResults) || 0,
    period: normalized.period || null,
    bestResult: normalized.bestResult || null,
    top10: Array.isArray(normalized.top10) ? normalized.top10 : [],
    createdAt: normalized.createdAt || null,
    completedAt: normalized.completedAt || null,
  };
}

const OptimizerRun = {
  async createFromResult(result, extra = {}) {
    const completedAt = result.completedAt || new Date().toISOString();
    return optimizerRunsDb.insert({
      symbol: result.symbol,
      strategy: result.strategy,
      timeframe: result.timeframe || null,
      initialBalance: normalizeInitialBalance(result.initialBalance),
      optimizeFor: result.optimizeFor || 'profitFactor',
      status: result.status || (result.stopped ? 'stopped' : 'completed'),
      stopped: Boolean(result.stopped),
      workerCount: Number(result.workerCount) || 1,
      totalCombinations: Number(result.totalCombinations) || 0,
      processedCombinations: Number(result.processedCombinations) || 0,
      validResults: Number(result.validResults) || 0,
      period: extra.period || result.period || null,
      breakevenConfigUsed: result.breakevenConfigUsed || null,
      bestResult: result.bestResult || null,
      top10: Array.isArray(result.top10) ? result.top10 : [],
      createdAt: extra.createdAt || completedAt,
      completedAt,
    });
  },

  async findAll(limit = 50) {
    const runs = await optimizerRunsDb.find({}).sort({ completedAt: -1, createdAt: -1 }).limit(limit);
    return runs.map(toSummary);
  },

  async findById(id) {
    return hydrateRun(await optimizerRunsDb.findOne({ _id: id }));
  },

  async findLatestBestResult(symbol, strategy) {
    const rows = await optimizerRunsDb
      .find({
        symbol,
        strategy,
        bestResult: { $ne: null },
      })
      .sort({ completedAt: -1, createdAt: -1 })
      .limit(1);

    return Array.isArray(rows) && rows.length > 0 ? hydrateRun(rows[0]) : null;
  },

  toSummary,
};

module.exports = OptimizerRun;
