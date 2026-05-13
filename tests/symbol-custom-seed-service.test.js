function matchesQuery(doc, query = {}) {
  return Object.entries(query).every(([key, value]) => doc[key] === value);
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

function createSymbolCustomsDb(records) {
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
        _id: doc._id || `symbol-custom-${nextId++}`,
        ...doc,
      };
      records.push(stored);
      return stored;
    }),
    update: jest.fn(async (query, update) => {
      const matchedRecords = records.filter((record) => matchesQuery(record, query));
      matchedRecords.forEach((record) => {
        if (update && update.$set) {
          Object.assign(record, update.$set);
        }
      });
      return matchedRecords.length;
    }),
    remove: jest.fn(async (query) => {
      const removed = records.filter((record) => matchesQuery(record, query));
      const remaining = records.filter((record) => !matchesQuery(record, query));
      records.splice(0, records.length, ...remaining);
      return removed.length;
    }),
  };
}

function loadSeedService({ records = [] } = {}) {
  jest.resetModules();

  const symbolCustomRecords = records.map((record) => ({ ...record }));
  const symbolCustomsDb = createSymbolCustomsDb(symbolCustomRecords);

  jest.doMock('../src/config/db', () => ({
    symbolCustomsDb,
  }));

  const seedService = require('../src/services/symbolCustomSeedService');
  const { PLACEHOLDER_SYMBOL_CUSTOM } = require('../src/symbolCustom/logics/PlaceholderSymbolCustom');

  return {
    seedService,
    records: symbolCustomRecords,
    symbolCustomsDb,
    PLACEHOLDER_SYMBOL_CUSTOM,
  };
}

describe('symbolCustomSeedService', () => {
  afterEach(() => {
    jest.dontMock('../src/config/db');
  });

  test('ensureDefaultSymbolCustomDrafts creates 3 drafts', async () => {
    const { seedService, records } = loadSeedService();

    const result = await seedService.ensureDefaultSymbolCustomDrafts();

    expect(result.createdCount).toBe(3);
    expect(result.existingCount).toBe(0);
    expect(records).toHaveLength(3);
    expect(records.map((record) => record.symbolCustomName).sort()).toEqual([
      'AUDUSD_SESSION_PULLBACK_V1',
      'GBPJPY_VOLATILITY_BREAKOUT_V1',
      'USDJPY_JPY_MACRO_REVERSAL_V1',
    ]);
  });

  test('repeated call does not duplicate drafts', async () => {
    const { seedService, records } = loadSeedService();

    await seedService.ensureDefaultSymbolCustomDrafts();
    const secondRun = await seedService.ensureDefaultSymbolCustomDrafts();

    expect(secondRun.createdCount).toBe(0);
    expect(secondRun.existingCount).toBe(3);
    expect(records).toHaveLength(3);
  });

  test('all default drafts are disabled draft placeholders', async () => {
    const { seedService, records, PLACEHOLDER_SYMBOL_CUSTOM } = loadSeedService();

    await seedService.ensureDefaultSymbolCustomDrafts();

    expect(records).toHaveLength(3);
    records.forEach((record) => {
      expect(record.status).toBe('draft');
      expect(record.paperEnabled).toBe(false);
      expect(record.liveEnabled).toBe(false);
      expect(record.isPrimaryLive).toBe(false);
      expect(record.allowLive).toBe(false);
      expect(record.logicName).toBe(PLACEHOLDER_SYMBOL_CUSTOM);
      expect(record.timeframes).toEqual({
        setupTimeframe: '15m',
        entryTimeframe: '5m',
        higherTimeframe: '1h',
      });
      expect(record.parameterSchema.map((field) => field.key)).toEqual([
        'lookbackBars',
        'slAtrMultiplier',
        'tpAtrMultiplier',
        'beTriggerR',
        'maxConsecutiveLosses',
      ]);
    });
  });

  test('existing defaults are not overwritten', async () => {
    const { seedService, records } = loadSeedService({
      records: [
        {
          _id: 'existing-usdjpy',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
          displayName: 'User Edited Name',
          status: 'validated',
          paperEnabled: true,
          liveEnabled: false,
          isPrimaryLive: false,
          allowLive: false,
          logicName: 'USER_SELECTED_PLACEHOLDER',
        },
      ],
    });

    const result = await seedService.ensureDefaultSymbolCustomDrafts();

    expect(result.createdCount).toBe(2);
    expect(result.existingCount).toBe(1);
    expect(records).toHaveLength(3);
    expect(records.find((record) => record._id === 'existing-usdjpy')).toEqual(expect.objectContaining({
      displayName: 'User Edited Name',
      status: 'validated',
      paperEnabled: true,
      logicName: 'USER_SELECTED_PLACEHOLDER',
    }));
  });
});
