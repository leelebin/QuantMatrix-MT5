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

function createStrategyInstancesDb(records) {
  return {
    findOne: jest.fn(async (query) => records.find((record) => matchesQuery(record, query)) || null),
    find: jest.fn((query = {}) => ({
      sort: jest.fn(async (sortSpec) => sortRecords(
        records.filter((record) => matchesQuery(record, query)),
        sortSpec
      )),
    })),
    insert: jest.fn(async (doc) => {
      const stored = { ...doc };
      records.push(stored);
      return stored;
    }),
    update: jest.fn(async (query, update) => {
      let updated = 0;
      records.forEach((record) => {
        if (!matchesQuery(record, query)) return;
        if (update && update.$set) {
          Object.assign(record, update.$set);
        }
        updated += 1;
      });
      return updated;
    }),
    remove: jest.fn(async (query) => {
      const remaining = records.filter((record) => !matchesQuery(record, query));
      records.splice(0, records.length, ...remaining);
      return 1;
    }),
  };
}

function loadStrategyInstanceModel({ strategyRecords = [], instanceRecords = [] } = {}) {
  jest.resetModules();

  const strategies = strategyRecords.map((record) => ({
    ...record,
    parameters: record.parameters ? JSON.parse(JSON.stringify(record.parameters)) : record.parameters,
  }));
  const instances = instanceRecords.map((record) => ({
    ...record,
    parameters: record.parameters ? JSON.parse(JSON.stringify(record.parameters)) : record.parameters,
  }));

  const strategyInstancesDb = createStrategyInstancesDb(instances);
  const strategyModel = {
    findAll: jest.fn(async () => strategies),
    findByName: jest.fn(async (name) => strategies.find((strategy) => strategy.name === name) || null),
  };

  jest.doMock('../src/config/db', () => ({
    strategyInstancesDb,
  }));
  jest.doMock('../src/models/Strategy', () => strategyModel);

  const StrategyInstance = require('../src/models/StrategyInstance');
  return {
    StrategyInstance,
    strategyModel,
    records: instances,
  };
}

describe('strategy instance model', () => {
  afterEach(() => {
    jest.dontMock('../src/config/db');
    jest.dontMock('../src/models/Strategy');
  });

  test('create stores a deep-cloned record and findByKey returns it', async () => {
    const { StrategyInstance } = loadStrategyInstanceModel();
    const parameters = { lookback_period: 20, slMultiplier: 2 };

    const created = await StrategyInstance.create({
      strategyName: 'Breakout',
      symbol: 'XAUUSD',
      parameters,
      enabled: false,
    });

    parameters.lookback_period = 999;

    expect(created).toEqual(expect.objectContaining({
      _id: 'Breakout:XAUUSD',
      strategyName: 'Breakout',
      symbol: 'XAUUSD',
      parameters: { lookback_period: 20, slMultiplier: 2 },
      enabled: false,
    }));

    const found = await StrategyInstance.findByKey('Breakout', 'XAUUSD');
    expect(found.parameters).toEqual({ lookback_period: 20, slMultiplier: 2 });
    expect(found.createdAt).toBeInstanceOf(Date);
    expect(found.updatedAt).toBeInstanceOf(Date);
  });

  test('upsert updates existing records and seeds new ones from legacy strategy parameters', async () => {
    const { StrategyInstance } = loadStrategyInstanceModel({
      strategyRecords: [
        {
          name: 'Breakout',
          parameters: { lookback_period: 20, body_multiplier: 1.2 },
          enabled: true,
        },
      ],
      instanceRecords: [
        {
          _id: 'Breakout:XAUUSD',
          strategyName: 'Breakout',
          symbol: 'XAUUSD',
          parameters: { lookback_period: 20, body_multiplier: 1.2 },
          enabled: true,
          createdAt: new Date('2026-04-01T00:00:00.000Z'),
          updatedAt: new Date('2026-04-01T00:00:00.000Z'),
        },
      ],
    });

    await StrategyInstance.upsert('Breakout', 'XAUUSD', {
      parameters: { lookback_period: 35, body_multiplier: 1.8 },
      enabled: false,
    });
    await StrategyInstance.upsert('Breakout', 'EURUSD', { enabled: false });

    expect(await StrategyInstance.findByKey('Breakout', 'XAUUSD')).toEqual(expect.objectContaining({
      parameters: { lookback_period: 35, body_multiplier: 1.8 },
      enabled: false,
    }));

    expect(await StrategyInstance.findByKey('Breakout', 'EURUSD')).toEqual(expect.objectContaining({
      strategyName: 'Breakout',
      symbol: 'EURUSD',
      parameters: { lookback_period: 20, body_multiplier: 1.2 },
      enabled: false,
    }));
  });

  test('migrateFromLegacy is idempotent and clones legacy parameters per symbol', async () => {
    const strategyRecords = [
      {
        name: 'Breakout',
        symbols: ['XAUUSD', 'EURUSD'],
        parameters: { lookback_period: 20, body_multiplier: 1.2 },
        enabled: true,
      },
      {
        name: 'Momentum',
        symbols: ['USDJPY'],
        parameters: { ema_period: 34 },
        enabled: false,
      },
    ];
    const { StrategyInstance, records } = loadStrategyInstanceModel({ strategyRecords });

    const firstRun = await StrategyInstance.migrateFromLegacy();
    strategyRecords[0].parameters.lookback_period = 99;
    const secondRun = await StrategyInstance.migrateFromLegacy();

    expect(firstRun).toEqual({ migrated: 3, skipped: 0 });
    expect(secondRun).toEqual({ migrated: 0, skipped: 3 });
    expect(records).toHaveLength(3);
    expect(await StrategyInstance.findByKey('Breakout', 'XAUUSD')).toEqual(expect.objectContaining({
      parameters: { lookback_period: 20, body_multiplier: 1.2 },
      enabled: true,
    }));
    expect(await StrategyInstance.findByKey('Momentum', 'USDJPY')).toEqual(expect.objectContaining({
      parameters: { ema_period: 34 },
      enabled: false,
    }));
  });
});
