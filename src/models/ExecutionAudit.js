const { executionAuditDb } = require('../config/db');

const ExecutionAudit = {
  async create(event) {
    return await executionAuditDb.insert({
      scope: event.scope || 'live',
      stage: event.stage || 'execution',
      status: event.status || 'INFO',
      symbol: event.symbol || null,
      type: event.type || null,
      strategy: event.strategy || null,
      volume: event.volume ?? null,
      code: event.code ?? null,
      codeName: event.codeName || null,
      message: event.message || '',
      accountMode: event.accountMode || null,
      accountLogin: event.accountLogin || null,
      accountServer: event.accountServer || null,
      source: event.source || 'system',
      details: event.details || null,
      createdAt: event.createdAt || new Date(),
    });
  },

  async findAll(query = {}, limit = 100) {
    return await executionAuditDb.find(query).sort({ createdAt: -1 }).limit(limit);
  },
};

module.exports = ExecutionAudit;
