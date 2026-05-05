const fs = require('fs');
const os = require('os');
const path = require('path');

const mockHistoryDir = path.join(os.tmpdir(), 'qm-weekly-review-export-test');
const mockTradesDb = {
  find: jest.fn(),
};
const mockTradeLogDb = {
  find: jest.fn(),
};

jest.mock('../src/config/db', () => ({
  DATA_GROUP_DIRS: {
    history: mockHistoryDir,
  },
  tradesDb: mockTradesDb,
  tradeLogDb: mockTradeLogDb,
}));

const weeklyReviewExportService = require('../src/services/weeklyReviewExportService');

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('weekly review export service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.rmSync(mockHistoryDir, { recursive: true, force: true });
    mockTradesDb.find.mockResolvedValue([
      {
        _id: 'live-1',
        symbol: 'EURUSD',
        strategy: 'Momentum',
        status: 'CLOSED',
        openedAt: new Date('2026-04-27T10:00:00.000Z'),
        closedAt: new Date('2026-04-28T10:00:00.000Z'),
        profitLoss: 12.5,
      },
      {
        _id: 'live-2',
        symbol: 'XAUUSD',
        strategy: 'Breakout',
        status: 'CLOSED',
        openedAt: new Date('2026-05-04T01:00:00.000Z'),
        closedAt: new Date('2026-05-04T02:00:00.000Z'),
        profitLoss: -3,
      },
    ]);
    mockTradeLogDb.find.mockResolvedValue([
      {
        _id: 'paper-1',
        symbol: 'SPX500',
        strategy: 'Breakout',
        status: 'OPEN',
        openedAt: new Date('2026-05-03T12:00:00.000Z'),
        profitLoss: null,
      },
    ]);
  });

  afterAll(() => {
    fs.rmSync(mockHistoryDir, { recursive: true, force: true });
  });

  test('exports live and paper trade review files by ISO week', async () => {
    const result = await weeklyReviewExportService.exportWeeklyTradeReviews();
    const outputDir = path.join(mockHistoryDir, 'weekly-trades');

    expect(mockTradesDb.find).toHaveBeenCalledWith({});
    expect(mockTradeLogDb.find).toHaveBeenCalledWith({});
    expect(result.totalRecords).toBe(3);
    expect(result.sources.map((source) => source.source)).toEqual(['live', 'paper']);

    expect(fs.existsSync(path.join(outputDir, 'live-2026-W18.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'live-2026-W19.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'paper-2026-W18.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'summary.json'))).toBe(true);

    const liveWeek18 = readJsonl(path.join(outputDir, 'live-2026-W18.jsonl'));
    expect(liveWeek18).toEqual([
      expect.objectContaining({
        reviewSource: 'live',
        reviewWeek: '2026-W18',
        originalId: 'live-1',
        symbol: 'EURUSD',
      }),
    ]);

    const paperWeek18 = readJsonl(path.join(outputDir, 'paper-2026-W18.jsonl'));
    expect(paperWeek18).toEqual([
      expect.objectContaining({
        reviewSource: 'paper',
        reviewWeek: '2026-W18',
        originalId: 'paper-1',
        status: 'OPEN',
      }),
    ]);
  });

  test('can export only paper review files', async () => {
    const outputDir = path.join(mockHistoryDir, 'weekly-trades');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'live-2026-W18.jsonl'), '{}\n');

    const result = await weeklyReviewExportService.exportWeeklyTradeReviews({ scope: 'paper' });

    expect(mockTradesDb.find).not.toHaveBeenCalled();
    expect(mockTradeLogDb.find).toHaveBeenCalledWith({});
    expect(result.totalRecords).toBe(1);
    expect(fs.existsSync(path.join(outputDir, 'live-2026-W18.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'paper-2026-W18.jsonl'))).toBe(true);
  });

  test('rejects unknown scopes', async () => {
    await expect(
      weeklyReviewExportService.exportWeeklyTradeReviews({ scope: 'backtests' })
    ).rejects.toMatchObject({
      message: 'Unknown weekly review export scope: backtests',
      statusCode: 400,
    });
  });
});
