const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../scripts/create-data-snapshot', () => ({
  createSnapshot: jest.fn(),
}));

const { createSnapshot } = require('../scripts/create-data-snapshot');
const dataSyncService = require('../src/services/dataSyncService');

function touchFile(filePath, mtime) {
  fs.writeFileSync(filePath, 'snapshot');
  fs.utimesSync(filePath, mtime, mtime);
}

describe('dataSyncService local backup cleanup', () => {
  let tempRoot;
  let backupDir;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-data-sync-'));
    backupDir = path.join(tempRoot, 'backups', 'local');
    fs.mkdirSync(backupDir, { recursive: true });
    createSnapshot.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('deletes old local snapshot files but keeps the newly created snapshot', async () => {
    const oldDate = new Date(Date.now() - (20 * 24 * 60 * 60 * 1000));
    const newDate = new Date();
    const oldZip = path.join(backupDir, 'quantmatrix-data-snapshot-2026-04-01-000000.zip');
    const oldManifest = path.join(backupDir, 'quantmatrix-data-snapshot-2026-04-01-000000.manifest.json');
    const newZip = path.join(backupDir, 'quantmatrix-data-snapshot-2026-05-06-235959.zip');
    const newManifest = path.join(backupDir, 'quantmatrix-data-snapshot-2026-05-06-235959.manifest.json');
    const unrelated = path.join(backupDir, 'not-a-quantmatrix-snapshot.zip');

    touchFile(oldZip, oldDate);
    touchFile(oldManifest, oldDate);
    touchFile(newZip, oldDate);
    touchFile(newManifest, oldDate);
    touchFile(unrelated, oldDate);

    createSnapshot.mockResolvedValue({
      zipPath: newZip,
      manifestPath: newManifest,
      fileCount: 3,
      totalBytes: 12,
      manifest: { generatedAt: newDate.toISOString() },
      skipped: [],
    });

    const result = await dataSyncService.syncDataToCloud({
      reason: 'manual',
      env: {
        DATA_SYNC_ENABLED: 'false',
        DATA_SYNC_KEEP_LOCAL_DAYS: '14',
        DATA_SYNC_PROVIDER: 'rclone',
        DATA_SYNC_REMOTE: 'quantmatrix-drive',
        DATA_SYNC_REMOTE_PATH: 'QuantMatrix/backups',
      },
    });

    expect(result.success).toBe(true);
    expect(result.uploadSkipped).toBe(true);
    expect(result.deletedLocalBackups.sort()).toEqual([
      path.resolve(oldManifest),
      path.resolve(oldZip),
    ].sort());
    expect(fs.existsSync(oldZip)).toBe(false);
    expect(fs.existsSync(oldManifest)).toBe(false);
    expect(fs.existsSync(newZip)).toBe(true);
    expect(fs.existsSync(newManifest)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});
