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

function buildBatchAggregate(results) {
  const sortedResults = [...results].sort(compareBatchResults);
  const scoredResults = sortedResults.filter((item) => item.summary);
  const completedResults = results.filter((item) => item.status === 'completed');
  const noTradeResults = results.filter((item) => item.status === 'no_trades');
  const insufficientDataResults = results.filter((item) => item.status === 'insufficient_data');
  const errorResults = results.filter((item) => item.status === 'error');
  const profitableResults = scoredResults.filter((item) => getNumeric(item.summary.returnPercent) > 0);
  const lowTradeResults = scoredResults.filter((item) => getNumeric(item.summary.totalTrades) > 0 && getNumeric(item.summary.totalTrades) < 5);

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

function buildBatchReport(job, aggregate) {
  const recommendations = buildRecommendationLines(aggregate);
  const topLines = (aggregate.topResults || []).slice(0, 5).map((result, index) => formatResultLine(result, index + 1));
  const bottomLines = (aggregate.bottomResults || []).slice(0, 5).map((result, index) => formatResultLine(result, index + 1));

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

  const summaryLines = [
    `批量回测作业 ${job._id}`,
    `时间范围: ${job.period.start} -> ${job.period.end}`,
    `初始资金: ${job.initialBalance}`,
    `运行模式: ${job.runModel}`,
    `时间框架模式: ${job.timeframeMode}`,
    `总组合: ${aggregate.totals.totalRuns} | 可评分: ${aggregate.totals.scoredRuns} | 盈利组合: ${aggregate.totals.profitableRuns} | 无交易: ${aggregate.totals.noTradeRuns} | 数据不足: ${aggregate.totals.insufficientDataRuns} | 执行失败: ${aggregate.totals.errorRuns}`,
  ];

  const reportText = [
    '批量回测微调报告',
    '================',
    ...summaryLines,
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
    '## 作业摘要',
    ...summaryLines.map((line) => `- ${line}`),
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
  filterBatchResults,
  paginateBatchResults,
  sortBatchResults,
};
