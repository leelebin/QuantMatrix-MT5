#!/usr/bin/env node

/**
 * Read-only local data snapshot backup.
 *
 * The snapshot is built from a temporary copy under backups/tmp so live data
 * files are not compressed directly. No upload, Telegram, trading, strategy,
 * or runtime configuration paths are touched.
 */

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const REPO_ROOT = path.resolve(__dirname, '..');
const LOCAL_BACKUP_DIR = path.join(REPO_ROOT, 'backups', 'local');
const TMP_BACKUP_DIR = path.join(REPO_ROOT, 'backups', 'tmp');
const SNAPSHOT_PREFIX = 'quantmatrix-data-snapshot';
const VALID_REASONS = new Set(['daily_settlement', 'manual']);
const REPORT_NAME_PATTERN = /(optimizer|backtest|validation)/i;
const REPORT_FILE_EXTENSIONS = new Set(['.csv', '.json', '.log', '.md', '.txt']);
const MAX_RECENT_REPORT_FILES = 30;

const CRC_TABLE = buildCrcTable();

function parseArgs(argv) {
  const args = {};

  for (let index = 2; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith('--')) continue;

    const withoutPrefix = entry.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    if (equalsIndex !== -1) {
      const key = withoutPrefix.slice(0, equalsIndex);
      args[key] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[withoutPrefix] = next;
      index += 1;
    } else {
      args[withoutPrefix] = 'true';
    }
  }

  return args;
}

function printHelp() {
  console.log([
    'Usage:',
    '  node scripts/create-data-snapshot.js --reason=daily_settlement',
    '  node scripts/create-data-snapshot.js --reason=manual',
    '',
    'Optional:',
    '  --appMode=local|vps|unknown',
  ].join('\n'));
}

function getReason(args) {
  const reason = args.reason || 'manual';
  if (!VALID_REASONS.has(reason)) {
    throw new Error(`Invalid --reason "${reason}". Expected daily_settlement or manual.`);
  }
  return reason;
}

function getAppMode(args) {
  const rawMode = args.appMode
    || args['app-mode']
    || process.env.QUANTMATRIX_APP_MODE
    || process.env.APP_MODE
    || process.env.DEPLOYMENT_MODE
    || '';

  const normalized = String(rawMode).trim().toLowerCase();
  if (normalized === 'local' || normalized === 'dev' || normalized === 'development') {
    return 'local';
  }
  if (normalized === 'vps' || normalized === 'prod' || normalized === 'production') {
    return 'vps';
  }
  if (normalized === 'unknown') {
    return 'unknown';
  }
  return 'unknown';
}

function localTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function toArchivePath(relativePath) {
  return relativePath.split(path.sep).join('/').replace(/^\/+/, '');
}

