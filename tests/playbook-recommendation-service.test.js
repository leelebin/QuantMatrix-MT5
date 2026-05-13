const mockGetSymbolPlaybookReport = jest.fn();
const mockGetBreakevenAnalysisReport = jest.fn();

jest.mock('../src/services/symbolPlaybookReportService', () => ({
  getSymbolPlaybookReport: mockGetSymbolPlaybookReport,
}));

jest.mock('../src/services/breakevenAnalysisReportService', () => ({
  getBreakevenAnalysisReport: mockGetBreakevenAnalysisReport,
}));

const {
  SUGGESTED_ACTIONS,
  buildPlaybookRecommendationsFromReports,
  getPlaybookRecommendations,
  shouldConsiderEntryRefinement,
} = require('../src/services/playbookRecommendationService');

function symbolSummary(overrides = {}) {
  return {
    symbol: 'XAUUSD',
    trades: 6,
    netPnl: 600,
    profitFactor: 2,
    profitFactorLabel: null,
    winRate: 0.66,
    avgR: 0.5,
    bestSetupType: 'event_breakout',
    worstSetupType: 'trend_pullback',
    recommendation: 'KEEP_AS_GROWTH_ENGINE',
    ...overrides,
  };
}

describe('playbookRecommendationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('builds conservative recommendations from playbook and BE reports', () => {
    const report = buildPlaybookRecommendationsFromReports(
      {
        scope: 'paper',
        since: '2026-04-27T00:00:00.000Z',
        symbols: [
          symbolSummary(),
          symbolSummary({
            symbol: 'NAS100',
            trades: 8,
            netPnl: 420,
            profitFactor: 1.8,
            avgR: 0.3,
            bestSetupType: 'us_session_momentum',
            worstSetupType: 'post_news_continuation',
          }),
          symbolSummary({
            symbol: 'GBPUSD',
            trades: 10,
            netPnl: -80,
            profitFactor: 0.5,
            avgR: -0.2,
            recommendation: 'DISABLE_SUGGESTED',
          }),
          symbolSummary({
            symbol: 'USDCAD',
            trades: 5,
            netPnl: -20,
            profitFactor: 0.9,
            avgR: -0.05,
            recommendation: 'PAPER_ONLY',
          }),
          symbolSummary({
            symbol: 'BTCUSD',
            trades: 2,
            netPnl: 100,
            profitFactor: 3,
            avgR: 1,
            recommendation: 'NEED_MORE_DATA',
          }),
          symbolSummary({
            symbol: 'XTIUSD',
            trades: 6,
            netPnl: 90,
            profitFactor: 1.2,
            avgR: 0.12,
            recommendation: 'KEEP_SMALL',
          }),
          symbolSummary({
            symbol: 'XAGUSD',
            trades: 7,
            netPnl: 20,
            profitFactor: 1.05,
            avgR: 0.03,
            recommendation: 'NEED_MORE_DATA',
          }),
          symbolSummary({
            symbol: 'UNKNOWNUSD',
            trades: 6,
            netPnl: 30,
            profitFactor: 1.3,
            avgR: 0.2,
            recommendation: 'KEEP_SMALL',
          }),
        ],
      },
      {
        scope: 'paper',
        since: '2026-04-27T00:00:00.000Z',
        groups: [
          {
            symbol: 'NAS100',
            strategy: 'Momentum',
            setupType: 'us_session_momentum',
            beStyle: 'medium',
            totalTrades: 8,
            beExitCount: 3,
            protectedLossEstimate: 100,
            missedProfitAfterBEEstimate: 300,
            avgRealizedR: 0.2,
            availableMetrics: {
              realizedRCount: 8,
              protectedLossEstimateCount: 3,
              missedProfitAfterBEEstimateCount: 3,
            },
            recommendation: 'CONSIDER_LOOSEN_BE',
          },
        ],
      }
    );

    expect(report).toEqual(expect.objectContaining({
      scope: 'paper',
      since: '2026-04-27T00:00:00.000Z',
      count: expect.any(Number),
      recommendations: expect.any(Array),
    }));

    for (const recommendation of report.recommendations) {
      expect(SUGGESTED_ACTIONS).toContain(recommendation.suggestedAction);
    }

    expect(report.recommendations.find((row) => row.symbol === 'XAUUSD')).toEqual(expect.objectContaining({
      currentRole: 'growth_engine',
      currentLiveBias: 'allowed_observe',
      suggestedAction: 'KEEP_CURRENT',
      suggestedRiskWeight: 1,
      suggestedBeStyle: 'medium_loose',
      suggestedEntryStyle: 'pullback_after_breakout',
      dataSummary: expect.objectContaining({
        trades: 6,
        playbookReportRecommendation: 'KEEP_AS_GROWTH_ENGINE',
      }),
    }));

    expect(report.recommendations.find((row) => row.symbol === 'NAS100')).toEqual(expect.objectContaining({
      suggestedAction: 'CONSIDER_BE_LOOSENING',
      suggestedBeStyle: 'medium_loose',
      dataSummary: expect.objectContaining({
        be: expect.objectContaining({
          beExitCount: 3,
          missedProfitAfterBEEstimate: 300,
          recommendation: 'CONSIDER_LOOSEN_BE',
        }),
      }),
    }));

    expect(report.recommendations.find((row) => row.symbol === 'GBPUSD')).toEqual(expect.objectContaining({
      suggestedAction: 'DISABLE_RECOMMENDED',
      suggestedRiskWeight: 0,
    }));

    expect(report.recommendations.find((row) => row.symbol === 'USDCAD')).toEqual(expect.objectContaining({
      suggestedAction: 'PAPER_ONLY_RECOMMENDED',
      suggestedRiskWeight: 0.225,
    }));

    expect(report.recommendations.find((row) => row.symbol === 'BTCUSD')).toEqual(expect.objectContaining({
      suggestedAction: 'OBSERVE_MORE',
    }));

    expect(report.recommendations.find((row) => row.symbol === 'XTIUSD')).toEqual(expect.objectContaining({
      currentRole: 'event_driven_growth',
      currentLiveBias: 'allowed_observe',
      suggestedAction: 'REDUCE_RISK',
      suggestedRiskWeight: 0.4,
    }));

    expect(report.recommendations.find((row) => row.symbol === 'XAGUSD')).toEqual(expect.objectContaining({
      suggestedAction: 'CONSIDER_ENTRY_REFINEMENT',
      suggestedRiskWeight: 0.8,
    }));

    expect(report.recommendations.find((row) => row.symbol === 'UNKNOWNUSD')).toEqual(expect.objectContaining({
      currentRole: 'unclassified',
      currentLiveBias: 'paper_first',
    }));
  });

  test('fetches symbol and BE reports without mutating configuration', async () => {
    const symbolReport = {
      scope: 'paper',
      since: '2026-04-27T00:00:00.000Z',
      symbols: [symbolSummary()],
    };
    const beReport = {
      scope: 'paper',
      since: '2026-04-27T00:00:00.000Z',
      groups: [],
    };

    mockGetSymbolPlaybookReport.mockResolvedValue(symbolReport);
    mockGetBreakevenAnalysisReport.mockResolvedValue(beReport);

    const report = await getPlaybookRecommendations({ since: '2026-04-27' });

    expect(mockGetSymbolPlaybookReport).toHaveBeenCalledWith({
      since: '2026-04-27',
      scope: 'paper',
    });
    expect(mockGetBreakevenAnalysisReport).toHaveBeenCalledWith({
      since: '2026-04-27',
      scope: 'paper',
    });
    expect(report.recommendations.find((row) => row.symbol === 'XAUUSD')).toEqual(expect.objectContaining({
      suggestedAction: 'KEEP_CURRENT',
    }));
  });

  test('entry refinement rule only triggers after enough thin positive samples', () => {
    expect(shouldConsiderEntryRefinement({
      trades: 4,
      netPnl: 50,
      profitFactor: 1.01,
      avgR: 0.02,
    })).toBe(false);

    expect(shouldConsiderEntryRefinement({
      trades: 5,
      netPnl: 50,
      profitFactor: 1.01,
      avgR: 0.02,
    })).toBe(true);
  });
});
