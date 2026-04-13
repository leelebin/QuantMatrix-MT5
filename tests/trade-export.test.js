const { LIVE_TRADE_COLUMNS, buildCsv, buildExportFilename } = require('../src/utils/tradeExport');

describe('trade export utilities', () => {
  test('builds a UTF-8 CSV with strategy/comment fields', () => {
    const csv = buildCsv(LIVE_TRADE_COLUMNS, [{
      openedAt: new Date('2026-04-10T11:03:38.000Z'),
      closedAt: new Date('2026-04-10T12:00:08.000Z'),
      symbol: 'GBPJPY',
      type: 'SELL',
      strategy: 'MeanReversion',
      confidence: 0.5,
      comment: 'Strategy=MeanReversion | Signal=SELL | Confidence=50%',
      mt5Comment: 'QM|MeanReversion',
      reason: 'Price bounced from upper BB',
      entryPrice: 213.705,
      exitPrice: 213.847,
      sl: 213.84,
      tp: 213.611,
      lotSize: 0.09,
      profitLoss: -8.02,
      profitPips: -14.2,
      commission: 0,
      swap: 0,
      fee: 0,
      exitReason: 'SL_HIT',
      status: 'CLOSED',
      mt5PositionId: '38313633',
      mt5OrderId: '38313633',
      mt5EntryDealId: '37500941',
      mt5CloseDealId: '37522737',
      brokerSyncSource: 'position',
      brokerSyncedAt: new Date('2026-04-13T00:10:00.000Z'),
      indicatorsSnapshot: { rsi: 66.33 },
    }]);

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('strategy');
    expect(csv).toContain('mt5_comment');
    expect(csv).toContain('Strategy=MeanReversion | Signal=SELL | Confidence=50%');
    expect(csv).toContain('QM|MeanReversion');
  });

  test('builds a readable CSV filename from filters', () => {
    const filename = buildExportFilename({
      symbol: 'GBPJPY',
      strategy: 'MeanReversion',
      status: 'CLOSED',
    });

    expect(filename).toMatch(/^quantmatrix-trades-GBPJPY-MeanReversion-CLOSED-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
