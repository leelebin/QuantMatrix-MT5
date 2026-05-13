jest.mock('../src/models/Strategy', () => ({
  findAll: jest.fn(),
}));

jest.mock('../src/models/StrategyInstance', () => ({
  findAll: jest.fn(),
}));

jest.mock('../src/services/strategyInstanceService', () => ({
  getStrategyInstance: jest.fn(),
}));

const Strategy = require('../src/models/Strategy');
const StrategyInstance = require('../src/models/StrategyInstance');
const { getStrategyInstance } = require('../src/services/strategyInstanceService');
const {
  buildSignalScanBucketStatus,
  getSignalCadenceMs,
  listActiveAssignments,
  resolveCategoryContext,
} = require('../src/services/assignmentRuntimeService');
const { getStrategyExecutionConfig } = require('../src/config/strategyExecution');

describe('assignmentRuntimeService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    StrategyInstance.findAll.mockResolvedValue([]);
    getStrategyInstance.mockResolvedValue({
      enabled: true,
      paperEnabled: true,
      liveEnabled: false,
      enabledForScope: true,
      source: 'instance',
      parameters: {},
      executionPolicy: null,
      newsBlackout: null,
    });
  });

  test('uses category-aware signal cadence for lower-timeframe strategies', async () => {
    Strategy.findAll.mockResolvedValue([
      { _id: 's1', name: 'TrendFollowing', symbols: ['EURUSD', 'XAUUSD', 'BTCUSD'] },
      { _id: 's2', name: 'VolumeFlowHybrid', symbols: ['XTIUSD'] },
      { _id: 's3', name: 'Momentum', symbols: ['US30'] },
    ]);

    const assignments = await listActiveAssignments();
    const lookup = Object.fromEntries(assignments.map((assignment) => [`${assignment.symbol}:${assignment.strategyType}`, assignment]));

    expect(lookup['EURUSD:TrendFollowing']).toEqual(expect.objectContaining({
      cadenceMs: 30 * 1000,
      category: 'forex',
      categoryFallback: false,
    }));
    expect(lookup['XAUUSD:TrendFollowing']).toEqual(expect.objectContaining({
      cadenceMs: 30 * 1000,
      category: 'metals',
      categoryFallback: false,
    }));
    expect(lookup['BTCUSD:TrendFollowing']).toEqual(expect.objectContaining({
      cadenceMs: 15 * 1000,
      category: 'crypto',
      categoryFallback: false,
    }));
    expect(lookup['XTIUSD:VolumeFlowHybrid']).toEqual(expect.objectContaining({
      cadenceMs: 15 * 1000,
      category: 'energy',
    }));
    expect(lookup['US30:Momentum']).toEqual(expect.objectContaining({
      cadenceMs: 180 * 1000,
      category: 'indices',
    }));
  });

  test('filters active assignments by paper and live scoped enablement', async () => {
    Strategy.findAll.mockResolvedValue([
      { _id: 's1', name: 'TrendFollowing', symbols: ['EURUSD', 'XAUUSD'] },
    ]);
    getStrategyInstance.mockImplementation(async (symbol, _strategyName, options = {}) => ({
      enabled: true,
      paperEnabled: symbol === 'EURUSD',
      liveEnabled: symbol === 'XAUUSD',
      enabledForScope: options.scope === 'live' ? symbol === 'XAUUSD' : symbol === 'EURUSD',
      source: 'instance',
      parameters: {},
      executionPolicy: null,
      newsBlackout: null,
    }));

    const paperAssignments = await listActiveAssignments({ scope: 'paper' });
    const liveAssignments = await listActiveAssignments({ scope: 'live' });

    expect(paperAssignments.map((assignment) => assignment.symbol)).toEqual(['EURUSD']);
    expect(liveAssignments.map((assignment) => assignment.symbol)).toEqual(['XAUUSD']);
    expect(getStrategyInstance).toHaveBeenCalledWith('EURUSD', 'TrendFollowing', expect.objectContaining({ scope: 'paper' }));
    expect(getStrategyInstance).toHaveBeenCalledWith('XAUUSD', 'TrendFollowing', expect.objectContaining({ scope: 'live' }));
  });

  test('includes explicit paper StrategyInstance entries outside legacy Strategy.symbols', async () => {
    Strategy.findAll.mockResolvedValue([
      { _id: 's1', name: 'MultiTimeframe', symbols: ['NAS100'] },
    ]);
    StrategyInstance.findAll.mockResolvedValue([
      {
        _id: 'MultiTimeframe:US30',
        strategyName: 'MultiTimeframe',
        symbol: 'US30',
        paperEnabled: true,
        liveEnabled: false,
        parameters: { stoch_period: 16 },
      },
    ]);
    getStrategyInstance.mockImplementation(async (symbol, strategyName, options = {}) => ({
      strategyName,
      symbol,
      paperEnabled: true,
      liveEnabled: false,
      enabledForScope: options.scope === 'paper',
      source: symbol === 'US30' ? 'instance' : 'strategy_default',
      parameters: symbol === 'US30' ? { stoch_period: 16 } : {},
      executionPolicy: null,
      newsBlackout: null,
    }));

    const paperAssignments = await listActiveAssignments({ scope: 'paper' });
    const liveAssignments = await listActiveAssignments({ scope: 'live' });

    expect(paperAssignments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        strategyType: 'MultiTimeframe',
        symbol: 'US30',
        assignmentSource: 'strategyInstance',
        runtimeSource: 'strategyInstance',
        strategyInstance: expect.objectContaining({
          parameters: { stoch_period: 16 },
        }),
      }),
    ]));
    expect(liveAssignments).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ strategyType: 'MultiTimeframe', symbol: 'US30' }),
    ]));
  });

  test('deduplicates legacy and StrategyInstance runtime sources for the same pair', async () => {
    Strategy.findAll.mockResolvedValue([
      { _id: 's1', name: 'Breakout', symbols: ['XAUUSD'] },
    ]);
    StrategyInstance.findAll.mockResolvedValue([
      {
        _id: 'Breakout:XAUUSD',
        strategyName: 'Breakout',
        symbol: 'XAUUSD',
        paperEnabled: true,
        liveEnabled: false,
        parameters: { lookback_period: 25 },
      },
    ]);
    getStrategyInstance.mockResolvedValue({
      paperEnabled: true,
      liveEnabled: false,
      enabledForScope: true,
      source: 'instance',
      parameters: { lookback_period: 25 },
      executionPolicy: null,
      newsBlackout: null,
    });

    const paperAssignments = await listActiveAssignments({ scope: 'paper' });
    const matches = paperAssignments.filter((assignment) => (
      assignment.strategyType === 'Breakout' && assignment.symbol === 'XAUUSD'
    ));

    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual(expect.objectContaining({
      assignmentSource: 'legacy+strategyInstance',
      runtimeSource: 'legacy+strategyInstance',
      strategyInstance: expect.objectContaining({
        parameters: { lookback_period: 25 },
      }),
    }));
  });

  test('includes explicit live StrategyInstance entries outside legacy Strategy.symbols only in live scope', async () => {
    Strategy.findAll.mockResolvedValue([
      { _id: 's1', name: 'Momentum', symbols: [] },
    ]);
    StrategyInstance.findAll.mockResolvedValue([
      {
        _id: 'Momentum:AUDNZD',
        strategyName: 'Momentum',
        symbol: 'AUDNZD',
        paperEnabled: false,
        liveEnabled: true,
        parameters: { ema_period: 70 },
      },
    ]);
    getStrategyInstance.mockImplementation(async (symbol, strategyName, options = {}) => ({
      strategyName,
      symbol,
      paperEnabled: false,
      liveEnabled: true,
      enabledForScope: options.scope === 'live',
      source: 'instance',
      parameters: { ema_period: 70 },
      executionPolicy: null,
      newsBlackout: null,
    }));

    const paperAssignments = await listActiveAssignments({ scope: 'paper' });
    const liveAssignments = await listActiveAssignments({ scope: 'live' });

    expect(paperAssignments).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ strategyType: 'Momentum', symbol: 'AUDNZD' }),
    ]));
    expect(liveAssignments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        strategyType: 'Momentum',
        symbol: 'AUDNZD',
        assignmentSource: 'strategyInstance',
      }),
    ]));
  });

  test('warns once and falls back to forex cadence for unknown categories', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const first = resolveCategoryContext('SYNTH1', 'synthetic_unknown', { warnSource: 'test' });
    const second = resolveCategoryContext('SYNTH1', 'synthetic_unknown', { warnSource: 'test' });

    expect(first).toEqual({
      category: 'forex',
      rawCategory: 'synthetic_unknown',
      categoryFallback: true,
    });
    expect(second.categoryFallback).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  test('builds signal scan bucket items with scan metadata', () => {
    const buckets = buildSignalScanBucketStatus([
      {
        symbol: 'EURUSD',
        strategyType: 'TrendFollowing',
        cadenceMs: 30 * 1000,
        category: 'forex',
        categoryFallback: false,
      },
      {
        symbol: 'BTCUSD',
        strategyType: 'TrendFollowing',
        cadenceMs: 15 * 1000,
        category: 'crypto',
        categoryFallback: false,
      },
    ], new Map([
      [15 * 1000, { nextScanAt: new Date('2026-04-24T00:00:15.000Z') }],
      [30 * 1000, { nextScanAt: new Date('2026-04-24T00:00:30.000Z') }],
    ]));

    expect(buckets.find((bucket) => bucket.cadenceMs === 15 * 1000)).toEqual(expect.objectContaining({
      items: [
        expect.objectContaining({
          symbol: 'BTCUSD',
          strategy: 'TrendFollowing',
          category: 'crypto',
          categoryFallback: false,
          scanMode: 'signal',
          scanReason: 'cadence',
        }),
      ],
    }));
    expect(buckets.find((bucket) => bucket.cadenceMs === 30 * 1000)).toEqual(expect.objectContaining({
      items: [
        expect.objectContaining({
          symbol: 'EURUSD',
          strategy: 'TrendFollowing',
          category: 'forex',
          scanMode: 'signal',
          scanReason: 'cadence',
        }),
      ],
    }));
  });

  test('exports direct cadence helper for category-based execution timing', () => {
    expect(getSignalCadenceMs(getStrategyExecutionConfig('EURUSD', 'TrendFollowing'), 'forex')).toBe(30 * 1000);
    expect(getSignalCadenceMs(getStrategyExecutionConfig('BTCUSD', 'TrendFollowing'), 'crypto')).toBe(15 * 1000);
    expect(getSignalCadenceMs(getStrategyExecutionConfig('US30', 'Momentum'), 'indices')).toBe(180 * 1000);
  });
});
