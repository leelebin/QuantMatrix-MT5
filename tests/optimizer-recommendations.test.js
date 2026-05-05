jest.mock('../src/config/db', () => ({
  backtestsDb: {
    insert: jest.fn(),
    find: jest.fn(() => ({
      sort: jest.fn(() => ({
        limit: jest.fn().mockResolvedValue([]),
      })),
    })),
    findOne: jest.fn(),
    remove: jest.fn(),
  },
}));

jest.mock('../src/services/backtestEngine', () => ({
  simulate: jest.fn(),
}));

const backtestEngine = require('../src/services/backtestEngine');
const optimizerService = require('../src/services/optimizerService');
const {
  RECOMMENDATION_TIERS,
  buildOptimizerRecommendation,
} = require('../src/utils/optimizerRecommendations');

function makeSummary(overrides = {}) {
  return {
    totalTrades: 80,
    robustScore: 75,
    profitFactor: 1.5,
    expectancyPerTrade: 25,
    netProfitMoney: 1200,
    maxDrawdownPercent: 10,
    warningFlags: [],
    returnToDrawdown: 3,
    avgRealizedR: 0.4,
    medianRealizedR: 0.25,
    ...overrides,
  };
}

function baseOptimizerParams(overrides = {}) {
  return {
    symbol: 'EURUSD',
    strategyType: 'TrendFollowing',
    timeframe: '1h',
    candles: [
      { time: '2026-01-01T00:00:00.000Z', open: 1, high: 2, low: 0.5, close: 1.5 },
    ],
    paramRanges: {
      score: { min: 1, max: 4, step: 1 },
    },
    parallelWorkers: 1,
    minimumTrades: 5,
    optimizeFor: 'robustScore',
    ...overrides,
  };
}

describe('optimizer recommendations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('healthy high-quality result becomes LIVE_CANDIDATE', () => {
    const recommendation = buildOptimizerRecommendation({
      summary: makeSummary({
        totalTrades: 120,
        robustScore: 86,
        profitFactor: 1.9,
        maxDrawdownPercent: 8,
      }),
    }, { symbol: 'EURUSD' });

    expect(recommendation).toEqual(expect.objectContaining({
      tier: RECOMMENDATION_TIERS.LIVE_CANDIDATE,
      suggestedRiskPerTrade: 0.005,
    }));
    expect(recommendation.reasons.join(' ')).toContain('Meets live-candidate thresholds');
  });

  test('small-sample high profit factor result is INSUFFICIENT_SAMPLE', () => {
    const recommendation = buildOptimizerRecommendation({
      summary: makeSummary({
        totalTrades: 12,
        robustScore: 30,
        profitFactor: 8,
        warningFlags: ['VERY_SMALL_SAMPLE'],
      }),
    }, { symbol: 'EURUSD' });

    expect(recommendation.tier).toBe(RECOMMENDATION_TIERS.INSUFFICIENT_SAMPLE);
    expect(recommendation.suggestedRiskPerTrade).toBeNull();
  });

  test('profitable but concentrated result is PAPER_ONLY', () => {
    const recommendation = buildOptimizerRecommendation({
      summary: makeSummary({
        totalTrades: 70,
        robustScore: 62,
        profitFactor: 1.4,
        warningFlags: ['PROFIT_CONCENTRATED'],
      }),
    }, { symbol: 'EURUSD' });

    expect(recommendation.tier).toBe(RECOMMENDATION_TIERS.PAPER_ONLY);
    expect(recommendation.suggestedRiskPerTrade).toBe(0.001);
    expect(recommendation.riskNotes.join(' ')).toContain('Profit is concentrated');
  });

  test('negative expectancy is REJECT', () => {
    const recommendation = buildOptimizerRecommendation({
      summary: makeSummary({
        expectancyPerTrade: -1,
        robustScore: 45,
      }),
    }, { symbol: 'EURUSD' });

    expect(recommendation.tier).toBe(RECOMMENDATION_TIERS.REJECT);
    expect(recommendation.reasons).toContain('expectancyPerTrade is not positive.');
  });

  test('very high drawdown is REJECT', () => {
    const recommendation = buildOptimizerRecommendation({
      summary: makeSummary({
        maxDrawdownPercent: 32,
        warningFlags: ['HIGH_DRAWDOWN'],
      }),
    }, { symbol: 'EURUSD' });

    expect(recommendation.tier).toBe(RECOMMENDATION_TIERS.REJECT);
    expect(recommendation.reasons).toContain('max drawdown is above 25%.');
  });

  test('optimizer result attaches per-row recommendations and summary counts', async () => {
    backtestEngine.simulate.mockImplementation(async (params) => {
      const score = params.strategyParams.score;
      const summaries = {
        1: makeSummary({
          totalTrades: 120,
          robustScore: 86,
          profitFactor: 1.9,
          maxDrawdownPercent: 8,
        }),
        2: makeSummary({
          totalTrades: 70,
          robustScore: 62,
          profitFactor: 1.4,
          warningFlags: ['PROFIT_CONCENTRATED'],
        }),
        3: makeSummary({
          totalTrades: 60,
          robustScore: 45,
          expectancyPerTrade: -1,
        }),
        4: makeSummary({
          totalTrades: 12,
          robustScore: 30,
          profitFactor: 8,
          warningFlags: ['VERY_SMALL_SAMPLE'],
        }),
      };

      return {
        parameters: { ...params.strategyParams },
        parameterSource: 'test',
        summary: summaries[score],
      };
    });

    const result = await optimizerService.run(baseOptimizerParams());

    expect(result.bestResult.recommendation.tier).toBe(RECOMMENDATION_TIERS.LIVE_CANDIDATE);
    expect(result.allResults.every((row) => row.recommendation && row.recommendation.tier)).toBe(true);
    expect(result.recommendationSummary).toEqual(expect.objectContaining({
      liveCandidateCount: 1,
      paperOnlyCount: 1,
      rejectCount: 1,
      insufficientSampleCount: 1,
    }));
    expect(result.recommendationSummary.topLiveCandidates).toHaveLength(1);
    expect(result.recommendationSummary.topLiveCandidates[0].parameters).toEqual({ score: 1 });
  });
});
