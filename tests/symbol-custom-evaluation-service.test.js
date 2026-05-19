const evaluationService = require('../src/services/symbolCustomEvaluationService');

function trade(overrides = {}) {
  return {
    symbol: 'USDJPY',
    symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
    logicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
    side: 'BUY',
    entryTime: '2026-01-01T00:00:00.000Z',
    exitTime: '2026-01-01T00:05:00.000Z',
    exitReason: 'TP',
    pnl: 1,
    ...overrides,
  };
}

function buildBacktest(overrides = {}) {
  return {
    symbol: 'USDJPY',
    symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    initialBalance: 500,
    summary: {
      trades: 8,
      netPnl: -10,
      profitFactor: 0.8,
      winRate: 0.375,
      maxDrawdown: 180,
      maxDrawdownPercent: 36,
    },
    costModelUsed: { spread: 0, commissionPerTrade: 0, slippage: 0 },
    trades: [
      trade({ side: 'BUY', entryTime: '2026-01-01T00:00:00.000Z', exitTime: '2026-01-01T00:05:00.000Z', pnl: 10, exitReason: 'TP' }),
      trade({ side: 'BUY', entryTime: '2026-01-01T00:20:00.000Z', exitTime: '2026-01-01T00:25:00.000Z', pnl: -5, exitReason: 'SL' }),
      trade({ side: 'SELL', entryTime: '2026-01-01T01:00:00.000Z', exitTime: '2026-01-01T01:05:00.000Z', pnl: -6, exitReason: 'SL' }),
      trade({ side: 'SELL', entryTime: '2026-01-01T01:20:00.000Z', exitTime: '2026-01-01T01:25:00.000Z', pnl: -4, exitReason: 'SL' }),
      trade({ side: 'SELL', entryTime: '2026-01-01T02:00:00.000Z', exitTime: '2026-01-01T02:05:00.000Z', pnl: -3, exitReason: 'CUSTOM_CLOSE' }),
      trade({ side: 'SELL', entryTime: '2026-01-01T02:20:00.000Z', exitTime: '2026-01-01T02:25:00.000Z', pnl: -2, exitReason: 'END_OF_BACKTEST' }),
      trade({ side: 'SELL', entryTime: '2026-01-02T03:00:00.000Z', exitTime: '2026-01-02T03:05:00.000Z', pnl: -1, exitReason: 'AMBIGUOUS_SL_TP_SAME_BAR_SL_FIRST' }),
      trade({ side: 'SELL', entryTime: '2026-01-02T03:30:00.000Z', exitTime: '2026-01-02T03:35:00.000Z', pnl: 1, exitReason: 'TP' }),
    ],
    ...overrides,
  };
}

describe('symbolCustomEvaluationService', () => {
  test('directionBreakdown BUY/SELL is correct', () => {
    const report = evaluationService.evaluateSymbolCustomBacktest(buildBacktest());

    expect(report.directionBreakdown.BUY).toEqual(expect.objectContaining({
      trades: 2,
      wins: 1,
      losses: 1,
      netPnl: 5,
      grossWin: 10,
      grossLoss: 5,
      profitFactor: 2,
      winRate: 0.5,
      avgPnl: 2.5,
    }));
    expect(report.directionBreakdown.SELL.trades).toBe(6);
    expect(report.directionBreakdown.SELL.netPnl).toBe(-15);
  });

  test('exitReasonBreakdown is correct', () => {
    const report = evaluationService.evaluateSymbolCustomBacktest(buildBacktest());

    expect(report.exitReasonBreakdown.TP.trades).toBe(2);
    expect(report.exitReasonBreakdown.TP.netPnl).toBe(11);
    expect(report.exitReasonBreakdown.SL.trades).toBe(3);
    expect(report.exitReasonBreakdown.SL.netPnl).toBe(-15);
    expect(report.exitReasonBreakdown.CUSTOM_CLOSE.trades).toBe(1);
    expect(report.exitReasonBreakdown.END_OF_BACKTEST.trades).toBe(1);
    expect(report.exitReasonBreakdown.AMBIGUOUS_SL_TP_SAME_BAR_SL_FIRST.trades).toBe(1);
  });

  test('hourlyBreakdownUtc is correct', () => {
    const report = evaluationService.evaluateSymbolCustomBacktest(buildBacktest());

    expect(report.hourlyBreakdownUtc['0']).toEqual(expect.objectContaining({
      trades: 2,
      netPnl: 5,
      profitFactor: 2,
      winRate: 0.5,
    }));
    expect(report.hourlyBreakdownUtc['1'].netPnl).toBe(-10);
  });

  test('monthlyBreakdown is correct', () => {
    const report = evaluationService.evaluateSymbolCustomBacktest(buildBacktest());

    expect(report.monthlyBreakdown['2026-01']).toEqual(expect.objectContaining({
      trades: 8,
      netPnl: -10,
      winRate: 0.25,
    }));
  });

  test('consecutiveLossAnalysis is correct', () => {
    const report = evaluationService.evaluateSymbolCustomBacktest(buildBacktest());

    expect(report.consecutiveLossAnalysis).toEqual(expect.objectContaining({
      maxConsecutiveLosses: 6,
      maxConsecutiveWins: 1,
      longestLossStreakStart: '2026-01-01T00:20:00.000Z',
      longestLossStreakEnd: '2026-01-02T03:05:00.000Z',
      lossStreaksOver3: 1,
      lossStreaksOver5: 1,
    }));
  });

  test('tradeFrequencyAnalysis is correct', () => {
    const report = evaluationService.evaluateSymbolCustomBacktest(buildBacktest());

    expect(report.tradeFrequencyAnalysis.tradesPerDay).toBe(4);
    expect(report.tradeFrequencyAnalysis.entriesWithin15m).toBe(0);
    expect(report.tradeFrequencyAnalysis.entriesWithin30m).toBe(4);
    expect(report.tradeFrequencyAnalysis.entriesWithin60m).toBe(6);
    expect(report.tradeFrequencyAnalysis.averageMinutesBetweenEntries).toBeGreaterThan(0);
  });

  test('costSensitivity is correct', () => {
    const report = evaluationService.evaluateSymbolCustomBacktest(buildBacktest({
      summary: { trades: 2, netPnl: 0.2, profitFactor: 1.05, winRate: 0.5, maxDrawdownPercent: 5 },
      trades: [
        trade({ pnl: 1.2, exitReason: 'TP' }),
        trade({ pnl: -1, exitReason: 'SL' }),
      ],
    }));

    expect(report.costSensitivity.zeroCost.netPnlAfterCost).toBeCloseTo(0.2);
    expect(report.costSensitivity.mediumCost.netPnlAfterCost).toBeCloseTo(-0.8);
    expect(report.costSensitivity.zeroCost.profitableAfterCost).toBe(true);
    expect(report.costSensitivity.mediumCost.profitableAfterCost).toBe(false);
    expect(report.recommendation.codes).toContain('COST_FRAGILE');
  });

  test('weak PF returns NO_EDGE and high drawdown returns RISK_TOO_HIGH', () => {
    const report = evaluationService.evaluateSymbolCustomBacktest(buildBacktest());

    expect(report.recommendation.codes).toContain('NO_EDGE');
    expect(report.recommendation.codes).toContain('RISK_TOO_HIGH');
  });

  test('one losing direction returns DIRECTION_FILTER_REQUIRED', () => {
    const report = evaluationService.evaluateSymbolCustomBacktest(buildBacktest());

    expect(report.recommendation.codes).toContain('DIRECTION_FILTER_REQUIRED');
  });
});
