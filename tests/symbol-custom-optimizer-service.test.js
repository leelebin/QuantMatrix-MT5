function getByPath(doc, key) {
  return String(key).split('.').reduce((value, part) => (value == null ? undefined : value[part]), doc);
}

function matchesQuery(doc, query = {}) {
  return Object.entries(query).every(([key, value]) => getByPath(doc, key) === value);
}

function sortRecords(records, sortSpec = {}) {
  const fields = Object.entries(sortSpec);
  return [...records].sort((left, right) => {
    for (const [field, direction] of fields) {
      const leftValue = getByPath(left, field);
      const rightValue = getByPath(right, field);
      if (leftValue === rightValue) continue;
      if (leftValue > rightValue) return direction;
      return -direction;
    }
    return 0;
  });
}

function createDb(records) {
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
        _id: doc._id || `symbol-custom-optimizer-run-${nextId++}`,
        ...doc,
      };
      records.push(stored);
      return stored;
    }),
    remove: jest.fn(async (query) => {
      const removed = records.filter((record) => matchesQuery(record, query));
      const remaining = records.filter((record) => !matchesQuery(record, query));
      records.splice(0, records.length, ...remaining);
      return removed.length;
    }),
  };
}

function loadService({ symbolCustoms = [], optimizerRuns = [] } = {}) {
  jest.resetModules();

  const symbolCustomRecords = symbolCustoms.map((record) => ({ ...record }));
  const optimizerRunRecords = optimizerRuns.map((record) => ({ ...record }));
  const symbolCustomsDb = createDb(symbolCustomRecords);
  const symbolCustomOptimizerRunsDb = createDb(optimizerRunRecords);
  const optimizerService = { optimize: jest.fn(), runOptimization: jest.fn() };
  const backtestEngine = { runBacktest: jest.fn(), run: jest.fn() };

  jest.doMock('../src/config/db', () => ({
    symbolCustomsDb,
    symbolCustomOptimizerRunsDb,
  }));
  jest.doMock('../src/services/optimizerService', () => optimizerService);
  jest.doMock('../src/services/backtestEngine', () => backtestEngine);

  return {
    service: require('../src/services/symbolCustomOptimizerService'),
    records: {
      symbolCustoms: symbolCustomRecords,
      optimizerRuns: optimizerRunRecords,
    },
    optimizerService,
    backtestEngine,
  };
}

