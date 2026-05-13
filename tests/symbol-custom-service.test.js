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

function loadService({ records = [] } = {}) {
  jest.resetModules();

  const symbolCustomRecords = records.map((record) => ({ ...record }));
  const symbolCustomsDb = createSymbolCustomsDb(symbolCustomRecords);

  jest.doMock('../src/config/db', () => ({
    symbolCustomsDb,
  }));
  jest.doMock('../src/services/tradeExecutor', () => ({
    executeTrade: jest.fn(),
  }));

  const service = require('../src/services/symbolCustomService');
  const tradeExecutor = require('../src/services/tradeExecutor');
  return {
    service,
    tradeExecutor,
    records: symbolCustomRecords,
  };
}

describe('symbolCustomService CRUD', () => {
  afterEach(() => {
    jest.dontMock('../src/config/db');
    jest.dontMock('../src/services/tradeExecutor');
  });

  test('creates and lists SymbolCustom records', async () => {
    const { service } = loadService();

    const created = await service.createSymbolCustom({
      symbol: 'usdjpy',
      symbolCustomName: 'USDJPY_Custom_A',
      paperEnabled: true,
    });
    const rows = await service.listSymbolCustoms();

    expect(created.symbolCustom).toEqual(expect.objectContaining({
      _id: expect.any(String),
      symbol: 'USDJPY',
      symbolCustomName: 'USDJPY_Custom_A',
      paperEnabled: true,
      liveEnabled: false,
    }));
    expect(created.warnings).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].symbolCustomName).toBe('USDJPY_Custom_A');
  });

  test('gets by id and symbol', async () => {
    const { service } = loadService();
    const first = await service.createSymbolCustom({
      symbol: 'GBPJPY',
      symbolCustomName: 'GBPJPY_Custom_A',
    });
    await service.createSymbolCustom({
      symbol: 'GBPJPY',
      symbolCustomName: 'GBPJPY_Custom_B',
    });

    await expect(service.getSymbolCustom(first.symbolCustom._id)).resolves.toEqual(expect.objectContaining({
      symbolCustomName: 'GBPJPY_Custom_A',
    }));
    await expect(service.getSymbolCustomsBySymbol('gbpjpy')).resolves.toHaveLength(2);
  });

  test('updates, duplicates, and deletes a SymbolCustom record', async () => {
    const { service } = loadService();
    const created = await service.createSymbolCustom({
      symbol: 'AUDUSD',
      symbolCustomName: 'AUDUSD_Custom_A',
      parameters: { lookback: 20 },
    });

    const updated = await service.updateSymbolCustom(created.symbolCustom._id, {
      status: 'validated',
      parameters: { lookback: 34 },
    });
    const duplicated = await service.duplicateSymbolCustom(created.symbolCustom._id, {
      symbolCustomName: 'AUDUSD_Custom_A_Copy',
    });
    const removed = await service.deleteSymbolCustom(created.symbolCustom._id);
    const remaining = await service.listSymbolCustoms({ symbol: 'AUDUSD' });

    expect(updated.symbolCustom).toEqual(expect.objectContaining({
      status: 'validated',
      parameters: { lookback: 34 },
    }));
    expect(duplicated.symbolCustom).toEqual(expect.objectContaining({
      symbol: 'AUDUSD',
      symbolCustomName: 'AUDUSD_Custom_A_Copy',
      status: 'draft',
      liveEnabled: false,
      isPrimaryLive: false,
    }));
    expect(removed).toEqual(expect.objectContaining({
      _id: created.symbolCustom._id,
    }));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]._id).toBe(duplicated.symbolCustom._id);
  });

  test('liveEnabled true is saved with phase 1 warning and does not execute live', async () => {
    const { service, tradeExecutor } = loadService();

    const created = await service.createSymbolCustom({
      symbol: 'USDJPY',
      symbolCustomName: 'USDJPY_Live_Field_Only',
      liveEnabled: true,
    });

    expect(created.symbolCustom.liveEnabled).toBe(true);
    expect(created.warnings).toEqual([
      service.SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1,
    ]);
    expect(tradeExecutor.executeTrade).not.toHaveBeenCalled();
  });

  test('same symbol keeps only one isPrimaryLive record when multiple live primaries are not allowed', async () => {
    const { service } = loadService();
    const first = await service.createSymbolCustom({
      symbol: 'USDJPY',
      symbolCustomName: 'USDJPY_Primary_A',
      isPrimaryLive: true,
    });
    const second = await service.createSymbolCustom({
      symbol: 'USDJPY',
      symbolCustomName: 'USDJPY_Primary_B',
      isPrimaryLive: true,
    });

    const rows = await service.getSymbolCustomsBySymbol('USDJPY');
    const primaryRows = rows.filter((row) => row.isPrimaryLive === true);

    expect(second.symbolCustom.isPrimaryLive).toBe(true);
    expect(primaryRows).toHaveLength(1);
    expect(primaryRows[0]._id).toBe(second.symbolCustom._id);
    expect(rows.find((row) => row._id === first.symbolCustom._id).isPrimaryLive).toBe(false);
  });

  test('updating isPrimaryLive true demotes the previous primary for the same symbol', async () => {
    const { service } = loadService();
    const first = await service.createSymbolCustom({
      symbol: 'GBPJPY',
      symbolCustomName: 'GBPJPY_Primary_A',
      isPrimaryLive: true,
    });
    const second = await service.createSymbolCustom({
      symbol: 'GBPJPY',
      symbolCustomName: 'GBPJPY_Primary_B',
    });

    await service.updateSymbolCustom(second.symbolCustom._id, { isPrimaryLive: true });
    const rows = await service.getSymbolCustomsBySymbol('GBPJPY');

    expect(rows.find((row) => row._id === second.symbolCustom._id).isPrimaryLive).toBe(true);
    expect(rows.find((row) => row._id === first.symbolCustom._id).isPrimaryLive).toBe(false);
  });
});
