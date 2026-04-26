const { decisionAuditDb } = require('../config/db');

// Valid stages in the decision pipeline
const STAGES = Object.freeze({
  SCAN: 'SCAN',
  NO_SETUP: 'NO_SETUP',
  SETUP_FOUND: 'SETUP_FOUND',
  FILTERED: 'FILTERED',
  TRIGGERED: 'TRIGGERED',
  DUPLICATE: 'DUPLICATE',
  RISK_REJECTED: 'RISK_REJECTED',
  PREFLIGHT_REJECTED: 'PREFLIGHT_REJECTED',
  ORDER_OPENED: 'ORDER_OPENED',
  ORDER_FAILED: 'ORDER_FAILED',
  POSITION_MANAGED: 'POSITION_MANAGED',
  ORDER_CLOSED: 'ORDER_CLOSED',
  NEWS_BLACKOUT: 'NEWS_BLACKOUT',
});

const STATUSES = Object.freeze({
  OK: 'OK',
  INFO: 'INFO',
  WARN: 'WARN',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
});

function normalizeRecord(event) {
  const now = new Date();
  return {
    timestamp: event.timestamp || now.toISOString(),
    symbol: event.symbol || null,
    strategy: event.strategy || null,
    module: event.module || null,
    type: event.type || null,
    stage: event.stage || null,
    status: event.status || 'INFO',
    scope: event.scope || 'live', // live | paper | backtest
    reasonCode: event.reasonCode || null,
    reasonText: event.reasonText || '',
    signal: event.signal || null, // BUY | SELL | NONE
    confidence: typeof event.confidence === 'number' ? event.confidence : null,
    setupDirection: event.setupDirection || null,
    setupActive: typeof event.setupActive === 'boolean' ? event.setupActive : null,
    filterReason: event.filterReason || null,
    triggerReason: event.triggerReason || null,
    setupTimeframe: event.setupTimeframe || null,
    entryTimeframe: event.entryTimeframe || null,
    setupCandleTime: event.setupCandleTime || null,
    entryCandleTime: event.entryCandleTime || null,
    price: typeof event.price === 'number' ? event.price : null,
    sl: typeof event.sl === 'number' ? event.sl : null,
    tp: typeof event.tp === 'number' ? event.tp : null,
    marketQualityScore:
      typeof event.marketQualityScore === 'number' ? event.marketQualityScore : null,
    marketQualityThreshold:
      typeof event.marketQualityThreshold === 'number' ? event.marketQualityThreshold : null,
    indicatorsSnapshot: event.indicatorsSnapshot || null,
    calculatedLot: typeof event.calculatedLot === 'number' ? event.calculatedLot : null,
    minLot: typeof event.minLot === 'number' ? event.minLot : null,
    riskCheck: event.riskCheck || null,
    preflightMessage: event.preflightMessage || null,
    mt5Retcode: typeof event.mt5Retcode === 'number' ? event.mt5Retcode : null,
    positionDbId: event.positionDbId || null,
    tradeLogId: event.tradeLogId || null,
    exitReason: event.exitReason || null,
    pnl: typeof event.pnl === 'number' ? event.pnl : null,
    source: event.source || 'system',
    details: event.details || null,
    createdAt: event.createdAt || now,
  };
}

const DecisionAudit = {
  STAGES,
  STATUSES,

  async create(event) {
    const record = normalizeRecord(event);
    return await decisionAuditDb.insert(record);
  },

  async find(query = {}, { limit = 100, skip = 0, sort = { createdAt: -1 } } = {}) {
    return await decisionAuditDb.find(query).sort(sort).skip(skip).limit(limit);
  },

  async count(query = {}) {
    return await decisionAuditDb.count(query);
  },

  // Aggregate stats: grouped counts by stage+reasonCode, by strategy, by symbol.
  async stats(query = {}, { limit = 5000 } = {}) {
    const rows = await decisionAuditDb.find(query).sort({ createdAt: -1 }).limit(limit);

    const byStage = {};
    const byReason = {};
    const byStrategy = {};
    const bySymbol = {};
    const byStatus = {};
    const topNoSetup = {};
    const topFiltered = {};
    const topRiskReject = {};
    const topExecReject = {};

    for (const row of rows) {
      byStage[row.stage] = (byStage[row.stage] || 0) + 1;
      byStatus[row.status] = (byStatus[row.status] || 0) + 1;
      if (row.strategy) byStrategy[row.strategy] = (byStrategy[row.strategy] || 0) + 1;
      if (row.symbol) bySymbol[row.symbol] = (bySymbol[row.symbol] || 0) + 1;

      const key = row.reasonCode || 'UNSPECIFIED';
      byReason[key] = (byReason[key] || 0) + 1;

      if (row.stage === 'NO_SETUP') topNoSetup[key] = (topNoSetup[key] || 0) + 1;
      if (row.stage === 'FILTERED') topFiltered[key] = (topFiltered[key] || 0) + 1;
      if (row.stage === 'RISK_REJECTED') topRiskReject[key] = (topRiskReject[key] || 0) + 1;
      if (row.stage === 'PREFLIGHT_REJECTED' || row.stage === 'ORDER_FAILED') {
        topExecReject[key] = (topExecReject[key] || 0) + 1;
      }
    }

    const toSortedArray = (obj) =>
      Object.entries(obj)
        .map(([k, v]) => ({ key: k, count: v }))
        .sort((a, b) => b.count - a.count);

    return {
      total: rows.length,
      byStage: toSortedArray(byStage),
      byStatus: toSortedArray(byStatus),
      byStrategy: toSortedArray(byStrategy),
      bySymbol: toSortedArray(bySymbol),
      byReason: toSortedArray(byReason),
      topNoSetup: toSortedArray(topNoSetup).slice(0, 10),
      topFiltered: toSortedArray(topFiltered).slice(0, 10),
      topRiskReject: toSortedArray(topRiskReject).slice(0, 10),
      topExecReject: toSortedArray(topExecReject).slice(0, 10),
    };
  },

  async deleteOlderThan(cutoffDate) {
    return await decisionAuditDb.remove({ createdAt: { $lt: cutoffDate } }, { multi: true });
  },
};

module.exports = DecisionAudit;
