const CANDIDATE_BUCKETS = Object.freeze({
  LIVE_CANDIDATE: 'LIVE_CANDIDATE',
  PAPER_ONLY: 'PAPER_ONLY',
  REJECT: 'REJECT',
});

const COST_STRESS_SCENARIOS = Object.freeze([
  { name: 'default', multipliers: Object.freeze({ spread: 1, slippage: 1, commission: 1 }) },
  { name: 'spread_x1_5', multipliers: Object.freeze({ spread: 1.5, slippage: 1, commission: 1 }) },
  { name: 'slippage_x2', multipliers: Object.freeze({ spread: 1, slippage: 2, commission: 1 }) },
  { name: 'commission_x2', multipliers: Object.freeze({ spread: 1, slippage: 1, commission: 2 }) },
]);

const HIGH_COST_SYMBOLS = new Set([
  'XAUUSD',
  'XAGUSD',
  'US30',
  'NAS100',
  'SPX500',
  'XTIUSD',
  'XBRUSD',
  'BTCUSD',
  'ETHUSD',
]);

const REJECT_PROFIT_CONCENTRATION_TOP1 = 0.75;
const LIVE_PROFIT_CONCENTRATION_TOP1 = 0.5;

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function nullableNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function round(value, digits = 4) {
  return Number(finiteNumber(value).toFixed(digits));
}

function summaryOf(row = {}) {
  return row.summary || row;
}

function getWarningFlags(summary = {}) {
  return Array.isArray(summary.warningFlags)
    ? summary.warningFlags.filter(Boolean).map((flag) => String(flag))
    : [];
}

function hasFlag(summary, flag) {
  return getWarningFlags(summary).includes(flag);
}

function isHighCostSymbol(symbol) {
  return HIGH_COST_SYMBOLS.has(String(symbol || '').toUpperCase());
}

function getSuggestedRiskPerTrade(bucket, summary = {}, context = {}) {
  if (bucket === CANDIDATE_BUCKETS.REJECT) return null;

  const symbol = String(context.symbol || '').toUpperCase();
  let risk = bucket === CANDIDATE_BUCKETS.LIVE_CANDIDATE ? 0.0025 : 0.001;

  if (
    bucket === CANDIDATE_BUCKETS.LIVE_CANDIDATE
    && finiteNumber(summary.totalTrades) >= 100
    && finiteNumber(summary.robustScore) >= 85
    && finiteNumber(summary.profitFactor) >= 1.8
    && finiteNumber(summary.maxDrawdownPercent) <= 10
  ) {
    risk = 0.005;
  }

  if (isHighCostSymbol(symbol)) risk *= 0.5;
  if (finiteNumber(summary.maxDrawdownPercent) > 15 || hasFlag(summary, 'HIGH_DRAWDOWN')) {
    risk *= 0.5;
  }

  return round(risk, 4);
}

function buildCostStressScenarios(baseCostModel = {}) {
  const base = { ...(baseCostModel || {}) };
  return COST_STRESS_SCENARIOS.map((scenario) => {
    const costModel = { ...base };
    if (costModel.spreadPips != null) {
      costModel.spreadPips = finiteNumber(costModel.spreadPips) * scenario.multipliers.spread;
    }
    if (costModel.slippagePips != null) {
      costModel.slippagePips = finiteNumber(costModel.slippagePips) * scenario.multipliers.slippage;
    }
    if (costModel.commissionPerLot != null) {
      costModel.commissionPerLot = finiteNumber(costModel.commissionPerLot) * scenario.multipliers.commission;
    }
    return {
      name: scenario.name,
      costModel,
      multipliers: { ...scenario.multipliers },
    };
  });
}

function costScenarioPasses(summary = {}) {
  return finiteNumber(summary.netProfitMoney) > 0
    && finiteNumber(summary.profitFactor) >= 1
    && finiteNumber(summary.expectancyPerTrade) > 0
    && finiteNumber(summary.robustScore) >= 35
    && finiteNumber(summary.maxDrawdownPercent) <= 25
    && finiteNumber(summary.maxConsecutiveLosses) <= 6;
}

