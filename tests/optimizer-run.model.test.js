function matchesQuery(doc, query = {}) {
  return Object.entries(query).every(([key, value]) => {
    if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, '$ne')) {
      return doc[key] !== value.$ne;
    }
    return doc[key] === value;
  });
}

function sortRecords(records, sortSpec = {}) {
  const fields = Object.entries(sortSpec);
  return [...records].sort((left, right) => {
    for (const [field, direction] of fields) {
      if (left[field] === right[field]) continue;
      if (left[field] > right[field]) return direction;
      return -direction;
    }
    return 0;
  });
}

function loadOptimizerRunModel(initialRecords = []) {
  jest.resetModules();

  const records = initialRecords.map((record) => ({ ...record }));
  const optimizerRunsDb = {
    insert: jest.fn(async (doc) => {
      const stored = { _id: doc._id || ('opt-run-' + (records.length + 1)), ...doc };
      records.push(stored);
      return stored;
    }),
    findOne: jest.fn(async (query) => records.find((record) => matchesQuery(record, query)) || null),
    find: jest.fn((query = {}) => ({
      sort: jest.fn((sortSpec = {}) => ({
        limit: jest.fn(async (limit) => sortRecords(
          records.filter((record) => matchesQuery(record, query)),
          sortSpec
        ).slice(0, limit)),
      })),
    })),
  };

  jest.doMock('../src/config/db', () => ({
    optimizerRunsDb,
  }));

  const OptimizerRun = require('../src/models/OptimizerRun');
  return {
    OptimizerRun,
    optimizerRunsDb,
    records,
  };
}

describe('optimizer run model', () => {
  afterEach(() => {
    jest.dontMock('../src/config/db');
  });

  test('createFromResult stores the optimizer initial balance', async () => {
    const { OptimizerRun, records } = loadOptimizerRunModel();

    await OptimizerRun.createFromResult({
      symbol: 'EURUSD',
      strategy: 'TrendFollowing',
      timeframe: '1h',
      initialBalance: 25000,
      optimizeFor: 'profitFactor',
      totalCombinations: 1,
      processedCombinations: 1,
      validResults: 1,
      bestResult: { parameters: { ema_fast: 20 } },
      top10: [],
      completedAt: '2026-04-24T10:00:00.000Z',
    });

    expect(records[0]).toEqual(expect.objectContaining({
      initialBalance: 25000,
    }));
  });

  test('findAll and findById backfill legacy optimizer runs to the default initial balance', async () => {
    const { OptimizerRun } = loadOptimizerRunModel([
      {
        _id: 'legacy-run',
        symbol: 'XAUUSD',
        strategy: 'Breakout',
        timeframe: '15m',
        optimizeFor: 'profitFactor',
        bestResult: { parameters: { lookback_period: 20 } },
        top10: [],
        completedAt: '2026-04-24T11:00:00.000Z',
      },
    ]);

    const history = await OptimizerRun.findAll(10);
    const detail = await OptimizerRun.findById('legacy-run');

    expect(history[0]).toEqual(expect.objectContaining({
      initialBalance: 10000,
    }));
    expect(detail).toEqual(expect.objectContaining({
      initialBalance: 10000,
    }));
  });

  test('findLatestBestResult preserves a stored initial balance', async () => {
    const { OptimizerRun } = loadOptimizerRunModel([
      {
        _id: 'latest-run',
        symbol: 'XAUUSD',
        strategy: 'VolumeFlowHybrid',
        initialBalance: 18000,
        bestResult: { parameters: { rvol_continuation: 1.8 } },
        completedAt: '2026-04-24T12:00:00.000Z',
      },
    ]);

    const latest = await OptimizerRun.findLatestBestResult('XAUUSD', 'VolumeFlowHybrid');

    expect(latest).toEqual(expect.objectContaining({
      initialBalance: 18000,
    }));
  });
});
