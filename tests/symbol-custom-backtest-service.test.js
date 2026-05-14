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

function loadService({
  symbolCustoms = [],
  backtests = [],
  registryLogics = {},
  historicalCandles = null,
} = {}) {
  jest.resetModules();

  const symbolCustomRecords = symbolCustoms.map((record) => ({ ...record }));
  const backtestRecords = backtests.map((record) => ({ ...record }));
  const symbolCustomsDb = createDb(symbolCustomRecords);
  const symbolCustomBacktestsDb = createDb(backtestRecords);
  const backtestEngine = { runBacktest: jest.fn(), run: jest.fn() };
  const tradeExecutor = { executeTrade: jest.fn() };
  const paperTradingService = { submitSymbolCustomSignal: jest.fn(), _executePaperTrade: jest.fn() };
  const riskManager = { calculateLotSize: jest.fn(), validateTrade: jest.fn() };
  const historicalProvider = jest.fn(async () => historicalCandles || { setup: [], entry: [], higher: [] });
  const symbolCustomCandleProviderService = {
    SYMBOL_CUSTOM_ENTRY_TIMEFRAME_REQUIRED: 'SYMBOL_CUSTOM_ENTRY_TIMEFRAME_REQUIRED',
    SYMBOL_CUSTOM_BACKTEST_DATE_RANGE_REQUIRED: 'SYMBOL_CUSTOM_BACKTEST_DATE_RANGE_REQUIRED',
    SYMBOL_CUSTOM_BACKTEST_CANDLES_NOT_FOUND: 'SYMBOL_CUSTOM_BACKTEST_CANDLES_NOT_FOUND',
    buildCandleProviderForSymbolCustom: jest.fn(() => historicalProvider),
    getSymbolCustomCandles: historicalProvider,
    normalizeTimeframe: jest.fn((timeframe) => timeframe),
  };
  const strategyMocks = mockStrategyClasses();
  const getSymbolCustomLogic = jest.fn((logicName) => {
    if (logicName === 'PLACEHOLDER_SYMBOL_CUSTOM') {
      return {
        name: 'PLACEHOLDER_SYMBOL_CUSTOM',
        analyze: jest.fn(() => ({
          signal: 'NONE',
          reason: 'Placeholder SymbolCustom has no active trading logic',
        })),
      };
    }
    return registryLogics[logicName] || null;
  });

  jest.doMock('../src/config/db', () => ({
    symbolCustomsDb,
    symbolCustomBacktestsDb,
  }));
  jest.doMock('../src/services/backtestEngine', () => backtestEngine);
  jest.doMock('../src/services/tradeExecutor', () => tradeExecutor);
  jest.doMock('../src/services/paperTradingService', () => paperTradingService);
  jest.doMock('../src/services/riskManager', () => riskManager);
  jest.doMock('../src/services/symbolCustomCandleProviderService', () => symbolCustomCandleProviderService);
  jest.doMock('../src/symbolCustom/registry', () => ({
    getSymbolCustomLogic,
  }));

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
    tradeExecutor,
    paperTradingService,
    riskManager,
    symbolCustomCandleProviderService,
    historicalProvider,
    getSymbolCustomLogic,
    strategyMocks,
  };
}

