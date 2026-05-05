const fs = require('fs');
const path = require('path');
const { DATA_DIR, DATA_GROUP_DIRS } = require('../config/db');
const fileLogger = require('./fileLogger');

const DEFAULT_TOP_FILES_LIMIT = 12;

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (_err) {
    return null;
  }
}

function walkFiles(rootDir, options = {}) {
  const maxFiles = Number(options.maxFiles) || 5000;
  const files = [];

  function walk(current) {
    if (files.length >= maxFiles) return;
    const stats = safeStat(current);
    if (!stats) return;
    if (stats.isFile()) {
      files.push({
        path: current,
        name: path.basename(current),
        sizeBytes: stats.size,
        lastWriteTime: stats.mtime.toISOString(),
      });
      return;
    }
    if (!stats.isDirectory()) return;

    let entries = [];
    try {
      entries = fs.readdirSync(current);
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      walk(path.join(current, entry));
      if (files.length >= maxFiles) break;
    }
  }

  walk(rootDir);
  return files;
}

function summarizeDirectory(rootDir, label, options = {}) {
  const exists = fs.existsSync(rootDir);
  if (!exists) {
    return {
      label,
      path: rootDir,
      exists: false,
      totalSizeBytes: 0,
      fileCount: 0,
      topFiles: [],
    };
  }

  const files = walkFiles(rootDir, options);
  const totalSizeBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  const topFiles = [...files]
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, Number(options.topFilesLimit) || DEFAULT_TOP_FILES_LIMIT)
    .map((file) => ({
      name: file.name,
      relativePath: path.relative(rootDir, file.path),
      sizeBytes: file.sizeBytes,
      lastWriteTime: file.lastWriteTime,
    }));

  return {
    label,
    path: rootDir,
    exists: true,
    totalSizeBytes,
    fileCount: files.length,
    topFiles,
  };
}

function getProcessMemory() {
  const memory = process.memoryUsage();
  return {
    pid: process.pid,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    uptimeSeconds: Math.round(process.uptime()),
    rssBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  };
}

function buildWarnings({ memory, storage }) {
  const warnings = [];
  const rssWarnBytes = Number(process.env.RESOURCE_RSS_WARN_MB || 512) * 1024 * 1024;
  const dataWarnBytes = Number(process.env.RESOURCE_DATA_WARN_MB || 1024) * 1024 * 1024;

  if (memory.rssBytes >= rssWarnBytes) {
    warnings.push({
      type: 'RAM',
      level: 'warn',
      message: `Node RSS is above ${Math.round(rssWarnBytes / 1024 / 1024)} MB`,
      valueBytes: memory.rssBytes,
    });
  }

  const dataSummary = storage.find((item) => item.key === 'data');
  if (dataSummary && dataSummary.totalSizeBytes >= dataWarnBytes) {
    warnings.push({
      type: 'ROM',
      level: 'warn',
      message: `data directory is above ${Math.round(dataWarnBytes / 1024 / 1024)} MB`,
      valueBytes: dataSummary.totalSizeBytes,
    });
  }

  return warnings;
}

function getResourceStatus(options = {}) {
  const memory = getProcessMemory();
  const groupStorage = Object.entries(DATA_GROUP_DIRS || {}).map(([key, dir]) => ({
    key: `data-${key}`,
    disposable: key === 'history',
    ...summarizeDirectory(dir, `${key} data directory`, options),
  }));
  const storage = [
    {
      key: 'data',
      ...summarizeDirectory(DATA_DIR, 'NeDB data directory', options),
    },
    ...groupStorage,
    {
      key: 'logs',
      disposable: true,
      ...summarizeDirectory(fileLogger.LOG_DIR, 'Runtime logs directory', options),
    },
  ];

  return {
    checkedAt: new Date().toISOString(),
    memory,
    storage,
    warnings: buildWarnings({ memory, storage }),
  };
}

module.exports = {
  getResourceStatus,
  summarizeDirectory,
  getProcessMemory,
};
