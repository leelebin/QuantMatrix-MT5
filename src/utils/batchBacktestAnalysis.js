function getSummary(result) {
  return result && result.summary ? result.summary : {};
}

function getNumeric(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getStatusPriority(status) {
  switch (status) {
    case 'completed':
      return 4;
    case 'no_trades':
      return 3;
    case 'insufficient_data':
      return 2;
    case 'error':
      return 1;
    default:
      return 0;
  }
}

function compareBatchResults(a, b) {
  const aStatus = getStatusPriority(a.status);
  const bStatus = getStatusPriority(b.status);
  if (aStatus !== bStatus) {
    return bStatus - aStatus;
  }

  const summaryA = getSummary(a);
  const summaryB = getSummary(b);
  const pfDiff = getNumeric(summaryB.profitFactor) - getNumeric(summaryA.profitFactor);
  if (pfDiff !== 0) return pfDiff;

  const returnDiff = getNumeric(summaryB.returnPercent) - getNumeric(summaryA.returnPercent);
  if (returnDiff !== 0) return returnDiff;

  const ddDiff = getNumeric(summaryA.maxDrawdownPercent) - getNumeric(summaryB.maxDrawdownPercent);
  if (ddDiff !== 0) return ddDiff;

  const tradesDiff = getNumeric(summaryB.totalTrades) - getNumeric(summaryA.totalTrades);
  if (tradesDiff !== 0) return tradesDiff;

  const strategyDiff = String(a.strategy || '').localeCompare(String(b.strategy || ''));
  if (strategyDiff !== 0) return strategyDiff;

  return String(a.symbol || '').localeCompare(String(b.symbol || ''));
}

function summarizeGroup(items, keyName) {
  const scoredItems = items.filter((item) => item.summary);
  const profitableItems = scoredItems.filter((item) => getNumeric(item.summary.returnPercent) > 0);
  const completedItems = items.filter((item) => item.status === 'completed');
  const noTradeItems = items.filter((item) => item.status === 'no_trades');
  const errorItems = items.filter((item) => item.status === 'error');
  const insufficientDataItems = items.filter((item) => item.status === 'insufficient_data');

  const average = (field) => {
    if (scoredItems.length === 0) return 0;
    const total = scoredItems.reduce((sum, item) => sum + getNumeric(getSummary(item)[field]), 0);
    return parseFloat((total / scoredItems.length).toFixed(2));
  };

  const sorted = [...items].sort(compareBatchResults);
  return {
    [keyName]: items[0] ? items[0][keyName] : '',
    totalRuns: items.length,
    completedRuns: completedItems.length,
    noTradeRuns: noTradeItems.length,
    errorRuns: errorItems.length,
    insufficientDataRuns: insufficientDataItems.length,
    profitableRuns: profitableItems.length,
    averageProfitFactor: average('profitFactor'),
    averageReturnPercent: average('returnPercent'),
    averageMaxDrawdownPercent: average('maxDrawdownPercent'),
    averageTrades: average('totalTrades'),
    averageWinRate: average('winRate'),
    bestResult: sorted[0] || null,
    worstResult: sorted.length > 0 ? sorted[sorted.length - 1] : null,
  };
}

function groupResults(results, keyName) {
  const groups = new Map();
  for (const result of results) {
    const key = result[keyName];
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(result);
  }

  return Array.from(groups.values())
    .map((items) => summarizeGroup(items, keyName))
    .sort((a, b) => compareBatchResults(a.bestResult || {}, b.bestResult || {}));
}

// True portfolio-level aggregate: each scored child run is treated as an
// independent sleeve starting with the same `initialBalance`. All totals
// are summed at the trade or money level — never averaged from per-run
// percentages. This keeps win rate, profit factor and return % consistent
// with "what would the combined book look like if I ran every strategy
// with an equal starting capital?".
//
// Notes on max drawdown:
//   - `worstRunMaxDrawdownPercent` = max over per-run DD (identifies the
//     single worst sleeve).
//   - `avgMaxDrawdownPercent` = mean of per-run DDs. With equal capital
//     per sleeve this equals the absolute worst-case simultaneous
//     portfolio DD as a % of combined capital; it is an upper bound
//     (it assumes all sleeves hit peak drawdown at the same time).
// We deliberately do not synthesize a combined equity curve here because
// per-run trade streams are persisted separately and stitching them by
// timestamp would require reloading every child backtest.
function buildPortfolioSummary(results, initialBalance) {
  const scored = results.filter((r) => r && r.summary && r.status === 'completed');
  const noTradeRuns = results.filter((r) => r && r.status === 'no_trades').length;
  const insufficientDataRuns = results.filter((r) => r && r.status === 'insufficient_data').length;
  const errorRuns = results.filter((r) => r && r.status === 'error').length;

  const base = {
    runCount: results.length,
    scoredRuns: scored.length,
    profitableRuns: 0,
    losingRuns: 0,
    breakevenRuns: 0,
    noTradeRuns,
    insufficientDataRuns,
    errorRuns,
    initialBalancePerRun: Number(initialBalance) || 0,
    totalStartingBalance: 0,
    totalEndingBalance: 0,
    netProfitMoney: 0,
    returnPercent: 0,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRate: 0,
    lossRate: 0,
    grossProfitMoney: 0,
    grossLossMoney: 0,
    profitFactor: 0,
    avgTradeMoney: 0,
    avgMaxDrawdownPercent: 0,
    worstRunMaxDrawdownPercent: 0,
  };

  if (scored.length === 0) {
    return base;
  }

  const safeBalance = Number(initialBalance) || 0;
  let totalEndingBalance = 0;
  let totalTrades = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let sumMaxDD = 0;
  let worstMaxDD = 0;
  let profitableRuns = 0;
  let losingRuns = 0;
  let breakevenRuns = 0;

  for (const run of scored) {
    const s = run.summary;
    const runNet = getNumeric(s.netProfitMoney);
    totalEndingBalance += safeBalance + runNet;
    totalTrades += getNumeric(s.totalTrades);
    winningTrades += getNumeric(s.winningTrades);
    losingTrades += getNumeric(s.losingTrades);
    grossProfit += getNumeric(s.grossProfitMoney);
    grossLoss += getNumeric(s.grossLossMoney);

    const dd = getNumeric(s.maxDrawdownPercent);
    sumMaxDD += dd;
    if (dd > worstMaxDD) worstMaxDD = dd;

    if (runNet > 0) profitableRuns += 1;
    else if (runNet < 0) losingRuns += 1;
    else breakevenRuns += 1;
  }

  const totalStartingBalance = safeBalance * scored.length;
  const netProfitMoney = totalEndingBalance - totalStartingBalance;
  const returnPercent = totalStartingBalance > 0 ? (netProfitMoney / totalStartingBalance) * 100 : 0;
  const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
  const lossRate = totalTrades > 0 ? losingTrades / totalTrades : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
  const avgTradeMoney = totalTrades > 0 ? netProfitMoney / totalTrades : 0;
  const avgMaxDrawdownPercent = scored.length > 0 ? sumMaxDD / scored.length : 0;

  const round2 = (value) => parseFloat(value.toFixed(2));
  const round4 = (value) => parseFloat(value.toFixed(4));

  return {
    ...base,
    profitableRuns,
    losingRuns,
    breakevenRuns,
    totalStartingBalance: round2(totalStartingBalance),
    totalEndingBalance: round2(totalEndingBalance),
    netProfitMoney: round2(netProfitMoney),
    returnPercent: round2(returnPercent),
    totalTrades,
    winningTrades,
    losingTrades,
    winRate: round4(winRate),
    lossRate: round4(lossRate),
    grossProfitMoney: round2(grossProfit),
    grossLossMoney: round2(grossLoss),
    profitFactor: round2(profitFactor),
    avgTradeMoney: round2(avgTradeMoney),
    avgMaxDrawdownPercent: round2(avgMaxDrawdownPercent),
    worstRunMaxDrawdownPercent: round2(worstMaxDD),
  };
}

function buildBatchAggregate(results, options = {}) {
  const sortedResults = [...results].sort(compareBatchResults);
  const scoredResults = sortedResults.filter((item) => item.summary);
  const completedResults = results.filter((item) => item.status === 'completed');
  const noTradeResults = results.filter((item) => item.status === 'no_trades');
  const insufficientDataResults = results.filter((item) => item.status === 'insufficient_data');
  const errorResults = results.filter((item) => item.status === 'error');
  const profitableResults = scoredResults.filter((item) => getNumeric(item.summary.returnPercent) > 0);
  const lowTradeResults = scoredResults.filter((item) => getNumeric(item.summary.totalTrades) > 0 && getNumeric(item.summary.totalTrades) < 5);
  const portfolio = buildPortfolioSummary(results, options.initialBalance);

  return {
    totals: {
      totalRuns: results.length,
      scoredRuns: scoredResults.length,
      completedRuns: completedResults.length,
      noTradeRuns: noTradeResults.length,
      insufficientDataRuns: insufficientDataResults.length,
      errorRuns: errorResults.length,
      profitableRuns: profitableResults.length,
    },
    portfolio,
    rankedResults: sortedResults,
    topResults: sortedResults.slice(0, 10),
    bottomResults: [...sortedResults].reverse().slice(0, 10),
    byStrategy: groupResults(results, 'strategy'),
    bySymbol: groupResults(results, 'symbol'),
    failures: {
      noTrades: noTradeResults,
      insufficientData: insufficientDataResults,
      errors: errorResults,
    },
    lowTradeResults,
  };
}

function buildRecommendationLines(aggregate) {
  const lines = [];
  const ranked = aggregate.rankedResults || [];
  const byStrategy = aggregate.byStrategy || [];
  const bySymbol = aggregate.bySymbol || [];
  const portfolio = aggregate.portfolio || null;

  if (portfolio && portfolio.scoredRuns > 0) {
    if (portfolio.profitFactor > 0 && portfolio.profitFactor < 1) {
      lines.push(
        `组合盈亏比 Profit Factor 为 ${portfolio.profitFactor}（<1），说明全组合整体期望值为负；建议先降低低表现策略权重或优化核心入场过滤。`
      );
    }
    if (portfolio.returnPercent < 0) {
      lines.push(
        `组合净收益率 ${portfolio.returnPercent}%（亏损），需要优先止损低表现组合并复核风控参数。`
      );
    }
    if (portfolio.worstRunMaxDrawdownPercent >= 25) {
      lines.push(
        `单策略最坏情况下最大回撤达到 ${portfolio.worstRunMaxDrawdownPercent}%；建议对该策略单独降低风险并强化止损。`
      );
    }
    if (portfolio.avgMaxDrawdownPercent >= 15) {
      lines.push(
        `组合平均最大回撤 ${portfolio.avgMaxDrawdownPercent}% 偏高；建议同时运行多策略时分散仓位或引入总体限损开关。`
      );
    }
    if (portfolio.totalTrades > 0 && portfolio.totalTrades < 30) {
      lines.push(
        `组合总交易数仅 ${portfolio.totalTrades} 笔，样本量偏小；建议延长回测窗口或放宽入场过滤以获得更稳健的统计结果。`
      );
    }
  }

  const lowTrades = aggregate.lowTradeResults || [];
  lowTrades.slice(0, 5).forEach((item) => {
    lines.push(
      `${item.strategy} @ ${item.symbol} 仅有 ${item.summary.totalTrades} 笔交易，样本过少；优先放宽入场过滤或延长测试区间后再评估参数。`
    );
  });

  ranked
    .filter((item) => item.summary && getNumeric(item.summary.winRate) >= 0.6 && (getNumeric(item.summary.returnPercent) <= 1 || getNumeric(item.summary.profitFactor) < 1.1))
    .slice(0, 5)
    .forEach((item) => {
      lines.push(
        `${item.strategy} @ ${item.symbol} 胜率 ${(getNumeric(item.summary.winRate) * 100).toFixed(1)}% 但收益 ${item.summary.returnPercent}% / PF ${item.summary.profitFactor}，说明盈亏比偏弱；建议优先调大止盈或收紧止损参数。`
      );
    });

  ranked
    .filter((item) => item.summary && getNumeric(item.summary.returnPercent) > 0 && getNumeric(item.summary.maxDrawdownPercent) >= 15)
    .slice(0, 5)
    .forEach((item) => {
      lines.push(
        `${item.strategy} @ ${item.symbol} 虽然收益为正 (${item.summary.returnPercent}%)，但最大回撤达到 ${item.summary.maxDrawdownPercent}%；建议先降低风险参数或提高过滤阈值。`
      );
    });

  ranked
    .filter((item) => item.summary && getNumeric(item.summary.profitFactor) > 0 && getNumeric(item.summary.profitFactor) < 1)
    .slice(0, 5)
    .forEach((item) => {
      lines.push(
        `${item.strategy} @ ${item.symbol} 的 Profit Factor 仅 ${item.summary.profitFactor}，长期期望值为负；建议先停止扩展该组合，优先调整核心入场参数。`
      );
    });

  byStrategy
    .filter((group) => group.profitableRuns > 0 && group.profitableRuns <= Math.max(1, Math.floor(group.totalRuns / 3)))
    .slice(0, 5)
    .forEach((group) => {
      lines.push(
        `策略 ${group.strategy} 只在 ${group.profitableRuns}/${group.totalRuns} 个品种上盈利，适用面较窄；建议只保留表现最好的品种，并按品种分开微调参数。`
      );
    });

  bySymbol
    .filter((group) => group.profitableRuns <= Math.max(1, Math.floor(group.totalRuns / 4)))
    .slice(0, 5)
    .forEach((group) => {
      lines.push(
        `品种 ${group.symbol} 在 ${group.totalRuns} 个策略中仅有 ${group.profitableRuns} 个盈利组合，说明该市场与当前策略库匹配度偏低；建议降低优先级或改用更适合的策略。`
      );
    });

  if (lines.length === 0) {
    lines.push('当前批量回测没有触发明确的风险信号，建议优先关注 Top 结果的参数稳健性，并在更长区间做二次验证。');
  }

  return lines;
}

function formatResultLine(result, index) {
  if (!result) return `${index}. --`;
  if (!result.summary) {
    return `${index}. ${result.strategy} @ ${result.symbol} | ${result.status} | ${result.error || '无可评分结果'}`;
  }

  return `${index}. ${result.strategy} @ ${result.symbol} | PF ${result.summary.profitFactor} | Return ${result.summary.returnPercent}% | DD ${result.summary.maxDrawdownPercent}% | Trades ${result.summary.totalTrades}`;
}

function formatScopeMode(mode) {
  if (mode === 'all_strategies') return 'All Strategies × All Symbols';
  return 'Enabled + Assigned Only';
}

function formatTimeframeMode(job) {
  if (job && job.timeframeMode === 'forced_timeframe') {
    return `forced_timeframe (${job.forcedTimeframe || '?'})`;
  }
  return 'strategy_default';
}

function buildPortfolioLines(portfolio) {
  if (!portfolio || portfolio.scoredRuns === 0) {
    return ['- 无可评分组合，无法计算整体组合表现'];
  }
  return [
    `- 初始资金池: ${portfolio.totalStartingBalance} (${portfolio.initialBalancePerRun} × ${portfolio.scoredRuns} 个可评分组合)`,
    `- 结束资金池: ${portfolio.totalEndingBalance}`,
    `- 净盈亏: ${portfolio.netProfitMoney} | 组合收益率: ${portfolio.returnPercent}%`,
    `- 总交易数: ${portfolio.totalTrades} | 盈利交易: ${portfolio.winningTrades} | 亏损交易: ${portfolio.losingTrades}`,
    `- 组合胜率: ${(portfolio.winRate * 100).toFixed(2)}% | 组合败率: ${(portfolio.lossRate * 100).toFixed(2)}%`,
    `- 组合 Profit Factor: ${portfolio.profitFactor} (毛盈 ${portfolio.grossProfitMoney} / 毛亏 ${portfolio.grossLossMoney})`,
    `- 平均单笔盈亏: ${portfolio.avgTradeMoney}`,
    `- 平均单策略最大回撤: ${portfolio.avgMaxDrawdownPercent}% | 最坏单策略回撤: ${portfolio.worstRunMaxDrawdownPercent}%`,
    `- 盈利组合: ${portfolio.profitableRuns} | 亏损组合: ${portfolio.losingRuns} | 无交易组合: ${portfolio.noTradeRuns}`,
  ];
}

function buildBatchReport(job, aggregate) {
  const recommendations = buildRecommendationLines(aggregate);
  const topLines = (aggregate.topResults || []).slice(0, 5).map((result, index) => formatResultLine(result, index + 1));
  const bottomLines = (aggregate.bottomResults || []).slice(0, 5).map((result, index) => formatResultLine(result, index + 1));
  const portfolio = aggregate.portfolio || null;
  const portfolioLines = buildPortfolioLines(portfolio);

  const strategyObservations = (aggregate.byStrategy || [])
    .slice(0, 5)
    .map((group) => {
      return `- ${group.strategy}: ${group.profitableRuns}/${group.totalRuns} 组合盈利，平均 PF ${group.averageProfitFactor}，平均收益 ${group.averageReturnPercent}%，平均回撤 ${group.averageMaxDrawdownPercent}%`;
    });

  const symbolObservations = (aggregate.bySymbol || [])
    .slice(0, 5)
    .map((group) => {
      return `- ${group.symbol}: ${group.profitableRuns}/${group.totalRuns} 组合盈利，平均 PF ${group.averageProfitFactor}，平均收益 ${group.averageReturnPercent}%，平均交易数 ${group.averageTrades}`;
    });

  const failureLines = [];
  (aggregate.failures.noTrades || []).slice(0, 5).forEach((item) => {
    failureLines.push(`- 无交易: ${item.strategy} @ ${item.symbol}`);
  });
  (aggregate.failures.insufficientData || []).slice(0, 5).forEach((item) => {
    failureLines.push(`- 数据不足: ${item.strategy} @ ${item.symbol} | ${item.error}`);
  });
  (aggregate.failures.errors || []).slice(0, 5).forEach((item) => {
    failureLines.push(`- 执行失败: ${item.strategy} @ ${item.symbol} | ${item.error}`);
  });

  const settingsLines = [
    `- 作业ID: ${job._id}`,
    `- 时间范围: ${job.period.start} -> ${job.period.end}`,
    `- 每策略初始资金: ${job.initialBalance}`,
    `- 运行模式: ${job.runModel}`,
    `- 策略覆盖范围: ${formatScopeMode(job.strategyScopeMode)}`,
    `- 时间框架模式: ${formatTimeframeMode(job)}`,
    `- 总组合: ${aggregate.totals.totalRuns} | 可评分: ${aggregate.totals.scoredRuns} | 盈利组合: ${aggregate.totals.profitableRuns} | 无交易: ${aggregate.totals.noTradeRuns} | 数据不足: ${aggregate.totals.insufficientDataRuns} | 执行失败: ${aggregate.totals.errorRuns}`,
  ];

  const reportText = [
    '批量回测微调报告',
    '================',
    ...settingsLines,
    '',
    '组合总体表现 (Portfolio Summary)',
    ...portfolioLines,
    '',
    '最佳组合',
    ...topLines,
    '',
    '最弱组合',
    ...bottomLines,
    '',
    '按策略观察',
    ...(strategyObservations.length > 0 ? strategyObservations : ['- 无策略统计结果']),
    '',
    '按品种观察',
    ...(symbolObservations.length > 0 ? symbolObservations : ['- 无品种统计结果']),
    '',
    '失败与低活跃组合',
    ...(failureLines.length > 0 ? failureLines : ['- 无失败组合']),
    '',
    '调参建议',
    ...recommendations.map((line, index) => `${index + 1}. ${line}`),
  ].join('\n');

  const reportMarkdown = [
    '# 批量回测微调报告',
    '',
    '## 作业设置',
    ...settingsLines,
    '',
    '## 组合总体表现 (Portfolio Summary)',
    ...portfolioLines,
    '',
    '## 最佳组合',
    ...topLines.map((line) => `- ${line}`),
    '',
    '## 最弱组合',
    ...bottomLines.map((line) => `- ${line}`),
    '',
    '## 按策略观察',
    ...(strategyObservations.length > 0 ? strategyObservations : ['- 无策略统计结果']),
    '',
    '## 按品种观察',
    ...(symbolObservations.length > 0 ? symbolObservations : ['- 无品种统计结果']),
    '',
    '## 失败与低活跃组合',
    ...(failureLines.length > 0 ? failureLines : ['- 无失败组合']),
    '',
    '## 调参建议',
    ...recommendations.map((line, index) => `${index + 1}. ${line}`),
  ].join('\n');

  return {
    reportText,
    reportMarkdown,
    recommendations,
  };
}

function filterBatchResults(results, filters = {}) {
  return results.filter((result) => {
    if (filters.strategy && result.strategy !== filters.strategy) return false;
    if (filters.symbol && result.symbol !== filters.symbol) return false;
    if (filters.status && result.status !== filters.status) return false;

    if (filters.minTrades != null && filters.minTrades !== '') {
      const minTrades = Number(filters.minTrades);
      if (Number.isFinite(minTrades) && getNumeric(getSummary(result).totalTrades) < minTrades) {
        return false;
      }
    }

    return true;
  });
}

function sortBatchResults(results, sortBy, sortDir = 'desc') {
  const direction = String(sortDir).toLowerCase() === 'asc' ? 1 : -1;
  if (!sortBy) {
    return [...results].sort(compareBatchResults);
  }

  const getValue = (result) => {
    switch (sortBy) {
      case 'strategy':
        return String(result.strategy || '');
      case 'symbol':
        return String(result.symbol || '');
      case 'status':
        return String(result.status || '');
      case 'totalTrades':
      case 'winRate':
      case 'profitFactor':
      case 'returnPercent':
      case 'maxDrawdownPercent':
        return getNumeric(getSummary(result)[sortBy]);
      default:
        return getNumeric(getSummary(result)[sortBy], null);
    }
  };

  return [...results].sort((a, b) => {
    const aValue = getValue(a);
    const bValue = getValue(b);
    if (typeof aValue === 'string' || typeof bValue === 'string') {
      return String(aValue).localeCompare(String(bValue)) * direction;
    }
    if (aValue === bValue) return compareBatchResults(a, b);
    return (aValue > bValue ? 1 : -1) * direction;
  });
}

function paginateBatchResults(results, page = 1, pageSize = 50) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.min(200, Math.max(1, Number(pageSize) || 50));
  const start = (safePage - 1) * safePageSize;
  const items = results.slice(start, start + safePageSize);

  return {
    items,
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      total: results.length,
      totalPages: Math.max(1, Math.ceil(results.length / safePageSize)),
    },
  };
}

module.exports = {
  compareBatchResults,
  buildBatchAggregate,
  buildBatchReport,
  buildPortfolioSummary,
  filterBatchResults,
  paginateBatchResults,
  sortBatchResults,
};