describe('symbolCustomBacktestService', () => {
  afterEach(() => {
    jest.dontMock('../src/config/db');
    jest.dontMock('../src/services/backtestEngine');
    jest.dontMock('../src/services/tradeExecutor');
    jest.dontMock('../src/services/paperTradingService');
    jest.dontMock('../src/services/riskManager');
    jest.dontMock('../src/services/symbolCustomCandleProviderService');
    jest.dontMock('../src/symbolCustom/registry');
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
        wins: 0,
        losses: 0,
        netPnl: 0,
        grossWin: 0,
        grossLoss: 0,
        profitFactor: null,
        winRate: null,
        avgR: null,
        maxDrawdown: 0,
        maxSingleLoss: 0,
        maxWin: 0,
        rejectedSignals: 0,
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

  test('non-placeholder logic without candles and historical disabled returns clear error', async () => {
    const { service } = loadService({
      symbolCustoms: [
        {
          _id: 'sc-needs-candles',
          symbol: 'GBPJPY',
          symbolCustomName: 'GBPJPY_MOCK',
          logicName: 'MOCK_SYMBOL_CUSTOM',
        },
      ],
      registryLogics: {
        MOCK_SYMBOL_CUSTOM: {
          name: 'MOCK_SYMBOL_CUSTOM',
          analyze: jest.fn(),
        },
      },
    });

    await expect(service.runSymbolCustomBacktest({
      symbolCustomId: 'sc-needs-candles',
      startDate: '2026-01-01',
      endDate: '2026-05-01',
      initialBalance: 500,
      options: { useHistoricalCandles: false },
    })).rejects.toMatchObject({
      statusCode: 400,
      message: service.SYMBOL_CUSTOM_BACKTEST_CANDLES_REQUIRED,
    });
  });

  test('non-placeholder historical backtest requires date range', async () => {
    const { service, historicalProvider } = loadService({
      symbolCustoms: [
        {
          _id: 'sc-needs-dates',
          symbol: 'GBPJPY',
          symbolCustomName: 'GBPJPY_MOCK',
          logicName: 'MOCK_SYMBOL_CUSTOM',
          timeframes: { entryTimeframe: '5m' },
        },
      ],
      registryLogics: {
        MOCK_SYMBOL_CUSTOM: {
          name: 'MOCK_SYMBOL_CUSTOM',
          analyze: jest.fn(),
        },
      },
    });

    await expect(service.runSymbolCustomBacktest({
      symbolCustomId: 'sc-needs-dates',
      initialBalance: 500,
      options: { useHistoricalCandles: true },
    })).rejects.toMatchObject({
      statusCode: 400,
      message: service.SYMBOL_CUSTOM_BACKTEST_DATE_RANGE_REQUIRED,
    });
    expect(historicalProvider).not.toHaveBeenCalled();
  });

  test('historical provider not found returns clear error', async () => {
    const { service, historicalProvider } = loadService({
      symbolCustoms: [
        {
          _id: 'sc-no-history',
          symbol: 'GBPJPY',
          symbolCustomName: 'GBPJPY_MOCK',
          logicName: 'MOCK_SYMBOL_CUSTOM',
          timeframes: { entryTimeframe: '5m' },
        },
      ],
      registryLogics: {
        MOCK_SYMBOL_CUSTOM: {
          name: 'MOCK_SYMBOL_CUSTOM',
          analyze: jest.fn(),
        },
      },
    });

    await expect(service.runSymbolCustomBacktest({
      symbolCustomId: 'sc-no-history',
      startDate: '2026-01-01',
      endDate: '2026-01-02',
      initialBalance: 500,
      options: { useHistoricalCandles: true },
    })).rejects.toMatchObject({
      statusCode: 400,
      message: service.SYMBOL_CUSTOM_BACKTEST_CANDLES_NOT_FOUND,
    });
    expect(historicalProvider).toHaveBeenCalledWith({
      symbol: 'GBPJPY',
      timeframes: { entryTimeframe: '5m' },
      startDate: '2026-01-01',
      endDate: '2026-01-02',
      limit: undefined,
    });
  });

  test('mock non-placeholder logic can complete a profitable backtest and save result', async () => {
    const analyze = jest.fn(async (context) => (context.currentIndex === 0
      ? { signal: 'BUY', sl: 95, tp: 110, reason: 'mock buy' }
      : { signal: 'NONE' }));
    const {
      service,
      records,
      getSymbolCustomLogic,
      historicalProvider,
      symbolCustomCandleProviderService,
    } = loadService({
      symbolCustoms: [
        {
          _id: 'sc-profitable',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_MOCK',
          logicName: 'MOCK_SYMBOL_CUSTOM',
          timeframes: { setupTimeframe: '15m', entryTimeframe: '5m', higherTimeframe: '1h' },
          parameters: { lookbackBars: 12 },
          riskConfig: { maxRiskPerTradePct: 1 },
        },
      ],
      registryLogics: {
        MOCK_SYMBOL_CUSTOM: {
          name: 'MOCK_SYMBOL_CUSTOM',
          analyze,
        },
      },
    });

    const backtest = await service.runSymbolCustomBacktest({
      symbolCustomId: 'sc-profitable',
      startDate: '2026-01-01',
      endDate: '2026-01-02',
      initialBalance: 1000,
      parameters: { lookbackBars: 20 },
      costModel: { spread: 0, commissionPerTrade: 0, slippage: 0 },
      candles: {
        setup: [],
        entry: [
          { time: '2026-01-01T00:00:00.000Z', open: 100, high: 101, low: 99, close: 100 },
          { time: '2026-01-01T00:05:00.000Z', open: 100, high: 110, low: 99, close: 109 },
        ],
        higher: [],
      },
    });

    expect(getSymbolCustomLogic).toHaveBeenCalledWith('MOCK_SYMBOL_CUSTOM');
    expect(symbolCustomCandleProviderService.buildCandleProviderForSymbolCustom).not.toHaveBeenCalled();
    expect(historicalProvider).not.toHaveBeenCalled();
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'backtest',
      symbol: 'USDJPY',
      symbolCustomId: 'sc-profitable',
      symbolCustomName: 'USDJPY_MOCK',
      logicName: 'MOCK_SYMBOL_CUSTOM',
    }));
    expect(backtest.status).toBe('completed');
    expect(backtest.finalBalance).toBeGreaterThan(1000);
    expect(backtest.summary.trades).toBe(1);
    expect(backtest.summary.netPnl).toBeGreaterThan(0);
    expect(backtest.trades[0]).toEqual(expect.objectContaining({
      exitReason: 'TP',
      positionSizingMode: 'RISK_BASED',
    }));
    expect(backtest.costModelUsed).toEqual({ spread: 0, commissionPerTrade: 0, slippage: 0 });
    expect(records.backtests).toHaveLength(1);
  });

  test('candleProvider can provide candles for non-placeholder logic', async () => {
    const analyze = jest.fn(async (context) => (context.currentIndex === 0
      ? { signal: 'SELL', sl: 105, tp: 90, reason: 'mock sell' }
      : { signal: 'NONE' }));
    const candleProvider = jest.fn(async () => ({
      entry: [
        { time: '2026-01-01T00:00:00.000Z', open: 100, high: 101, low: 99, close: 100 },
        { time: '2026-01-01T00:05:00.000Z', open: 100, high: 101, low: 90, close: 91 },
      ],
    }));
    const { service } = loadService({
      symbolCustoms: [
        {
          _id: 'sc-provider',
          symbol: 'AUDUSD',
          symbolCustomName: 'AUDUSD_MOCK',
          logicName: 'MOCK_SYMBOL_CUSTOM',
          timeframes: { entryTimeframe: '5m' },
        },
      ],
      registryLogics: {
        MOCK_SYMBOL_CUSTOM: {
          name: 'MOCK_SYMBOL_CUSTOM',
          analyze,
        },
      },
    });

    const backtest = await service.runSymbolCustomBacktest({
      symbolCustomId: 'sc-provider',
      startDate: '2026-01-01',
      endDate: '2026-01-02',
      initialBalance: 1000,
      candleProvider,
    });

    expect(candleProvider).toHaveBeenCalledWith({
      symbol: 'AUDUSD',
      timeframes: { entryTimeframe: '5m' },
      startDate: '2026-01-01',
      endDate: '2026-01-02',
      limit: undefined,
    });
    expect(backtest.status).toBe('completed');
    expect(backtest.trades[0].side).toBe('SELL');
    expect(backtest.trades[0].exitReason).toBe('TP');
  });

  test('historical provider can supply setup entry and higher candles for runner execution', async () => {
    const analyze = jest.fn(async (context) => (context.currentIndex === 0
      ? { signal: 'BUY', sl: 95, tp: 110, reason: 'historical buy' }
      : { signal: 'NONE' }));
    const historicalCandles = {
      setup: [
        { time: '2026-01-01T00:00:00.000Z', open: 100, high: 101, low: 99, close: 100 },
      ],
      entry: [
        { time: '2026-01-01T00:00:00.000Z', open: 100, high: 101, low: 99, close: 100 },
        { time: '2026-01-01T00:05:00.000Z', open: 100, high: 110, low: 99, close: 109 },
      ],
      higher: [
        { time: '2026-01-01T00:00:00.000Z', open: 100, high: 101, low: 99, close: 100 },
      ],
    };
    const { service, historicalProvider, symbolCustomCandleProviderService } = loadService({
      historicalCandles,
      symbolCustoms: [
        {
          _id: 'sc-history',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_HISTORY_MOCK',
          logicName: 'MOCK_SYMBOL_CUSTOM',
          timeframes: { setupTimeframe: '15m', entryTimeframe: '5m', higherTimeframe: '1h' },
          riskConfig: { maxRiskPerTradePct: 1 },
        },
      ],
      registryLogics: {
        MOCK_SYMBOL_CUSTOM: {
          name: 'MOCK_SYMBOL_CUSTOM',
          analyze,
        },
      },
    });

    const backtest = await service.runSymbolCustomBacktest({
      symbolCustomId: 'sc-history',
      startDate: '2026-01-01',
      endDate: '2026-01-02',
      initialBalance: 1000,
    });

    expect(symbolCustomCandleProviderService.buildCandleProviderForSymbolCustom).toHaveBeenCalledWith(expect.objectContaining({
      _id: 'sc-history',
      symbol: 'USDJPY',
    }));
    expect(historicalProvider).toHaveBeenCalledWith({
      symbol: 'USDJPY',
      timeframes: { setupTimeframe: '15m', entryTimeframe: '5m', higherTimeframe: '1h' },
      startDate: '2026-01-01',
      endDate: '2026-01-02',
      limit: undefined,
    });
    expect(backtest.status).toBe('completed');
    expect(backtest.summary.trades).toBe(1);
    expect(backtest.trades[0].exitReason).toBe('TP');
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

  test('does not call old backtestEngine, six strategy classes, tradeExecutor, paperTradingService, or riskManager', async () => {
    const { service, backtestEngine, strategyMocks, tradeExecutor, paperTradingService, riskManager } = loadService({
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
    expect(tradeExecutor.executeTrade).not.toHaveBeenCalled();
    expect(paperTradingService.submitSymbolCustomSignal).not.toHaveBeenCalled();
    expect(paperTradingService._executePaperTrade).not.toHaveBeenCalled();
    expect(riskManager.calculateLotSize).not.toHaveBeenCalled();
    expect(riskManager.validateTrade).not.toHaveBeenCalled();
    Object.values(strategyMocks).forEach((StrategyClass) => {
      expect(StrategyClass).not.toHaveBeenCalled();
    });
  });
});
