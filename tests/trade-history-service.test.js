const mockTradeRows = [];

function mockMatchesDate(value, condition = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (condition.$gte && date < condition.$gte) return false;
  if (condition.$lte && date > condition.$lte) return false;
  return true;
}

function mockMatchesField(value, condition) {
  if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
    if (condition.$exists != null) {
      const exists = value !== undefined;
      if (exists !== condition.$exists) return false;
    }
    if (condition.$ne != null && value === condition.$ne) return false;
    if (condition.$gte != null || condition.$lte != null) {
      return mockMatchesDate(value, condition);
    }
    return true;
  }

  return value === condition;
}

function mockMatchesQuery(row, query = {}) {
  if (query.$or) {
    const matchedOrBranch = query.$or.some((branch) => mockMatchesQuery(row, branch));
    if (!matchedOrBranch) return false;
  }

  for (const [field, condition] of Object.entries(query)) {
    if (field === '$or') continue;
    if (!mockMatchesField(row[field], condition)) return false;
  }

  return true;
}

function mockMakeCursor(rows) {
  return {
    sort(sortSpec = {}) {
      const [[field, direction]] = Object.entries(sortSpec);
      const sorted = [...rows].sort((left, right) => {
        const leftValue = new Date(left[field] || 0).getTime();
        const rightValue = new Date(right[field] || 0).getTime();
        return direction >= 0 ? leftValue - rightValue : rightValue - leftValue;
      });
      return mockMakeCursor(sorted);
    },
    limit(limit) {
      return Promise.resolve(rows.slice(0, limit));
    },
    then(resolve, reject) {
      return Promise.resolve(rows).then(resolve, reject);
    },
  };
}

jest.mock('../src/config/db', () => ({
  tradesDb: {
    find: jest.fn((query = {}) => mockMakeCursor(mockTradeRows.filter((row) => mockMatchesQuery(row, query)))),
    findOne: jest.fn(async (query = {}) => mockTradeRows.find((row) => mockMatchesQuery(row, query)) || null),
    insert: jest.fn(async (doc) => {
      const inserted = { _id: `trade-${mockTradeRows.length + 1}`, ...doc };
      mockTradeRows.push(inserted);
      return inserted;
    }),
    update: jest.fn(async (query = {}, update = {}) => {
      const row = mockTradeRows.find((candidate) => mockMatchesQuery(candidate, query));
      if (!row) return 0;
      Object.assign(row, update.$set || {});
      return 1;
    }),
  },
}));

jest.mock('../src/config/instruments', () => ({
  getInstrument: jest.fn((symbol) => ({
    symbol,
    pipSize: symbol === 'NAS100' ? 1 : 0.0001,
    pipValue: symbol === 'NAS100' ? 1 : 10,
    contractSize: 100000,
  })),
}));

jest.mock('../src/services/mt5Service', () => ({
  isConnected: jest.fn(),
  connect: jest.fn(),
  disconnect: jest.fn(),
  getDeals: jest.fn(),
  getPositionDealSummary: jest.fn(),
  getDealsByOrder: jest.fn(),
  summarizePositionDeals: jest.fn(),
}));

const mt5Service = require('../src/services/mt5Service');
const tradeHistoryService = require('../src/services/tradeHistoryService');

