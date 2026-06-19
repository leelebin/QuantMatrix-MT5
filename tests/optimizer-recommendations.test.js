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
const {
  CANDIDATE_BUCKETS,
  assessWalkForwardMetrics,
  buildCostStressScenarios,
  classifyOptimizerCandidate,
  evaluateCostStressResults,
} = require('../src/utils/optimizerCandidateValidation');

function makeSummary(overrides = {}) {
  return {
    totalTrades: 80,
    robustScore: 75,
    profitFactor: 1.5,
    expectancyPerTrade: 25,
    netProfitMoney: 1200,
    returnPercent: 12,
    maxDrawdownPercent: 10,
    maxConsecutiveLosses: 2,
    profitConcentrationTop1: 0.25,
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

  test('live candidate requires strict concentration and consecutive-loss thresholds', () => {
    expect(buildOptimizerRecommendation({
      summary: makeSummary({
        totalTrades: 120,
        robustScore: 86,
        profitFactor: 1.9,
        maxConsecutiveLosses: 4,
      }),
    }, { symbol: 'EURUSD' }).tier).toBe(RECOMMENDATION_TIERS.PAPER_ONLY);

    expect(buildOptimizerRecommendation({
      summary: makeSummary({
        totalTrades: 120,
        robustScore: 86,
        profitFactor: 1.9,
        profitConcentrationTop1: 0.8,
      }),
    }, { symbol: 'EURUSD' }).tier).toBe(RECOMMENDATION_TIERS.REJECT);
  });

  test('cost stress failure downgrades live candidate and rejects failed default cost', () => {
    const summary = makeSummary({
      totalTrades: 120,
      robustScore: 86,
      profitFactor: 1.9,
      maxDrawdownPercent: 8,
    });
    const stress = evaluateCostStressResults([
      { name: 'default', summary },
      { name: 'spread_x1_5', summary: { ...summary, profitFactor: 0.95, netProfitMoney: 50 } },
      { name: 'slippage_x2', summary },
      { name: 'commission_x2', summary },
    ], { symbol: 'XAUUSD' });

    const downgraded = classifyOptimizerCandidate({ summary }, {
      symbol: 'XAUUSD',
      requireCostStress: true,
      costStressResult: stress,
    });
    expect(downgraded.bucket).toBe(CANDIDATE_BUCKETS.PAPER_ONLY);
    expect(downgraded.reasons.join(' ')).toContain('Cost stress failed');

    const failedDefault = evaluateCostStressResults([
      { name: 'default', summary: { ...summary, profitFactor: 0.8, netProfitMoney: -10 } },
      { name: 'spread_x1_5', summary },
      { name: 'slippage_x2', summary },
      { name: 'commission_x2', summary },
    ], { symbol: 'XAUUSD' });
    expect(classifyOptimizerCandidate({ summary }, {
      symbol: 'XAUUSD',
      requireCostStress: true,
      costStressResult: failedDefault,
    }).bucket).toBe(CANDIDATE_BUCKETS.REJECT);
  });

  test('cost stress scenarios preserve default and mutate one cost dimension each', () => {
    const scenarios = buildCostStressScenarios({
      spreadPips: 2,
      slippagePips: 1,
      commissionPerLot: 7,
      commissionPerSide: true,
    });

    expect(scenarios.map((scenario) => scenario.name)).toEqual([
      'default',
      'spread_x1_5',
      'slippage_x2',
      'commission_x2',
    ]);
    expect(scenarios.find((scenario) => scenario.name === 'default').costModel).toEqual(expect.objectContaining({
      spreadPips: 2,
      slippagePips: 1,
      commissionPerLot: 7,
    }));
    expect(scenarios.find((scenario) => scenario.name === 'spread_x1_5').costModel.spreadPips).toBe(3);
    expect(scenarios.find((scenario) => scenario.name === 'slippage_x2').costModel.slippagePips).toBe(2);
    expect(scenarios.find((scenario) => scenario.name === 'commission_x2').costModel.commissionPerLot).toBe(14);
  });

  test('walk-forward degradation downgrades without contaminating train metrics', () => {
    const trainSummary = makeSummary({ netProfitMoney: 3000, profitFactor: 2.2, robustScore: 90 });
    const validationSummary = makeSummary({ netProfitMoney: 1800, profitFactor: 1.6, robustScore: 75 });
    const outOfSampleSummary = makeSummary({
      netProfitMoney: 600,
      profitFactor: 1.35,
      robustScore: 72,
      totalTrades: 70,
    });

    const assessment = assessWalkForwardMetrics({
      trainSummary,
      validationSummary,
      outOfSampleSummary,
    });

    expect(assessment.trainMetrics).toBe(trainSummary);
    expect(assessment.validationMetrics).toBe(validationSummary);
    expect(assessment.outOfSampleMetrics).toBe(outOfSampleSummary);
    expect(assessment.overfittingRisk).toBe('MEDIUM');
    expect(assessment.finalBucket).toBe(CANDIDATE_BUCKETS.PAPER_ONLY);
    expect(assessment.outOfSampleDegradationPercent).toBe(80);
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
