const RECOMMENDATION_TIERS = Object.freeze({
  LIVE_CANDIDATE: 'LIVE_CANDIDATE',
  PAPER_ONLY: 'PAPER_ONLY',
  REJECT: 'REJECT',
  INSUFFICIENT_SAMPLE: 'INSUFFICIENT_SAMPLE',
});

const WARNING_FLAGS = Object.freeze({
  VERY_SMALL_SAMPLE: 'VERY_SMALL_SAMPLE',
  LOW_EXPECTANCY: 'LOW_EXPECTANCY',
  HIGH_DRAWDOWN: 'HIGH_DRAWDOWN',
  PROFIT_CONCENTRATED: 'PROFIT_CONCENTRATED',
  AVG_LOSS_GT_AVG_WIN: 'AVG_LOSS_GT_AVG_WIN',
  HIGH_CONSECUTIVE_LOSSES: 'HIGH_CONSECUTIVE_LOSSES',
});

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getWarningFlags(summary = {}) {
  return Array.isArray(summary.warningFlags)
    ? summary.warningFlags.filter(Boolean).map((flag) => String(flag))
    : [];
}

function hasFlag(summary, flag) {
  return getWarningFlags(summary).includes(flag);
}

function getMaxDrawdownPercent(summary = {}) {
  if (summary.maxDrawdownPercent != null) return finiteNumber(summary.maxDrawdownPercent);
  return finiteNumber(summary.maxDrawdown);
}

function deriveSampleQuality(summary = {}) {
  if (summary.sampleQuality) return String(summary.sampleQuality).toUpperCase();
  const totalTrades = finiteNumber(summary.totalTrades);
  if (totalTrades < 30) return 'VERY_LOW';
  if (totalTrades < 50) return 'LOW';
  if (totalTrades < 100) return 'MEDIUM';
  return 'HIGH';
}

function isIndexOrCryptoSymbol(symbol) {
  const normalized = String(symbol || '').toUpperCase();
  return [
    'BTC',
    'ETH',
    'LTC',
    'XRP',
    'DOGE',
    'US30',
    'US500',
    'SPX',
    'SPX500',
    'NAS',
    'NAS100',
    'NDX',
    'GER40',
    'DAX',
    'UK100',
    'JP225',
    'HK50',
  ].some((token) => normalized.includes(token));
}

function roundRisk(value) {
  if (value == null) return null;
  return Number(value.toFixed(4));
}

function buildRiskNotes(summary = {}, context = {}) {
  const notes = [];
  if (hasFlag(summary, WARNING_FLAGS.PROFIT_CONCENTRATED)) {
    notes.push('Profit is concentrated in a small number of trades; forward validation is required.');
  }
  if (hasFlag(summary, WARNING_FLAGS.AVG_LOSS_GT_AVG_WIN)) {
    notes.push('Average loss is larger than average win; win rate must remain safely above breakeven.');
  }
  if (hasFlag(summary, WARNING_FLAGS.HIGH_DRAWDOWN) || getMaxDrawdownPercent(summary) > 15) {
    notes.push('Drawdown is elevated; use reduced risk until paper trading confirms stability.');
  }
  if (hasFlag(summary, WARNING_FLAGS.VERY_SMALL_SAMPLE) || finiteNumber(summary.totalTrades) < 30) {
    notes.push('Sample size is too small for live decision-making.');
  }
  if (hasFlag(summary, WARNING_FLAGS.LOW_EXPECTANCY) || finiteNumber(summary.expectancyPerTrade) <= 0) {
    notes.push('Expectancy is not positive, so the edge is not reliable.');
  }
  if (hasFlag(summary, WARNING_FLAGS.HIGH_CONSECUTIVE_LOSSES)) {
    notes.push('Consecutive loss streak risk is elevated.');
  }
  if (isIndexOrCryptoSymbol(context.symbol)) {
    notes.push('Index or crypto symbol detected; suggested risk is reduced due to higher volatility.');
  }
  return notes;
}

function shouldReject(summary = {}) {
  const profitFactor = finiteNumber(summary.profitFactor);
  const expectancy = finiteNumber(summary.expectancyPerTrade);
  const netProfit = finiteNumber(summary.netProfitMoney);
  const robustScore = finiteNumber(summary.robustScore);
  const drawdown = getMaxDrawdownPercent(summary);

  return profitFactor < 1
    || expectancy <= 0
    || netProfit <= 0
    || drawdown > 25
    || robustScore < 35;
}

function isLiveCandidate(summary = {}) {
  const totalTrades = finiteNumber(summary.totalTrades);
  const robustScore = finiteNumber(summary.robustScore);
  const profitFactor = finiteNumber(summary.profitFactor);
  const expectancy = finiteNumber(summary.expectancyPerTrade);
  const drawdown = getMaxDrawdownPercent(summary);

  return totalTrades >= 50
    && robustScore >= 70
    && profitFactor >= 1.3
    && expectancy > 0
    && drawdown <= 15
    && !hasFlag(summary, WARNING_FLAGS.VERY_SMALL_SAMPLE)
    && !hasFlag(summary, WARNING_FLAGS.LOW_EXPECTANCY)
    && !hasFlag(summary, WARNING_FLAGS.HIGH_DRAWDOWN);
}

