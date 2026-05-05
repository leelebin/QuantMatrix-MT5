const DEFAULT_OPTIMIZER_OBJECTIVE = 'profitFactor';

const OPTIMIZER_OBJECTIVES = Object.freeze({
  profitFactor: { summaryKey: 'profitFactor', label: 'Profit Factor' },
  sharpeRatio: { summaryKey: 'sharpeRatio', label: 'Sharpe Ratio' },
  returnPercent: { summaryKey: 'returnPercent', label: 'Return %' },
  returnPct: { summaryKey: 'returnPercent', label: 'Return %', alias: true },
  winRate: { summaryKey: 'winRate', label: 'Win Rate' },
  robustScore: { summaryKey: 'robustScore', label: 'Robust Score' },
  returnToDrawdown: { summaryKey: 'returnToDrawdown', label: 'Return / Drawdown' },
  expectancyPerTrade: { summaryKey: 'expectancyPerTrade', label: 'Expectancy / Trade' },
  avgRealizedR: { summaryKey: 'avgRealizedR', label: 'Average Realized R' },
  medianRealizedR: { summaryKey: 'medianRealizedR', label: 'Median Realized R' },
});

const DEFAULT_OPTIMIZER_MINIMUM_TRADES = 30;
const MIN_OPTIMIZER_MINIMUM_TRADES = 5;
const MAX_OPTIMIZER_MINIMUM_TRADES = 500;
const MINIMUM_TRADES_WARNING_MESSAGE =
  'minimumTrades below recommended threshold; results may be sample-sensitive';

function buildBadRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function getOptimizerObjectiveKeys() {
  return Object.keys(OPTIMIZER_OBJECTIVES);
}

function normalizeOptimizerObjective(value = DEFAULT_OPTIMIZER_OBJECTIVE) {
  const requestedKey = value == null || value === ''
    ? DEFAULT_OPTIMIZER_OBJECTIVE
    : String(value).trim();
  const objective = OPTIMIZER_OBJECTIVES[requestedKey];

  if (!objective) {
    throw buildBadRequest(
      `Invalid optimizeFor: ${requestedKey}. Allowed: ${getOptimizerObjectiveKeys().join(', ')}`
    );
  }

  return {
    requestedKey,
    key: objective.summaryKey,
    summaryKey: objective.summaryKey,
    label: objective.label,
    alias: Boolean(objective.alias),
  };
}

function normalizeOptimizerMinimumTrades(value = DEFAULT_OPTIMIZER_MINIMUM_TRADES) {
  if (value == null || value === '') {
    return DEFAULT_OPTIMIZER_MINIMUM_TRADES;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw buildBadRequest('minimumTrades must be a positive integer');
  }

  if (parsed < MIN_OPTIMIZER_MINIMUM_TRADES || parsed > MAX_OPTIMIZER_MINIMUM_TRADES) {
    throw buildBadRequest(
      `minimumTrades must be between ${MIN_OPTIMIZER_MINIMUM_TRADES} and ${MAX_OPTIMIZER_MINIMUM_TRADES}`
    );
  }

  return parsed;
}

function buildMinimumTradesWarning(minimumTrades) {
  return minimumTrades < DEFAULT_OPTIMIZER_MINIMUM_TRADES
    ? MINIMUM_TRADES_WARNING_MESSAGE
    : null;
}

module.exports = {
  DEFAULT_OPTIMIZER_OBJECTIVE,
  OPTIMIZER_OBJECTIVES,
  DEFAULT_OPTIMIZER_MINIMUM_TRADES,
  MIN_OPTIMIZER_MINIMUM_TRADES,
  MAX_OPTIMIZER_MINIMUM_TRADES,
  MINIMUM_TRADES_WARNING_MESSAGE,
  getOptimizerObjectiveKeys,
  normalizeOptimizerObjective,
  normalizeOptimizerMinimumTrades,
  buildMinimumTradesWarning,
};
