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

const strategyEngine = require('../src/services/strategyEngine');
const { STRATEGY_TYPES } = require('../src/config/instruments');

function makeCandles(count = 60) {
  return Array.from({ length: count }, (_, index) => ({
    time: `2026-05-10T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
    open: 2300 + index,
    high: 2302 + index,
    low: 2298 + index,
    close: 2301 + index,
  }));
}

describe('strategyEngine symbol playbook metadata', () => {
  beforeEach(() => {
    strategyEngine.signals = [];
    strategyEngine.lastEmittedSignals.clear();
    jest.restoreAllMocks();
  });

  test('adds setupType and curated playbook metadata without changing the signal decision fields', async () => {
    jest.spyOn(strategyEngine.strategies[STRATEGY_TYPES.BREAKOUT], 'analyze')
      .mockReturnValue({
        signal: 'BUY',
        confidence: 0.82,
        sl: 2320,
        tp: 2360,
        reason: 'Breakout confirmed',
        indicatorsSnapshot: { atr: 8 },
        setupTimeframe: '1h',
        entryTimeframe: null,
        setupActive: false,
        setupDirection: 'BUY',
        status: 'TRIGGERED',
        setupCandleTime: '2026-05-10T10:00:00.000Z',
        entryCandleTime: null,
      });

    const onSignalFn = jest.fn();
    const results = await strategyEngine.analyzeAll(
      jest.fn(async () => makeCandles()),
      onSignalFn,
      null,
      {
        scope: 'live',
        mode: 'live',
        analysisTasks: [{
          symbol: 'XAUUSD',
          strategyType: STRATEGY_TYPES.BREAKOUT,
          strategyInstance: {
            parameters: {},
            enabledForScope: true,
            liveEnabled: true,
            paperEnabled: true,
            source: 'instance',
          },
          cadenceTimeframe: '1h',
        }],
      }
    );

    const signalRecord = results[0];

    expect(signalRecord).toEqual(expect.objectContaining({
      signal: 'BUY',
      confidence: 0.82,
      rawConfidence: 0.82,
      sl: 2320,
      tp: 2360,
      setupType: 'event_breakout',
    }));
    expect(signalRecord.playbook).toEqual({
      role: 'growth_engine',
      category: 'metals',
      allowedSetups: [
        'event_breakout',
        'trend_pullback',
        'momentum_continuation',
        'safe_haven_rotation',
      ],
      preferredEntryStyle: 'pullback_after_breakout',
      riskWeight: 1.0,
      beStyle: 'medium_loose',
      liveBias: 'allowed_observe',
    });
    expect(Object.keys(signalRecord.playbook).sort()).toEqual([
      'allowedSetups',
      'beStyle',
      'category',
      'liveBias',
      'preferredEntryStyle',
      'riskWeight',
      'role',
    ].sort());
    expect(signalRecord.entryRefinementShadow).toEqual({
      symbol: 'XAUUSD',
      strategy: STRATEGY_TYPES.BREAKOUT,
      setupType: 'event_breakout',
      actualEntry: 2359,
      direction: 'BUY',
      atrAtSignal: 8,
      suggestedPullback025Atr: 2357,
      suggestedPullback040Atr: 2355.8,
      triggerCandleMidpoint: 2358,
      preferredEntryStyle: 'pullback_after_breakout',
      analysisMode: 'shadow_only',
    });
    expect(onSignalFn).toHaveBeenCalledWith(expect.objectContaining({
      signal: 'BUY',
      confidence: 0.82,
      sl: 2320,
      tp: 2360,
      setupType: 'event_breakout',
      playbook: expect.objectContaining({
        role: 'growth_engine',
        liveBias: 'allowed_observe',
      }),
      entryRefinementShadow: expect.objectContaining({
        analysisMode: 'shadow_only',
        actualEntry: 2359,
      }),
    }));
  });
});
