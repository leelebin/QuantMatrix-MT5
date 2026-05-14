const SymbolCustom = require('../models/SymbolCustom');
const SymbolCustomBacktest = require('../models/SymbolCustomBacktest');
const { getSymbolCustomLogic } = require('../symbolCustom/registry');
const { PLACEHOLDER_SYMBOL_CUSTOM } = require('../symbolCustom/logics/PlaceholderSymbolCustom');
const symbolCustomBacktestRunnerService = require('./symbolCustomBacktestRunnerService');

const SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED = 'SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED';
const SYMBOL_CUSTOM_BACKTEST_CANDLES_REQUIRED = 'SYMBOL_CUSTOM_BACKTEST_CANDLES_REQUIRED';
const PHASE_1_PLACEHOLDER_BACKTEST_MESSAGE = 'Placeholder SymbolCustom has no active backtest logic';

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
    wins: 0,
    losses: 0,
    netPnl: 0,
    grossWin: 0,
    grossLoss: 0,
    profitFactor: null,
    winRate: null,
    avgR: null,
    maxDrawdown: 0,
    maxSingleLoss: 0,
    maxWin: 0,
    rejectedSignals: 0,
  };
}

function resolveLogicName(symbolCustom = {}) {
  return String(symbolCustom.logicName || symbolCustom.registryLogicName || symbolCustom.symbolCustomName || '').trim();
}

function hasUsableCandles(candles = {}) {
  return Boolean(candles)
    && typeof candles === 'object'
    && !Array.isArray(candles)
    && Array.isArray(candles.entry)
    && candles.entry.length > 0;
}

async function resolveBacktestCandles({ symbolCustom, startDate, endDate, candles, candleProvider }) {
  if (hasUsableCandles(candles)) {
    return candles;
  }

  if (typeof candleProvider === 'function') {
    const provided = await candleProvider({
      symbol: symbolCustom.symbol,
      timeframes: symbolCustom.timeframes || {},
      startDate,
      endDate,
    });
    if (hasUsableCandles(provided)) {
      return provided;
    }
  }

  return null;
}

function buildBacktestPayload({
  symbolCustom,
  logicName,
  status,
  startDate,
  endDate,
  initialBalance,
  finalBalance,
  parameters,
  costModel,
  costModelUsed,
  summary,
  trades,
  equityCurve,
  message,
  error = null,
}) {
  return {
    symbol: symbolCustom.symbol,
    symbolCustomId: symbolCustom._id,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName,
    mode: 'symbolCustom',
    status,
    startDate,
    endDate,
    initialBalance,
    finalBalance,
    timeframes: symbolCustom.timeframes || {},
    parameters,
    costModel,
    costModelUsed: costModelUsed || costModel || {},
    summary,
    trades,
    equityCurve,
    message,
    error,
    completedAt: new Date(),
  };
}

async function runSymbolCustomBacktest({
  symbolCustomId,
  startDate,
  endDate,
  initialBalance,
  parameters,
  costModel,
  candles,
  candleProvider,
  options,
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
      ...buildBacktestPayload({
        symbolCustom,
        logicName,
        status: 'stub',
        startDate,
        endDate,
        initialBalance,
        finalBalance: initialBalance ?? null,
        parameters: parameters || symbolCustom.parameters || {},
        costModel: costModel || {},
        costModelUsed: costModel || {},
        summary: buildZeroSummary(),
        trades: [],
        equityCurve: [],
        message: PHASE_1_PLACEHOLDER_BACKTEST_MESSAGE,
      }),
    });
  }

  const resolvedCandles = await resolveBacktestCandles({
    symbolCustom,
    startDate,
    endDate,
    candles,
    candleProvider,
  });
  if (!resolvedCandles) {
    throw buildHttpError(SYMBOL_CUSTOM_BACKTEST_CANDLES_REQUIRED, 400, [
      { field: 'candles', message: 'candles.entry or candleProvider is required for non-placeholder SymbolCustom backtests' },
    ]);
  }

  try {
    const mergedParameters = {
      ...(symbolCustom.parameters || {}),
      ...(parameters || {}),
    };
    const simulation = await symbolCustomBacktestRunnerService.runSymbolCustomBacktestSimulation({
      symbolCustom,
      logic,
      logicName,
      candles: resolvedCandles,
      parameters: mergedParameters,
      costModel: costModel || {},
      initialBalance,
      options: options || {},
    });

    return SymbolCustomBacktest.create(buildBacktestPayload({
      symbolCustom,
      logicName,
      status: simulation.status,
      startDate,
      endDate,
      initialBalance: simulation.initialBalance,
      finalBalance: simulation.finalBalance,
      parameters: mergedParameters,
      costModel: simulation.costModelUsed,
      costModelUsed: simulation.costModelUsed,
      summary: simulation.summary,
      trades: simulation.trades,
      equityCurve: simulation.equityCurve,
      message: simulation.message,
    }));
  } catch (error) {
    return SymbolCustomBacktest.create(buildBacktestPayload({
      symbolCustom,
      logicName,
      status: 'failed',
      startDate,
      endDate,
      initialBalance,
      finalBalance: initialBalance ?? null,
      parameters: parameters || symbolCustom.parameters || {},
      costModel: costModel || {},
      costModelUsed: costModel || {},
      summary: buildZeroSummary(),
      trades: [],
      equityCurve: [],
      message: 'SymbolCustom backtest failed',
      error: error.message,
    }));
  }
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
  SYMBOL_CUSTOM_BACKTEST_CANDLES_REQUIRED,
  runSymbolCustomBacktest,
  getSymbolCustomBacktest,
  listSymbolCustomBacktests,
  deleteSymbolCustomBacktest,
};
