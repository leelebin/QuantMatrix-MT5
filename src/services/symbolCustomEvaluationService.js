function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getTradePnl(trade = {}) {
  return toNumber(
    trade.pnl != null ? trade.pnl : (trade.profitLoss != null ? trade.profitLoss : trade.netPnl),
    0
  );
}

function getTradeSide(trade = {}) {
  return String(trade.side || trade.direction || trade.type || 'UNKNOWN').toUpperCase();
}

function getTradeEntryTime(trade = {}) {
  return trade.entryTime || trade.openTime || trade.time || null;
}

function getTradeExitTime(trade = {}) {
  return trade.exitTime || trade.closeTime || getTradeEntryTime(trade);
}

function getDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function getUtcDateKey(value) {
  const date = getDate(value);
  if (!date) return 'UNKNOWN';
  return date.toISOString().slice(0, 10);
}

function getUtcMonthKey(value) {
  const date = getDate(value);
  if (!date) return 'UNKNOWN';
  return date.toISOString().slice(0, 7);
}

function getUtcHour(value) {
  const date = getDate(value);
  return date ? date.getUTCHours() : 'UNKNOWN';
}

function createAccumulator() {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    netPnl: 0,
    grossWin: 0,
    grossLoss: 0,
  };
}

function addTrade(acc, trade = {}, adjustedPnl = null) {
  const pnl = adjustedPnl == null ? getTradePnl(trade) : toNumber(adjustedPnl, 0);
  acc.trades += 1;
  acc.netPnl += pnl;
  if (pnl > 0) {
    acc.wins += 1;
    acc.grossWin += pnl;
  } else if (pnl < 0) {
    acc.losses += 1;
    acc.grossLoss += Math.abs(pnl);
  }
  return acc;
}

function finalizeAccumulator(acc) {
  return {
    trades: acc.trades,
    wins: acc.wins,
    losses: acc.losses,
    netPnl: acc.netPnl,
    grossWin: acc.grossWin,
    grossLoss: acc.grossLoss,
    profitFactor: acc.grossLoss > 0 ? acc.grossWin / acc.grossLoss : (acc.grossWin > 0 ? null : null),
    winRate: acc.trades > 0 ? acc.wins / acc.trades : null,
    avgPnl: acc.trades > 0 ? acc.netPnl / acc.trades : null,
  };
}

function groupTrades(trades, keyFn) {
  const groups = {};
  trades.forEach((trade) => {
    const key = String(keyFn(trade));
    if (!groups[key]) groups[key] = createAccumulator();
    addTrade(groups[key], trade);
  });

  return Object.keys(groups)
    .sort()
    .reduce((result, key) => {
      result[key] = finalizeAccumulator(groups[key]);
      return result;
    }, {});
}

function buildDirectionBreakdown(trades) {
  const groups = {
    BUY: createAccumulator(),
    SELL: createAccumulator(),
  };

  trades.forEach((trade) => {
    const side = getTradeSide(trade);
    if (!groups[side]) groups[side] = createAccumulator();
    addTrade(groups[side], trade);
  });

  return Object.keys(groups).reduce((result, key) => {
    result[key] = {
      ...finalizeAccumulator(groups[key]),
      maxDrawdown: null,
    };
    return result;
  }, {});
}

function buildExitReasonBreakdown(trades) {
  const expected = [
    'TP',
    'SL',
    'CUSTOM_CLOSE',
    'END_OF_BACKTEST',
    'AMBIGUOUS_SL_TP_SAME_BAR_SL_FIRST',
  ];
  const groups = expected.reduce((acc, reason) => {
    acc[reason] = createAccumulator();
    return acc;
  }, {});

  trades.forEach((trade) => {
    const reason = String(trade.exitReason || trade.exitReasonText || 'UNKNOWN');
    if (!groups[reason]) groups[reason] = createAccumulator();
    addTrade(groups[reason], trade);
  });

  return Object.keys(groups).reduce((result, key) => {
    result[key] = finalizeAccumulator(groups[key]);
    return result;
  }, {});
}

