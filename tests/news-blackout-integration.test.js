jest.mock('../src/models/Strategy', () => ({
  findAll: jest.fn(),
}));

jest.mock('../src/services/strategyInstanceService', () => ({
  getStrategyInstance: jest.fn(),
}));

jest.mock('../src/services/economicCalendarService', () => ({
  ensureCalendar: jest.fn(),
  isInBlackout: jest.fn(),
}));

jest.mock('../src/services/auditService', () => ({
  REASON: {
    NEWS_BLACKOUT: 'NEWS_BLACKOUT',
  },
  record: jest.fn(),
  noSetup: jest.fn(),
  setupFound: jest.fn(),
  filtered: jest.fn(),
  triggered: jest.fn(),
  duplicate: jest.fn(),
}));

const Strategy = require('../src/models/Strategy');
const strategyEngine = require('../src/services/strategyEngine');
const { getStrategyInstance } = require('../src/services/strategyInstanceService');
const economicCalendarService = require('../src/services/economicCalendarService');
const auditService = require('../src/services/auditService');
const { STRATEGY_TYPES } = require('../src/config/instruments');

function makeCandles(count = 60) {
  return Array.from({ length: count }, (_, index) => ({
    time: `2026-04-21T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
    open: 1.1 + (index * 0.001),
    high: 1.101 + (index * 0.001),
    low: 1.099 + (index * 0.001),
    close: 1.1 + (index * 0.0015),
  }));
}

describe('news blackout integration', () => {
  const originalTrendFollowing = strategyEngine.strategies[STRATEGY_TYPES.TREND_FOLLOWING];

  beforeEach(() => {
    strategyEngine.signals = [];
    strategyEngine.lastEmittedSignals.clear();
    jest.clearAllMocks();

    Strategy.findAll.mockResolvedValue([
      {
        name: STRATEGY_TYPES.TREND_FOLLOWING,
        symbols: ['EURUSD'],
      },
    ]);

    getStrategyInstance.mockResolvedValue({
      parameters: {},
      enabled: true,
      newsBlackout: {
        enabled: true,
        beforeMinutes: 15,
        afterMinutes: 15,
        impactLevels: ['High'],
      },
      source: 'instance',
    });
  });

  afterAll(() => {
    strategyEngine.strategies[STRATEGY_TYPES.TREND_FOLLOWING] = originalTrendFollowing;
  });

  test('returns a NEWS_BLACKOUT result and writes an audit entry when a matching event is active', async () => {
    const analyzeSpy = jest.fn(() => ({
      signal: 'BUY',
      confidence: 0.84,
      sl: 1.08,
      tp: 1.16,
      reason: 'Should not run inside blackout',
      status: 'TRIGGERED',
    }));
    strategyEngine.strategies[STRATEGY_TYPES.TREND_FOLLOWING] = {
      ...originalTrendFollowing,
      analyze: analyzeSpy,
    };

    economicCalendarService.ensureCalendar.mockResolvedValue([]);
    economicCalendarService.isInBlackout.mockReturnValue({
      blocked: true,
      event: {
        title: 'US CPI',
        country: 'USD',
        currency: 'USD',
        impact: 'High',
        time: '2026-04-21T12:30:00.000Z',
      },
    });

    const onSignal = jest.fn();
    const results = await strategyEngine.analyzeAll(
      async () => makeCandles(),
      onSignal,
      ['EURUSD'],
      { scope: 'live', mode: 'live' }
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expect.objectContaining({
      symbol: 'EURUSD',
      strategy: STRATEGY_TYPES.TREND_FOLLOWING,
      signal: 'NONE',
      reason: 'NEWS_BLACKOUT',
      parameterSource: 'instance',
      blackoutEvent: expect.objectContaining({
        title: 'US CPI',
        impact: 'High',
      }),
    }));
    expect(analyzeSpy).not.toHaveBeenCalled();
    expect(onSignal).not.toHaveBeenCalled();
    expect(economicCalendarService.ensureCalendar).toHaveBeenCalledTimes(1);
    expect(auditService.record).toHaveBeenCalledWith(expect.objectContaining({
      type: 'NEWS_BLACKOUT',
      stage: 'NEWS_BLACKOUT',
      symbol: 'EURUSD',
      strategy: STRATEGY_TYPES.TREND_FOLLOWING,
      reasonCode: 'NEWS_BLACKOUT',
      details: expect.objectContaining({
        event: expect.objectContaining({ title: 'US CPI' }),
      }),
    }));
  });

  test('passes through to the underlying strategy when not in a blackout window', async () => {
    const analyzeSpy = jest.fn(() => ({
      signal: 'BUY',
      confidence: 0.9,
      sl: 1.08,
      tp: 1.16,
      reason: 'Trend confirmed',
      status: 'TRIGGERED',
      setupCandleTime: '2026-04-21T10:00:00.000Z',
      entryCandleTime: '2026-04-21T10:00:00.000Z',
      indicatorsSnapshot: { atr: 0.0021 },
    }));
    strategyEngine.strategies[STRATEGY_TYPES.TREND_FOLLOWING] = {
      ...originalTrendFollowing,
      analyze: analyzeSpy,
    };

    economicCalendarService.ensureCalendar.mockResolvedValue([]);
    economicCalendarService.isInBlackout.mockReturnValue({ blocked: false });

    const onSignal = jest.fn();
    const results = await strategyEngine.analyzeAll(
      async () => makeCandles(),
      onSignal,
      ['EURUSD'],
      { scope: 'live', mode: 'live' }
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(expect.objectContaining({
      signal: 'BUY',
      reason: 'Trend confirmed',
      parameterSource: 'instance',
    }));
    expect(analyzeSpy).toHaveBeenCalledTimes(1);
    expect(onSignal).toHaveBeenCalledWith(expect.objectContaining({
      signal: 'BUY',
      symbol: 'EURUSD',
    }));
    expect(auditService.record).not.toHaveBeenCalled();
  });
});
