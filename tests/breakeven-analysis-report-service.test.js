const mockPaperRows = [];
const mockLiveRows = [];

function mockCursor(rows) {
  return {
    sort: jest.fn(() => Promise.resolve([...rows])),
  };
}

jest.mock('../src/config/db', () => ({
  tradeLogDb: {
    find: jest.fn(() => mockCursor(mockPaperRows)),
  },
  tradesDb: {
    find: jest.fn(() => mockCursor(mockLiveRows)),
  },
}));

const { tradeLogDb, tradesDb } = require('../src/config/db');
const {
  UNKNOWN_BE_STYLE,
  UNKNOWN_SETUP_TYPE,
  buildRecommendation,
  getBreakevenAnalysisReport,
  isBreakevenExit,
} = require('../src/services/breakevenAnalysisReportService');

function closedTrade(overrides = {}) {
  return {
    symbol: 'XAUUSD',
    strategy: 'Breakout',
    setupType: 'event_breakout',
    beStyle: 'medium_loose',
    status: 'CLOSED',
    closedAt: new Date('2026-04-28T12:00:00.000Z'),
    openedAt: new Date('2026-04-28T11:00:00.000Z'),
    profitLoss: 0,
    plannedRiskAmount: 100,
    realizedRMultiple: 0,
    exitReason: 'BREAKEVEN_SL_HIT',
    ...overrides,
  };
}