function summarizeDeals(deals = []) {
  const orderedDeals = [...deals].sort((left, right) => new Date(left.time) - new Date(right.time));
  const entryDeals = orderedDeals.filter((deal) => deal.entryName === 'IN');
  const exitDeals = orderedDeals.filter((deal) => deal.entryName === 'OUT');
  const lastExitDeal = exitDeals[exitDeals.length - 1] || null;

  return {
    deals: orderedDeals,
    entryDeals,
    exitDeals,
    entryPrice: entryDeals[0]?.price || null,
    exitPrice: lastExitDeal?.price || null,
    entryTime: entryDeals[0]?.time || null,
    exitTime: lastExitDeal?.time || null,
    positionId: orderedDeals[0]?.positionId || null,
    entryVolume: entryDeals.reduce((sum, deal) => sum + (Number(deal.volume) || 0), 0),
    exitVolume: exitDeals.reduce((sum, deal) => sum + (Number(deal.volume) || 0), 0),
    realizedProfit: orderedDeals.reduce((sum, deal) => (
      sum + (Number(deal.profit) || 0) + (Number(deal.commission) || 0) + (Number(deal.swap) || 0) + (Number(deal.fee) || 0)
    ), 0),
    commission: orderedDeals.reduce((sum, deal) => sum + (Number(deal.commission) || 0), 0),
    swap: orderedDeals.reduce((sum, deal) => sum + (Number(deal.swap) || 0), 0),
    fee: orderedDeals.reduce((sum, deal) => sum + (Number(deal.fee) || 0), 0),
    exitReason: lastExitDeal?.reasonName || null,
    lastExitDeal,
  };
}

