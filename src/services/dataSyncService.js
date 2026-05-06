const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const { createSnapshot } = require('../../scripts/create-data-snapshot');

const DEFAULT_PROVIDER = 'rclone';
const DEFAULT_REMOTE = 'quantmatrix-drive';
const DEFAULT_REMOTE_PATH = 'QuantMatrix/backups';
const DEFAULT_KEEP_LOCAL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCAL_SNAPSHOT_FILE_PATTERN = /^quantmatrix-data-snapshot-\d{4}-\d{2}-\d{2}-\d{6}\.(zip|manifest\.json)$/;

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeProvider(provider) {
  return String(provider || DEFAULT_PROVIDER).trim().toLowerCase();
}

function normalizeRemotePath(remotePath) {
  return String(remotePath || DEFAULT_REMOTE_PATH)
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function joinRemotePath(...segments) {
  return segments
    .filter((segment) => segment !== undefined && segment !== null && segment !== '')
    .map((segment) => String(segment).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

function resolveConfig(env = process.env) {
  return {
    enabled: parseBoolean(env.DATA_SYNC_ENABLED, false),
    provider: normalizeProvider(env.DATA_SYNC_PROVIDER),
    remote: String(env.DATA_SYNC_REMOTE || DEFAULT_REMOTE).trim(),
    remoteBasePath: normalizeRemotePath(env.DATA_SYNC_REMOTE_PATH),
    keepLocalDays: normalizeKeepLocalDays(env.DATA_SYNC_KEEP_LOCAL_DAYS),
    notifyTelegram: parseBoolean(env.DATA_SYNC_NOTIFY_TELEGRAM, true),
  };
}

function normalizeKeepLocalDays(value) {
  const source = value === undefined || value === null || value === ''
    ? String(DEFAULT_KEEP_LOCAL_DAYS)
    : value;
  const parsed = Number.parseInt(source, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_KEEP_LOCAL_DAYS;
}

function getSnapshotDateFolder(snapshotResult) {
  const zipName = path.basename(snapshotResult.zipPath || '');
  const match = zipName.match(/quantmatrix-data-snapshot-(\d{4}-\d{2}-\d{2})-\d{6}\.zip$/);
  if (match) return match[1];

  const generatedAt = snapshotResult.manifest && snapshotResult.manifest.generatedAt;
  if (generatedAt) return new Date(generatedAt).toISOString().slice(0, 10);

  return new Date().toISOString().slice(0, 10);
}

function buildRemoteFolder(config, dateFolder) {
  const folderPath = joinRemotePath(config.remoteBasePath, dateFolder);
  return `${config.remote}:${folderPath}/`;
}

function buildRemoteFile(config, dateFolder, localPath) {
  const remotePath = joinRemotePath(config.remoteBasePath, dateFolder, path.basename(localPath));
  return `${config.remote}:${remotePath}`;
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(command, args, {
      windowsHide: true,
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        error,
      });
    });

    child.on('close', (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        error: null,
      });
    });
  });
}

function makeError(code, message, details = {}) {
  return {
    code,
    message,
    ...details,
  };
}

function makeBaseResult(config, snapshotResult, remotePath, deletedLocalBackups = []) {
  const skipped = snapshotResult && Array.isArray(snapshotResult.skipped)
    ? snapshotResult.skipped
    : [];

  return {
    success: false,
    provider: config.provider,
    remote: config.remote,
    remotePath,
    zipPath: snapshotResult ? snapshotResult.zipPath : null,
    manifestPath: snapshotResult ? snapshotResult.manifestPath : null,
    fileCount: snapshotResult ? snapshotResult.fileCount : 0,
    totalBytes: snapshotResult ? snapshotResult.totalBytes : 0,
    partial: skipped.length > 0,
    skipped,
    deletedLocalBackups,
    uploadedFiles: [],
    error: null,
  };
}

function cleanupOldLocalBackups(snapshotResult, keepLocalDays, now = new Date()) {
  if (!snapshotResult || !snapshotResult.zipPath) return [];

  const backupDir = path.dirname(snapshotResult.zipPath);
  if (
    path.basename(backupDir).toLowerCase() !== 'local'
    || path.basename(path.dirname(backupDir)).toLowerCase() !== 'backups'
  ) {
    return [];
  }

  const protectedPaths = new Set(
    [snapshotResult.zipPath, snapshotResult.manifestPath]
      .filter(Boolean)
      .map((filePath) => path.resolve(filePath))
  );
  const cutoffMs = now.getTime() - (normalizeKeepLocalDays(keepLocalDays) * DAY_MS);
  const deleted = [];

  let entries;
  try {
    entries = fs.readdirSync(backupDir, { withFileTypes: true });
  } catch (error) {
    return deleted;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !LOCAL_SNAPSHOT_FILE_PATTERN.test(entry.name)) {
      continue;
    }

    const filePath = path.join(backupDir, entry.name);
    const resolvedPath = path.resolve(filePath);
    if (protectedPaths.has(resolvedPath)) {
      continue;
    }

    try {
      const stats = fs.statSync(resolvedPath);
      if (stats.mtimeMs >= cutoffMs) {
        continue;
      }

      fs.rmSync(resolvedPath, { force: true });
      deleted.push(resolvedPath);
    } catch (error) {
      // Cleanup is best-effort and should never fail a successful snapshot.
    }
  }

  return deleted;
}

