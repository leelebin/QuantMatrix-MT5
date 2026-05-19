jest.mock('../src/models/TradeLog', () => ({
  findClosedByDate: jest.fn(),
  findToday: jest.fn(),
  getStats: jest.fn(),
}));

jest.mock('../src/services/notificationHubService', () => ({
  enqueueTelegram: jest.fn(() => Promise.resolve({ queued: 1, skipped: 0 })),
  _internals: {
    escapeHtml: jest.fn((value) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')),
  },
}));

jest.mock('../src/config/db', () => ({
  paperPositionsDb: {
    find: jest.fn(),
  },
  positionsDb: {
    find: jest.fn(),
  },
  tradesDb: {
    find: jest.fn(),
  },
}));

const TradeLog = require('../src/models/TradeLog');
const notificationHubService = require('../src/services/notificationHubService');
const { paperPositionsDb } = require('../src/config/db');
const dailyReportService = require('../src/services/dailyReportService');

function closedTrade(overrides = {}) {
  return {
    symbol: 'EURUSD',
    type: 'BUY',
    strategy: 'Momentum',
    profitLoss: 10,
    profitPips: 15,
    realizedRMultiple: 1,
    exitReason: 'TP_HIT',
    closedAt: new Date('2026-05-19T10:00:00.000Z'),
    ...overrides,
  };
}

describe('dailyReportService v2', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DAILY_REPORT_SCOPE = 'paper';
    process.env.DAILY_REPORT_INCLUDE_SYMBOLCUSTOM = 'true';
    TradeLog.findClosedByDate.mockResolvedValue([]);
    TradeLog.findToday.mockResolvedValue([]);
    TradeLog.getStats.mockResolvedValue({
      totalTrades: 0,
      winRate: 0,
      totalProfit: 0,
      profitFactor: 0,
    });
    paperPositionsDb.find.mockResolvedValue([]);
  });

  afterEach(() => {
    delete process.env.DAILY_REPORT_SCOPE;
    delete process.env.DAILY_REPORT_INCLUDE_SYMBOLCUSTOM;
  });

  test('groups SymbolCustom daily report by source, strategy, and symbol', async () => {
    TradeLog.findClosedByDate.mockResolvedValue([
      closedTrade({
        symbol: 'USDJPY',
        type: 'SELL',
        strategy: 'SymbolCustom',
        source: 'symbolCustom',
        symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
        logicName: 'JPY_MACRO_REVERSAL',
        candidatePreset: 'trial-ready',
        profitLoss: 120.5,
        profitPips: 42.3,
        realizedRMultiple: 1.8,
      }),
      closedTrade({
        symbol: 'EURUSD',
        strategy: 'TrendFollowing',
        profitLoss: -24,
        profitPips: -8,
        realizedRMultiple: -0.5,
        exitReason: 'SL_HIT',
      }),
    ]);
    TradeLog.findToday.mockResolvedValue([
      { openedAt: '2026-05-19T03:00:00.000Z' },
      { openedAt: '2026-05-18T23:00:00.000Z' },
    ]);
    TradeLog.getStats.mockResolvedValue({
      totalTrades: 22,
      winRate: 0.5455,
      totalProfit: 318.7,
      profitFactor: 1.9,
    });
    paperPositionsDb.find.mockResolvedValue([
      {
        symbol: 'USDJPY',
        type: 'SELL',
        source: 'symbolCustom',
        symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
        unrealizedPl: 18.5,
        currentSl: 156.2,
        currentTp: 154.8,
      },
    ]);

    const report = await dailyReportService.generateAndSendReport(new Date('2026-05-19T12:00:00.000Z'));

    expect(report).toContain('Trading Daily Report v2');
    expect(report).toContain('PAPER Summary');
    expect(report).toContain('By Source');
    expect(report).toContain('six_strategy');
    expect(report).toContain('symbolCustom');
    expect(report).toContain('USDJPY_JPY_MACRO_REVERSAL_V1');
    expect(report).toContain('JPY_MACRO_REVERSAL');
    expect(report).toContain('trial-ready');
    expect(report).toContain('avgR +1.80');
    expect(report).toContain('By Strategy');
    expect(report).toContain('By Symbol');
    expect(report).toContain('Top Winners');
    expect(report).toContain('Top Losers');
    expect(report).toContain('Open Positions');
    expect(report).toContain('source symbolCustom');
    expect(notificationHubService.enqueueTelegram).toHaveBeenCalledWith(expect.objectContaining({
      type: 'daily_report',
      scope: 'paper',
      message: report,
      immediate: true,
    }));
  });

  test('sends long daily reports through notification hub for chunking', async () => {
    const trades = Array.from({ length: 180 }, (_, index) => closedTrade({
      symbol: `SYM${index}`,
      strategy: `Strategy${index}`,
      source: 'symbolCustom',
      symbolCustomName: `CUSTOM_${index}`,
      logicName: `LOGIC_${index}`,
      candidatePreset: `PRESET_${index}`,
      profitLoss: index % 2 === 0 ? 5 + index : -index,
      profitPips: index,
      exitReason: index % 2 === 0 ? 'TP_HIT' : 'SL_HIT',
    }));
    TradeLog.findClosedByDate.mockResolvedValue(trades);

    const report = await dailyReportService.generateAndSendReport(new Date('2026-05-19T12:00:00.000Z'));

    expect(report.length).toBeGreaterThan(3900);
    expect(notificationHubService.enqueueTelegram).toHaveBeenCalledWith(expect.objectContaining({
      type: 'daily_report',
      message: report,
      immediate: true,
    }));
  });
});
