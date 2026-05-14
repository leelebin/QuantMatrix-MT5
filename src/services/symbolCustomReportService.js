const SymbolCustom = require('../models/SymbolCustom');
const SymbolCustomBacktest = require('../models/SymbolCustomBacktest');
const { isSymbolCustomRegistered } = require('../symbolCustom/registry');
const { PLACEHOLDER_SYMBOL_CUSTOM } = require('../symbolCustom/logics/PlaceholderSymbolCustom');
const { SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1 } = require('./symbolCustomService');

const RECOMMENDATIONS = Object.freeze({
  DRAFT_ONLY: 'DRAFT_ONLY',
  PAPER_TESTING: 'PAPER_TESTING',
  NEEDS_BACKTEST: 'NEEDS_BACKTEST',
  PLACEHOLDER_ONLY: 'PLACEHOLDER_ONLY',
  DISABLED: 'DISABLED',
});

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeString(value) {
  return String(value || '').trim();
}

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function buildFilter(filter = {}) {
  const query = {};
  const symbol = normalizeSymbol(filter.symbol);
  if (symbol) query.symbol = symbol;

  const status = normalizeString(filter.status);
  if (status) query.status = status;

  return query;
}

function toTime(value) {
  const time = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : null;
}

function isSinceMatch(record, since) {
  const sinceTime = toTime(since);
  if (!sinceTime) return true;

  const updatedAt = toTime(record.updatedAt);
  const createdAt = toTime(record.createdAt);
  return [updatedAt, createdAt].some((time) => time != null && time >= sinceTime);
}

function resolveLogicName(symbolCustom = {}) {
  return normalizeString(symbolCustom.logicName || symbolCustom.registryLogicName);
}

function buildBacktestSummary(backtest) {
  if (!backtest) return null;
  const summary = backtest.summary || {};
  return {
    status: backtest.status || null,
    startDate: backtest.startDate || null,
    endDate: backtest.endDate || null,
    trades: summary.trades ?? null,
    netPnl: summary.netPnl ?? null,
    profitFactor: summary.profitFactor ?? null,
    winRate: summary.winRate ?? null,
    avgR: summary.avgR ?? null,
    maxDrawdown: summary.maxDrawdown ?? null,
    message: backtest.message || null,
    createdAt: backtest.createdAt || null,
  };
}

function sortBacktestsNewestFirst(backtests = []) {
  return [...backtests].sort((left, right) => {
    const rightTime = toTime(right.createdAt) || 0;
    const leftTime = toTime(left.createdAt) || 0;
    return rightTime - leftTime;
  });
}

async function buildSymbolCustomBacktestSummary(symbolCustomId) {
  if (!symbolCustomId) return null;
  const backtests = await SymbolCustomBacktest.findAll({ symbolCustomId });
  const [latest] = sortBacktestsNewestFirst(backtests);
  return buildBacktestSummary(latest);
}

function buildRecommendation(symbolCustom, latestBacktest, warnings) {
  const status = normalizeString(symbolCustom.status);
  if (status === 'archived' || status === 'disabled') {
    return RECOMMENDATIONS.DISABLED;
  }

  const logicName = resolveLogicName(symbolCustom);
  if (!logicName) {
    warnings.push('SYMBOL_CUSTOM_LOGIC_MISSING');
    return RECOMMENDATIONS.PLACEHOLDER_ONLY;
  }

  if (!isSymbolCustomRegistered(logicName)) {
    warnings.push('SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED');
    return RECOMMENDATIONS.PLACEHOLDER_ONLY;
  }

  if (logicName === PLACEHOLDER_SYMBOL_CUSTOM) {
    return RECOMMENDATIONS.PLACEHOLDER_ONLY;
  }

  if (!latestBacktest) {
    return RECOMMENDATIONS.NEEDS_BACKTEST;
  }

  if (symbolCustom.paperEnabled === true && symbolCustom.liveEnabled !== true) {
    return RECOMMENDATIONS.PAPER_TESTING;
  }

  return RECOMMENDATIONS.DRAFT_ONLY;
}

async function buildSymbolCustomSummary(symbolCustom) {
  const warnings = [];
  const latestBacktest = await buildSymbolCustomBacktestSummary(symbolCustom._id);

  if (symbolCustom.liveEnabled === true) {
    warnings.push(SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1);
  }

  const logicName = resolveLogicName(symbolCustom);
  const recommendation = buildRecommendation(symbolCustom, latestBacktest, warnings);

  return {
    symbol: symbolCustom.symbol,
    symbolCustomName: symbolCustom.symbolCustomName,
    displayName: symbolCustom.displayName,
    status: symbolCustom.status,
    paperEnabled: symbolCustom.paperEnabled === true,
    liveEnabled: symbolCustom.liveEnabled === true,
    isPrimaryLive: symbolCustom.isPrimaryLive === true,
    allowLive: symbolCustom.allowLive === true,
    logicName: logicName || null,
    version: symbolCustom.version || 1,
    timeframes: cloneValue(symbolCustom.timeframes || {}),
    latestBacktest,
    recommendation,
    warnings,
  };
}

async function buildSymbolCustomReport(filter = {}) {
  const symbolCustoms = await SymbolCustom.findAll(buildFilter(filter));
  const filtered = symbolCustoms.filter((symbolCustom) => isSinceMatch(symbolCustom, filter.since));
  const summaries = [];

  for (const symbolCustom of filtered) {
    summaries.push(await buildSymbolCustomSummary(symbolCustom));
  }

  return {
    success: true,
    count: summaries.length,
    symbolCustoms: summaries,
  };
}

module.exports = {
  RECOMMENDATIONS,
  buildSymbolCustomReport,
  buildSymbolCustomSummary,
  buildSymbolCustomBacktestSummary,
};