async function ensureRcloneAvailable() {
  const result = await runCommand('rclone', ['version']);

  if (result.error && result.error.code === 'ENOENT') {
    return {
      ok: false,
      error: makeError('RCLONE_NOT_FOUND', 'rclone was not found on PATH. Install rclone and configure the DATA_SYNC_REMOTE remote before forcing upload.'),
    };
  }

  if (result.error) {
    return {
      ok: false,
      error: makeError('RCLONE_NOT_FOUND', result.error.message, {
        spawnCode: result.error.code || null,
      }),
    };
  }

  if (result.exitCode !== 0) {
    return {
      ok: false,
      error: makeError('RCLONE_VERSION_FAILED', 'rclone version check failed.', {
        exitCode: result.exitCode,
      }),
    };
  }

  return { ok: true };
}

async function uploadFileWithRclone(localPath, remotePath) {
  const result = await runCommand('rclone', [
    'copyto',
    localPath,
    remotePath,
    '--ignore-existing',
  ]);

  if (result.error && result.error.code === 'ENOENT') {
    throw makeError('RCLONE_NOT_FOUND', 'rclone was not found on PATH. Install rclone and configure the DATA_SYNC_REMOTE remote before forcing upload.');
  }

  if (result.error) {
    throw makeError('UPLOAD_FAILED', result.error.message, {
      spawnCode: result.error.code || null,
      localPath,
      remotePath,
    });
  }

  if (result.exitCode !== 0) {
    throw makeError('UPLOAD_FAILED', 'rclone upload command failed.', {
      exitCode: result.exitCode,
      localPath,
      remotePath,
    });
  }

  return {
    localPath,
    remotePath,
    exitCode: result.exitCode,
  };
}

async function syncDataToCloud(options = {}) {
  const config = resolveConfig(options.env || process.env);
  const reason = options.reason || 'manual';
  const force = Boolean(options.force);

  let snapshotResult = null;
  let deletedLocalBackups = [];
  let remotePath = `${config.remote}:${joinRemotePath(config.remoteBasePath, new Date().toISOString().slice(0, 10))}/`;

  try {
    try {
      snapshotResult = await createSnapshot({
        reason,
        appMode: options.appMode,
      });
    } catch (error) {
      const result = makeBaseResult(config, snapshotResult, remotePath);
      return {
        ...result,
        error: makeError('SNAPSHOT_FAILED', error.message || String(error)),
      };
    }

    const dateFolder = getSnapshotDateFolder(snapshotResult);
    remotePath = buildRemoteFolder(config, dateFolder);
    deletedLocalBackups = cleanupOldLocalBackups(snapshotResult, config.keepLocalDays);
    const result = makeBaseResult(config, snapshotResult, remotePath, deletedLocalBackups);

    if (!config.enabled && !force) {
      return {
        ...result,
        success: true,
        uploadSkipped: true,
        skipReason: 'DATA_SYNC_DISABLED',
      };
    }

    if (config.provider !== DEFAULT_PROVIDER) {
      return {
        ...result,
        error: makeError('UNSUPPORTED_PROVIDER', `Unsupported DATA_SYNC_PROVIDER "${config.provider}". Only rclone is supported.`),
      };
    }

    if (!config.remote) {
      return {
        ...result,
        error: makeError('DATA_SYNC_REMOTE_MISSING', 'DATA_SYNC_REMOTE is required for rclone upload.'),
      };
    }

    const rclone = await ensureRcloneAvailable();
    if (!rclone.ok) {
      return {
        ...result,
        error: rclone.error,
      };
    }

    const uploadedFiles = [];
    for (const localPath of [snapshotResult.zipPath, snapshotResult.manifestPath]) {
      uploadedFiles.push(await uploadFileWithRclone(
        localPath,
        buildRemoteFile(config, dateFolder, localPath),
      ));
    }

    return {
      ...result,
      success: true,
      uploadedFiles,
    };
  } catch (error) {
    const result = makeBaseResult(config, snapshotResult, remotePath, deletedLocalBackups);
    return {
      ...result,
      error: error && error.code
        ? error
        : makeError('UPLOAD_FAILED', error.message || String(error)),
    };
  }
}

module.exports = {
  syncDataToCloud,
  resolveConfig,
  _internals: {
    cleanupOldLocalBackups,
    normalizeKeepLocalDays,
  },
};