describe('breakevenAnalysisReportService', () => {
  beforeEach(() => {
    mockPaperRows.length = 0;
    mockLiveRows.length = 0;
    jest.clearAllMocks();
  });

  test('aggregates BE metrics by symbol strategy setupType and beStyle', async () => {
    mockPaperRows.push(
      closedTrade(),
      closedTrade({ profitLoss: 5, realizedRMultiple: 0.05 }),
      closedTrade({
        plannedRiskAmount: 120,
        missedProfitAfterBEEstimate: 30,
        realizedRMultiple: 0.02,
      }),
      closedTrade({
        exitReason: 'TP_HIT',
        profitLoss: 200,
        realizedRMultiple: 2,
      }),
      closedTrade({
        symbol: 'XAGUSD',
        strategy: 'Momentum',
        setupType: 'momentum_continuation',
        beStyle: 'medium_loose',
        exitReason: 'SL_HIT',
        protectiveStopState: { phase: 'breakeven' },
        profitLoss: 0,
        realizedRMultiple: 0,
      }),
      closedTrade({
        symbol: 'OLDUSD',
        strategy: '',
        setupType: '',
        beStyle: '',
        exitReason: 'MANUAL',
        profitLoss: -10,
        plannedRiskAmount: null,
        realizedRMultiple: null,
      }),
      closedTrade({
        exitReason: 'BREAKEVEN_SL_HIT',
        profitLoss: 999,
        closedAt: new Date('2026-04-20T12:00:00.000Z'),
        openedAt: new Date('2026-04-20T11:00:00.000Z'),
      }),
      closedTrade({
        status: 'OPEN',
        exitReason: 'BREAKEVEN_SL_HIT',
        profitLoss: 999,
      })
    );

    const report = await getBreakevenAnalysisReport({ since: '2026-04-27' });

    expect(tradeLogDb.find).toHaveBeenCalledWith({
      status: 'CLOSED',
      $or: [
        { closedAt: { $gte: expect.any(Date) } },
        { openedAt: { $gte: expect.any(Date) } },
      ],
    });
    expect(tradesDb.find).not.toHaveBeenCalled();
    expect(report.scope).toBe('paper');
    expect(report.count).toBe(3);
    expect(report.totalTrades).toBe(6);

    const xauusd = report.groups.find((row) => row.symbol === 'XAUUSD');
    expect(xauusd).toEqual(expect.objectContaining({
      symbol: 'XAUUSD',
      strategy: 'Breakout',
      setupType: 'event_breakout',
      beStyle: 'medium_loose',
      totalTrades: 4,
      beExitCount: 3,
      beExitRate: 0.75,
      protectedLossEstimate: 320,
      missedProfitAfterBEEstimate: 30,
      avgRealizedR: 0.5175,
      recommendation: 'KEEP_TIGHT_BE',
      availableMetrics: {
        realizedRCount: 4,
        protectedLossEstimateCount: 3,
        missedProfitAfterBEEstimateCount: 1,
        beExitCount: 3,
      },
    }));

    const legacy = report.groups.find((row) => row.symbol === 'OLDUSD');
    expect(legacy).toEqual(expect.objectContaining({
      strategy: 'Unknown',
      setupType: UNKNOWN_SETUP_TYPE,
      beStyle: UNKNOWN_BE_STYLE,
      totalTrades: 1,
      beExitCount: 0,
      protectedLossEstimate: null,
      missedProfitAfterBEEstimate: null,
      avgRealizedR: null,
      recommendation: 'NEED_MORE_DATA',
    }));
  });

  test('does not guess missed profit after BE when no post-BE metric exists', async () => {
    mockPaperRows.push(
      closedTrade({ plannedRiskAmount: 100 }),
      closedTrade({ plannedRiskAmount: 100 }),
      closedTrade({ plannedRiskAmount: 100 })
    );

    const report = await getBreakevenAnalysisReport({ since: '2026-04-27' });

    expect(report.groups[0]).toEqual(expect.objectContaining({
      beExitCount: 3,
      protectedLossEstimate: 300,
      missedProfitAfterBEEstimate: null,
      recommendation: 'NEUTRAL',
      availableMetrics: expect.objectContaining({
        missedProfitAfterBEEstimateCount: 0,
      }),
    }));
  });

  test('uses explicit post-BE R metric with planned risk for loosen recommendation', async () => {
    mockPaperRows.push(
      closedTrade({ plannedRiskAmount: 100, postBeMaxFavourableR: 2 }),
      closedTrade({ plannedRiskAmount: 100, postBeMaxFavourableR: 2 }),
      closedTrade({ plannedRiskAmount: 100, postBeMaxFavourableR: 2 })
    );

    const report = await getBreakevenAnalysisReport({ since: '2026-04-27' });

    expect(report.groups[0]).toEqual(expect.objectContaining({
      protectedLossEstimate: 300,
      missedProfitAfterBEEstimate: 600,
      recommendation: 'CONSIDER_LOOSEN_BE',
    }));
  });

  test('recognizes BE exit from management events and supports live scope', async () => {
    mockLiveRows.push(
      closedTrade({
        symbol: 'EURUSD',
        strategy: 'Momentum',
        setupType: 'm15_intraday_pullback',
        beStyle: 'tight',
        exitReason: 'SL_HIT',
        protectiveStopState: null,
        managementEvents: [
          { type: 'BREAKEVEN', status: 'APPLIED', phase: 'breakeven', newSl: 1.1 },
        ],
      })
    );

    const report = await getBreakevenAnalysisReport({ since: '2026-04-27', scope: 'live' });

    expect(tradesDb.find).toHaveBeenCalledTimes(1);
    expect(tradeLogDb.find).not.toHaveBeenCalled();
    expect(report.scope).toBe('live');
    expect(report.groups[0]).toEqual(expect.objectContaining({
      symbol: 'EURUSD',
      beExitCount: 1,
      protectedLossEstimate: 100,
      recommendation: 'NEED_MORE_DATA',
    }));
    expect(isBreakevenExit(mockLiveRows[0])).toBe(true);
  });

  test('recommendation rules stay conservative for small samples and unavailable comparisons', () => {
    expect(buildRecommendation({
      beExitCount: 2,
      protectedLossEstimate: 1000,
      missedProfitAfterBEEstimate: 5000,
    })).toBe('NEED_MORE_DATA');

    expect(buildRecommendation({
      beExitCount: 3,
      protectedLossEstimate: 100,
      missedProfitAfterBEEstimate: null,
    })).toBe('NEUTRAL');
  });

  test('rejects unsupported scope and invalid since date', async () => {
    await expect(getBreakevenAnalysisReport({ scope: 'demo' })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Unsupported breakeven report scope: demo',
    });

    await expect(getBreakevenAnalysisReport({ since: 'not-a-date' })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Invalid breakeven report since date: not-a-date',
    });
  });
});
