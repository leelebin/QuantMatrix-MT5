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

function loadSymbolCustomModel({ records = [] } = {}) {
  jest.resetModules();

  const symbolCustomRecords = records.map((record) => ({
    ...record,
    parameterSchema: record.parameterSchema ? JSON.parse(JSON.stringify(record.parameterSchema)) : record.parameterSchema,
    parameters: record.parameters ? JSON.parse(JSON.stringify(record.parameters)) : record.parameters,
  }));
  const symbolCustomsDb = createSymbolCustomsDb(symbolCustomRecords);

  jest.doMock('../src/config/db', () => ({
    symbolCustomsDb,
  }));

  const SymbolCustom = require('../src/models/SymbolCustom');
  return {
    SymbolCustom,
    records: symbolCustomRecords,
    symbolCustomsDb,
  };
}

describe('SymbolCustom model', () => {
  afterEach(() => {
    jest.dontMock('../src/config/db');
  });

  test('create succeeds with a complete payload', async () => {
    const { SymbolCustom } = loadSymbolCustomModel();

    const created = await SymbolCustom.create({
      symbol: 'usdjpy',
      symbolCustomName: 'USDJPY_Momentum_A',
      displayName: 'USDJPY Momentum A',
      description: 'Dedicated USDJPY system',
      logicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      registryLogicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      status: 'paper_testing',
      paperEnabled: true,
      liveEnabled: true,
      isPrimaryLive: false,
      allowLive: true,
      timeframes: {
        setupTimeframe: '1h',
        entryTimeframe: '15m',
        higherTimeframe: '4h',
      },
      parameterSchema: [{ key: 'lookback', type: 'number' }],
      parameters: { lookback: 20 },
      riskConfig: { riskWeight: 0.75 },
      hypothesis: 'JPY trend continuation after London open',
    });

    expect(created).toEqual(expect.objectContaining({
      _id: expect.any(String),
      symbol: 'USDJPY',
      symbolCustomName: 'USDJPY_Momentum_A',
      displayName: 'USDJPY Momentum A',
      logicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      registryLogicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      status: 'paper_testing',
      paperEnabled: true,
      liveEnabled: true,
      isPrimaryLive: false,
      allowLive: true,
      version: 1,
      parameterSchema: [{ key: 'lookback', type: 'number' }],
      parameters: { lookback: 20 },
      riskConfig: expect.objectContaining({ riskWeight: 0.75 }),
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    }));
  });

  test('validates required fields', async () => {
    const { SymbolCustom } = loadSymbolCustomModel();

    await expect(SymbolCustom.create({}))
      .rejects
      .toMatchObject({
        statusCode: 400,
        details: expect.arrayContaining([
          expect.objectContaining({ field: 'symbol' }),
          expect.objectContaining({ field: 'symbolCustomName' }),
        ]),
      });
  });

  test('validates status, parameter containers, risk weight, and booleans', async () => {
    const { SymbolCustom } = loadSymbolCustomModel();

    await expect(SymbolCustom.create({
      symbol: 'USDJPY',
      symbolCustomName: 'Invalid_Config',
      status: 'live',
      paperEnabled: 'true',
      liveEnabled: 1,
      isPrimaryLive: null,
      allowLive: 'yes',
      parameterSchema: {},
      parameters: [],
      riskConfig: { riskWeight: 'heavy' },
    }))
      .rejects
      .toMatchObject({
        statusCode: 400,
        details: expect.arrayContaining([
          expect.objectContaining({ field: 'status' }),
          expect.objectContaining({ field: 'paperEnabled' }),
          expect.objectContaining({ field: 'liveEnabled' }),
          expect.objectContaining({ field: 'isPrimaryLive' }),
          expect.objectContaining({ field: 'allowLive' }),
          expect.objectContaining({ field: 'parameterSchema' }),
          expect.objectContaining({ field: 'parameters' }),
          expect.objectContaining({ field: 'riskConfig.riskWeight' }),
        ]),
      });
  });

  test('applies safe default values on create', async () => {
    const { SymbolCustom } = loadSymbolCustomModel();

    const created = await SymbolCustom.create({
      symbol: 'AUDUSD',
      symbolCustomName: 'AUDUSD_Custom',
    });

    expect(created).toEqual(expect.objectContaining({
      status: 'draft',
      version: 1,
      displayName: 'AUDUSD_Custom',
      description: '',
      paperEnabled: false,
      liveEnabled: false,
      isPrimaryLive: false,
      allowLive: false,
      parameterSchema: [],
      parameters: {},
      timeframes: {
        setupTimeframe: null,
        entryTimeframe: null,
        higherTimeframe: null,
      },
      riskConfig: {
        riskWeight: null,
        maxRiskPerTradePct: null,
        maxDailyLossR: null,
        maxConsecutiveLosses: null,
      },
    }));
  });

  test('requires symbolCustomName to be unique within the same symbol', async () => {
    const { SymbolCustom } = loadSymbolCustomModel();

    await SymbolCustom.create({
      symbol: 'GBPJPY',
      symbolCustomName: 'Breakout_A',
    });

    await expect(SymbolCustom.create({
      symbol: 'GBPJPY',
      symbolCustomName: 'Breakout_A',
    }))
      .rejects
      .toMatchObject({
        statusCode: 409,
        details: expect.arrayContaining([
          expect.objectContaining({ field: 'symbolCustomName' }),
        ]),
      });
  });

  test('allows the same symbolCustomName on different symbols', async () => {
    const { SymbolCustom } = loadSymbolCustomModel();

    const first = await SymbolCustom.create({
      symbol: 'USDJPY',
      symbolCustomName: 'Asia_Session',
    });
    const second = await SymbolCustom.create({
      symbol: 'AUDUSD',
      symbolCustomName: 'Asia_Session',
    });

    expect(first.symbolCustomName).toBe('Asia_Session');
    expect(second.symbolCustomName).toBe('Asia_Session');
    expect(second.symbol).toBe('AUDUSD');
  });

  test('update supports partial payloads', async () => {
    const { SymbolCustom } = loadSymbolCustomModel();
    const created = await SymbolCustom.create({
      symbol: 'USDJPY',
      symbolCustomName: 'Custom_A',
      parameters: { lookback: 20 },
    });

    const updated = await SymbolCustom.update(created._id, {
      status: 'validated',
      parameters: { lookback: 34, threshold: 0.6 },
    });

    expect(updated).toEqual(expect.objectContaining({
      _id: created._id,
      symbol: 'USDJPY',
      symbolCustomName: 'Custom_A',
      status: 'validated',
      parameters: { lookback: 34, threshold: 0.6 },
      updatedAt: expect.any(Date),
    }));
  });

  test('duplicate forces execution-related switches off', async () => {
    const { SymbolCustom } = loadSymbolCustomModel();
    const created = await SymbolCustom.create({
      symbol: 'GBPJPY',
      symbolCustomName: 'GBPJPY_LiveCandidate',
      status: 'live_ready',
      paperEnabled: true,
      liveEnabled: true,
      isPrimaryLive: true,
      allowLive: true,
      parameters: { range: 12 },
    });

    const duplicated = await SymbolCustom.duplicate(created._id, {
      symbolCustomName: 'GBPJPY_LiveCandidate_Copy',
    });

    expect(duplicated).toEqual(expect.objectContaining({
      symbol: 'GBPJPY',
      symbolCustomName: 'GBPJPY_LiveCandidate_Copy',
      status: 'draft',
      paperEnabled: false,
      liveEnabled: false,
      isPrimaryLive: false,
      allowLive: false,
      parameters: { range: 12 },
    }));
  });

  test('duplicate auto-generates a copy name when no override is provided', async () => {
    const { SymbolCustom } = loadSymbolCustomModel();
    const created = await SymbolCustom.create({
      symbol: 'AUDUSD',
      symbolCustomName: 'AUDUSD_Session_A',
    });

    const duplicated = await SymbolCustom.duplicate(created._id);

    expect(duplicated.symbolCustomName).toMatch(/^AUDUSD_Session_A_COPY_\d+$/);
    expect(duplicated.status).toBe('draft');
  });

  test('remove deletes and returns the existing record', async () => {
    const { SymbolCustom } = loadSymbolCustomModel();
    const created = await SymbolCustom.create({
      symbol: 'USDJPY',
      symbolCustomName: 'Remove_Me',
    });

    const removed = await SymbolCustom.remove(created._id);

    expect(removed).toEqual(expect.objectContaining({
      _id: created._id,
      symbolCustomName: 'Remove_Me',
    }));
    await expect(SymbolCustom.findById(created._id)).resolves.toBeNull();
  });
});