function evaluateCostStressResults(scenarios = [], context = {}) {
  const normalized = (Array.isArray(scenarios) ? scenarios : []).map((scenario) => {
    const summary = scenario.summary || scenario;
    const passed = scenario.passed != null ? Boolean(scenario.passed) : costScenarioPasses(summary);
    return {
      ...scenario,
      passed,
      summary,
      netProfitMoney: nullableNumber(summary.netProfitMoney),
      profitFactor: nullableNumber(summary.profitFactor),
      expectancyPerTrade: nullableNumber(summary.expectancyPerTrade),
      robustScore: nullableNumber(summary.robustScore),
      maxDrawdownPercent: nullableNumber(summary.maxDrawdownPercent),
      maxConsecutiveLosses: nullableNumber(summary.maxConsecutiveLosses),
    };
  });

  const missing = COST_STRESS_SCENARIOS
    .map((scenario) => scenario.name)
    .filter((name) => !normalized.some((scenario) => scenario.name === name));
  const failedScenarios = normalized.filter((scenario) => !scenario.passed).map((scenario) => scenario.name);
  const passed = normalized.length > 0 && missing.length === 0 && failedScenarios.length === 0;
  const defaultScenario = normalized.find((scenario) => scenario.name === 'default');
  const allScenariosNetNegative = normalized.length > 0
    && normalized.every((scenario) => finiteNumber(scenario.netProfitMoney) <= 0);

  const reasons = [];
  if (missing.length) reasons.push(`Missing cost stress scenarios: ${missing.join(', ')}.`);
  if (failedScenarios.length) reasons.push(`Cost stress failed scenarios: ${failedScenarios.join(', ')}.`);
  if (isHighCostSymbol(context.symbol) && !passed) {
    reasons.push('High-volatility/high-cost symbol must pass cost stress before live consideration.');
  }

  return {
    passed,
    scenarios: normalized,
    missingScenarios: missing,
    failedScenarios,
    defaultScenarioPassed: defaultScenario ? defaultScenario.passed : false,
    allScenariosNetNegative,
    reasons,
  };
}

function degradationPercent(trainValue, laterValue) {
  const train = nullableNumber(trainValue);
  const later = nullableNumber(laterValue);
  if (train == null || later == null || train === 0) return null;
  return round(((train - later) / Math.abs(train)) * 100, 2);
}

function assessWalkForwardMetrics({ trainSummary = {}, validationSummary = {}, outOfSampleSummary = {} } = {}) {
  const validationDegradationPercent = degradationPercent(trainSummary.netProfitMoney, validationSummary.netProfitMoney);
  const outOfSampleDegradationPercent = degradationPercent(trainSummary.netProfitMoney, outOfSampleSummary.netProfitMoney);
  const pfDegradationPercent = degradationPercent(trainSummary.profitFactor, outOfSampleSummary.profitFactor);
  const reasons = [];

  const oosClassification = classifyOptimizerCandidate({ summary: outOfSampleSummary }, {
    requireCostStress: false,
    passType: 'primary',
  });

  let overfittingRisk = 'LOW';
  if (
    finiteNumber(trainSummary.netProfitMoney) > 0
    && finiteNumber(outOfSampleSummary.netProfitMoney) <= 0
  ) {
    overfittingRisk = 'HIGH';
    reasons.push('Train profitable but out-of-sample net profit is non-positive.');
  } else if (
    (outOfSampleDegradationPercent != null && outOfSampleDegradationPercent > 50)
    || (pfDegradationPercent != null && pfDegradationPercent > 35)
  ) {
    overfittingRisk = 'MEDIUM';
    reasons.push('Out-of-sample degradation is material.');
  }

  let finalBucket = oosClassification.bucket;
  if (overfittingRisk === 'HIGH') finalBucket = CANDIDATE_BUCKETS.REJECT;
  else if (overfittingRisk === 'MEDIUM' && finalBucket === CANDIDATE_BUCKETS.LIVE_CANDIDATE) {
    finalBucket = CANDIDATE_BUCKETS.PAPER_ONLY;
    reasons.push('Live candidate downgraded to PAPER_ONLY due to OOS degradation.');
  }

  return {
    trainMetrics: trainSummary,
    validationMetrics: validationSummary,
    outOfSampleMetrics: outOfSampleSummary,
    validationDegradationPercent,
    outOfSampleDegradationPercent,
    profitFactorDegradationPercent: pfDegradationPercent,
    overfittingRisk,
    finalBucket,
    reasons: [...reasons, ...oosClassification.reasons],
  };
}

