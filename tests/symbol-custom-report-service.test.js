function loadReportService({ symbolCustoms = [], backtests = [], registeredLogics = ['PLACEHOLDER_SYMBOL_CUSTOM'] } = {}) {
  jest.resetModules();

  const SymbolCustom = {
    findAll: jest.fn(async (filter = {}) => symbolCustoms.filter((record) => Object.entries(filter).every(([key, value]) => record[key] === value))),
  };
  const SymbolCustomBacktest = {
    findAll: jest.fn(async (filter = {}) => backtests.filter((record) => Object.entries(filter).every(([key, value]) => record[key] === value))),
  };

  jest.doMock('../src/models/SymbolCustom', () => SymbolCustom);
  jest.doMock('../src/models/SymbolCustomBacktest', () => SymbolCustomBacktest);
  jest.doMock('../src/symbolCustom/registry', () => ({
    isSymbolCustomRegistered: jest.fn((logicName) => registeredLogics.includes(logicName)),
  }));

  return {
    service: require('../src/services/symbolCustomReportService'),
    SymbolCustom,
    SymbolCustomBacktest,
  };
}

describe('symbolCustomReportService', () => {
  afterEach(() => {
    jest.dontMock('../src/models/SymbolCustom');
    jest.dontMock('../src/models/SymbolCustomBacktest');
    jest.dontMock('../src/symbolCustom/registry');
  });

  test('draft with placeholder returns PLACEHOLDER_ONLY', async () => {
    const { service } = loadReportService({
      symbolCustoms: [
        {
          _id: 'sc-1',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_DRAFT',
          displayName: 'USDJPY Draft',
          status: 'draft',
          paperEnabled: false,
          liveEnabled: false,
          isPrimaryLive: false,
          allowLive: false,
          logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
          version: 1,
          timeframes: { setupTimeframe: '15m' },
        },
      ],
    });

    const report = await service.buildSymbolCustomReport();

    expect(report).toEqual({
      success: true,
      count: 1,
      symbolCustoms: [
        expect.objectContaining({
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_DRAFT',
          logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
          latestBacktest: null,
          recommendation: 'PLACEHOLDER_ONLY',
          warnings: [],
        }),
      ],
    });
  });

  test('paper enabled registered custom logic with no backtest returns NEEDS_BACKTEST', async () => {
    const { service } = loadReportService({
      registeredLogics: ['PLACEHOLDER_SYMBOL_CUSTOM', 'CUSTOM_SYMBOL_LOGIC'],
      symbolCustoms: [
        {
          _id: 'sc-paper',
          symbol: 'GBPJPY',
          symbolCustomName: 'GBPJPY_CUSTOM',
          status: 'paper_testing',
          paperEnabled: true,
          liveEnabled: false,
          logicName: 'CUSTOM_SYMBOL_LOGIC',
        },
      ],
    });

    const report = await service.buildSymbolCustomReport();

    expect(report.symbolCustoms[0]).toEqual(expect.objectContaining({
      paperEnabled: true,
      liveEnabled: false,
      latestBacktest: null,
      recommendation: 'NEEDS_BACKTEST',
    }));
  });

  test('latest backtest summary loads newest record correctly', async () => {
    const { service } = loadReportService({
      registeredLogics: ['PLACEHOLDER_SYMBOL_CUSTOM', 'CUSTOM_SYMBOL_LOGIC'],
      symbolCustoms: [
        {
          _id: 'sc-1',
          symbol: 'AUDUSD',
          symbolCustomName: 'AUDUSD_CUSTOM',
          status: 'paper_testing',
          paperEnabled: true,
          liveEnabled: false,
          logicName: 'CUSTOM_SYMBOL_LOGIC',
        },
      ],
      backtests: [
        {
          _id: 'bt-old',
          symbolCustomId: 'sc-1',
          status: 'stub',
          startDate: '2026-01-01',
          endDate: '2026-02-01',
          summary: { trades: 0, netPnl: 0, profitFactor: null, winRate: null, avgR: null, maxDrawdown: 0 },
          message: 'old',
          createdAt: new Date('2026-02-02T00:00:00.000Z'),
        },
        {
          _id: 'bt-new',
          symbolCustomId: 'sc-1',
          status: 'completed',
          startDate: '2026-03-01',
          endDate: '2026-04-01',
          summary: { trades: 12, netPnl: 45.5, profitFactor: 1.4, winRate: 58.3, avgR: 0.22, maxDrawdown: 12 },
          message: 'new',
          createdAt: new Date('2026-04-02T00:00:00.000Z'),
        },
      ],
    });

    const summary = await service.buildSymbolCustomSummary({
      _id: 'sc-1',
      symbol: 'AUDUSD',
      symbolCustomName: 'AUDUSD_CUSTOM',
      status: 'paper_testing',
      paperEnabled: true,
      liveEnabled: false,
      logicName: 'CUSTOM_SYMBOL_LOGIC',
    });

    expect(summary.latestBacktest).toEqual({
      status: 'completed',
      startDate: '2026-03-01',
      endDate: '2026-04-01',
      trades: 12,
      netPnl: 45.5,
      profitFactor: 1.4,
      winRate: 58.3,
      avgR: 0.22,
      maxDrawdown: 12,
      message: 'new',
      createdAt: new Date('2026-04-02T00:00:00.000Z'),
    });
    expect(summary.recommendation).toBe('PAPER_TESTING');
  });

  test('filters by symbol and status', async () => {
    const { service, SymbolCustom } = loadReportService({
      symbolCustoms: [
        { _id: 'sc-1', symbol: 'USDJPY', symbolCustomName: 'A', status: 'draft', logicName: 'PLACEHOLDER_SYMBOL_CUSTOM' },
        { _id: 'sc-2', symbol: 'GBPJPY', symbolCustomName: 'B', status: 'draft', logicName: 'PLACEHOLDER_SYMBOL_CUSTOM' },
        { _id: 'sc-3', symbol: 'USDJPY', symbolCustomName: 'C', status: 'disabled', logicName: 'PLACEHOLDER_SYMBOL_CUSTOM' },
      ],
    });

    await expect(service.buildSymbolCustomReport({ symbol: 'usdjpy', status: 'draft' })).resolves.toEqual(expect.objectContaining({
      count: 1,
      symbolCustoms: [expect.objectContaining({ symbolCustomName: 'A' })],
    }));
    expect(SymbolCustom.findAll).toHaveBeenCalledWith({ symbol: 'USDJPY', status: 'draft' });
  });

  test('warnings include liveEnabled true but Phase 1 has no live support', async () => {
    const { service } = loadReportService({
      symbolCustoms: [
        {
          _id: 'sc-live',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_LIVE_FLAG',
          status: 'draft',
          liveEnabled: true,
          logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
        },
      ],
    });

    const report = await service.buildSymbolCustomReport();

    expect(report.symbolCustoms[0].warnings).toContain('SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1');
  });

  test('missing or unregistered logic returns PLACEHOLDER_ONLY warning', async () => {
    const { service } = loadReportService({
      symbolCustoms: [
        { _id: 'sc-missing', symbol: 'USDJPY', symbolCustomName: 'MISSING', status: 'draft' },
        { _id: 'sc-unknown', symbol: 'USDJPY', symbolCustomName: 'UNKNOWN', status: 'draft', logicName: 'UNKNOWN_LOGIC' },
      ],
    });

    const report = await service.buildSymbolCustomReport();

    expect(report.symbolCustoms).toEqual([
      expect.objectContaining({
        recommendation: 'PLACEHOLDER_ONLY',
        warnings: ['SYMBOL_CUSTOM_LOGIC_MISSING'],
      }),
      expect.objectContaining({
        recommendation: 'PLACEHOLDER_ONLY',
        warnings: ['SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED'],
      }),
    ]);
  });
});
