const SymbolCustom = require('../models/SymbolCustom');
const { PLACEHOLDER_SYMBOL_CUSTOM } = require('../symbolCustom/logics/PlaceholderSymbolCustom');
const symbolCustomBacktestService = require('./symbolCustomBacktestService');
const symbolCustomEvaluationService = require('./symbolCustomEvaluationService');

const DEFAULT_GUARDRAIL_PRESETS = Object.freeze([
  Object.freeze({ presetName: 'baseline', parameters: Object.freeze({}) }),
  Object.freeze({ presetName: 'buy_only', parameters: Object.freeze({ enableBuy: true, enableSell: false }) }),
  Object.freeze({ presetName: 'sell_only', parameters: Object.freeze({ enableBuy: false, enableSell: true }) }),
  Object.freeze({
    presetName: 'session_best_probe',
    parameters: Object.freeze({
      allowedUtcHours: '23,0,1,7,8,9,10',
      enableBuy: true,
      enableSell: true,
    }),
  }),
  Object.freeze({
    presetName: 'block_bad_hours_probe',
    parameters: Object.freeze({
      blockedUtcHours: '4,6,15,17',
      enableBuy: true,
      enableSell: true,
    }),
  }),
  Object.freeze({
    presetName: 'cooldown_light',
    parameters: Object.freeze({
      cooldownBarsAfterAnyExit: 6,
      cooldownBarsAfterSL: 12,
    }),
  }),
  Object.freeze({
    presetName: 'cooldown_strict',
    parameters: Object.freeze({
      cooldownBarsAfterAnyExit: 12,
      cooldownBarsAfterSL: 24,
    }),
  }),
  Object.freeze({
    presetName: 'daily_guard',
    parameters: Object.freeze({
      maxDailyLosses: 3,
      maxDailyTrades: 6,
    }),
  }),
  Object.freeze({
    presetName: 'combined_conservative',
    parameters: Object.freeze({
      allowedUtcHours: '23,0,1,7,8,9,10',
      cooldownBarsAfterAnyExit: 6,
      cooldownBarsAfterSL: 18,
      maxDailyLosses: 3,
      maxDailyTrades: 6,
      enableBuy: true,
      enableSell: true,
    }),
  }),
  Object.freeze({
    presetName: 'buy_session_conservative',
    parameters: Object.freeze({
      enableBuy: true,
      enableSell: false,
      allowedUtcHours: '23,0,1,7,8,9,10',
      cooldownBarsAfterAnyExit: 6,
      cooldownBarsAfterSL: 18,
      maxDailyLosses: 3,
      maxDailyTrades: 6,
    }),
  }),
  Object.freeze({
    presetName: 'sell_session_conservative',
    parameters: Object.freeze({
      enableBuy: false,
      enableSell: true,
      allowedUtcHours: '23,0,1,7,8,9,10',
      cooldownBarsAfterAnyExit: 6,
      cooldownBarsAfterSL: 18,
      maxDailyLosses: 3,
      maxDailyTrades: 6,
    }),
  }),
]);

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

function normalizePreset(preset = {}, index = 0) {
  return {
    presetName: String(preset.presetName || preset.name || `preset_${index + 1}`).trim(),
    parameters: cloneValue(preset.parameters || {}),
  };
}

