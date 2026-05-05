jest.mock('../src/models/Strategy', () => ({
  findAll: jest.fn(),
  update: jest.fn(),
}));

jest.mock('../src/models/StrategyInstance', () => ({
  findAll: jest.fn(),
  upsert: jest.fn(),
}));

jest.mock('../src/config/instruments', () => ({
  getAllSymbols: jest.fn(() => ['EURUSD', 'XAUUSD']),
}));

const Strategy = require('../src/models/Strategy');
const StrategyInstance = require('../src/models/StrategyInstance');
const {
  getRuntimeMatrix,
  updateRuntimeMatrix,
} = require('../src/services/strategyRuntimeMatrixService');

function mockStrategies() {
  return [
    {
      _id: 'trend-1',
      name: 'TrendFollowing',
      displayName: 'Trend Following',
      enabled: true,
      symbols: ['EURUSD'],
    },
    {
      _id: 'breakout-1',
      name: 'Breakout',
      displayName: 'Breakout',
      enabled: true,
      symbols: [],
    },
  ];
}

describe('strategy runtime matrix service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Strategy.findAll.mockResolvedValue(mockStrategies());
    Strategy.update.mockResolvedValue({});
    StrategyInstance.findAll.mockResolvedValue([]);
    StrategyInstance.upsert.mockResolvedValue({});
  });

  test('builds paper and live matrices from independent scoped enable fields', async () => {
    StrategyInstance.findAll.mockResolvedValue([
      {
        strategyName: 'TrendFollowing',
        symbol: 'EURUSD',
        enabled: true,
        paperEnabled: true,
        liveEnabled: false,
      },
      {
        strategyName: 'Breakout',
        symbol: 'XAUUSD',
        enabled: false,
        paperEnabled: false,
        liveEnabled: true,
      },
    ]);

    const paper = await getRuntimeMatrix({ scope: 'paper' });
    const live = await getRuntimeMatrix({ scope: 'live' });

    expect(paper.enabledBySymbol).toEqual({
      EURUSD: ['TrendFollowing'],
      XAUUSD: [],
    });
    expect(live.enabledBySymbol).toEqual({
      EURUSD: [],
      XAUUSD: ['Breakout'],
    });
  });

  test('live scope enables a new combo without writing paper fields', async () => {
    Strategy.findAll
      .mockResolvedValueOnce(mockStrategies())
      .mockResolvedValueOnce([
        {
          ...mockStrategies()[0],
          symbols: ['EURUSD'],
        },
        {
          ...mockStrategies()[1],
          symbols: ['XAUUSD'],
        },
      ]);
    StrategyInstance.findAll
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          strategyName: 'Breakout',
          symbol: 'XAUUSD',
          paperEnabled: false,
          liveEnabled: true,
        },
      ]);

    const result = await updateRuntimeMatrix({
      scope: 'live',
      enabledBySymbol: {
        EURUSD: [],
        XAUUSD: ['Breakout'],
      },
    });

    expect(Strategy.update).toHaveBeenCalledWith('breakout-1', { symbols: ['XAUUSD'] });
    expect(StrategyInstance.upsert).toHaveBeenCalledWith('Breakout', 'XAUUSD', {
      liveEnabled: true,
    });
    expect(StrategyInstance.upsert).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ paperEnabled: expect.any(Boolean) })
    );
    expect(result.summary).toEqual(expect.objectContaining({
      scope: 'live',
      enabledCount: 1,
      createdConfigurationCount: 1,
    }));
    expect(result.changes).toEqual([
      expect.objectContaining({
        symbol: 'XAUUSD',
        strategyName: 'Breakout',
        before: false,
        after: true,
        createdConfiguration: true,
      }),
    ]);
  });

  test('live scope disables only liveEnabled and does not remove shared assignments', async () => {
    StrategyInstance.findAll
      .mockResolvedValueOnce([
        {
          strategyName: 'TrendFollowing',
          symbol: 'EURUSD',
          paperEnabled: true,
          liveEnabled: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          strategyName: 'TrendFollowing',
          symbol: 'EURUSD',
          paperEnabled: true,
          liveEnabled: false,
        },
      ]);

    await updateRuntimeMatrix({
      scope: 'live',
      enabledBySymbol: {
        EURUSD: [],
        XAUUSD: [],
      },
    });

    expect(Strategy.update).not.toHaveBeenCalled();
    expect(StrategyInstance.upsert).toHaveBeenCalledWith('TrendFollowing', 'EURUSD', {
      liveEnabled: false,
    });
  });

  test('paper scope disables only paperEnabled and leaves live untouched', async () => {
    StrategyInstance.findAll
      .mockResolvedValueOnce([
        {
          strategyName: 'TrendFollowing',
          symbol: 'EURUSD',
          paperEnabled: true,
          liveEnabled: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          strategyName: 'TrendFollowing',
          symbol: 'EURUSD',
          paperEnabled: false,
          liveEnabled: true,
        },
      ]);

    await updateRuntimeMatrix({
      scope: 'paper',
      enabledBySymbol: {
        EURUSD: [],
        XAUUSD: [],
      },
    });

    expect(StrategyInstance.upsert).toHaveBeenCalledWith('TrendFollowing', 'EURUSD', {
      paperEnabled: false,
    });
    expect(StrategyInstance.upsert).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ liveEnabled: expect.any(Boolean) })
    );
  });

  test('rejects invalid runtime matrix payloads', async () => {
    await expect(updateRuntimeMatrix({
      scope: 'paper',
      enabledBySymbol: {
        FAKE: ['TrendFollowing'],
      },
    })).rejects.toThrow('Invalid symbol: FAKE');

    await expect(updateRuntimeMatrix({
      scope: 'paper',
      enabledBySymbol: {
        EURUSD: ['MissingStrategy'],
      },
    })).rejects.toThrow('Invalid strategy: MissingStrategy');
  });
});
