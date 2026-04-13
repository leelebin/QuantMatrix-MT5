const {
  buildBatchAggregate,
  buildBatchReport,
} = require('../src/utils/batchBacktestAnalysis');

describe('batch backtest analysis', () => {
  test('builds report recommendations for low trades, weak PF, and weak symbol coverage', () => {
    const results = [
      {
        symbol: 'EURUSD',
        strategy: 'TrendFollowing',
        status: 'completed',
        summary: {
          totalTrades: 3,
          winRate: 0.72,
          profitFactor: 0.92,
          returnPercent: 0.4,
          maxDrawdownPercent: 4.5,
        },
      },
      {
        symbol: 'EURUSD',
        strategy: 'Momentum',
        status: 'completed',
        summary: {
          totalTrades: 10,
          winRate: 0.45,
          profitFactor: 0.88,
          returnPercent: -2.2,
          maxDrawdownPercent: 8.1,
        },
      },
      {
        symbol: 'USDJPY',
        strategy: 'TrendFollowing',
        status: 'completed',
        summary: {
          totalTrades: 14,
          winRate: 0.57,
          profitFactor: 1.4,
          returnPercent: 6.5,
          maxDrawdownPercent: 17.2,
        },
      },
      {
        symbol: 'USDJPY',
        strategy: 'Momentum',
        status: 'no_trades',
        summary: {
          totalTrades: 0,
          winRate: 0,
          profitFactor: 0,
          returnPercent: 0,
          maxDrawdownPercent: 0,
        },
      },
    ];

    const aggregate = buildBatchAggregate(results);
    const report = buildBatchReport({
      _id: 'job-1',
      period: { start: '2025-04-01T00:00:00.000Z', end: '2025-04-30T23:59:59.999Z' },
      initialBalance: 10000,
      runModel: 'independent',
      timeframeMode: 'strategy_default',
    }, aggregate);

    expect(aggregate.totals.totalRuns).toBe(4);
    expect(aggregate.totals.noTradeRuns).toBe(1);
    expect(report.reportText).toContain('仅有 3 笔交易');
    expect(report.reportText).toContain('Profit Factor 仅 0.92');
    expect(report.reportText).toContain('最大回撤达到 17.2%');
    expect(report.reportMarkdown).toContain('## 调参建议');
  });
});
