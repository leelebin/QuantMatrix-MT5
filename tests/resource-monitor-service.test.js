const fs = require('fs');
const os = require('os');
const path = require('path');

const mockDataDir = path.join(os.tmpdir(), 'qm-resource-monitor-data-test');
const mockLogDir = path.join(os.tmpdir(), 'qm-resource-monitor-logs-test');

jest.mock('../src/config/db', () => ({
  DATA_DIR: mockDataDir,
}));

jest.mock('../src/services/fileLogger', () => ({
  LOG_DIR: mockLogDir,
}));

const resourceMonitorService = require('../src/services/resourceMonitorService');

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

describe('resource monitor service', () => {
  beforeEach(() => {
    resetDir(mockDataDir);
    resetDir(mockLogDir);
    fs.writeFileSync(path.join(mockDataDir, 'small.db'), '1234');
    fs.mkdirSync(path.join(mockDataDir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(mockDataDir, 'nested', 'large.db'), '1234567890');
    fs.writeFileSync(path.join(mockLogDir, 'system.log'), 'log');
  });

  afterAll(() => {
    fs.rmSync(mockDataDir, { recursive: true, force: true });
    fs.rmSync(mockLogDir, { recursive: true, force: true });
  });

  test('getResourceStatus reports process memory and storage summaries', () => {
    const result = resourceMonitorService.getResourceStatus({ topFilesLimit: 1 });

    const dataSummary = result.storage.find((item) => item.key === 'data');
    const logsSummary = result.storage.find((item) => item.key === 'logs');

    expect(result.memory.rssBytes).toBeGreaterThan(0);
    expect(dataSummary.totalSizeBytes).toBe(14);
    expect(dataSummary.fileCount).toBe(2);
    expect(dataSummary.topFiles).toEqual([
      expect.objectContaining({
        relativePath: path.join('nested', 'large.db'),
        sizeBytes: 10,
      }),
    ]);
    expect(logsSummary.totalSizeBytes).toBe(3);
  });
});
