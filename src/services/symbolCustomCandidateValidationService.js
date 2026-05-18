const SymbolCustom = require('../models/SymbolCustom');
const { PLACEHOLDER_SYMBOL_CUSTOM } = require('../symbolCustom/logics/PlaceholderSymbolCustom');
const symbolCustomBacktestService = require('./symbolCustomBacktestService');
const symbolCustomEvaluationService = require('./symbolCustomEvaluationService');

const DEFAULT_VALIDATION_WINDOWS = Object.freeze([
  Object.freeze({ label: '2M', startDate: '2026-03-15', endDate: '2026-05-15' }),
  Object.freeze({ label: '4M', startDate: '2026-01-15', endDate: '2026-05-15' }),
  Object.freeze({ label: '8M', startDate: '2025-09-15', endDate: '2026-05-15' }),
  Object.freeze({ label: '12M', startDate: '2025-05-15', endDate: '2026-05-15' }),
]);

const DEFAULT_BUY_SESSION_CONSERVATIVE_PARAMETERS = Object.freeze({
  enableBuy: true,
  enableSell: false,
  allowedUtcHours: '23,0,1,7,8,9,10',
  cooldownBarsAfterAnyExit: 6,
  cooldownBarsAfterSL: 18,
  maxDailyLosses: 3,
  maxDailyTrades: 6,
});

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function buildHttpError(message, statusCode, reasonCode, details = undefined) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.reasonCode = reasonCode;
  if (details) error.details = details;
  return error;
}

function resolveLogicName(symbolCustom = {}) {
  return String(symbolCustom.logicName || symbolCustom.registryLogicName || symbolCustom.symbolCustomName || '').trim();
}

function normalizeWindows(windows) {
  const source = Array.isArray(windows) && windows.length > 0 ? windows : DEFAULT_VALIDATION_WINDOWS;
  return source
    .map((window, index) => ({
      label: String(window.label || `W${index + 1}`).trim(),
      startDate: window.startDate,
      endDate: window.endDate,
    }))
    .filter((window) => window.label && window.startDate && window.endDate);
}

function normalizeSummary(summary = {}, initialBalance = 0) {
  const maxDrawdown = toNumber(summary.maxDrawdown, 0);
  const maxDrawdownPercent = summary.maxDrawdownPercent != null
    ? toNumber(summary.maxDrawdownPercent, 0)
    : (initialBalance > 0 ? (maxDrawdown / initialBalance) * 100 : null);

  return {
    ...summary,
    trades: toNumber(summary.trades != null ? summary.trades : summary.totalTrades, 0),
    netPnl: toNumber(summary.netPnl != null ? summary.netPnl : summary.netProfitMoney, 0),
    profitFactor: summary.profitFactor == null ? null : toNumber(summary.profitFactor, null),
    winRate: summary.winRate == null ? null : toNumber(summary.winRate, null),
    avgR: summary.avgR == null ? null : toNumber(summary.avgR, null),
    maxDrawdown,
    maxDrawdownPercent,
  };
}

function getMediumCostNetPnl(evaluation = {}) {
  return evaluation.costSensitivity?.mediumCost?.netPnlAfterCost == null
    ? null
    : toNumber(evaluation.costSensitivity.mediumCost.netPnlAfterCost, null);
}

function classifyWindow(summary = {}, evaluation = {}) {
  const trades = toNumber(summary.trades, 0);
  const profitFactor = summary.profitFactor == null ? null : toNumber(summary.profitFactor, null);
  const avgR = summary.avgR == null ? null : toNumber(summary.avgR, null);
  const maxDrawdownPercent = summary.maxDrawdownPercent == null ? null : toNumber(summary.maxDrawdownPercent, null);
  const mediumCostNetPnl = getMediumCostNetPnl(evaluation);
  const reasons = [];

  if (profitFactor == null || profitFactor < 1.10) reasons.push('PF_BELOW_1_10');
  if (avgR == null || avgR <= 0) reasons.push('AVGR_NOT_POSITIVE');
  if (maxDrawdownPercent != null && maxDrawdownPercent > 35) reasons.push('DRAWDOWN_ABOVE_35');
  if (mediumCostNetPnl == null || mediumCostNetPnl <= 0) reasons.push('MEDIUM_COST_NOT_PROFITABLE');
  if (trades < 30) reasons.push('INSUFFICIENT_TRADES');

  const pass = profitFactor != null && profitFactor >= 1.20
    && avgR != null && avgR >= 0.10
    && (maxDrawdownPercent == null || maxDrawdownPercent <= 30)
    && mediumCostNetPnl != null && mediumCostNetPnl > 0
    && trades >= 30;

  return {
    status: pass ? 'PASS' : 'FAIL',
    reason: pass ? 'PASS_RULES_MET' : reasons.join(', '),
    reasons,
    mediumCostNetPnl,
  };
}