function ensureInsideRepo(targetPath) {
  const resolved = path.resolve(targetPath);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside repository: ${resolved}`);
  }
  return resolved;
}

function safeRemoveDir(targetPath) {
  const resolved = ensureInsideRepo(targetPath);
  const relative = path.relative(path.join(REPO_ROOT, 'backups'), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove outside backups directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function getGitCommitHash() {
  try {
    return childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    return null;
  }
}

function makeSkippedEntry(sourcePath, reason) {
  return {
    path: toArchivePath(path.relative(REPO_ROOT, sourcePath)),
    reason,
  };
}

function copyFileToSnapshot(sourcePath, destinationPath, archivePath, copiedFiles, skipped) {
  try {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
    const copiedStats = fs.statSync(destinationPath);
    copiedFiles.push({
      sourcePath,
      archivePath,
      size: copiedStats.size,
    });
  } catch (error) {
    skipped.push(makeSkippedEntry(sourcePath, error.message));
  }
}

function copyDirectoryToSnapshot(sourceRoot, destinationRoot, archiveRoot, copiedFiles, skipped) {
  let stats;
  try {
    stats = fs.lstatSync(sourceRoot);
  } catch (error) {
    skipped.push(makeSkippedEntry(sourceRoot, 'missing'));
    return false;
  }

  if (stats.isSymbolicLink()) {
    skipped.push(makeSkippedEntry(sourceRoot, 'symbolic links are skipped'));
    return false;
  }

  if (!stats.isDirectory()) {
    skipped.push(makeSkippedEntry(sourceRoot, 'not a directory'));
    return false;
  }

  fs.mkdirSync(destinationRoot, { recursive: true });

  let entries;
  try {
    entries = fs.readdirSync(sourceRoot, { withFileTypes: true });
  } catch (error) {
    skipped.push(makeSkippedEntry(sourceRoot, error.message));
    return true;
  }

  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const destinationPath = path.join(destinationRoot, entry.name);
    const childArchivePath = toArchivePath(path.posix.join(archiveRoot, entry.name));

    if (entry.isSymbolicLink()) {
      skipped.push(makeSkippedEntry(sourcePath, 'symbolic links are skipped'));
      continue;
    }

    if (entry.isDirectory()) {
      copyDirectoryToSnapshot(sourcePath, destinationPath, childArchivePath, copiedFiles, skipped);
      continue;
    }

    if (entry.isFile()) {
      copyFileToSnapshot(sourcePath, destinationPath, childArchivePath, copiedFiles, skipped);
      continue;
    }

    skipped.push(makeSkippedEntry(sourcePath, 'unsupported file type'));
  }

  return true;
}

function listRecentReportFiles(reportsRoot, skipped) {
  let rootStats;
  try {
    rootStats = fs.lstatSync(reportsRoot);
  } catch (error) {
    skipped.push(makeSkippedEntry(reportsRoot, 'missing'));
    return [];
  }

  if (!rootStats.isDirectory()) {
    skipped.push(makeSkippedEntry(reportsRoot, 'not a directory'));
    return [];
  }

  const matches = [];

  function walk(currentPath) {
    let entries;
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (error) {
      skipped.push(makeSkippedEntry(currentPath, error.message));
      return;
    }

    for (const entry of entries) {
      const sourcePath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.push(makeSkippedEntry(sourcePath, 'symbolic links are skipped'));
        continue;
      }

      if (entry.isDirectory()) {
        walk(sourcePath);
        continue;
      }

      if (!entry.isFile()) {
        skipped.push(makeSkippedEntry(sourcePath, 'unsupported file type'));
        continue;
      }

      const relativePath = toArchivePath(path.relative(reportsRoot, sourcePath));
      if (!REPORT_NAME_PATTERN.test(relativePath)) continue;
      if (!REPORT_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

      try {
        const stats = fs.statSync(sourcePath);
        matches.push({ sourcePath, relativePath, mtimeMs: stats.mtimeMs });
      } catch (error) {
        skipped.push(makeSkippedEntry(sourcePath, error.message));
      }
    }
  }

  walk(reportsRoot);

  matches.sort((left, right) => {
    if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs;
    return left.relativePath.localeCompare(right.relativePath);
  });

  return matches.slice(0, MAX_RECENT_REPORT_FILES);
}

function copySnapshotSources(tempRoot, skipped) {
  const copiedFiles = [];
  const includedPaths = [];

  const requiredDirectories = [
    'data/history',
    'data/trading',
    'data/config',
  ];

  for (const relativeRoot of requiredDirectories) {
    const sourceRoot = path.join(REPO_ROOT, ...relativeRoot.split('/'));
    const destinationRoot = path.join(tempRoot, ...relativeRoot.split('/'));
    const archiveRoot = toArchivePath(relativeRoot);
    const included = copyDirectoryToSnapshot(
      sourceRoot,
      destinationRoot,
      archiveRoot,
      copiedFiles,
      skipped,
    );
    if (included) includedPaths.push(archiveRoot);
  }

  const reportsRoot = path.join(REPO_ROOT, 'reports');
  const reportFiles = listRecentReportFiles(reportsRoot, skipped);
  if (reportFiles.length === 0) {
    skipped.push({
      path: 'reports',
      reason: 'no recent optimizer/backtest/validation reports found',
    });
  }

  for (const reportFile of reportFiles) {
    const archivePath = toArchivePath(path.posix.join('reports', reportFile.relativePath));
    const destinationPath = path.join(tempRoot, 'reports', ...reportFile.relativePath.split('/'));
    copyFileToSnapshot(reportFile.sourcePath, destinationPath, archivePath, copiedFiles, skipped);
    includedPaths.push(archivePath);
  }

  return {
    copiedFiles,
    includedPaths: Array.from(new Set(includedPaths)),
  };
}

function collectArchiveEntries(root) {
  const entries = [];

  function walk(currentPath, relativePath) {
    const children = fs.readdirSync(currentPath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      const childRelative = relativePath ? path.join(relativePath, child.name) : child.name;
      const archivePath = toArchivePath(childRelative);
      const fullPath = path.join(currentPath, child.name);

      if (child.isDirectory()) {
        entries.push({
          type: 'directory',
          archivePath: archivePath.endsWith('/') ? archivePath : `${archivePath}/`,
          fullPath,
        });
        walk(fullPath, childRelative);
        continue;
      }

      if (child.isFile()) {
        entries.push({
          type: 'file',
          archivePath,
          fullPath,
        });
      }
    }
  }

  walk(root, '');
  return entries;
}

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dateToDosTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11)
    | (date.getMinutes() << 5)
    | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9)
    | ((date.getMonth() + 1) << 5)
    | date.getDate();
  return { dosTime, dosDate };
}

function assertZip32(value, label) {
  if (value > 0xffffffff) {
    throw new Error(`${label} exceeds ZIP32 limits; split the snapshot or add ZIP64 support.`);
  }
}

function buildLocalHeader(entry) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(entry.dosTime, 10);
  header.writeUInt16LE(entry.dosDate, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressedSize, 18);
  header.writeUInt32LE(entry.uncompressedSize, 22);
  header.writeUInt16LE(entry.nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function buildCentralHeader(entry) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(entry.dosTime, 12);
  header.writeUInt16LE(entry.dosDate, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.uncompressedSize, 24);
  header.writeUInt16LE(entry.nameBuffer.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(entry.type === 'directory' ? 0x10 : 0, 38);
  header.writeUInt32LE(entry.offset, 42);
  return header;
}

function buildEndOfCentralDirectory(entryCount, centralDirectorySize, centralDirectoryOffset) {
  const header = Buffer.alloc(22);
  header.writeUInt32LE(0x06054b50, 0);
  header.writeUInt16LE(0, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(entryCount, 8);
  header.writeUInt16LE(entryCount, 10);
  header.writeUInt32LE(centralDirectorySize, 12);
  header.writeUInt32LE(centralDirectoryOffset, 16);
  header.writeUInt16LE(0, 20);
  return header;
}

function writeAll(fd, buffer, offsetTracker) {
  fs.writeSync(fd, buffer, 0, buffer.length, offsetTracker.value);
  offsetTracker.value += buffer.length;
}

function createZipFromDirectory(sourceRoot, zipPath) {
  const entries = collectArchiveEntries(sourceRoot);
  const centralEntries = [];
  const offsetTracker = { value: 0 };
  const fd = fs.openSync(zipPath, 'w');

  try {
    for (const archiveEntry of entries) {
      const nameBuffer = Buffer.from(archiveEntry.archivePath, 'utf8');
      let input = Buffer.alloc(0);
      let output = Buffer.alloc(0);
      let method = 0;
      let statsDate = new Date();

      if (archiveEntry.type === 'file') {
        const stats = fs.statSync(archiveEntry.fullPath);
        statsDate = stats.mtime;
        input = fs.readFileSync(archiveEntry.fullPath);
        const compressed = input.length > 0 ? zlib.deflateRawSync(input, { level: 9 }) : Buffer.alloc(0);
        if (compressed.length > 0 && compressed.length < input.length) {
          method = 8;
          output = compressed;
        } else {
          output = input;
        }
      }

      const { dosTime, dosDate } = dateToDosTime(statsDate);
      const metadata = {
        type: archiveEntry.type,
        method,
        dosTime,
        dosDate,
        crc: crc32(input),
        compressedSize: output.length,
        uncompressedSize: input.length,
        nameBuffer,
        offset: offsetTracker.value,
      };

      assertZip32(metadata.compressedSize, `${archiveEntry.archivePath} compressed size`);
      assertZip32(metadata.uncompressedSize, `${archiveEntry.archivePath} size`);
      assertZip32(metadata.offset, `${archiveEntry.archivePath} offset`);

      writeAll(fd, buildLocalHeader(metadata), offsetTracker);
      writeAll(fd, nameBuffer, offsetTracker);
      writeAll(fd, output, offsetTracker);
      centralEntries.push(metadata);
    }

    const centralDirectoryOffset = offsetTracker.value;
    for (const entry of centralEntries) {
      writeAll(fd, buildCentralHeader(entry), offsetTracker);
      writeAll(fd, entry.nameBuffer, offsetTracker);
    }

    const centralDirectorySize = offsetTracker.value - centralDirectoryOffset;
    assertZip32(centralEntries.length, 'entry count');
    assertZip32(centralDirectorySize, 'central directory size');
    assertZip32(centralDirectoryOffset, 'central directory offset');
    writeAll(
      fd,
      buildEndOfCentralDirectory(
        centralEntries.length,
        centralDirectorySize,
        centralDirectoryOffset,
      ),
      offsetTracker,
    );
  } finally {
    fs.closeSync(fd);
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function createSnapshot(options = {}) {
  const reason = getReason({ reason: options.reason });
  const appMode = getAppMode({
    appMode: options.appMode,
    'app-mode': options['app-mode'],
  });
  const timestamp = options.timestamp || localTimestamp();
  const baseName = `${SNAPSHOT_PREFIX}-${timestamp}`;
  const tempRoot = path.join(TMP_BACKUP_DIR, `snapshot-${timestamp}`);
  const zipPath = path.join(LOCAL_BACKUP_DIR, `${baseName}.zip`);
  const manifestPath = path.join(LOCAL_BACKUP_DIR, `${baseName}.manifest.json`);
  const skipped = [];

  fs.mkdirSync(LOCAL_BACKUP_DIR, { recursive: true });
  fs.mkdirSync(TMP_BACKUP_DIR, { recursive: true });

  if (fs.existsSync(tempRoot)) {
    safeRemoveDir(tempRoot);
  }
  fs.mkdirSync(tempRoot, { recursive: true });

  let snapshotDetails;
  try {
    snapshotDetails = copySnapshotSources(tempRoot, skipped);
    createZipFromDirectory(tempRoot, zipPath);
  } finally {
    if (fs.existsSync(tempRoot)) {
      safeRemoveDir(tempRoot);
    }
  }

  const checksum = await sha256File(zipPath);
  const fileCount = snapshotDetails.copiedFiles.length;
  const totalBytes = snapshotDetails.copiedFiles.reduce((sum, file) => sum + file.size, 0);

  const manifest = {
    generatedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    gitCommitHash: getGitCommitHash(),
    includedPaths: snapshotDetails.includedPaths,
    fileCount,
    totalBytes,
    sha256: checksum,
    backupReason: reason,
    appMode,
    skipped,
  };

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return {
    zipPath,
    manifestPath,
    fileCount,
    totalBytes,
    checksum,
    manifest,
    skipped,
  };
}

async function runCli() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) {
    printHelp();
    return;
  }

  const result = await createSnapshot({
    reason: args.reason,
    appMode: args.appMode,
    'app-mode': args['app-mode'],
  });

  console.log('Data snapshot created');
  console.log(`zip path: ${result.zipPath}`);
  console.log(`manifest path: ${result.manifestPath}`);
  console.log(`file count: ${result.fileCount}`);
  console.log(`total bytes: ${result.totalBytes}`);
  console.log(`checksum: ${result.checksum}`);
  if (result.skipped.length > 0) {
    console.log(`skipped: ${result.skipped.length}`);
  }
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(`Snapshot failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  createSnapshot,
};
