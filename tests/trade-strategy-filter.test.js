const mockTradeRows = [];

function mockMatchesDate(value, condition = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (condition.$gte && date < condition.$gte) return false;
  if (condition.$lte && date > condition.$lte) return false;
  return true;
}

function mockMatchesField(value, condition) {
  if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
    if (Array.isArray(condition.$in)) {
      return condition.$in.includes(value);
    }
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

const Trade = require('../src/models/Trade');
const { parseStrategyFromBrokerComment, buildTradeComment } = require('../src/utils/tradeComment');

describe('trade strategy alias handling', () => {
  beforeEach(() => {
    mockTradeRows.length = 0;
    jest.clearAllMocks();
  });

  test('canonicalizes truncated strategy names from broker comments', () => {
    expect(parseStrategyFromBrokerComment('PT|VolumeFlowHyb|BUY|0.55')).toBe('VolumeFlowHybrid');
    expect(buildTradeComment({}, 'PT|VolumeFlowHyb|BUY|0.55')).toContain('Strategy=VolumeFlowHybrid');
  });

  test('findByFilters matches canonical strategy filters against legacy truncated values', async () => {
    mockTradeRows.push(
      {
        _id: 'trade-1',
        symbol: 'XAUUSD',
        strategy: 'VolumeFlowHyb',
        status: 'CLOSED',
        openedAt: new Date('2026-04-19T10:00:00.000Z'),
      },
      {
        _id: 'trade-2',
        symbol: 'EURUSD',
        strategy: 'TrendFollowin',
        status: 'CLOSED',
        openedAt: new Date('2026-04-18T10:00:00.000Z'),
      },
      {
        _id: 'trade-3',
        symbol: 'XTIUSD',
        strategy: 'Breakout',
        status: 'CLOSED',
        openedAt: new Date('2026-04-17T10:00:00.000Z'),
      }
    );

    const trades = await Trade.findByFilters({ strategy: 'VolumeFlowHybrid' }, 10);

    expect(trades).toHaveLength(1);
    expect(trades[0]).toEqual(expect.objectContaining({
      _id: 'trade-1',
      strategy: 'VolumeFlowHybrid',
    }));
  });

  test('getStats includes legacy truncated rows under the canonical strategy filter', async () => {
    mockTradeRows.push(
      {
        _id: 'trade-1',
        symbol: 'XAUUSD',
        strategy: 'VolumeFlowHyb',
        status: 'CLOSED',
        profitLoss: 12.5,
        profitPips: 35.2,
        openedAt: new Date('2026-04-19T10:00:00.000Z'),
      },
      {
        _id: 'trade-2',
        symbol: 'XAUUSD',
        strategy: 'VolumeFlowHyb',
        status: 'CLOSED',
        profitLoss: -4.1,
        profitPips: -10.8,
        openedAt: new Date('2026-04-18T10:00:00.000Z'),
      },
      {
        _id: 'trade-3',
        symbol: 'XTIUSD',
        strategy: 'Breakout',
        status: 'CLOSED',
        profitLoss: 6,
        profitPips: 12,
        openedAt: new Date('2026-04-17T10:00:00.000Z'),
      }
    );

    const stats = await Trade.getStats({ strategy: 'VolumeFlowHybrid' });

    expect(stats.totalTrades).toBe(2);
    expect(stats.byStrategy).toEqual(expect.objectContaining({
      VolumeFlowHybrid: expect.objectContaining({
        trades: 2,
        wins: 1,
      }),
    }));
  });
});
