const { batchBacktestJobsDb } = require('../config/db');

function toSummary(job) {
  if (!job) return null;

  return {
    jobId: job._id,
    status: job.status,
    scope: job.scope,
    runModel: job.runModel || 'independent',
    period: job.period,
    initialBalance: job.initialBalance,
    strategyScopeMode: job.strategyScopeMode || 'enabled_assigned_only',
    timeframeMode: job.timeframeMode,
    forcedTimeframe: job.forcedTimeframe || null,
    progress: job.progress || null,
    aggregate: job.aggregate || null,
    portfolioResult: job.portfolioResult || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    completedAt: job.completedAt || null,
  };
}

const BatchBacktestJob = {
  async create(data) {
    return batchBacktestJobsDb.insert({
      ...data,
      createdAt: data.createdAt || new Date().toISOString(),
    });
  },

  async findById(id) {
    return batchBacktestJobsDb.findOne({ _id: id });
  },

  async update(id, fields) {
    await batchBacktestJobsDb.update({ _id: id }, { $set: fields });
    return this.findById(id);
  },

  async findAll(limit = 20) {
    return batchBacktestJobsDb.find({}).sort({ createdAt: -1 }).limit(limit);
  },

  toSummary,
};

module.exports = BatchBacktestJob;
