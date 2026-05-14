function getByPath(doc, key) {
  return String(key).split('.').reduce((value, part) => (value == null ? undefined : value[part]), doc);
}

function matchesQuery(doc, query = {}) {
  return Object.entries(query).every(([key, value]) => {
    const actual = getByPath(doc, key);
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, '$gt')) {
      return actual > value.$gt;
    }
    return actual === value;
  });
}

function sortRecords(records, sortSpec = {}) {
  const fields = Object.entries(sortSpec);
  return [...records].sort((left, right) => {
    for (const [field, direction] of fields) {
      const leftValue = getByPath(left, field);
      const rightValue = getByPath(right, field);
      if (leftValue === rightValue) continue;
      if (leftValue > rightValue) return direction;
      return -direction;
    }
    return 0;
  });
}

function createDb(records) {
  let nextId = records.length + 1;
  return {
    findOne: jest.fn(async (query) => records.find((record) => matchesQuery(record, query)) || null),
    find: jest.fn((query = {}) => ({
      sort: jest.fn(async (sortSpec) => sortRecords(
        records.filter((record) => matchesQuery(record, query)),
        sortSpec
      )),
    })),
    insert: jest.fn(async (doc) => {
      const stored = {
        _id: doc._id || `symbol-custom-backtest-${nextId++}`,
        ...doc,
      };
      records.push(stored);
      return stored;
    }),
    remove: jest.fn(async (query) => {
      const removed = records.filter((record) => matchesQuery(record, query));
      const remaining = records.filter((record) => !matchesQuery(record, query));
      records.splice(0, records.length, ...remaining);
      return removed.length;
    }),
  };
}

function mockStrategyClasses() {
  const strategyMocks = {
    TrendFollowingStrategy: jest.fn(),
    MeanReversionStrategy: jest.fn(),
    BreakoutStrategy: jest.fn(),
    MomentumStrategy: jest.fn(),
    MultiTimeframeStrategy: jest.fn(),
    VolumeFlowHybridStrategy: jest.fn(),
  };

  Object.entries(strategyMocks).forEach(([name, mockFn]) => {
    jest.doMock(`../src/strategies/${name}`, () => mockFn);
  });

  return strategyMocks;
}

function loadService({ symbolCustoms = [], backtests = [] } = {}) {
  jest.resetModules();

  const symbolCustomRecords = symbolCustoms.map((record) => ({ ...record }));
  const backtestRecords = backtests.map((record) => ({ ...record }));
  const symbolCustomsDb = createDb(symbolCustomRecords);
  const symbolCustomBacktestsDb = createDb(backtestRecords);
  const backtestEngine = { runBacktest: jest.fn(), run: jest.fn() };
  const strategyMocks = mockStrategyClasses();

  jest.doMock('../src/config/db', () => ({
    symbolCustomsDb,
    symbolCustomBacktestsDb,
  }));
  jest.doMock('../src/services/backtestEngine', () => backtestEngine);

  const service = require('../src/services/symbolCustomBacktestService');
  return {
    service,
    records: {
      symbolCustoms: symbolCustomRecords,
      backtests: backtestRecords,
    },
    db: {
      symbolCustomsDb,
      symbolCustomBacktestsDb,
    },
    backtestEngine,
    strategyMocks,
  };
}