describe('symbolCustomOptimizerService', () => {
  afterEach(() => {
    jest.dontMock('../src/config/db');
    jest.dontMock('../src/services/optimizerService');
    jest.dontMock('../src/services/backtestEngine');
  });

  test('number range grid generation', () => {
    const { service } = loadService();

    expect(service.buildParameterGridPreview([
      { key: 'lookbackBars', type: 'number', min: 10, max: 20, step: 5, defaultValue: 10 },
    ], 10)).toEqual({
      parameterGridPreview: [
        { lookbackBars: 10 },
        { lookbackBars: 15 },
        { lookbackBars: 20 },
      ],
      totalCombinations: 3,
      maxCombinations: 10,
    });
  });

  test('enum grid generation', () => {
    const { service } = loadService();

    const result = service.buildParameterGridPreview([
      { key: 'mode', type: 'enum', options: ['slow', 'fast'], defaultValue: 'fast' },
    ], 10);

    expect(result.parameterGridPreview).toEqual([
      { mode: 'fast' },
      { mode: 'slow' },
    ]);
    expect(result.totalCombinations).toBe(2);
  });

  test('boolean grid generation', () => {
    const { service } = loadService();

    const result = service.buildParameterGridPreview([
      { key: 'useSessionFilter', type: 'boolean', defaultValue: true },
    ], 10);

    expect(result.parameterGridPreview).toEqual([
      { useSessionFilter: true },
      { useSessionFilter: false },
    ]);
    expect(result.totalCombinations).toBe(2);
  });

  test('maxCombinations limits preview without changing totalCombinations', () => {
    const { service } = loadService();

    const result = service.buildParameterGridPreview([
      { key: 'lookbackBars', type: 'number', min: 10, max: 30, step: 10 },
      { key: 'mode', type: 'enum', options: ['a', 'b', 'c'] },
      { key: 'enabled', type: 'boolean', defaultValue: false },
    ], 4);

    expect(result.parameterGridPreview).toHaveLength(4);
    expect(result.totalCombinations).toBe(18);
    expect(result.maxCombinations).toBe(4);
  });

  test('create run saves a stub record', async () => {
    const { service, records } = loadService({
      symbolCustoms: [
        {
          _id: 'sc-1',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_DRAFT',
          logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
          parameterSchema: [
            { key: 'lookbackBars', type: 'number', min: 10, max: 20, step: 10 },
            { key: 'useSessionFilter', type: 'boolean', defaultValue: false },
          ],
        },
      ],
    });

    const run = await service.createOptimizerRun({
      symbolCustomId: 'sc-1',
      maxCombinations: 3,
      parameterOverrides: {
        lookbackBars: { max: 30 },
      },
    });

    expect(run).toEqual(expect.objectContaining({
      _id: expect.any(String),
      symbolCustomId: 'sc-1',
      symbol: 'USDJPY',
      symbolCustomName: 'USDJPY_DRAFT',
      logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
      status: 'stub',
      totalCombinations: 6,
      maxCombinations: 3,
      results: [],
      bestResult: null,
      message: service.PHASE_1_OPTIMIZER_STUB_MESSAGE,
      completedAt: expect.any(Date),
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    }));
    expect(run.parameterGridPreview).toHaveLength(3);
    expect(records.optimizerRuns).toHaveLength(1);
  });

  test('list, get, and delete runs work', async () => {
    const { service } = loadService({
      optimizerRuns: [
        { _id: 'run-1', symbolCustomId: 'sc-1', symbol: 'USDJPY', symbolCustomName: 'A', status: 'stub', parameterSchema: [], parameterGridPreview: [], totalCombinations: 0, maxCombinations: 50, createdAt: new Date('2026-01-01') },
        { _id: 'run-2', symbolCustomId: 'sc-2', symbol: 'GBPJPY', symbolCustomName: 'B', status: 'stub', parameterSchema: [], parameterGridPreview: [], totalCombinations: 0, maxCombinations: 50, createdAt: new Date('2026-01-02') },
      ],
    });

    await expect(service.listOptimizerRuns({ symbol: 'usdjpy' })).resolves.toEqual([
      expect.objectContaining({ _id: 'run-1', symbol: 'USDJPY' }),
    ]);
    await expect(service.getOptimizerRun('run-2')).resolves.toEqual(expect.objectContaining({
      _id: 'run-2',
      symbol: 'GBPJPY',
    }));
    await expect(service.deleteOptimizerRun('run-1')).resolves.toEqual(expect.objectContaining({
      _id: 'run-1',
    }));
    await expect(service.getOptimizerRun('run-1')).resolves.toBeNull();
  });

  test('does not call old optimizerService or backtestEngine', async () => {
    const { service, optimizerService, backtestEngine } = loadService({
      symbolCustoms: [
        {
          _id: 'sc-1',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_DRAFT',
          logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
          parameterSchema: [{ key: 'lookbackBars', type: 'number', min: 10, max: 20, step: 10 }],
        },
      ],
    });

    await service.createOptimizerRun({ symbolCustomId: 'sc-1', maxCombinations: 10 });

    expect(optimizerService.optimize).not.toHaveBeenCalled();
    expect(optimizerService.runOptimization).not.toHaveBeenCalled();
    expect(backtestEngine.runBacktest).not.toHaveBeenCalled();
    expect(backtestEngine.run).not.toHaveBeenCalled();
  });
});
