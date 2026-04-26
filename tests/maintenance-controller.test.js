jest.mock('../src/services/cacheMaintenanceService', () => ({
  getCacheStatus: jest.fn(),
  clearCache: jest.fn(),
}));

const maintenanceController = require('../src/controllers/maintenanceController');
const cacheMaintenanceService = require('../src/services/cacheMaintenanceService');

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
});