function buildConsecutiveLossAnalysis(trades) {
  let currentLosses = 0;
  let currentWins = 0;
  let currentLossStart = null;
  let maxConsecutiveLosses = 0;
  let maxConsecutiveWins = 0;
  let longestLossStreakStart = null;
  let longestLossStreakEnd = null;
  let lossStreaksOver3 = 0;
  let lossStreaksOver5 = 0;

  function closeLossStreak(lastTrade) {
    if (currentLosses > 0) {
      if (currentLosses > 3) lossStreaksOver3 += 1;
      if (currentLosses > 5) lossStreaksOver5 += 1;
      if (currentLosses > maxConsecutiveLosses) {
        maxConsecutiveLosses = currentLosses;
        longestLossStreakStart = currentLossStart;
        longestLossStreakEnd = getTradeExitTime(lastTrade);
      }
    }
    currentLosses = 0;
    currentLossStart = null;
  }

  trades.forEach((trade, index) => {
    const pnl = getTradePnl(trade);
    if (pnl < 0) {
      if (currentLosses === 0) currentLossStart = getTradeEntryTime(trade);
      currentLosses += 1;
      currentWins = 0;
    } else {
      closeLossStreak(trades[index - 1] || trade);
      if (pnl > 0) {
        currentWins += 1;
        maxConsecutiveWins = Math.max(maxConsecutiveWins, currentWins);
      } else {
        currentWins = 0;
      }
    }
  });
  closeLossStreak(trades[trades.length - 1] || {});

  return {
    maxConsecutiveLosses,
    maxConsecutiveWins,
    longestLossStreakStart,
    longestLossStreakEnd,
    lossStreaksOver3,
    lossStreaksOver5,
  };
}

function buildTradeFrequencyAnalysis(trades) {
  const sortedEntries = trades
    .map((trade) => getDate(getTradeEntryTime(trade)))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());

  if (!sortedEntries.length) {
    return {
      tradesPerDay: 0,
      averageMinutesBetweenEntries: null,
      entriesWithin15m: 0,
      entriesWithin30m: 0,
      entriesWithin60m: 0,
    };
  }

  const first = sortedEntries[0].getTime();
  const last = sortedEntries[sortedEntries.length - 1].getTime();
  const uniqueDays = new Set(sortedEntries.map((date) => date.toISOString().slice(0, 10)));
  const days = Math.max(1, uniqueDays.size || Math.ceil((last - first) / (24 * 60 * 60 * 1000)));
  const gaps = [];
  for (let index = 1; index < sortedEntries.length; index += 1) {
    gaps.push((sortedEntries[index].getTime() - sortedEntries[index - 1].getTime()) / 60000);
  }

  return {
    tradesPerDay: trades.length / days,
    averageMinutesBetweenEntries: gaps.length ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : null,
    entriesWithin15m: gaps.filter((value) => value <= 15).length,
    entriesWithin30m: gaps.filter((value) => value <= 30).length,
    entriesWithin60m: gaps.filter((value) => value <= 60).length,
  };
}

function buildCostSensitivity(trades) {
  const scenarios = {
    zeroCost: 0,
    lightCost: 0.25,
    mediumCost: 0.5,
    heavyCost: 1,
  };

  return Object.keys(scenarios).reduce((result, key) => {
    const cost = scenarios[key];
    const acc = createAccumulator();
    trades.forEach((trade) => addTrade(acc, trade, getTradePnl(trade) - cost));
    const finalized = finalizeAccumulator(acc);
    result[key] = {
      costPerTrade: cost,
      netPnlAfterCost: finalized.netPnl,
      profitFactorAfterCost: finalized.profitFactor,
      profitableAfterCost: finalized.netPnl > 0,
    };
    return result;
  }, {});
}

function findSessionFilterNeed(hourlyBreakdownUtc) {
  const rows = Object.values(hourlyBreakdownUtc || {}).filter((row) => row.trades > 0);
  return rows.some((row) => row.profitFactor != null && row.profitFactor > 1.3)
    && rows.some((row) => row.profitFactor != null && row.profitFactor < 0.9);
}

function findDirectionFilterNeed(directionBreakdown) {
  const buyPf = directionBreakdown.BUY?.profitFactor;
  const sellPf = directionBreakdown.SELL?.profitFactor;
  return (
    buyPf != null && sellPf != null
    && ((buyPf < 1 && sellPf > 1.05) || (sellPf < 1 && buyPf > 1.05))
  );
}

