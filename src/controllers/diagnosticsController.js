const DecisionAudit = require('../models/DecisionAudit');

const VALID_STAGES = new Set(Object.values(DecisionAudit.STAGES));
const VALID_STATUSES = new Set(Object.values(DecisionAudit.STATUSES));

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildQuery(params) {
  const query = {};
  if (params.symbol) query.symbol = params.symbol;
  if (params.strategy) query.strategy = params.strategy;
  if (params.scope) query.scope = params.scope;
  if (params.module) query.module = params.module;
  if (params.reasonCode) query.reasonCode = params.reasonCode;

  if (params.stage) {
    const stages = String(params.stage).split(',').map((s) => s.trim()).filter(Boolean);
    const valid = stages.filter((s) => VALID_STAGES.has(s));
    if (valid.length === 1) query.stage = valid[0];
    else if (valid.length > 1) query.stage = { $in: valid };
  }

  if (params.status) {
    const statuses = String(params.status).split(',').map((s) => s.trim()).filter(Boolean);
    const valid = statuses.filter((s) => VALID_STATUSES.has(s));
    if (valid.length === 1) query.status = valid[0];
    else if (valid.length > 1) query.status = { $in: valid };
  }

  const startDate = parseDate(params.startDate);
  const endDate = parseDate(params.endDate);
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = startDate;
    if (endDate) query.createdAt.$lte = endDate;
  }

  if (params.q) {
    const escaped = String(params.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    query.$or = [
      { reasonText: { $regex: regex } },
      { reasonCode: { $regex: regex } },
    ];
  }

  return query;
}

exports.getAudits = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const query = buildQuery(req.query);

    const [items, total] = await Promise.all([
      DecisionAudit.find(query, { limit, skip }),
      DecisionAudit.count(query),
    ]);

    res.json({
      success: true,
      data: items,
      count: items.length,
      pagination: { total, limit, skip },
      filters: req.query,
    });
  } catch (err) {
    console.error('[Diagnostics] getAudits error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getStats = async (req, res) => {
  try {
    const query = buildQuery(req.query);
    const limit = Math.min(parseInt(req.query.limit, 10) || 5000, 20000);
    const stats = await DecisionAudit.stats(query, { limit });
    res.json({ success: true, data: stats, filters: req.query });
  } catch (err) {
    console.error('[Diagnostics] getStats error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getConstants = async (_req, res) => {
  res.json({
    success: true,
    data: {
      stages: Object.values(DecisionAudit.STAGES),
      statuses: Object.values(DecisionAudit.STATUSES),
      scopes: ['live', 'paper', 'backtest'],
    },
  });
};
