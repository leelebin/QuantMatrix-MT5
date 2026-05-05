jest.mock('../src/services/cacheMaintenanceService', () => ({
  getCacheStatus: jest.fn(),
  clearCache: jest.fn(),
}));

jest.mock('../src/services/databaseMaintenanceService', () => ({
  getDatabaseStatus: jest.fn(),
  compactDatabases: jest.fn(),
  cleanupOldRecords: jest.fn(),
}));

jest.mock('../src/services/resourceMonitorService', () => ({
  getResourceStatus: jest.fn(),
}));

jest.mock('../src/services/weeklyReviewExportService', () => ({
  exportWeeklyTradeReviews: jest.fn(),
}));

const maintenanceController = require('../src/controllers/maintenanceController');
const cacheMaintenanceService = require('../src/services/cacheMaintenanceService');
const databaseMaintenanceService = require('../src/services/databaseMaintenanceService');
const resourceMonitorService = require('../src/services/resourceMonitorService');
const weeklyReviewExportService = require('../src/services/weeklyReviewExportService');

function createRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    },
  };
}

describe('maintenance controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('getCacheStatus returns the safe cache summary', async () => {
    cacheMaintenanceService.getCacheStatus.mockResolvedValue({
      scope: 'safe',
      targets: [
        {
          key: 'economic-calendar',
          label: 'Economic Calendar',
          totalSizeBytes: 512,
        },
      ],
      totalSizeBytes: 512,
    });

    const req = { query: {} };
    const res = createRes();

    await maintenanceController.getCacheStatus(req, res);

    expect(cacheMaintenanceService.getCacheStatus).toHaveBeenCalledWith('safe');
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      message: 'Loaded safe cache status',
      data: {
        scope: 'safe',
        targets: [
          {
            key: 'economic-calendar',
            label: 'Economic Calendar',
            totalSizeBytes: 512,
          },
        ],
        totalSizeBytes: 512,
      },
    });
  });

  test('clearCache returns the clear result summary', async () => {
    cacheMaintenanceService.clearCache.mockResolvedValue({
      scope: 'safe',
      targets: [
        {
          key: 'economic-calendar',
          label: 'Economic Calendar',
          totalSizeBytes: 0,
        },
      ],
      totalSizeBytes: 0,
      clearedTargets: [
        {
          key: 'economic-calendar',
          label: 'Economic Calendar',
        },
      ],
      freedBytes: 1024,
      message: 'Cleared 1 safe cache target',
    });

    const req = { body: { scope: 'safe' } };
    const res = createRes();

    await maintenanceController.clearCache(req, res);

    expect(cacheMaintenanceService.clearCache).toHaveBeenCalledWith('safe');
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      message: 'Cleared 1 safe cache target',
      data: {
        scope: 'safe',
        targets: [
          {
            key: 'economic-calendar',
            label: 'Economic Calendar',
            totalSizeBytes: 0,
          },
        ],
        totalSizeBytes: 0,
        clearedTargets: [
          {
            key: 'economic-calendar',
            label: 'Economic Calendar',
          },
        ],
        freedBytes: 1024,
        message: 'Cleared 1 safe cache target',
      },
    });
  });

  test('getCacheStatus returns the service error status code when scope is invalid', async () => {
    const error = new Error('Unsupported cache scope: logs');
    error.statusCode = 400;
    cacheMaintenanceService.getCacheStatus.mockRejectedValue(error);

    const req = { query: { scope: 'logs' } };
    const res = createRes();

    await maintenanceController.getCacheStatus(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual({
      success: false,
      message: 'Unsupported cache scope: logs',
    });
  });

  test('getResourceStatus returns RAM and ROM summaries', async () => {
    resourceMonitorService.getResourceStatus.mockReturnValue({
      memory: { rssBytes: 128 },
      storage: [{ key: 'data', totalSizeBytes: 256 }],
      warnings: [],
    });

    const req = { query: { topFilesLimit: '5' } };
    const res = createRes();

    await maintenanceController.getResourceStatus(req, res);

    expect(resourceMonitorService.getResourceStatus).toHaveBeenCalledWith({ topFilesLimit: '5' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      message: 'Loaded resource status',
      data: {
        memory: { rssBytes: 128 },
        storage: [{ key: 'data', totalSizeBytes: 256 }],
        warnings: [],
      },
    });
  });

  test('getDatabaseStatus returns database file summaries', async () => {
    databaseMaintenanceService.getDatabaseStatus.mockResolvedValue({
      totalSizeBytes: 1024,
      databases: [{ name: 'backtests', count: 4 }],
    });

    const req = {};
    const res = createRes();

    await maintenanceController.getDatabaseStatus(req, res);

    expect(databaseMaintenanceService.getDatabaseStatus).toHaveBeenCalledWith();
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      message: 'Loaded database status',
      data: {
        totalSizeBytes: 1024,
        databases: [{ name: 'backtests', count: 4 }],
      },
    });
  });

  test('compactDatabases forwards selected targets', async () => {
    databaseMaintenanceService.compactDatabases.mockResolvedValue({
      totalFreedBytes: 512,
      results: [{ name: 'backtests', compacted: true }],
    });

    const req = { body: { targets: ['backtests'], timeoutMs: 7000 } };
    const res = createRes();

    await maintenanceController.compactDatabases(req, res);

    expect(databaseMaintenanceService.compactDatabases).toHaveBeenCalledWith({
      targets: ['backtests'],
      databases: undefined,
      timeoutMs: 7000,
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      message: 'Compacted databases',
      data: {
        totalFreedBytes: 512,
        results: [{ name: 'backtests', compacted: true }],
      },
    });
  });

  test('cleanupOldRecords previews cleanup by default', async () => {
    databaseMaintenanceService.cleanupOldRecords.mockResolvedValue({
      dryRun: true,
      totalMatched: 3,
      totalRemoved: 0,
    });

    const req = { body: { targets: ['decisionAudit'], retentionDays: 7 } };
    const res = createRes();

    await maintenanceController.cleanupOldRecords(req, res);

    expect(databaseMaintenanceService.cleanupOldRecords).toHaveBeenCalledWith({
      targets: ['decisionAudit'],
      dryRun: undefined,
      retentionDays: 7,
      retentionDaysByTarget: undefined,
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      message: 'Previewed old record cleanup',
      data: {
        dryRun: true,
        totalMatched: 3,
        totalRemoved: 0,
      },
    });
  });

  test('cleanupOldRecords returns clean message when dry run is disabled', async () => {
    databaseMaintenanceService.cleanupOldRecords.mockResolvedValue({
      dryRun: false,
      totalMatched: 3,
      totalRemoved: 3,
    });

    const req = { body: { targets: ['executionAudit'], dryRun: false } };
    const res = createRes();

    await maintenanceController.cleanupOldRecords(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      message: 'Cleaned old records',
      data: {
        dryRun: false,
        totalMatched: 3,
        totalRemoved: 3,
      },
    });
  });

  test('exportWeeklyTradeReviews forwards review export options', async () => {
    weeklyReviewExportService.exportWeeklyTradeReviews.mockResolvedValue({
      outputDir: 'data/history/weekly-trades',
      totalRecords: 4,
    });

    const req = { body: { scope: 'paper', rebuild: true } };
    const res = createRes();

    await maintenanceController.exportWeeklyTradeReviews(req, res);

    expect(weeklyReviewExportService.exportWeeklyTradeReviews).toHaveBeenCalledWith({
      scope: 'paper',
      rebuild: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      message: 'Exported weekly trade review files',
      data: {
        outputDir: 'data/history/weekly-trades',
        totalRecords: 4,
      },
    });
  });
});
