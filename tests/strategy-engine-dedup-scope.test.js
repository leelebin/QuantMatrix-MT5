jest.mock('../src/models/Strategy', () => ({
  findAll: jest.fn().mockResolvedValue([]),
}));

jest.mock('../src/services/strategyInstanceService', () => ({
  getStrategyInstance: jest.fn(),
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
const { STRATEGY_TYPES } = require('../src/config/instruments');

function makeCandles(count = 60) {
  return Array.from({ length: count }, (_, index) => ({
    time: `2026-04-25T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
    open: 2300 + index,
    high: 2301 + index,
    low: 2299 + index,
    close: 2300.5 + index,
  }));
}

function makeBreakoutSignal(timeframe = '15m') {
  return {
    signal: 'BUY',
    confidence: 0.82,
    sl: 2320,
    tp: 2360,
    reason: `XAUUSD Breakout ${timeframe}`,
    indicatorsSnapshot: { atr: 8 },
    setupTimeframe: timeframe,
    entryTimeframe: null,
    setupActive: false,
    setupDirection: 'BUY',
    status: 'TRIGGERED',
    setupCandleTime: '2026-04-25T10:00:00.000Z',
    entryCandleTime: null,
  };
}

async function analyzeBreakoutScope(scope, onSignalFn = jest.fn(), timeframe = '15m') {
  const getCandlesFn = jest.fn(async () => makeCandles());
  const results = await strategyEngine.analyzeAll(
    getCandlesFn,
    onSignalFn,
    null,
    {
      scope,
      mode: scope,
      analysisTasks: [{
        symbol: 'XAUUSD',
        strategyType: STRATEGY_TYPES.BREAKOUT,
        assignmentScope: scope,
        cadenceTimeframe: timeframe,
      }],
    }
  );

  return { results, getCandlesFn };
}

describe('strategyEngine signal dedup runtime scope isolation', () => {
  beforeEach(() => {
    strategyEngine.signals = [];
    strategyEngine.lastEmittedSignals.clear();
    jest.restoreAllMocks();
    Strategy.findAll.mockResolvedValue([]);
    getStrategyInstance.mockResolvedValue({
      parameters: {},
      enabled: true,
      liveEnabled: true,
      paperEnabled: true,
      source: 'instance',
    });
  });

  test('defaults dedup helper scope to live for legacy callers', () => {
    expect(strategyEngine.buildSignalDedupKey({
      symbol: 'XAUUSD',
      strategyType: STRATEGY_TYPES.BREAKOUT,
    })).toBe('live:XAUUSD:Breakout:default');
  });

  test('paper signal does not block later live signal for same symbol strategy and timeframe', async () => {
    jest.spyOn(strategyEngine.strategies[STRATEGY_TYPES.BREAKOUT], 'analyze')
      .mockReturnValue(makeBreakoutSignal('15m'));
    const onSignalFn = jest.fn();

    await analyzeBreakoutScope('paper', onSignalFn, '15m');
    const { results } = await analyzeBreakoutScope('live', onSignalFn, '15m');

    expect(results[0]).toEqual(expect.objectContaining({
      scope: 'live',
      signal: 'BUY',
      status: 'TRIGGERED',
      setupTimeframe: '15m',
    }));
    expect(onSignalFn).toHaveBeenCalledTimes(2);
    expect(strategyEngine.lastEmittedSignals.has('paper:XAUUSD:Breakout:15m')).toBe(true);
    expect(strategyEngine.lastEmittedSignals.has('live:XAUUSD:Breakout:15m')).toBe(true);
  });

  test('live signal does not block later paper signal for same symbol strategy and timeframe', async () => {
    jest.spyOn(strategyEngine.strategies[STRATEGY_TYPES.BREAKOUT], 'analyze')
      .mockReturnValue(makeBreakoutSignal('15m'));
    const onSignalFn = jest.fn();

    await analyzeBreakoutScope('live', onSignalFn, '15m');
    const { results } = await analyzeBreakoutScope('paper', onSignalFn, '15m');

    expect(results[0]).toEqual(expect.objectContaining({
      scope: 'paper',
      signal: 'BUY',
      status: 'TRIGGERED',
      setupTimeframe: '15m',
    }));
    expect(onSignalFn).toHaveBeenCalledTimes(2);
  });

  test('same scope still blocks duplicate symbol strategy and timeframe signal', async () => {
    jest.spyOn(strategyEngine.strategies[STRATEGY_TYPES.BREAKOUT], 'analyze')
      .mockReturnValue(makeBreakoutSignal('15m'));
    const onSignalFn = jest.fn();

    await analyzeBreakoutScope('live', onSignalFn, '15m');
    const { results } = await analyzeBreakoutScope('live', onSignalFn, '15m');

    expect(results[0]).toEqual(expect.objectContaining({
      scope: 'live',
      signal: 'NONE',
      status: 'DUPLICATE',
      reason: 'Signal already processed for the latest setup/entry candle',
    }));
    expect(onSignalFn).toHaveBeenCalledTimes(1);
  });

  test('same scope does not block same symbol and strategy on different timeframes', async () => {
    jest.spyOn(strategyEngine.strategies[STRATEGY_TYPES.BREAKOUT], 'analyze')
      .mockReturnValueOnce(makeBreakoutSignal('15m'))
      .mockReturnValueOnce(makeBreakoutSignal('1h'));
    const onSignalFn = jest.fn();

    await analyzeBreakoutScope('live', onSignalFn, '15m');
    const { results } = await analyzeBreakoutScope('live', onSignalFn, '1h');

    expect(results[0]).toEqual(expect.objectContaining({
      scope: 'live',
      signal: 'BUY',
      status: 'TRIGGERED',
      setupTimeframe: '1h',
    }));
    expect(onSignalFn).toHaveBeenCalledTimes(2);
    expect(strategyEngine.lastEmittedSignals.has('live:XAUUSD:Breakout:15m')).toBe(true);
    expect(strategyEngine.lastEmittedSignals.has('live:XAUUSD:Breakout:1h')).toBe(true);
  });
});
