jest.mock('../src/config/db', () => ({
  backtestsDb: {
    insert: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
  },
}));

const backtestEngine = require('../src/services/backtestEngine');

function makeTrade(profitLoss, index, realizedRMultiple = profitLoss / 100) {
  return {
    profitPips: profitLoss / 10,
    grossProfitLoss: profitLoss,
    profitLoss,
    realizedRMultiple,
    entryTime: new Date(Date.UTC(2026, 0, 1, index, 0)).toISOString(),
    exitTime: new Date(Date.UTC(2026, 0, 1, index, 1)).toISOString(),
  };
}

function summarize(trades, equityCurve = null) {
  const initialBalance = 10000;
  const netProfit = trades.reduce((sum, trade) => sum + trade.profitLoss, 0);
  return backtestEngine._generateSummary(
    trades,
    initialBalance,
    initialBalance + netProfit,
    equityCurve || [
      { time: '2026-01-01T00:00:00.000Z', equity: initialBalance },
      { time: '2026-01-31T00:00:00.000Z', equity: initialBalance + netProfit },
    ]
  );
}

describe('backtest robust score summary fields', () => {
  test('empty summaries still expose finite robust fields', () => {
    const summary = summarize([]);

    expect(Number.isFinite(summary.robustScore)).toBe(true);
    expect(summary.robustScore).toBe(0);
    expect(summary.sampleQuality).toBe('VERY_LOW');
    expect(summary.payoffRatio).toBe(0);
    expect(summary.profitConcentrationTop5).toBe(0);
    expect(Array.isArray(summary.warningFlags)).toBe(true);
    expect(summary.warningFlags).toEqual(expect.arrayContaining([
      'VERY_SMALL_SAMPLE',
      'LOW_TRADE_COUNT',
    ]));
  });

  test('high profit factor with very few trades is penalized as sample-sensitive', () => {
    const trades = [
      ...Array.from({ length: 5 }, (_, index) => makeTrade(100, index, 1)),
      makeTrade(-10, 5, -0.1),
      ...Array.from({ length: 4 }, (_, index) => makeTrade(100, index + 6, 1)),
    ];

    const summary = summarize(trades);

    expect(summary.profitFactor).toBeGreaterThan(2);
    expect(summary.robustScore).toBeLessThan(60);
    expect(summary.warningFlags).toEqual(expect.arrayContaining([
      'SMALL_SAMPLE',
      'VERY_SMALL_SAMPLE',
      'LOW_TRADE_COUNT',
    ]));
  });

  test('flags when one trade contributes more than half of net profit', () => {
    const trades = [
      makeTrade(1000, 0, 2),
      ...Array.from({ length: 59 }, (_, index) => makeTrade(10, index + 1, 0.1)),
    ];

    const summary = summarize(trades);

    expect(summary.profitConcentrationTop1).toBeGreaterThan(0.5);
    expect(summary.warningFlags).toContain('PROFIT_CONCENTRATED');
  });

  test('flags average loss larger than average win when win-rate safety margin is thin', () => {
    const trades = [];
    for (let index = 0; index < 35; index++) {
      trades.push(makeTrade(100, trades.length, 0.5));
      trades.push(makeTrade(-150, trades.length, -0.75));
    }
    for (let index = 0; index < 30; index++) {
      trades.push(makeTrade(100, trades.length, 0.5));
    }

    const summary = summarize(trades);

    expect(summary.winRate).toBe(0.65);
    expect(summary.averageWinMoney).toBe(100);
    expect(summary.averageLossMoney).toBe(-150);
    expect(summary.warningFlags).toContain('AVG_LOSS_GT_AVG_WIN');
  });

  test('flags non-positive expectancy', () => {
    const trades = [];
    for (let index = 0; index < 50; index++) {
      trades.push(makeTrade(50, trades.length, 0.5));
      trades.push(makeTrade(-70, trades.length, -0.7));
    }

    const summary = summarize(trades);

    expect(summary.expectancyPerTrade).toBeLessThanOrEqual(0);
    expect(summary.warningFlags).toContain('LOW_EXPECTANCY');
  });

  test('flags high drawdown', () => {
    const trades = [];
    for (let index = 0; index < 30; index++) {
      trades.push(makeTrade(100, trades.length, 0.7));
      trades.push(makeTrade(-50, trades.length, -0.3));
    }
    for (let index = 0; index < 40; index++) {
      trades.push(makeTrade(100, trades.length, 0.7));
    }

    const summary = summarize(trades, [
      { time: '2026-01-01T00:00:00.000Z', equity: 10000 },
      { time: '2026-01-10T00:00:00.000Z', equity: 12000 },
      { time: '2026-01-15T00:00:00.000Z', equity: 8500 },
      { time: '2026-01-31T00:00:00.000Z', equity: 15500 },
    ]);

    expect(summary.maxDrawdownPercent).toBeGreaterThan(25);
    expect(summary.warningFlags).toContain('HIGH_DRAWDOWN');
  });

  test('healthy strategy receives a high score without severe warnings', () => {
    const trades = [];
    for (let index = 0; index < 50; index++) {
      trades.push(makeTrade(120, trades.length, 0.6));
      trades.push(makeTrade(-60, trades.length, -0.3));
    }
    for (let index = 0; index < 20; index++) {
      trades.push(makeTrade(120, trades.length, 0.6));
    }

    const summary = summarize(trades);

    expect(summary.robustScore).toBeGreaterThan(75);
    expect(summary.warningFlags).toEqual([]);
    expect(summary.averageWinMoney).toBe(120);
    expect(summary.averageLossMoney).toBe(-60);
    expect(summary.payoffRatio).toBe(2);
    expect(summary.sampleQuality).toBe('HIGH');
    expect(summary.profitConcentrationTop5).toBeGreaterThanOrEqual(summary.profitConcentrationTop3);
    expect(summary.avgRealizedR).toBeGreaterThan(0);
    expect(summary.medianRealizedR).toBeGreaterThan(0);
  });

  test('new optimizer summary fields remain finite and JSON-safe', () => {
    const trades = [
      ...Array.from({ length: 35 }, (_, index) => makeTrade(100, index, 1)),
    ];

    const summary = summarize(trades);
    const requiredFields = [
      'robustScore',
      'expectancyPerTrade',
      'payoffRatio',
      'returnToDrawdown',
      'avgRealizedR',
      'medianRealizedR',
      'profitConcentrationTop1',
      'profitConcentrationTop3',
      'profitConcentrationTop5',
    ];

    requiredFields.forEach((field) => {
      expect(Number.isFinite(summary[field])).toBe(true);
    });
    expect(Array.isArray(summary.warningFlags)).toBe(true);
    expect(typeof summary.sampleQuality).toBe('string');
    expect(JSON.stringify(summary)).not.toMatch(/NaN|Infinity/);
  });
});
