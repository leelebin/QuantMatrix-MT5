const WARNING_FLAGS = Object.freeze({
  SMALL_SAMPLE: 'SMALL_SAMPLE',
  VERY_SMALL_SAMPLE: 'VERY_SMALL_SAMPLE',
  PROFIT_CONCENTRATED: 'PROFIT_CONCENTRATED',
  AVG_LOSS_GT_AVG_WIN: 'AVG_LOSS_GT_AVG_WIN',
  HIGH_DRAWDOWN: 'HIGH_DRAWDOWN',
  LOW_EXPECTANCY: 'LOW_EXPECTANCY',
  LOW_PROFIT_FACTOR: 'LOW_PROFIT_FACTOR',
  LOW_TRADE_COUNT: 'LOW_TRADE_COUNT',
  HIGH_CONSECUTIVE_LOSSES: 'HIGH_CONSECUTIVE_LOSSES',
});

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundScore(value) {
  return parseFloat(clamp(finiteNumber(value), 0, 100).toFixed(2));
}

function addFlag(flags, flag) {
  if (!flags.includes(flag)) {
    flags.push(flag);
  }
}

function scoreProfitFactor(profitFactor) {
  if (profitFactor <= 1) return 0;
  return clamp((profitFactor - 1) / 1, 0, 1) * 25;
}

function scoreReturnToDrawdown(returnToDrawdown) {
  return clamp(returnToDrawdown / 3, 0, 1) * 20;
}

function scoreExpectancy(expectancyPerTrade, averageLossMoney) {
  if (expectancyPerTrade <= 0) return 0;
  const lossScale = Math.abs(averageLossMoney);
  if (lossScale <= 0) return 20;
  return clamp(expectancyPerTrade / (lossScale * 0.5), 0, 1) * 20;
}

function scoreRealizedR(avgRealizedR, medianRealizedR) {
  const avgScore = clamp(avgRealizedR / 0.5, 0, 1) * 8;
  const medianScore = clamp(medianRealizedR / 0.25, 0, 1) * 7;
  return avgScore + medianScore;
}

function scoreSampleSize(totalTrades) {
  if (totalTrades >= 100) return 20;
  if (totalTrades >= 50) return 12 + (((totalTrades - 50) / 50) * 8);
  if (totalTrades >= 20) return 5 + (((totalTrades - 20) / 30) * 7);
  return (totalTrades / 20) * 4;
}

function deriveSampleQuality(totalTrades) {
  if (totalTrades >= 100) return 'HIGH';
  if (totalTrades >= 50) return 'MEDIUM';
  if (totalTrades >= 30) return 'LOW';
  return 'VERY_LOW';
}

function calculateBacktestRobustScore(summary = {}) {
  const warningFlags = [];
  const totalTrades = finiteNumber(summary.totalTrades);
  const profitFactor = finiteNumber(summary.profitFactor);
  const returnToDrawdown = finiteNumber(summary.returnToDrawdown);
  const expectancyPerTrade = finiteNumber(summary.expectancyPerTrade);
  const avgRealizedR = finiteNumber(summary.avgRealizedR);
  const medianRealizedR = finiteNumber(summary.medianRealizedR);
  const averageWinMoney = finiteNumber(summary.averageWinMoney);
  const averageLossMoney = finiteNumber(summary.averageLossMoney);
  const maxDrawdownPercent = finiteNumber(summary.maxDrawdownPercent);
  const winRate = finiteNumber(summary.winRate);
  const profitConcentrationTop1 = finiteNumber(summary.profitConcentrationTop1);
  const profitConcentrationTop3 = finiteNumber(summary.profitConcentrationTop3);
  const maxConsecutiveLosses = finiteNumber(summary.maxConsecutiveLosses);

  let score = scoreProfitFactor(profitFactor)
    + scoreReturnToDrawdown(returnToDrawdown)
    + scoreExpectancy(expectancyPerTrade, averageLossMoney)
    + scoreRealizedR(avgRealizedR, medianRealizedR)
    + scoreSampleSize(totalTrades);

  if (totalTrades < 50) {
    addFlag(warningFlags, WARNING_FLAGS.SMALL_SAMPLE);
    score -= 12;
  }

  if (totalTrades < 20) {
    addFlag(warningFlags, WARNING_FLAGS.VERY_SMALL_SAMPLE);
    score -= 30;
  }

  if (totalTrades < 30) {
    addFlag(warningFlags, WARNING_FLAGS.LOW_TRADE_COUNT);
    score -= 8;
  }

  if (profitConcentrationTop1 > 0.5 || profitConcentrationTop3 > 0.75) {
    addFlag(warningFlags, WARNING_FLAGS.PROFIT_CONCENTRATED);
    score -= 18;
  }

  const averageLossAbs = Math.abs(averageLossMoney);
  if (averageLossAbs > averageWinMoney && averageWinMoney > 0) {
    const requiredWinRate = averageLossAbs / (averageWinMoney + averageLossAbs);
    if ((winRate - requiredWinRate) < 0.1) {
      addFlag(warningFlags, WARNING_FLAGS.AVG_LOSS_GT_AVG_WIN);
      score -= 12;
    }
  }

  if (maxDrawdownPercent > 15) {
    addFlag(warningFlags, WARNING_FLAGS.HIGH_DRAWDOWN);
    score -= maxDrawdownPercent > 25 ? 30 : 12;
  }

  if (expectancyPerTrade <= 0) {
    addFlag(warningFlags, WARNING_FLAGS.LOW_EXPECTANCY);
    score -= 20;
  }

  if (profitFactor < 1.2) {
    addFlag(warningFlags, WARNING_FLAGS.LOW_PROFIT_FACTOR);
    score -= 15;
  }

  if (maxConsecutiveLosses >= 4) {
    addFlag(warningFlags, WARNING_FLAGS.HIGH_CONSECUTIVE_LOSSES);
    score -= 10;
  }

  return {
    robustScore: roundScore(score),
    warningFlags,
    sampleQuality: deriveSampleQuality(totalTrades),
  };
}

module.exports = {
  WARNING_FLAGS,
  calculateBacktestRobustScore,
  deriveSampleQuality,
};
