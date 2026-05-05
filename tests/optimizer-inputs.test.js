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
  MINIMUM_TRADES_WARNING_MESSAGE,
} = require('../src/utils/optimizerInputs');

function mockSimulationFromSummaryFactory(summaryFactory) {
  backtestEngine.simulate.mockImplementation(async (params) => ({
    parameters: { ...params.strategyParams },
    parameterSource: 'test',
    summary: {
      totalTrades: 50,
      profitFactor: 1,
      sharpeRatio: 1,
      returnPercent: 1,
      winRate: 1,
      robustScore: 1,
      returnToDrawdown: 1,
      expectancyPerTrade: 1,
      avgRealizedR: 1,
      medianRealizedR: 1,
      ...summaryFactory(params.strategyParams, params),
    },
  }));
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
      score: { min: 1, max: 2, step: 1 },
    },
    parallelWorkers: 1,
    ...overrides,
  };
}

describe('optimizer input normalization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([
    ['profitFactor', 'profitFactor', 2],
    ['sharpeRatio', 'sharpeRatio', 1],
    ['returnPercent', 'returnPercent', 2],
    ['returnPct', 'returnPercent', 2],
    ['winRate', 'winRate', 2],
    ['robustScore', 'robustScore', 2],
    ['returnToDrawdown', 'returnToDrawdown', 2],
    ['expectancyPerTrade', 'expectancyPerTrade', 2],
    ['avgRealizedR', 'avgRealizedR', 2],
    ['medianRealizedR', 'medianRealizedR', 2],
  ])('supports optimizeFor=%s', async (optimizeFor, normalizedOptimizeFor, expectedScore) => {
    mockSimulationFromSummaryFactory(({ score }) => ({
      profitFactor: score,
      sharpeRatio: 3 - score,
      returnPercent: score * 10,
      winRate: score * 20,
      robustScore: score * 30,
      returnToDrawdown: score * 3,
      expectancyPerTrade: score * 5,
      avgRealizedR: score * 0.2,
      medianRealizedR: score * 0.1,
    }));

    const result = await optimizerService.run(baseOptimizerParams({
      optimizeFor,
      minimumTrades: 30,
    }));

    expect(result.optimizeFor).toBe(normalizedOptimizeFor);
    expect(result.bestResult.parameters.score).toBe(expectedScore);
  });

  test('rejects unknown optimizeFor values instead of silently sorting by combination index', async () => {
    mockSimulationFromSummaryFactory(() => ({}));

    await expect(optimizerService.run(baseOptimizerParams({
      optimizeFor: 'unknown',
      minimumTrades: 30,
    }))).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Invalid optimizeFor: unknown'),
    });
  });

  test('treats missing and non-finite objective values as the lowest score', async () => {
    mockSimulationFromSummaryFactory(({ score }) => {
      if (score === 1) return { profitFactor: NaN };
      if (score === 2) return { profitFactor: null };
      if (score === 3) return { profitFactor: Infinity };
      return { profitFactor: 1.5 };
    });

    const result = await optimizerService.run(baseOptimizerParams({
      paramRanges: {
        score: { min: 1, max: 4, step: 1 },
      },
      optimizeFor: 'profitFactor',
      minimumTrades: 30,
    }));

    expect(result.bestResult.parameters.score).toBe(4);
  });

  test('legacy profitFactor still sorts with robust tie-breakers', async () => {
    mockSimulationFromSummaryFactory(({ score }) => ({
      profitFactor: score === 1 ? 2 : 3,
      robustScore: score === 1 ? 95 : 50,
      returnToDrawdown: score === 1 ? 8 : 3,
    }));

    const result = await optimizerService.run(baseOptimizerParams({
      optimizeFor: 'profitFactor',
      minimumTrades: 30,
    }));

    expect(result.optimizeFor).toBe('profitFactor');
    expect(result.bestResult.parameters.score).toBe(2);
  });

  test('profitFactor ties use robustScore before older tie-breakers', async () => {
    mockSimulationFromSummaryFactory(({ score }) => ({
      profitFactor: 2,
      robustScore: score === 1 ? 80 : 90,
      returnToDrawdown: score === 1 ? 10 : 1,
    }));

    const result = await optimizerService.run(baseOptimizerParams({
      optimizeFor: 'profitFactor',
      minimumTrades: 30,
    }));

    expect(result.bestResult.parameters.score).toBe(2);
  });

  test('robustScore ties use profitFactor and returnToDrawdown as secondary keys', async () => {
    mockSimulationFromSummaryFactory(({ score }) => ({
      robustScore: 80,
      profitFactor: score === 1 ? 1.5 : 2,
      returnToDrawdown: score === 1 ? 8 : 3,
    }));

    const result = await optimizerService.run(baseOptimizerParams({
      optimizeFor: 'robustScore',
      minimumTrades: 30,
    }));

    expect(result.bestResult.parameters.score).toBe(2);
  });

  test('very small sample high profitFactor does not outrank a healthier robust result', async () => {
    mockSimulationFromSummaryFactory(({ score }) => {
      if (score === 1) {
        return {
          totalTrades: 5,
          profitFactor: 999,
          robustScore: 10,
          returnToDrawdown: 20,
          warningFlags: ['VERY_SMALL_SAMPLE'],
        };
      }

      return {
        totalTrades: 80,
        profitFactor: 2,
        robustScore: 85,
        returnToDrawdown: 4,
        warningFlags: [],
      };
    });

    const result = await optimizerService.run(baseOptimizerParams({
      optimizeFor: 'profitFactor',
      minimumTrades: 5,
    }));

    expect(result.bestResult.parameters.score).toBe(2);
    expect(result.bestResult.summary.warningFlags).toEqual([]);
  });

  test('defaults minimumTrades to 30 when omitted', async () => {
    mockSimulationFromSummaryFactory(() => ({ totalTrades: 30 }));

    const result = await optimizerService.run(baseOptimizerParams());

    expect(result.minimumTrades).toBe(30);
    expect(result.minimumTradesWarning).toBe(false);
    expect(result.validResults).toBe(2);
  });

  test('accepts minimumTrades below the recommendation and returns a warning', async () => {
    mockSimulationFromSummaryFactory(() => ({ totalTrades: 10 }));

    const result = await optimizerService.run(baseOptimizerParams({
      minimumTrades: 10,
    }));

    expect(result.minimumTrades).toBe(10);
    expect(result.minimumTradesWarning).toBe(true);
    expect(result.minimumTradesWarningMessage).toBe(MINIMUM_TRADES_WARNING_MESSAGE);
  });

  test('accepts minimumTrades at the recommendation without a warning', async () => {
    mockSimulationFromSummaryFactory(() => ({ totalTrades: 30 }));

    const result = await optimizerService.run(baseOptimizerParams({
      minimumTrades: 30,
    }));

    expect(result.minimumTrades).toBe(30);
    expect(result.minimumTradesWarning).toBe(false);
    expect(result.minimumTradesWarningMessage).toBeNull();
  });

  test.each([0, 'abc', 1000])('rejects invalid minimumTrades=%p', async (minimumTrades) => {
    mockSimulationFromSummaryFactory(() => ({ totalTrades: 50 }));

    await expect(optimizerService.run(baseOptimizerParams({
      minimumTrades,
    }))).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('minimumTrades'),
    });
  });

  test('filters out optimizer results below minimumTrades', async () => {
    mockSimulationFromSummaryFactory(({ score }) => ({
      totalTrades: score === 1 ? 29 : 30,
      profitFactor: score,
    }));

    const result = await optimizerService.run(baseOptimizerParams({
      minimumTrades: 30,
    }));

    expect(result.validResults).toBe(1);
    expect(result.allResults).toHaveLength(1);
    expect(result.bestResult.parameters.score).toBe(2);
    expect(result.bestResult.summary.totalTrades).toBe(30);
  });

  test('sequential optimizer forwards costModel to backtestEngine.simulate', async () => {
    const costModel = {
      spreadPips: 1.2,
      slippagePips: 0.4,
      commissionPerLot: 7,
      commissionPerSide: true,
      fixedFeePerTrade: 0.5,
    };
    mockSimulationFromSummaryFactory(() => ({ totalTrades: 30 }));

    const result = await optimizerService.run(baseOptimizerParams({
      costModel,
      minimumTrades: 30,
    }));

    expect(result.costModelUsed).toBe(costModel);
    expect(backtestEngine.simulate).toHaveBeenCalledWith(expect.objectContaining({
      costModel,
    }));
  });

  test('commission costModel can change optimizer ranking and reported economics', async () => {
    mockSimulationFromSummaryFactory(({ score }, { costModel }) => {
      if (!costModel) {
        return {
          totalTrades: 30,
          profitFactor: score === 1 ? 3 : 2,
          netProfitMoney: score === 1 ? 300 : 200,
          robustScore: score === 1 ? 70 : 60,
        };
      }

      return {
        totalTrades: 30,
        profitFactor: score === 1 ? 0.8 : 1.8,
        netProfitMoney: score === 1 ? -50 : 150,
        robustScore: score === 1 ? 20 : 75,
        totalCommission: -Math.abs(costModel.commissionPerLot || 0),
      };
    });

    const noCost = await optimizerService.run(baseOptimizerParams({
      optimizeFor: 'profitFactor',
      minimumTrades: 30,
    }));
    const withCost = await optimizerService.run(baseOptimizerParams({
      optimizeFor: 'profitFactor',
      minimumTrades: 30,
      costModel: { commissionPerLot: 50 },
    }));

    expect(noCost.costModelUsed).toBeNull();
    expect(noCost.bestResult.parameters.score).toBe(1);
    expect(noCost.bestResult.summary.netProfitMoney).toBe(300);
    expect(withCost.costModelUsed).toEqual({ commissionPerLot: 50 });
    expect(withCost.bestResult.parameters.score).toBe(2);
    expect(withCost.allResults.find((row) => row.parameters.score === 1).summary.profitFactor).toBe(0.8);
    expect(withCost.allResults.find((row) => row.parameters.score === 1).summary.netProfitMoney).toBe(-50);
  });
});