describe('trade history service', () => {
  beforeEach(() => {
    mockTradeRows.length = 0;
    jest.clearAllMocks();

    mt5Service.isConnected.mockReturnValue(true);
    mt5Service.connect.mockResolvedValue(true);
    mt5Service.disconnect.mockResolvedValue(true);
    mt5Service.getPositionDealSummary.mockResolvedValue(null);
    mt5Service.getDealsByOrder.mockResolvedValue([]);
    mt5Service.summarizePositionDeals.mockImplementation((deals) => summarizeDeals(deals));
  });

  test('imports missing closed MT5 trades and keeps non-QM strategies as Unknown', async () => {
    mt5Service.getDeals.mockResolvedValue([
      {
        id: 'entry-1',
        orderId: 'order-1',
        positionId: 'position-1',
        symbol: 'GBPJPY',
        typeName: 'SELL',
        volume: 0.1,
        price: 213.7,
        profit: 0,
        commission: 0,
        swap: 0,
        fee: 0,
        comment: 'QM|MeanReversion|SELL|0.60',
        entryName: 'IN',
        reasonName: 'EXPERT',
        time: '2026-04-10T10:00:00.000Z',
      },
      {
        id: 'exit-1',
        orderId: 'order-2',
        positionId: 'position-1',
        symbol: 'GBPJPY',
        typeName: 'BUY',
        volume: 0.1,
        price: 213.5,
        profit: 20,
        commission: 0,
        swap: 0,
        fee: 0,
        comment: '[tp 213.5]',
        entryName: 'OUT',
        reasonName: 'TP',
        time: '2026-04-10T11:00:00.000Z',
      },
      {
        id: 'entry-2',
        orderId: 'order-3',
        positionId: 'position-2',
        symbol: 'EURUSD',
        typeName: 'BUY',
        volume: 0.2,
        price: 1.1,
        profit: 0,
        commission: -0.3,
        swap: 0,
        fee: 0,
        comment: 'Manual trade',
        entryName: 'IN',
        reasonName: 'CLIENT',
        time: '2026-04-10T10:10:00.000Z',
      },
      {
        id: 'exit-2',
        orderId: 'order-4',
        positionId: 'position-2',
        symbol: 'EURUSD',
        typeName: 'SELL',
        volume: 0.2,
        price: 1.101,
        profit: 5,
        commission: 0,
        swap: 0,
        fee: 0,
        comment: '[manual close]',
        entryName: 'OUT',
        reasonName: 'CLIENT',
        time: '2026-04-10T11:10:00.000Z',
      },
    ]);

    const result = await tradeHistoryService.syncTradesFromBroker({
      mode: 'full',
      limit: 50,
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    });

    expect(result.checked).toBe(2);
    expect(result.imported).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(mockTradeRows).toHaveLength(2);
    expect(mockTradeRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        symbol: 'GBPJPY',
        strategy: 'MeanReversion',
        type: 'SELL',
        status: 'CLOSED',
        mt5PositionId: 'position-1',
        mt5EntryDealId: 'entry-1',
        mt5CloseDealId: 'exit-1',
      }),
      expect.objectContaining({
        symbol: 'EURUSD',
        strategy: 'Unknown',
        type: 'BUY',
        status: 'CLOSED',
        mt5PositionId: 'position-2',
        mt5EntryDealId: 'entry-2',
        mt5CloseDealId: 'exit-2',
      }),
    ]));
  });

  test('imports missing open MT5 positions without closed fields', async () => {
    mt5Service.getDeals.mockResolvedValue([
      {
        id: 'entry-open-1',
        orderId: 'order-open-1',
        positionId: 'position-open-1',
        symbol: 'USDCHF',
        typeName: 'BUY',
        volume: 0.15,
        price: 0.8812,
        profit: 0,
        commission: -0.4,
        swap: 0,
        fee: 0,
        comment: 'QM|TrendFollowing|BUY|0.55',
        entryName: 'IN',
        reasonName: 'EXPERT',
        time: '2026-04-12T08:00:00.000Z',
      },
    ]);

    const result = await tradeHistoryService.syncTradesFromBroker({
      mode: 'full',
      limit: 20,
    });

    expect(result.checked).toBe(1);
    expect(result.imported).toBe(1);
    expect(mockTradeRows[0]).toEqual(expect.objectContaining({
      symbol: 'USDCHF',
      type: 'BUY',
      strategy: 'TrendFollowing',
      status: 'OPEN',
      mt5PositionId: 'position-open-1',
      mt5EntryDealId: 'entry-open-1',
      mt5CloseDealId: null,
      exitPrice: null,
      closedAt: null,
      exitReason: null,
    }));
  });

  test('repeated sync does not duplicate positions and updates an imported open trade when it closes', async () => {
    mt5Service.getDeals
      .mockResolvedValueOnce([
        {
          id: 'entry-open-2',
          orderId: 'order-open-2',
          positionId: 'position-open-2',
          symbol: 'NAS100',
          typeName: 'BUY',
          volume: 0.1,
          price: 25100,
          profit: 0,
          commission: -0.2,
          swap: 0,
          fee: 0,
          comment: 'Manual index trade',
          entryName: 'IN',
          reasonName: 'CLIENT',
          time: '2026-04-12T09:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'entry-open-2',
          orderId: 'order-open-2',
          positionId: 'position-open-2',
          symbol: 'NAS100',
          typeName: 'BUY',
          volume: 0.1,
          price: 25100,
          profit: 0,
          commission: -0.2,
          swap: 0,
          fee: 0,
          comment: 'Manual index trade',
          entryName: 'IN',
          reasonName: 'CLIENT',
          time: '2026-04-12T09:00:00.000Z',
        },
        {
          id: 'exit-open-2',
          orderId: 'order-open-3',
          positionId: 'position-open-2',
          symbol: 'NAS100',
          typeName: 'SELL',
          volume: 0.1,
          price: 25145,
          profit: 45,
          commission: 0,
          swap: 0,
          fee: 0,
          comment: '[manual close]',
          entryName: 'OUT',
          reasonName: 'CLIENT',
          time: '2026-04-12T10:15:00.000Z',
        },
      ]);

    const firstSync = await tradeHistoryService.syncTradesFromBroker({ mode: 'full', limit: 20 });
    const secondSync = await tradeHistoryService.syncTradesFromBroker({ mode: 'incremental', limit: 20 });

    expect(firstSync.imported).toBe(1);
    expect(secondSync.imported).toBe(0);
    expect(secondSync.updated).toBe(1);
    expect(mockTradeRows).toHaveLength(1);
    expect(mockTradeRows[0]).toEqual(expect.objectContaining({
      symbol: 'NAS100',
      strategy: 'Unknown',
      status: 'CLOSED',
      mt5PositionId: 'position-open-2',
      mt5EntryDealId: 'entry-open-2',
      mt5CloseDealId: 'exit-open-2',
      exitPrice: 25145,
    }));
  });
});
