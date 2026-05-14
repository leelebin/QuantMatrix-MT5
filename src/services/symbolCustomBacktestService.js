const SymbolCustom = require('../models/SymbolCustom');
const SymbolCustomBacktest = require('../models/SymbolCustomBacktest');
const { getSymbolCustomLogic } = require('../symbolCustom/registry');
const { PLACEHOLDER_SYMBOL_CUSTOM } = require('../symbolCustom/logics/PlaceholderSymbolCustom');
const symbolCustomBacktestRunnerService = require('./symbolCustomBacktestRunnerService');
const symbolCustomCandleProviderService = require('./symbolCustomCandleProviderService');

const SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED = 'SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED';
const SYMBOL_CUSTOM_BACKTEST_CANDLES_REQUIRED = 'SYMBOL_CUSTOM_BACKTEST_CANDLES_REQUIRED';
const {
  SYMBOL_CUSTOM_BACKTEST_DATE_RANGE_REQUIRED,
  SYMBOL_CUSTOM_BACKTEST_CANDLES_NOT_FOUND,
} = symbolCustomCandleProviderService;
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

function normalizeChartCandle(candle = {}) {
  return {
    time: candle.time || candle.timestamp || candle.date || null,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.volume ?? candle.tickVolume ?? 0),
  };
}

function buildSymbolCustomTradeEvents(trades = []) {
  return (Array.isArray(trades) ? trades : []).map((trade, index) => ({
    tradeId: trade.tradeId != null ? trade.tradeId : index + 1,
    direction: trade.side || trade.direction || '--',
    entryTime: trade.entryTime || null,
    entryPrice: trade.entryPrice,
    entryReason: trade.entryReason || '',
    setupReason: trade.entryReason || '',
    triggerReason: trade.logicName || '',
    exitTime: trade.exitTime || null,
    exitPrice: trade.exitPrice,
    exitReason: trade.exitReason || '',
    profitLoss: trade.pnl,
    profitPips: null,
    module: trade.logicName || 'SymbolCustom',
  }));
}

function buildSymbolCustomChartData({ symbolCustom, logicName, candles, trades, startDate, endDate }) {
  const entryCandles = candles && Array.isArray(candles.entry) ? candles.entry : [];
  if (!entryCandles.length) return null;
  return {
    source: 'symbolCustom',
    symbol: symbolCustom.symbol,
    strategy: symbolCustom.symbolCustomName,
    logicName,
    effectiveTimeframe: symbolCustom.timeframes?.entryTimeframe || '--',
    period: {
      start: startDate,
      end: endDate,
    },
    candles: entryCandles.map(normalizeChartCandle),
    panels: [
      { kind: 'price', title: 'Price', series: [], referenceLines: [] },
    ],
    tradeEvents: buildSymbolCustomTradeEvents(trades),
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

async function resolveBacktestCandles({
  symbolCustom,
  startDate,
  endDate,
  candles,
  candleProvider,
  options = {},
}) {
  if (hasUsableCandles(candles)) {
    return { candles, source: 'body' };
  }

  const useHistoricalCandles = options.useHistoricalCandles !== false;
  if (!useHistoricalCandles) {
    return { candles: null, source: 'disabled' };
  }

  if (!startDate || !endDate) {
    throw buildHttpError(SYMBOL_CUSTOM_BACKTEST_DATE_RANGE_REQUIRED, 400, [
      { field: 'startDate', message: 'startDate is required when using historical candles' },
      { field: 'endDate', message: 'endDate is required when using historical candles' },
    ]);
  }

  const provider = typeof candleProvider === 'function'
    ? candleProvider
    : symbolCustomCandleProviderService.buildCandleProviderForSymbolCustom(symbolCustom);

  const provided = await provider({
    symbol: symbolCustom.symbol,
    timeframes: symbolCustom.timeframes || {},
    startDate,
    endDate,
    limit: options.limit,
  });
  if (hasUsableCandles(provided)) {
    return {
      candles: provided,
      source: typeof candleProvider === 'function' ? 'injectedProvider' : 'historicalProvider',
    };
  }

  return {
    candles: null,
    source: typeof candleProvider === 'function' ? 'injectedProvider' : 'historicalProvider',
  };
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
  chartData,
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
    chartData,
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

  const resolved = await resolveBacktestCandles({
    symbolCustom,
    startDate,
    endDate,
    candles,
    candleProvider,
    options,
  });

  if (!resolved.candles) {
    if (resolved.source === 'historicalProvider' || resolved.source === 'injectedProvider') {
      throw buildHttpError(SYMBOL_CUSTOM_BACKTEST_CANDLES_NOT_FOUND, 400, [
        { field: 'candles', message: SYMBOL_CUSTOM_BACKTEST_CANDLES_NOT_FOUND },
      ]);
    }

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
      candles: resolved.candles,
      parameters: mergedParameters,
      costModel: costModel || {},
      initialBalance,
      options: options || {},
    });
    const chartData = buildSymbolCustomChartData({
      symbolCustom,
      logicName,
      candles: resolved.candles,
      trades: simulation.trades,
      startDate,
      endDate,
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
      chartData,
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
  SYMBOL_CUSTOM_BACKTEST_DATE_RANGE_REQUIRED,
  SYMBOL_CUSTOM_BACKTEST_CANDLES_NOT_FOUND,
  runSymbolCustomBacktest,
  getSymbolCustomBacktest,
  listSymbolCustomBacktests,
  deleteSymbolCustomBacktest,
};