describe('symbolCustomBacktestService', () => {
  afterEach(() => {
    jest.dontMock('../src/config/db');
    jest.dontMock('../src/services/backtestEngine');
    [
      'TrendFollowingStrategy',
      'MeanReversionStrategy',
      'BreakoutStrategy',
      'MomentumStrategy',
      'MultiTimeframeStrategy',
      'VolumeFlowHybridStrategy',
    ].forEach((name) => {
      jest.dontMock(`../src/strategies/${name}`);
    });
  });

  test('placeholder logic returns stub result and saves a backtest record', async () => {
    const { service, records } = loadService({
      symbolCustoms: [
        {
          _id: 'sc-1',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
          logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
          timeframes: { setupTimeframe: '15m', entryTimeframe: '5m', higherTimeframe: '1h' },
          parameters: { lookbackBars: 50 },
        },
      ],
    });

    const backtest = await service.runSymbolCustomBacktest({
      symbolCustomId: 'sc-1',
      startDate: '2026-01-01',
      endDate: '2026-05-01',
      initialBalance: 500,
      parameters: { lookbackBars: 34 },
      costModel: { spreadPips: 1.2 },
    });

    expect(backtest).toEqual(expect.objectContaining({
      _id: expect.any(String),
      symbol: 'USDJPY',
      symbolCustomId: 'sc-1',
      symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
      mode: 'symbolCustom',
      status: 'stub',
      message: service.PHASE_1_PLACEHOLDER_BACKTEST_MESSAGE,
      trades: [],
      equityCurve: [],
      parameters: { lookbackBars: 34 },
      costModel: { spreadPips: 1.2 },
      summary: {
        trades: 0,
        netPnl: 0,
        grossWin: 0,
        grossLoss: 0,
        profitFactor: null,
        winRate: null,
        avgR: null,
        maxDrawdown: 0,
        maxSingleLoss: 0,
      },
      completedAt: expect.any(Date),
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    }));
    expect(records.backtests).toHaveLength(1);
    expect(records.backtests[0]._id).toBe(backtest._id);
  });

  test('missing logic returns clear error', async () => {
    const { service } = loadService({
      symbolCustoms: [
        {
          _id: 'sc-missing-logic',
          symbol: 'GBPJPY',
          symbolCustomName: 'GBPJPY_UNKNOWN',
          logicName: 'UNKNOWN_SYMBOL_CUSTOM',
        },
      ],
    });

    await expect(service.runSymbolCustomBacktest({
      symbolCustomId: 'sc-missing-logic',
      startDate: '2026-01-01',
      endDate: '2026-05-01',
      initialBalance: 500,
    })).rejects.toMatchObject({
      statusCode: 400,
      message: service.SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED,
      details: expect.arrayContaining([
        expect.objectContaining({ field: 'logicName' }),
      ]),
    });
  });

  test('list, get, and delete backtests work', async () => {
    const { service } = loadService({
      backtests: [
        { _id: 'bt-1', symbol: 'USDJPY', symbolCustomId: 'sc-1', symbolCustomName: 'A', mode: 'symbolCustom', status: 'stub', createdAt: new Date('2026-01-01') },
        { _id: 'bt-2', symbol: 'AUDUSD', symbolCustomId: 'sc-2', symbolCustomName: 'B', mode: 'symbolCustom', status: 'stub', createdAt: new Date('2026-01-02') },
      ],
    });

    await expect(service.listSymbolCustomBacktests({ symbol: 'usdjpy' })).resolves.toEqual([
      expect.objectContaining({ _id: 'bt-1', symbol: 'USDJPY' }),
    ]);
    await expect(service.getSymbolCustomBacktest('bt-2')).resolves.toEqual(expect.objectContaining({
      _id: 'bt-2',
      symbol: 'AUDUSD',
    }));
    await expect(service.deleteSymbolCustomBacktest('bt-1')).resolves.toEqual(expect.objectContaining({
      _id: 'bt-1',
    }));
    await expect(service.getSymbolCustomBacktest('bt-1')).resolves.toBeNull();
  });

  test('does not call old backtestEngine or six strategy classes', async () => {
    const { service, backtestEngine, strategyMocks } = loadService({
      symbolCustoms: [
        {
          _id: 'sc-1',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_PLACEHOLDER',
          logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
        },
      ],
    });

    await service.runSymbolCustomBacktest({
      symbolCustomId: 'sc-1',
      startDate: '2026-01-01',
      endDate: '2026-05-01',
      initialBalance: 500,
    });

    expect(backtestEngine.runBacktest).not.toHaveBeenCalled();
    expect(backtestEngine.run).not.toHaveBeenCalled();
    Object.values(strategyMocks).forEach((StrategyClass) => {
      expect(StrategyClass).not.toHaveBeenCalled();
    });
  });
});
