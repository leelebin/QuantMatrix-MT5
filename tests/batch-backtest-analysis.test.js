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
          netProfitFactor: 0.86,
          returnPercent: 0.4,
          maxDrawdownPercent: 4.5,
          netProfitMoney: 40,
          grossProfitMoney: 92,
          grossLossMoney: 100,
          netGrossProfitMoney: 86,
          netGrossLossMoney: 100,
          totalCommission: -4,
          totalTradingCosts: -4,
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
          netProfitFactor: 0.81,
          returnPercent: -2.2,
          maxDrawdownPercent: 8.1,
          netProfitMoney: -220,
          grossProfitMoney: 88,
          grossLossMoney: 100,
          netGrossProfitMoney: 81,
          netGrossLossMoney: 100,
          totalCommission: -7,
          totalTradingCosts: -7,
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
          netProfitFactor: 1.32,
          returnPercent: 6.5,
          maxDrawdownPercent: 17.2,
          netProfitMoney: 650,
          grossProfitMoney: 140,
          grossLossMoney: 100,
          netGrossProfitMoney: 132,
          netGrossLossMoney: 100,
          totalCommission: -8,
          totalTradingCosts: -8,
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

    const aggregate = buildBatchAggregate(results, { initialBalance: 10000 });
    const report = buildBatchReport({
      _id: 'job-1',
      period: { start: '2025-04-01T00:00:00.000Z', end: '2025-04-30T23:59:59.999Z' },
      initialBalance: 10000,
      runModel: 'independent',
      timeframeMode: 'strategy_default',
    }, aggregate);

    expect(aggregate.totals.totalRuns).toBe(4);
    expect(aggregate.totals.noTradeRuns).toBe(1);
    expect(aggregate.portfolio.netProfitFactor).toBe(1);
    expect(aggregate.portfolio.totalTradingCosts).toBe(-19);
    expect(report.reportText).toContain('Net Profit Factor (after costs)');
    expect(report.reportText).toContain('Trading costs');
    expect(report.reportText).toContain('Profit Factor');
    expect(report.reportMarkdown).toContain('## 调参建议');
  });

  test('aggregates breakeven metrics by trade counts instead of averaging rates', () => {
    const results = [
      {
        symbol: 'EURUSD',
        strategy: 'Breakout',
        status: 'completed',
        summary: {
          totalTrades: 10,
          winningTrades: 6,
          losingTrades: 4,
          winRate: 0.6,
          profitFactor: 1.5,
          returnPercent: 2,
          maxDrawdownPercent: 4,
          netProfitMoney: 200,
          grossProfitMoney: 600,
          grossLossMoney: 400,
          netWinningTrades: 6,
          netLosingTrades: 4,
          netGrossProfitMoney: 600,
          netGrossLossMoney: 400,
          netProfitFactor: 1.5,
          breakevenExitTrades: 2,
          breakevenTriggeredTrades: 4,
          requiredBreakevenWinRate: 0.4,
          totalTradingCosts: 0,
        },
      },
      {
        symbol: 'USDJPY',
        strategy: 'Breakout',
        status: 'completed',
        summary: {
          totalTrades: 5,
          winningTrades: 4,
          losingTrades: 1,
          winRate: 0.8,
          profitFactor: 4,
          returnPercent: 3,
          maxDrawdownPercent: 2,
          netProfitMoney: 300,
          grossProfitMoney: 400,
          grossLossMoney: 100,
          netWinningTrades: 4,
          netLosingTrades: 1,
          netGrossProfitMoney: 400,
          netGrossLossMoney: 100,
          netProfitFactor: 4,
          breakevenExitTrades: 1,
          breakevenTriggeredTrades: 1,
          requiredBreakevenWinRate: 0.2,
          totalTradingCosts: 0,
        },
      },
    ];

    const aggregate = buildBatchAggregate(results, { initialBalance: 10000 });
    const breakout = aggregate.byStrategy.find((item) => item.strategy === 'Breakout');

    expect(aggregate.portfolio.totalTrades).toBe(15);
    expect(aggregate.portfolio.breakevenExitTrades).toBe(3);
    expect(aggregate.portfolio.breakevenExitRate).toBe(0.2);
    expect(aggregate.portfolio.breakevenTriggeredTrades).toBe(5);
    expect(aggregate.portfolio.breakevenTriggerRate).toBe(0.3333);
    expect(aggregate.portfolio.requiredBreakevenWinRate).toBe(0.5);

    expect(breakout.breakevenExitTrades).toBe(3);
    expect(breakout.breakevenExitRate).toBe(0.2);
    expect(breakout.breakevenTriggeredTrades).toBe(5);
    expect(breakout.breakevenTriggerRate).toBe(0.3333);
    expect(breakout.requiredBreakevenWinRate).toBe(0.3333);
  });
});