function classifyOptimizerCandidate(row = {}, context = {}) {
  const summary = summaryOf(row);
  const passType = context.passType || row.passType || 'primary';
  const reasons = [];
  const warningFlags = new Set(getWarningFlags(summary));
  const totalTrades = finiteNumber(summary.totalTrades);
  const robustScore = finiteNumber(summary.robustScore);
  const profitFactor = finiteNumber(summary.profitFactor);
  const expectancy = finiteNumber(summary.expectancyPerTrade);
  const returnPercent = finiteNumber(summary.returnPercent);
  const netProfitMoney = finiteNumber(summary.netProfitMoney);
  const maxDrawdownPercent = finiteNumber(summary.maxDrawdownPercent);
  const maxConsecutiveLosses = finiteNumber(summary.maxConsecutiveLosses);
  const profitConcentrationTop1 = finiteNumber(summary.profitConcentrationTop1);

  let bucket;
  if (passType === 'secondary') {
    reasons.push('LOW_SAMPLE_SECONDARY_PASS: result is observation-only and cannot be LIVE_CANDIDATE.');
    bucket = netProfitMoney > 0 && profitFactor > 1 && expectancy > 0 && robustScore >= 35
      ? CANDIDATE_BUCKETS.PAPER_ONLY
      : CANDIDATE_BUCKETS.REJECT;
  } else if (
    netProfitMoney <= 0
    || profitFactor < 1
    || expectancy <= 0
    || robustScore < 35
    || maxDrawdownPercent > 25
    || maxConsecutiveLosses > 6
    || profitConcentrationTop1 > REJECT_PROFIT_CONCENTRATION_TOP1
  ) {
    bucket = CANDIDATE_BUCKETS.REJECT;
    if (netProfitMoney <= 0) reasons.push('netProfitMoney <= 0.');
    if (profitFactor < 1) reasons.push('profitFactor < 1.');
    if (expectancy <= 0) reasons.push('expectancyPerTrade <= 0.');
    if (robustScore < 35) reasons.push('robustScore < 35.');
    if (maxDrawdownPercent > 25) reasons.push('maxDrawdownPercent > 25.');
    if (maxConsecutiveLosses > 6) reasons.push('maxConsecutiveLosses > 6.');
    if (profitConcentrationTop1 > REJECT_PROFIT_CONCENTRATION_TOP1) {
      reasons.push('Profit is highly concentrated in the top trade.');
    }
  } else {
    const liveEligible = robustScore >= 70
      && totalTrades >= 50
      && profitFactor >= 1.3
      && expectancy > 0
      && returnPercent > 0
      && maxDrawdownPercent <= 15
      && maxConsecutiveLosses <= 3
      && profitConcentrationTop1 <= LIVE_PROFIT_CONCENTRATION_TOP1
      && !warningFlags.has('VERY_SMALL_SAMPLE')
      && !warningFlags.has('LOW_EXPECTANCY')
      && !warningFlags.has('HIGH_DRAWDOWN');

    if (liveEligible) {
      bucket = CANDIDATE_BUCKETS.LIVE_CANDIDATE;
      reasons.push('Meets live-candidate thresholds before paper/OOS/cost gates.');
    } else if (netProfitMoney > 0 && profitFactor > 1) {
      bucket = CANDIDATE_BUCKETS.PAPER_ONLY;
      if (totalTrades < 50) reasons.push('Sample is below LIVE_CANDIDATE threshold.');
      if (robustScore < 70) reasons.push('robustScore is below LIVE_CANDIDATE threshold.');
      if (returnPercent <= 0) reasons.push('returnPercent is not positive.');
      if (maxDrawdownPercent > 15) reasons.push('maxDrawdownPercent is above LIVE_CANDIDATE threshold.');
      if (maxConsecutiveLosses > 3) reasons.push('maxConsecutiveLosses is above LIVE_CANDIDATE threshold.');
      if (profitConcentrationTop1 > LIVE_PROFIT_CONCENTRATION_TOP1) reasons.push('Profit concentration is above LIVE_CANDIDATE threshold.');
      if (warningFlags.has('PROFIT_CONCENTRATED')) reasons.push('warningFlags includes PROFIT_CONCENTRATED.');
      if (!reasons.length) reasons.push('Profitable but does not meet every live-candidate threshold.');
    } else {
      bucket = CANDIDATE_BUCKETS.REJECT;
      reasons.push('Does not meet paper or live thresholds.');
    }
  }

  const costStress = context.costStressResult || row.costStressResult || null;
  if (context.requireCostStress && !costStress) {
    if (bucket === CANDIDATE_BUCKETS.LIVE_CANDIDATE) {
      bucket = CANDIDATE_BUCKETS.PAPER_ONLY;
      reasons.push('Cost stress has not been run, so live eligibility is withheld.');
    }
  } else if (costStress && !costStress.passed) {
    reasons.push(...(costStress.reasons || ['Cost stress failed.']));
    if (bucket === CANDIDATE_BUCKETS.LIVE_CANDIDATE) {
      bucket = CANDIDATE_BUCKETS.PAPER_ONLY;
      reasons.push('Downgraded from LIVE_CANDIDATE because cost stress did not pass.');
    }
    if (costStress.allScenariosNetNegative || costStress.defaultScenarioPassed === false) {
      bucket = CANDIDATE_BUCKETS.REJECT;
      reasons.push('Rejected because default cost scenario failed or every stress scenario is net negative.');
    }
  }

  const walkForward = context.walkForwardAssessment || row.walkForwardAssessment || null;
  if (walkForward) {
    reasons.push(...(walkForward.reasons || []));
    if (walkForward.finalBucket === CANDIDATE_BUCKETS.REJECT) {
      bucket = CANDIDATE_BUCKETS.REJECT;
      reasons.push('Walk-forward/OOS assessment rejects this combination.');
    } else if (
      walkForward.finalBucket === CANDIDATE_BUCKETS.PAPER_ONLY
      && bucket === CANDIDATE_BUCKETS.LIVE_CANDIDATE
    ) {
      bucket = CANDIDATE_BUCKETS.PAPER_ONLY;
      reasons.push('Downgraded to PAPER_ONLY by walk-forward/OOS degradation.');
    }
  }

  return {
    bucket,
    reasons: [...new Set(reasons)],
    suggestedRiskPerTrade: getSuggestedRiskPerTrade(bucket, summary, context),
    warningFlags: [...warningFlags],
    costStressPassed: costStress ? Boolean(costStress.passed) : null,
    overfittingRisk: walkForward?.overfittingRisk || null,
  };
}

module.exports = {
  CANDIDATE_BUCKETS,
  COST_STRESS_SCENARIOS,
  HIGH_COST_SYMBOLS,
  assessWalkForwardMetrics,
  buildCostStressScenarios,
  classifyOptimizerCandidate,
  evaluateCostStressResults,
  getSuggestedRiskPerTrade,
  isHighCostSymbol,
};
