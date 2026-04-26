jest.mock('../src/models/Strategy', () => ({
  findAll: jest.fn(),
}));

jest.mock('../src/models/RiskProfile', () => ({
  getActive: jest.fn(),
}));

jest.mock('../src/services/strategyInstanceService', () => ({
  getStrategyInstance: jest.fn(),
}));

const Strategy = require('../src/models/Strategy');
const RiskProfile = require('../src/models/RiskProfile');
const { getStrategyInstance } = require('../src/services/strategyInstanceService');
const { listAssignedStrategyRiskStatuses } = require('../src/services/strategyParametersLibraryService');

describe('strategy parameters library service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('aggregates assigned symbol-strategy pairs with effective risk controls', async () => {
    Strategy.findAll.mockResolvedValue([
      {
        name: 'TrendFollowing',
        displayName: 'Trend Following',
        description: 'Trend strategy',
        symbols: ['EURUSD'],
        tradeManagement: {
          breakevenOverride: {
            enabled: true,
            triggerAtrMultiple: 1.2,
            includeSpreadCompensation: true,
            extraBufferPips: 1,
            trailStartAtrMultiple: 1.8,
            trailDistanceAtrMultiple: 1.1,
          },
        },
      },
      {
        name: 'Breakout',
        displayName: 'Breakout',
        description: 'Breakout strategy',
        symbols: ['XTIUSD'],
      },
    ]);

    RiskProfile.getActive.mockResolvedValue({
      _id: 'risk-1',
      name: 'Desk Default',
      maxRiskPerTradePct: 2,
      maxDailyLossPct: 5,
      maxDrawdownPct: 10,
      maxConcurrentPositions: 4,
      maxPositionsPerSymbol: 2,
      allowAggressiveMinLot: false,
      tradeManagement: {
        breakeven: {
          enabled: true,
          triggerAtrMultiple: 0.8,
          includeSpreadCompensation: true,
          extraBufferPips: 0,
          trailStartAtrMultiple: 1.5,
          trailDistanceAtrMultiple: 1,
        },
      },
    });

    getStrategyInstance.mockImplementation(async (symbol, strategyName) => {
      if (symbol === 'EURUSD' && strategyName === 'TrendFollowing') {
        return {
          storedParameters: {
            riskPercent: 0.02,
            slMultiplier: 2.2,
            tpMultiplier: 4.4,
            ema_fast: 20,
          },
          parameters: {
            riskPercent: 0.02,
            slMultiplier: 2.2,
            tpMultiplier: 4.4,
            ema_fast: 20,
          },
          enabled: true,
          source: 'instance',
          newsBlackout: {
            enabled: true,
            beforeMinutes: 20,
            afterMinutes: 10,
            impactLevels: ['High', 'Medium'],
          },
          effectiveBreakeven: {
            enabled: true,
            triggerAtrMultiple: 1.2,
            includeSpreadCompensation: true,
            extraBufferPips: 1,
            trailStartAtrMultiple: 1.8,
            trailDistanceAtrMultiple: 1.1,
          },
          effectiveExitPlan: {},
          effectiveTradeManagement: {
            breakeven: {
              enabled: true,
              triggerAtrMultiple: 1.2,
              includeSpreadCompensation: true,
              extraBufferPips: 1,
              trailStartAtrMultiple: 1.8,
              trailDistanceAtrMultiple: 1.1,
            },
            exitPlan: {},
          },
          executionPolicy: null,
          storedExecutionPolicy: null,
          storedTradeManagement: null,
          strategyDefaultParameters: {
            riskPercent: 0.02,
            slMultiplier: 2.2,
            tpMultiplier: 4.4,
            ema_fast: 20,
          },
        };
      }

      return {
        storedParameters: {
          riskPercent: 0.01,
          slMultiplier: 2,
          tpMultiplier: 5,
          lookback_period: 20,
        },
        parameters: {
          riskPercent: 0.01,
          slMultiplier: 2,
          tpMultiplier: 5,
          lookback_period: 20,
        },
        enabled: false,
        source: 'instance',
        newsBlackout: {
          enabled: false,
          beforeMinutes: 15,
          afterMinutes: 15,
          impactLevels: ['High'],
        },
        effectiveBreakeven: {
          enabled: true,
          triggerAtrMultiple: 0.8,
          includeSpreadCompensation: true,
          extraBufferPips: 0,
          trailStartAtrMultiple: 1.5,
          trailDistanceAtrMultiple: 1,
        },
        effectiveExitPlan: {},
        effectiveTradeManagement: {
          breakeven: {
            enabled: true,
            triggerAtrMultiple: 0.8,
            includeSpreadCompensation: true,
            extraBufferPips: 0,
            trailStartAtrMultiple: 1.5,
            trailDistanceAtrMultiple: 1,
          },
          exitPlan: {},
        },
        executionPolicy: null,
        storedExecutionPolicy: null,
        storedTradeManagement: null,
        strategyDefaultParameters: {
          riskPercent: 0.01,
          slMultiplier: 2,
          tpMultiplier: 5,
          lookback_period: 20,
        },
      };
    });

    const payload = await listAssignedStrategyRiskStatuses();

    expect(payload.activeRiskProfile).toEqual(expect.objectContaining({
      name: 'Desk Default',
      maxRiskPerTradePct: 2,
      maxConcurrentPositions: 4,
      maxPositionsPerSymbol: 2,
    }));
    expect(payload.count).toBe(2);
    expect(payload.rows).toHaveLength(2);

    const eurusdRow = payload.rows.find((row) => row.key === 'TrendFollowing:EURUSD');
    expect(eurusdRow).toEqual(expect.objectContaining({
      symbol: 'EURUSD',
      strategyName: 'TrendFollowing',
      strategyDisplayName: 'Trend Following',
      instanceEnabled: true,
      parameterSource: 'instance',
      instanceParameters: expect.objectContaining({
        riskPercent: 0.02,
        slMultiplier: 2.2,
      }),
      newsBlackout: expect.objectContaining({
        enabled: true,
        beforeMinutes: 20,
        impactLevels: ['High', 'Medium'],
      }),
      riskParameters: expect.objectContaining({
        riskPercent: 0.02,
        riskPercentPct: 2,
        slMultiplier: 2.2,
        tpMultiplier: 4.4,
      }),
      effectiveBreakeven: expect.objectContaining({
        triggerAtrMultiple: 1.2,
        trailStartAtrMultiple: 1.8,
      }),
      instrument: expect.objectContaining({
        category: 'forex_major',
        timeframe: '1h',
      }),
    }));
    expect(eurusdRow.effectiveParameters).toEqual(expect.objectContaining({
      riskPercent: 0.02,
      slMultiplier: 2.2,
      tpMultiplier: 4.4,
    }));

    const xtiusdRow = payload.rows.find((row) => row.key === 'Breakout:XTIUSD');
    expect(xtiusdRow).toEqual(expect.objectContaining({
      symbol: 'XTIUSD',
      strategyName: 'Breakout',
      instanceEnabled: false,
      riskParameters: expect.objectContaining({
        riskPercentPct: 1,
        slMultiplier: 2,
        tpMultiplier: 5,
      }),
    }));
  });
});