function buildRecommendation({ summary, directionBreakdown, hourlyBreakdownUtc, consecutiveLossAnalysis, tradeFrequencyAnalysis, costSensitivity }) {
  const codes = [];
  const rationale = [];
  const profitFactor = toNumber(summary.profitFactor, 0);
  const maxDrawdownPercent = toNumber(summary.maxDrawdownPercent, 0);

  if (profitFactor < 1.05) {
    codes.push('NO_EDGE');
    rationale.push('Profit factor is below 1.05.');
  }
  if (maxDrawdownPercent > 30) {
    codes.push('RISK_TOO_HIGH');
    rationale.push('Max drawdown percent is above 30%.');
  }
  if (toNumber(tradeFrequencyAnalysis.tradesPerDay, 0) > 5) {
    codes.push('OVERTRADING');
    rationale.push('Trade frequency is above 5 trades per day.');
  }
  if (costSensitivity.zeroCost?.profitableAfterCost && !costSensitivity.mediumCost?.profitableAfterCost) {
    codes.push('COST_FRAGILE');
    rationale.push('Zero-cost result is profitable but medium cost turns net P/L negative.');
  }
  if (findDirectionFilterNeed(directionBreakdown)) {
    codes.push('DIRECTION_FILTER_REQUIRED');
    rationale.push('One side is losing while the other side has PF above 1.05.');
  }
  if (findSessionFilterNeed(hourlyBreakdownUtc)) {
    codes.push('SESSION_FILTER_REQUIRED');
    rationale.push('Some UTC hours are strong while others are weak.');
  }
  if (toNumber(consecutiveLossAnalysis.maxConsecutiveLosses, 0) >= 8) {
    codes.push('LOSS_STREAK_GUARD_REQUIRED');
    rationale.push('Max consecutive losses is 8 or more.');
  }

  return {
    primary: codes[0] || 'BACKTEST_ONLY_REVIEW',
    codes,
    rationale,
  };
}

function buildWarnings(backtest = {}, recommendation) {
  const warnings = [];
  if (recommendation.codes.includes('NO_EDGE')) {
    warnings.push('Profit factor is too close to breakeven for deployment consideration.');
  }
  if (recommendation.codes.includes('RISK_TOO_HIGH')) {
    warnings.push('Drawdown is above acceptable research guardrail.');
  }
  if (backtest.costModelUsed && Object.values(backtest.costModelUsed).every((value) => toNumber(value, 0) === 0)) {
    warnings.push('Cost model is zero; spread, slippage, and commission sensitivity should be reviewed.');
  }
  return warnings;
}

function evaluateSymbolCustomBacktest(backtest = {}) {
  const trades = Array.isArray(backtest.trades) ? backtest.trades.slice() : [];
  const summary = backtest.summary || {};
  const directionBreakdown = buildDirectionBreakdown(trades);
  const exitReasonBreakdown = buildExitReasonBreakdown(trades);
  const hourlyBreakdownUtc = groupTrades(trades, (trade) => getUtcHour(getTradeEntryTime(trade)));
  const dailyBreakdown = groupTrades(trades, (trade) => getUtcDateKey(getTradeEntryTime(trade)));
  const monthlyBreakdown = groupTrades(trades, (trade) => getUtcMonthKey(getTradeEntryTime(trade)));
  const consecutiveLossAnalysis = buildConsecutiveLossAnalysis(trades);
  const tradeFrequencyAnalysis = buildTradeFrequencyAnalysis(trades);
  const costSensitivity = buildCostSensitivity(trades);
  const recommendation = buildRecommendation({
    summary,
    directionBreakdown,
    hourlyBreakdownUtc,
    consecutiveLossAnalysis,
    tradeFrequencyAnalysis,
    costSensitivity,
  });

  return {
    symbol: backtest.symbol || null,
    symbolCustomName: backtest.symbolCustomName || null,
    period: {
      startDate: backtest.startDate || null,
      endDate: backtest.endDate || null,
    },
    summary,
    directionBreakdown,
    exitReasonBreakdown,
    hourlyBreakdownUtc,
    dailyBreakdown,
    monthlyBreakdown,
    consecutiveLossAnalysis,
    tradeFrequencyAnalysis,
    costSensitivity,
    recommendation,
    warnings: buildWarnings(backtest, recommendation),
  };
}

module.exports = {
  evaluateSymbolCustomBacktest,
  _internals: {
    buildConsecutiveLossAnalysis,
    buildCostSensitivity,
    buildDirectionBreakdown,
    buildExitReasonBreakdown,
    buildTradeFrequencyAnalysis,
    groupTrades,
  },
};
