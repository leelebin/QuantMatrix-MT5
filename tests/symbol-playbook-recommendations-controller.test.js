const mockGetPlaybookRecommendations = jest.fn();

jest.mock('../src/services/playbookRecommendationService', () => ({
  getPlaybookRecommendations: mockGetPlaybookRecommendations,
}));

const symbolPlaybookController = require('../src/controllers/symbolPlaybookController');

function createRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    },
  };
}

describe('symbol playbook recommendations controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns recommendation report in API shape', async () => {
    mockGetPlaybookRecommendations.mockResolvedValue({
      scope: 'paper',
      since: '2026-04-27T00:00:00.000Z',
      count: 1,
      recommendations: [
        {
          symbol: 'XAUUSD',
          currentRole: 'growth_engine',
          currentLiveBias: 'allowed_observe',
          dataSummary: {
            trades: 6,
            playbookReportRecommendation: 'KEEP_AS_GROWTH_ENGINE',
          },
          suggestedAction: 'KEEP_CURRENT',
          suggestedRiskWeight: 1,
          suggestedBeStyle: 'medium_loose',
          suggestedEntryStyle: 'pullback_after_breakout',
          reason: 'Playbook and recent report do not require a configuration change suggestion.',
        },
      ],
    });
    const res = createRes();

    await symbolPlaybookController.getPlaybookRecommendations({
      query: { since: '2026-04-27' },
    }, res);

    expect(mockGetPlaybookRecommendations).toHaveBeenCalledWith({
      since: '2026-04-27',
      scope: undefined,
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      scope: 'paper',
      since: '2026-04-27T00:00:00.000Z',
      count: 1,
      recommendations: [
        expect.objectContaining({
          symbol: 'XAUUSD',
          suggestedAction: 'KEEP_CURRENT',
        }),
      ],
    });
  });
});