function buildOverallRecommendation(windows = []) {
  if (!windows.length) return 'NEEDS_MORE_DATA';

  if (windows.some((window) => toNumber(window.maxDrawdownPercent, 0) > 35)) {
    return 'REJECT_DRAWDOWN_TOO_HIGH';
  }

  if (windows.some((window) => window.mediumCostNetPnl == null || toNumber(window.mediumCostNetPnl, 0) <= 0)) {
    return 'REJECT_COST_FRAGILE';
  }

  const passCount = windows.filter((window) => window.validationStatus === 'PASS').length;
  const failCount = windows.length - passCount;

  if (failCount === 0) return 'VALIDATION_PASSED';
  if (passCount > 0) return 'NEEDS_MORE_DATA';
  return 'REJECT_UNSTABLE';
}

async function runSymbolCustomCandidateValidation({
  symbolCustomId,
  candidateName = 'buy_session_conservative',
  candidateParameters = DEFAULT_BUY_SESSION_CONSERVATIVE_PARAMETERS,
  windows,
  initialBalance = 500,
  costModel,
} = {}) {
  if (!symbolCustomId) {
    throw buildHttpError('symbolCustomId is required', 400, 'SYMBOL_CUSTOM_ID_REQUIRED', [
      { field: 'symbolCustomId', message: 'Required' },
    ]);
  }

  const symbolCustom = await SymbolCustom.findById(symbolCustomId);
  if (!symbolCustom) {
    throw buildHttpError('SymbolCustom not found', 404, 'SYMBOL_CUSTOM_NOT_FOUND');
  }

  const logicName = resolveLogicName(symbolCustom);
  const normalizedCandidateParameters = cloneValue(candidateParameters || {});
  const normalizedWindows = normalizeWindows(windows);

  if (logicName === PLACEHOLDER_SYMBOL_CUSTOM) {
    return {
      symbol: symbolCustom.symbol,
      symbolCustomName: symbolCustom.symbolCustomName,
      logicName,
      candidateName,
      candidateParameters: normalizedCandidateParameters,
      windows: [],
      passCount: 0,
      failCount: 0,
      overallRecommendation: 'REJECT_UNSTABLE',
      conclusion: {
        reasonCode: PLACEHOLDER_SYMBOL_CUSTOM,
        message: 'Placeholder SymbolCustom has no active backtest logic for candidate validation.',
      },
    };
  }

  const results = [];
  for (const window of normalizedWindows) {
    const backtest = await symbolCustomBacktestService.runSymbolCustomBacktest({
      symbolCustomId,
      startDate: window.startDate,
      endDate: window.endDate,
      initialBalance,
      costModel: cloneValue(costModel || {}),
      parameters: cloneValue(normalizedCandidateParameters),
      options: {
        useHistoricalCandles: true,
        candidateValidation: true,
        candidateName,
        validationWindow: window.label,
      },
    });

    const evaluation = symbolCustomEvaluationService.evaluateSymbolCustomBacktest(backtest);
    const summary = normalizeSummary(backtest.summary || {}, toNumber(backtest.initialBalance ?? initialBalance, 0));
    const classification = classifyWindow(summary, evaluation);

    results.push({
      label: window.label,
      startDate: window.startDate,
      endDate: window.endDate,
      trades: summary.trades,
      netPnl: summary.netPnl,
      profitFactor: summary.profitFactor,
      winRate: summary.winRate,
      avgR: summary.avgR,
      maxDrawdownPercent: summary.maxDrawdownPercent,
      mediumCostNetPnl: classification.mediumCostNetPnl,
      validationStatus: classification.status,
      reason: classification.reason,
      reasons: classification.reasons,
      recommendation: evaluation.recommendation,
      monthlyBreakdown: evaluation.monthlyBreakdown || {},
      directionBreakdown: evaluation.directionBreakdown || {},
      exitReasonBreakdown: evaluation.exitReasonBreakdown || {},
      summary,
      evaluation,
      backtestId: backtest._id || null,
      status: backtest.status || null,
      message: backtest.message || null,
    });
  }

  const passCount = results.filter((window) => window.validationStatus === 'PASS').length;
  const failCount = results.length - passCount;

  return {
    symbol: symbolCustom.symbol,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName,
    candidateName,
    candidateParameters: normalizedCandidateParameters,
    windows: results,
    passCount,
    failCount,
    overallRecommendation: buildOverallRecommendation(results),
  };
}

module.exports = {
  DEFAULT_BUY_SESSION_CONSERVATIVE_PARAMETERS,
  DEFAULT_VALIDATION_WINDOWS,
  runSymbolCustomCandidateValidation,
  _internals: {
    buildOverallRecommendation,
    classifyWindow,
    normalizeSummary,
    normalizeWindows,
  },
};
