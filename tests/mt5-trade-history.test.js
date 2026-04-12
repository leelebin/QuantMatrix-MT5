jest.mock('../src/config/db', () => ({
  tradesDb: {
    update: jest.fn(),
  },
}));

jest.mock('../src/services/mt5Service', () => ({
  getPositionDealSummary: jest.fn(),
  getDealsByOrder: jest.fn(),
  isConnected: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(),
}));

const { tradesDb } = require('../src/config/db');
const mt5Service = require('../src/services/mt5Service');
const tradeHistoryService = require('../src/services/tradeHistoryService');
const { buildClosedTradeSnapshot } = require('../src/utils/mt5Reconciliation');

describe('trade history reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('uses pipValue fallback so JPY pairs are approximated in account currency', () => {
    const snapshot = buildClosedTradeSnapshot({
      symbol: 'USDJPY',
      type: 'BUY',
      lotSize: 0.04,
      entryPrice: 159.196,
    }, null, {
      exitPrice: 158.927,
      reason: 'SL_HIT',
      closedAt: new Date('2026-04-10T15:30:02.000Z'),
    });

    expect(snapshot.profitLoss).toBeCloseTo(-7.21, 2);
    expect(snapshot.profitPips).toBeCloseTo(-26.9, 1);
    expect(snapshot.exitReason).toBe('SL_HIT');
  });

  test('reconciles a closed trade from broker history when only mt5OrderId is present', async () => {
    mt5Service.getPositionDealSummary.mockResolvedValue({
      deals: [{ id: '37379719' }, { id: '37596008' }],
      positionId: '38189876',
      entryDeals: [{ id: '37379719', comment: 'QM|TrendFollowing|BUY|0.50' }],
      exitDeals: [{ id: '37596008' }],
      lastExitDeal: { id: '37596008' },
      entryPrice: 159.196,
      exitPrice: 158.927,
      entryTime: '2026-04-10T03:08:38.000Z',
      exitTime: '2026-04-10T15:30:02.000Z',
      realizedProfit: -6.77,
      commission: 0,
      swap: 0,
      fee: 0,
      exitReason: 'SL',
    });

    const result = await tradeHistoryService.reconcileTrade({
      _id: 'trade-1',
      symbol: 'USDJPY',
      type: 'BUY',
      lotSize: 0.04,
      entryPrice: 159.196,
      exitPrice: 159.024,
      profitLoss: -688,
      mt5OrderId: '38189876',
      openedAt: '2026-04-10T00:08:38.266Z',
      closedAt: '2026-04-10T12:30:10.333Z',
      exitReason: 'SL_HIT',
      status: 'CLOSED',
    });

    expect(mt5Service.getPositionDealSummary).toHaveBeenCalledWith(
      '38189876',
      expect.any(Date),
      expect.any(Date)
    );
    expect(tradesDb.update).toHaveBeenCalledWith(
      { _id: 'trade-1' },
      {
        $set: expect.objectContaining({
          entryPrice: 159.196,
          exitPrice: 158.927,
          profitLoss: -6.77,
          mt5PositionId: '38189876',
          mt5EntryDealId: '37379719',
          mt5CloseDealId: '37596008',
          mt5Comment: 'QM|TrendFollowing|BUY|0.50',
          comment: expect.stringContaining('Strategy=TrendFollowing'),
          openedAt: new Date('2026-04-10T03:08:38.000Z'),
          closedAt: new Date('2026-04-10T15:30:02.000Z'),
        }),
      }
    );
    expect(result.updated).toBe(true);
  });
});