function isStrongLiveCandidate(summary = {}) {
  return finiteNumber(summary.totalTrades) >= 100
    && finiteNumber(summary.robustScore) >= 85
    && finiteNumber(summary.profitFactor) >= 1.8
    && getMaxDrawdownPercent(summary) <= 10
    && getWarningFlags(summary).length === 0;
}

function getSuggestedRiskPerTrade(tier, summary = {}, context = {}) {
  if (tier === RECOMMENDATION_TIERS.INSUFFICIENT_SAMPLE || tier === RECOMMENDATION_TIERS.REJECT) {
    return null;
  }

  let risk = tier === RECOMMENDATION_TIERS.LIVE_CANDIDATE
    ? (isStrongLiveCandidate(summary) ? 0.005 : 0.0025)
    : 0.001;

  if (hasFlag(summary, WARNING_FLAGS.HIGH_DRAWDOWN) || getMaxDrawdownPercent(summary) > 15) {
    risk *= 0.5;
  }
  if (isIndexOrCryptoSymbol(context.symbol)) {
    risk *= 0.5;
  }

  return roundRisk(risk);
}

function buildOptimizerRecommendation(row = {}, context = {}) {
  const summary = row.summary || {};
  const totalTrades = finiteNumber(summary.totalTrades);
  const sampleQuality = deriveSampleQuality(summary);
  const reasons = [];

  let tier;
  if (totalTrades < 30) {
    tier = RECOMMENDATION_TIERS.INSUFFICIENT_SAMPLE;
    reasons.push('totalTrades is below 30, so the sample is not large enough for a paper/live decision.');
  } else if (shouldReject(summary)) {
    tier = RECOMMENDATION_TIERS.REJECT;
    if (finiteNumber(summary.profitFactor) < 1) reasons.push('profitFactor is below 1.');
    if (finiteNumber(summary.expectancyPerTrade) <= 0) reasons.push('expectancyPerTrade is not positive.');
    if (finiteNumber(summary.netProfitMoney) <= 0) reasons.push('netProfitMoney is not positive.');
    if (getMaxDrawdownPercent(summary) > 25) reasons.push('max drawdown is above 25%.');
    if (finiteNumber(summary.robustScore) < 35) reasons.push('robustScore is too low.');
  } else if (isLiveCandidate(summary)) {
    tier = RECOMMENDATION_TIERS.LIVE_CANDIDATE;
    reasons.push('Meets live-candidate thresholds for sample size, robustScore, profitFactor, expectancy, and drawdown.');
  } else {
    tier = RECOMMENDATION_TIERS.PAPER_ONLY;
    if (finiteNumber(summary.netProfitMoney) > 0 && finiteNumber(summary.profitFactor) > 1) {
      reasons.push('Profitable result, but it needs paper validation before live use.');
    }
    if (sampleQuality === 'LOW' || sampleQuality === 'MEDIUM') {
      reasons.push(`sampleQuality is ${sampleQuality}.`);
    }
    if (hasFlag(summary, WARNING_FLAGS.PROFIT_CONCENTRATED)) {
      reasons.push('warningFlags includes PROFIT_CONCENTRATED.');
    }
    if (hasFlag(summary, WARNING_FLAGS.AVG_LOSS_GT_AVG_WIN)) {
      reasons.push('warningFlags includes AVG_LOSS_GT_AVG_WIN.');
    }
    if (hasFlag(summary, WARNING_FLAGS.HIGH_DRAWDOWN) || getMaxDrawdownPercent(summary) > 15) {
      reasons.push('Drawdown is above the live-candidate threshold.');
    }
    if (reasons.length === 0) {
      reasons.push('Does not meet every live-candidate threshold yet.');
    }
  }

  const riskNotes = buildRiskNotes(summary, context);
  return {
    tier,
    reasons,
    riskNotes,
    suggestedRiskPerTrade: getSuggestedRiskPerTrade(tier, summary, context),
  };
}

function attachOptimizerRecommendations(results = [], context = {}) {
  return results.map((row) => ({
    ...row,
    recommendation: buildOptimizerRecommendation(row, context),
  }));
}

function buildRecommendationSummary(results = []) {
  const counts = {
    liveCandidateCount: 0,
    paperOnlyCount: 0,
    rejectCount: 0,
    insufficientSampleCount: 0,
  };

  results.forEach((row) => {
    const tier = row?.recommendation?.tier;
    if (tier === RECOMMENDATION_TIERS.LIVE_CANDIDATE) counts.liveCandidateCount += 1;
    else if (tier === RECOMMENDATION_TIERS.PAPER_ONLY) counts.paperOnlyCount += 1;
    else if (tier === RECOMMENDATION_TIERS.REJECT) counts.rejectCount += 1;
    else if (tier === RECOMMENDATION_TIERS.INSUFFICIENT_SAMPLE) counts.insufficientSampleCount += 1;
  });

  return {
    ...counts,
    topLiveCandidates: results
      .filter((row) => row?.recommendation?.tier === RECOMMENDATION_TIERS.LIVE_CANDIDATE)
      .slice(0, 5)
      .map((row) => ({
        parameters: row.parameters || {},
        summary: row.summary || {},
        recommendation: row.recommendation,
      })),
  };
}

module.exports = {
  RECOMMENDATION_TIERS,
  buildOptimizerRecommendation,
  attachOptimizerRecommendations,
  buildRecommendationSummary,
  deriveSampleQuality,
};
