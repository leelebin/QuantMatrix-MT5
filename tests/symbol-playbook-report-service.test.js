const mockPaperRows = [];
const mockLiveRows = [];

function mockCursor(rows) {
  return {
    sort: jest.fn(() => Promise.resolve([...rows])),
  };
}

jest.mock('../src/config/db', () => ({
  tradeLogDb: {
    find: jest.fn(() => mockCursor(mockPaperRows)),
  },
  tradesDb: {
    find: jest.fn(() => mockCursor(mockLiveRows)),
  },
}));

const { tradeLogDb, tradesDb } = require('../src/config/db');
const {
  SETUP_TYPE_LEGACY_FALLBACK,
  getSymbolPlaybookReport,
  inferLegacySetupType,
} = require('../src/services/symbolPlaybookReportService');

function closedTrade(overrides = {}) {
  return {
    symbol: 'XAUUSD',
    status: 'CLOSED',
    closedAt: new Date('2026-04-28T12:00:00.000Z'),
    openedAt: new Date('2026-04-28T11:00:00.000Z'),
    profitLoss: 0,
    ...overrides,
  };
}

describe('symbolPlaybookReportService', () => {
  beforeEach(() => {
    mockPaperRows.length = 0;
    mockLiveRows.length = 0;
    jest.clearAllMocks();
  });

  test('aggregates paper trades by symbol and setup type with legacy fallback', async () => {
    mockPaperRows.push(
      closedTrade({ setupType: 'event_breakout', profitLoss: 100, realizedRMultiple: 1 }),
      closedTrade({ setupType: 'event_breakout', profitLoss: -40, realizedRMultiple: -0.4 }),
      closedTrade({ setupType: 'event_breakout', profitLoss: 60, tradeR: 0.6 }),
      closedTrade({ profitLoss: 20, plannedRiskAmount: 100 }),
      closedTrade({ profitLoss: -10 }),
      closedTrade({
        setupType: 'old_trade',
        profitLoss: 999,
        closedAt: new Date('2026-04-20T12:00:00.000Z'),
        openedAt: new Date('2026-04-20T11:00:00.000Z'),
      }),
      closedTrade({
        status: 'OPEN',
        setupType: 'open_trade',
        profitLoss: 999,
      })
    );

    const report = await getSymbolPlaybookReport({ since: '2026-04-27' });

    expect(tradeLogDb.find).toHaveBeenCalledWith({
      status: 'CLOSED',
      $or: [
        { closedAt: { $gte: expect.any(Date) } },
        { openedAt: { $gte: expect.any(Date) } },
      ],
    });
    expect(tradesDb.find).not.toHaveBeenCalled();
    expect(report.scope).toBe('paper');
    expect(report.count).toBe(1);
    expect(report.totalTrades).toBe(5);
    expect(report.setupTypeSourceBreakdown).toEqual({
      recorded: 3,
      legacy_inferred: 0,
      unknown_legacy: 2,
    });

    const xauusd = report.symbols[0];
    expect(xauusd).toEqual(expect.objectContaining({
      symbol: 'XAUUSD',
      trades: 5,
      netPnl: 130,
      grossWin: 180,
      grossLoss: 50,
      profitFactor: 3.6,
      profitFactorLabel: null,
      winRate: 0.6,
      avgR: 0.35,
      maxSingleLoss: -40,
      bestSetupType: 'event_breakout',
      worstSetupType: SETUP_TYPE_LEGACY_FALLBACK,
      setupTypeSourceBreakdown: {
        recorded: 3,
        legacy_inferred: 0,
        unknown_legacy: 2,
      },
      recommendation: 'KEEP_AS_GROWTH_ENGINE',
    }));
    expect(xauusd.setups).toEqual([
      {
        setupType: 'event_breakout',
        setupTypeSourceBreakdown: {
          recorded: 3,
          legacy_inferred: 0,
          unknown_legacy: 0,
        },
        trades: 3,
        netPnl: 120,
        profitFactor: 4,
        profitFactorLabel: null,
        winRate: 0.6667,
        avgR: 0.4,
        maxSingleLoss: -40,
      },
      {
        setupType: SETUP_TYPE_LEGACY_FALLBACK,
        setupTypeSourceBreakdown: {
          recorded: 0,
          legacy_inferred: 0,
          unknown_legacy: 2,
        },
        trades: 2,
        netPnl: 10,
        profitFactor: 2,
        profitFactorLabel: null,
        winRate: 0.5,
        avgR: 0.2,
        maxSingleLoss: -10,
      },
    ]);
  });

  test('uses JSON-friendly INF label when there are wins and no losses', async () => {
    mockPaperRows.push(
      closedTrade({
        symbol: 'NAS100',
        setupType: 'us_session_momentum',
        profitLoss: 50,
        realizedRMultiple: 0.5,
      }),
      closedTrade({
        symbol: 'NAS100',
        setupType: 'us_session_momentum',
        profitLoss: 30,
        realizedRMultiple: 0.3,
      })
    );

    const report = await getSymbolPlaybookReport({ since: '2026-04-27' });
    const nas100 = report.symbols[0];

    expect(nas100).toEqual(expect.objectContaining({
      profitFactor: null,
      profitFactorLabel: 'INF',
      recommendation: 'NEED_MORE_DATA',
    }));
    expect(nas100.setups[0]).toEqual(expect.objectContaining({
      profitFactor: null,
      profitFactorLabel: 'INF',
      avgR: 0.4,
      setupTypeSourceBreakdown: {
        recorded: 2,
        legacy_inferred: 0,
        unknown_legacy: 0,
      },
    }));
  });

  test('keeps recorded setupType ahead of virtual legacy inference', async () => {
    mockPaperRows.push(
      closedTrade({
        symbol: 'XAUUSD',
        strategy: 'Breakout',
        setupType: 'recorded_override',
        profitLoss: 100,
      })
    );

    const report = await getSymbolPlaybookReport({ since: '2026-04-27' });

    expect(report.setupTypeSourceBreakdown).toEqual({
      recorded: 1,
      legacy_inferred: 0,
      unknown_legacy: 0,
    });
    expect(report.symbols[0].setups).toEqual([
      expect.objectContaining({
        setupType: 'recorded_override',
        setupTypeSourceBreakdown: {
          recorded: 1,
          legacy_inferred: 0,
          unknown_legacy: 0,
        },
      }),
    ]);
  });

  test('infers virtual setupType for legacy trades without writing records', async () => {
    mockPaperRows.push(
      closedTrade({
        symbol: 'XTIUSD',
        strategy: 'Breakout',
        setupType: undefined,
        profitLoss: 50,
      }),
      closedTrade({
        symbol: 'EURUSD',
        strategy: 'MeanReversion',
        setupType: '',
        profitLoss: 25,
      }),
      closedTrade({
        symbol: 'BTCUSD',
        strategyType: 'Momentum',
        setupType: null,
        profitLoss: 10,
      })
    );

    const report = await getSymbolPlaybookReport({ since: '2026-04-27' });

    expect(report.setupTypeSourceBreakdown).toEqual({
      recorded: 0,
      legacy_inferred: 3,
      unknown_legacy: 0,
    });
    expect(mockPaperRows[0].setupType).toBeUndefined();
    expect(mockPaperRows[1].setupType).toBe('');
    expect(mockPaperRows[2].setupType).toBeNull();
    expect(report.symbols.find((row) => row.symbol === 'XTIUSD')).toEqual(expect.objectContaining({
      bestSetupType: 'oil_news_continuation',
      setupTypeSourceBreakdown: {
        recorded: 0,
        legacy_inferred: 1,
        unknown_legacy: 0,
      },
    }));
    expect(report.symbols.find((row) => row.symbol === 'EURUSD').setups[0]).toEqual(expect.objectContaining({
      setupType: 'session_range_reversal',
      setupTypeSourceBreakdown: {
        recorded: 0,
        legacy_inferred: 1,
        unknown_legacy: 0,
      },
    }));
    expect(report.symbols.find((row) => row.symbol === 'BTCUSD').setups[0]).toEqual(expect.objectContaining({
      setupType: 'risk_on_momentum',
    }));
  });

  test('falls back to unknown legacy when virtual inference has no match', async () => {
    mockPaperRows.push(
      closedTrade({
        symbol: 'AUDUSD',
        strategy: 'TrendFollowing',
        setupType: null,
        profitLoss: -10,
      })
    );

    const report = await getSymbolPlaybookReport({ since: '2026-04-27' });

    expect(inferLegacySetupType({ symbol: 'AUDUSD', strategy: 'TrendFollowing' })).toBe(SETUP_TYPE_LEGACY_FALLBACK);
    expect(report.setupTypeSourceBreakdown).toEqual({
      recorded: 0,
      legacy_inferred: 0,
      unknown_legacy: 1,
    });
    expect(report.symbols[0].setups[0]).toEqual(expect.objectContaining({
      setupType: SETUP_TYPE_LEGACY_FALLBACK,
      setupTypeSourceBreakdown: {
        recorded: 0,
        legacy_inferred: 0,
        unknown_legacy: 1,
      },
    }));
  });

  test('supports live scope without reading paper trade log', async () => {
    mockLiveRows.push(
      closedTrade({
        symbol: 'EURUSD',
        setupType: 'm15_intraday_pullback',
        profitLoss: 12.5,
        plannedRiskAmount: 50,
      })
    );

    const report = await getSymbolPlaybookReport({ since: '2026-04-27', scope: 'live' });

    expect(tradesDb.find).toHaveBeenCalledTimes(1);
    expect(tradeLogDb.find).not.toHaveBeenCalled();
    expect(report.scope).toBe('live');
    expect(report.symbols[0]).toEqual(expect.objectContaining({
      symbol: 'EURUSD',
      trades: 1,
      netPnl: 12.5,
      avgR: 0.25,
    }));
  });

  test('suggests disable only for enough clearly negative data', async () => {
    mockPaperRows.push(
      closedTrade({ symbol: 'GBPUSD', setupType: 'm15_intraday_pullback', profitLoss: 10 }),
      ...Array.from({ length: 9 }, () => (
        closedTrade({ symbol: 'GBPUSD', setupType: 'm15_intraday_pullback', profitLoss: -10 })
      ))
    );

    const report = await getSymbolPlaybookReport({ since: '2026-04-27' });

    expect(report.symbols[0]).toEqual(expect.objectContaining({
      symbol: 'GBPUSD',
      trades: 10,
      netPnl: -80,
      profitFactor: 0.1111,
      recommendation: 'DISABLE_SUGGESTED',
    }));
  });

  test('rejects unsupported scope and invalid since date', async () => {
    await expect(getSymbolPlaybookReport({ scope: 'demo' })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Unsupported symbol playbook report scope: demo',
    });

    await expect(getSymbolPlaybookReport({ since: 'not-a-date' })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Invalid symbol playbook report since date: not-a-date',
    });
  });
});