function normalizePresets(presets) {
  const source = Array.isArray(presets) && presets.length > 0
    ? presets
    : DEFAULT_GUARDRAIL_PRESETS;
  return source.map(normalizePreset).filter((preset) => preset.presetName);
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

function scorePreset(summary = {}, evaluation = {}) {
  const profitFactor = summary.profitFactor == null ? null : toNumber(summary.profitFactor, null);
  const avgR = summary.avgR == null ? null : toNumber(summary.avgR, null);
  const maxDrawdownPercent = summary.maxDrawdownPercent == null ? null : toNumber(summary.maxDrawdownPercent, null);
  const trades = toNumber(summary.trades, 0);
  const mediumCostNetPnl = getMediumCostNetPnl(evaluation);
  let score = 0;

  if (profitFactor != null && profitFactor >= 1.2) score += 3;
  if (avgR != null && avgR > 0.1) score += 2;
  if (maxDrawdownPercent != null && maxDrawdownPercent < 30) score += 2;
  if (trades >= 100 && trades <= 1200) score += 2;
  if (mediumCostNetPnl != null && mediumCostNetPnl > 0) score += 2;

  if (profitFactor == null || profitFactor < 1.05) score -= 3;
  if (maxDrawdownPercent != null && maxDrawdownPercent > 30) score -= 3;
  if (trades > 2000) score -= 2;
  if (mediumCostNetPnl != null && mediumCostNetPnl < 0) score -= 2;

  return score;
}

function recommendPreset(summary = {}, evaluation = {}, score = 0) {
  const profitFactor = summary.profitFactor == null ? null : toNumber(summary.profitFactor, null);
  const maxDrawdownPercent = summary.maxDrawdownPercent == null ? null : toNumber(summary.maxDrawdownPercent, null);
  const trades = toNumber(summary.trades, 0);
  const netPnl = toNumber(summary.netPnl, 0);
  const mediumCostNetPnl = getMediumCostNetPnl(evaluation);

  if (trades > 0 && mediumCostNetPnl != null && netPnl > 0 && mediumCostNetPnl < 0) {
    return 'REJECT_COST_FRAGILE';
  }
  if (maxDrawdownPercent != null && maxDrawdownPercent > 30) {
    return 'REJECT_DRAWDOWN_TOO_HIGH';
  }
  if (profitFactor == null || profitFactor < 1.05) {
    return 'REJECT_NO_EDGE';
  }
  if (trades > 0 && trades < 100) {
    return 'NEEDS_MORE_DATA';
  }
  if (score >= 5) {
    return 'PROMISING_FILTER';
  }
  return 'KEEP_TESTING';
}

function buildConclusion(results = []) {
  if (!results.length) {
    return {
      recommendation: 'REJECT_NO_EDGE',
      message: 'No runnable guardrail preset comparison results were produced.',
      bestPresetName: null,
    };
  }

  const bestPreset = results[0];
  const promising = results
    .filter((result) => ['PROMISING_FILTER', 'KEEP_TESTING'].includes(result.recommendation))
    .map((result) => result.presetName);

  return {
    recommendation: bestPreset.recommendation,
    bestPresetName: bestPreset.presetName,
    message: promising.length > 0
      ? `Best preset is ${bestPreset.presetName}; keep reviewing ${promising.join(', ')}.`
      : `Best preset is ${bestPreset.presetName}, but no preset cleared the current research guardrails.`,
    keepTestingPresets: promising,
  };
}

async function runSymbolCustomPresetComparison({
  symbolCustomId,
  startDate,
  endDate,
  initialBalance = 500,
  costModel,
  presets,
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
  if (logicName === PLACEHOLDER_SYMBOL_CUSTOM) {
    return {
      symbol: symbolCustom.symbol,
      symbolCustomName: symbolCustom.symbolCustomName,
      logicName,
      startDate,
      endDate,
      results: [],
      bestPreset: null,
      conclusion: {
        recommendation: 'REJECT_NO_EDGE',
        reasonCode: PLACEHOLDER_SYMBOL_CUSTOM,
        message: 'Placeholder SymbolCustom has no active backtest logic for preset comparison.',
      },
    };
  }

  const normalizedPresets = normalizePresets(presets);
  const results = [];

  for (const preset of normalizedPresets) {
    const backtest = await symbolCustomBacktestService.runSymbolCustomBacktest({
      symbolCustomId,
      startDate,
      endDate,
      initialBalance,
      costModel: cloneValue(costModel || {}),
      parameters: cloneValue(preset.parameters || {}),
      options: {
        useHistoricalCandles: true,
        presetComparison: true,
        presetName: preset.presetName,
      },
    });
    const evaluation = symbolCustomEvaluationService.evaluateSymbolCustomBacktest(backtest);
    const summary = normalizeSummary(backtest.summary || {}, toNumber(backtest.initialBalance ?? initialBalance, 0));
    const score = scorePreset(summary, evaluation);

    results.push({
      presetName: preset.presetName,
      parameters: cloneValue(preset.parameters || {}),
      summary,
      evaluation,
      score,
      recommendation: recommendPreset(summary, evaluation, score),
      backtestId: backtest._id || null,
      status: backtest.status || null,
      message: backtest.message || null,
    });
  }

  results.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return (right.summary?.profitFactor || 0) - (left.summary?.profitFactor || 0);
  });

  const bestPreset = results[0] || null;

  return {
    symbol: symbolCustom.symbol,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName,
    startDate,
    endDate,
    results,
    bestPreset: bestPreset
      ? {
        presetName: bestPreset.presetName,
        score: bestPreset.score,
        recommendation: bestPreset.recommendation,
        summary: bestPreset.summary,
      }
      : null,
    conclusion: buildConclusion(results),
  };
}

module.exports = {
  DEFAULT_GUARDRAIL_PRESETS,
  runSymbolCustomPresetComparison,
  _internals: {
    normalizePresets,
    normalizeSummary,
    recommendPreset,
    scorePreset,
  },
};
