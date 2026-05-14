const SymbolCustom = require('../models/SymbolCustom');
const SymbolCustomBacktest = require('../models/SymbolCustomBacktest');
const { getSymbolCustomLogic } = require('../symbolCustom/registry');
const { PLACEHOLDER_SYMBOL_CUSTOM } = require('../symbolCustom/logics/PlaceholderSymbolCustom');

const SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED = 'SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED';
const PHASE_1_PLACEHOLDER_BACKTEST_MESSAGE = 'Placeholder SymbolCustom has no active backtest logic in Phase 1';

function buildHttpError(message, statusCode, details = undefined) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeBooleanFilter(value) {
  if (value === true || value === false) return value;
  if (value === undefined || value === null || value === '') return undefined;

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function buildListFilter(filter = {}) {
  const query = {};
  const symbol = normalizeSymbol(filter.symbol);
  if (symbol) query.symbol = symbol;

  for (const field of ['symbolCustomId', 'symbolCustomName', 'logicName', 'status']) {
    const value = String(filter[field] || '').trim();
    if (value) query[field] = value;
  }

  const mode = String(filter.mode || '').trim();
  if (mode) query.mode = mode;

  const hasTrades = normalizeBooleanFilter(filter.hasTrades);
  if (hasTrades !== undefined) {
    query['summary.trades'] = hasTrades ? { $gt: 0 } : 0;
  }

  return query;
}

function buildZeroSummary() {
  return {
    trades: 0,
    netPnl: 0,
    grossWin: 0,
    grossLoss: 0,
    profitFactor: null,
    winRate: null,
    avgR: null,
    maxDrawdown: 0,
    maxSingleLoss: 0,
  };
}

function resolveLogicName(symbolCustom = {}) {
  return String(symbolCustom.logicName || symbolCustom.registryLogicName || '').trim();
}

async function runSymbolCustomBacktest({
  symbolCustomId,
  startDate,
  endDate,
  initialBalance,
  parameters,
  costModel,
} = {}) {
  if (!symbolCustomId) {
    throw buildHttpError('symbolCustomId is required', 400, [
      { field: 'symbolCustomId', message: 'Required' },
    ]);
  }

  const symbolCustom = await SymbolCustom.findById(symbolCustomId);
  if (!symbolCustom) {
    throw buildHttpError('SymbolCustom not found', 404);
  }

  const logicName = resolveLogicName(symbolCustom);
  const logic = getSymbolCustomLogic(logicName);
  if (!logic) {
    throw buildHttpError(SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED, 400, [
      { field: 'logicName', message: SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED },
    ]);
  }

  if (logic.name === PLACEHOLDER_SYMBOL_CUSTOM) {
    return SymbolCustomBacktest.create({
      symbol: symbolCustom.symbol,
      symbolCustomId: symbolCustom._id,
      symbolCustomName: symbolCustom.symbolCustomName,
      logicName,
      mode: 'symbolCustom',
      status: 'stub',
      startDate,
      endDate,
      initialBalance,
      timeframes: symbolCustom.timeframes || {},
      parameters: parameters || symbolCustom.parameters || {},
      costModel: costModel || {},
      summary: buildZeroSummary(),
      trades: [],
      equityCurve: [],
      message: PHASE_1_PLACEHOLDER_BACKTEST_MESSAGE,
      error: null,
      completedAt: new Date(),
    });
  }

  throw buildHttpError('SYMBOL_CUSTOM_BACKTEST_NOT_SUPPORTED_IN_PHASE_1', 400, [
    { field: 'logicName', message: 'Only PLACEHOLDER_SYMBOL_CUSTOM stub backtests are supported in Phase 1' },
  ]);
}

async function getSymbolCustomBacktest(id) {
  return SymbolCustomBacktest.findById(id);
}

async function listSymbolCustomBacktests(filter = {}) {
  return SymbolCustomBacktest.findAll(buildListFilter(filter));
}

async function deleteSymbolCustomBacktest(id) {
  return SymbolCustomBacktest.remove(id);
}

module.exports = {
  PHASE_1_PLACEHOLDER_BACKTEST_MESSAGE,
  SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED,
  runSymbolCustomBacktest,
  getSymbolCustomBacktest,
  listSymbolCustomBacktests,
  deleteSymbolCustomBacktest,
};
