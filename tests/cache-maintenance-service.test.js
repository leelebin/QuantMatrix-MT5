jest.mock('../src/services/economicCalendarService', () => ({
  getCacheStatus: jest.fn(),
  clearCache: jest.fn(),
}));

const economicCalendarService = require('../src/services/economicCalendarService');
const cacheMaintenanceService = require('../src/services/cacheMaintenanceService');

describe('cache maintenance service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('getCacheStatus returns the aggregated safe cache summary', async () => {
    economicCalendarService.getCacheStatus.mockResolvedValue({
      key: 'economic-calendar',
      label: 'Economic Calendar',
      totalSizeBytes: 768,
      memory: { exists: true, entryCount: 2, sizeBytes: 256 },
      disk: { exists: true, sizeBytes: 512 },
    });

    const result = await cacheMaintenanceService.getCacheStatus('safe');

    expect(result).toEqual({
      scope: 'safe',
      targets: [
        {
          key: 'economic-calendar',
          label: 'Economic Calendar',
          totalSizeBytes: 768,
          memory: { exists: true, entryCount: 2, sizeBytes: 256 },
          disk: { exists: true, sizeBytes: 512 },
        },
      ],
      totalSizeBytes: 768,
    });
  });

  test('clearCache clears the safe cache and reports freed bytes', async () => {
    economicCalendarService.getCacheStatus
      .mockResolvedValueOnce({
        key: 'economic-calendar',
        label: 'Economic Calendar',
        totalSizeBytes: 768,
        memory: { exists: true, entryCount: 2, sizeBytes: 256 },
        disk: { exists: true, sizeBytes: 512 },
      })
      .mockResolvedValueOnce({
        key: 'economic-calendar',
        label: 'Economic Calendar',
        totalSizeBytes: 0,
        memory: { exists: false, entryCount: 0, sizeBytes: 0 },
        disk: { exists: false, sizeBytes: 0 },
      });
    economicCalendarService.clearCache.mockResolvedValue({
      key: 'economic-calendar',
      label: 'Economic Calendar',
      totalSizeBytes: 0,
      memory: { exists: false, entryCount: 0, sizeBytes: 0 },
      disk: { exists: false, sizeBytes: 0 },
    });

    const result = await cacheMaintenanceService.clearCache('safe');

    expect(economicCalendarService.clearCache).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      scope: 'safe',
      targets: [
        {
          key: 'economic-calendar',
          label: 'Economic Calendar',
          totalSizeBytes: 0,
          memory: { exists: false, entryCount: 0, sizeBytes: 0 },
          disk: { exists: false, sizeBytes: 0 },
        },
      ],
      totalSizeBytes: 0,
      clearedTargets: [
        {
          key: 'economic-calendar',
          label: 'Economic Calendar',
        },
      ],
      freedBytes: 768,
      message: 'Cleared 1 safe cache target',
    });
  });

  test('normalizeScope rejects unsupported cache scopes', () => {
    expect(() => cacheMaintenanceService.normalizeScope('logs')).toThrow('Unsupported cache scope: logs');
  });
});
