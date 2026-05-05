const fs = require('fs');
const path = require('path');
const { DATA_DIR, DATABASES } = require('../config/db');

const CLEANUP_TARGETS = Object.freeze({
  backtests: {
    label: 'Single backtest results',
    defaultRetentionDays: 30,
    dateField: 'createdAt',
    query(cutoff) {
      return { createdAt: { $lt: cutoff } };
    },
  },
  batchBacktestJobs: {
    label: 'Batch backtest jobs',
    defaultRetentionDays: 30,
    dateField: 'createdAt',
    query(cutoff) {
      return {
        createdAt: { $lt: cutoff.toISOString() },
        status: { $in: ['completed', 'error'] },
      };
    },
  },
  decisionAudit: {
    label: 'Decision audit records',
    defaultRetentionDays: 14,
    dateField: 'createdAt',
    query(cutoff) {
      return { createdAt: { $lt: cutoff } };
    },
  },
  executionAudit: {
    label: 'Execution audit records',
    defaultRetentionDays: 30,
    dateField: 'createdAt',
    query(cutoff) {
      return { createdAt: { $lt: cutoff } };
    },
  },
});

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function getDbFilePath(entry) {
  if (entry && typeof entry === 'object') {
    return entry.path || path.join(DATA_DIR, entry.filename);
  }
  return path.join(DATA_DIR, entry);
}

function getFileSizeBytes(entry) {
  try {
    return fs.statSync(getDbFilePath(entry)).size;
  } catch (_err) {
    return 0;
  }
}

async function countSafe(db, query = {}) {
  if (!db || typeof db.count !== 'function') return null;
  try {
    return await db.count(query);
  } catch (_err) {
    return null;
  }
}

function normalizeDatabaseNames(names = null) {
  if (!names || names === 'all') return Object.keys(DATABASES);
  const raw = Array.isArray(names) ? names : String(names).split(',');
  const normalized = raw.map((name) => String(name).trim()).filter(Boolean);
  const invalid = normalized.filter((name) => !DATABASES[name]);
  if (invalid.length > 0) {
    const error = new Error(`Unknown database target: ${invalid.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function normalizeCleanupTargets(targets = null) {
  if (!targets || targets === 'safe') return Object.keys(CLEANUP_TARGETS);
  const raw = Array.isArray(targets) ? targets : String(targets).split(',');
  const normalized = raw.map((name) => String(name).trim()).filter(Boolean);
  const invalid = normalized.filter((name) => !CLEANUP_TARGETS[name]);
  if (invalid.length > 0) {
    const error = new Error(`Unknown cleanup target: ${invalid.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

async function getDatabaseStatus() {
  const databases = [];
  let totalSizeBytes = 0;

  for (const [name, entry] of Object.entries(DATABASES)) {
    const sizeBytes = getFileSizeBytes(entry);
    totalSizeBytes += sizeBytes;
    databases.push({
      name,
      group: entry.group || 'root',
      filename: entry.filename,
      path: getDbFilePath(entry),
      sizeBytes,
      sizeMb: round2(sizeBytes / 1024 / 1024),
      count: await countSafe(entry.db, {}),
      compactSupported: Boolean(entry.db?.persistence?.compactDatafile),
    });
  }

  databases.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return {
    checkedAt: new Date().toISOString(),
    dataDir: DATA_DIR,
    totalSizeBytes,
    totalSizeMb: round2(totalSizeBytes / 1024 / 1024),
    databases,
  };
}

function compactOne(entry, timeoutMs = 30000) {
  if (!entry?.db?.persistence || typeof entry.db.persistence.compactDatafile !== 'function') {
    return Promise.resolve({ compacted: false, reason: 'compactDatafile not supported' });
  }

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (typeof entry.db.removeListener === 'function') {
        entry.db.removeListener('compactionDone', onDone);
      }
      resolve(result);
    };
    const onDone = () => finish({ compacted: true });
    const timer = setTimeout(() => {
      if (typeof entry.db.removeListener === 'function') {
        entry.db.removeListener('compactionDone', onDone);
      }
      reject(new Error(`Compaction timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      if (typeof entry.db.once === 'function') {
        entry.db.once('compactionDone', onDone);
      }
      entry.db.persistence.compactDatafile();
      if (typeof entry.db.once !== 'function') {
        finish({ compacted: true, reason: 'compaction event unavailable' });
      }
    } catch (err) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

async function compactDatabases(options = {}) {
  const names = normalizeDatabaseNames(options.targets || options.databases || 'all');
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 30000);
  const results = [];

  for (const name of names) {
    const entry = DATABASES[name];
    const beforeBytes = getFileSizeBytes(entry);
    try {
      const compactResult = await compactOne(entry, timeoutMs);
      const afterBytes = getFileSizeBytes(entry);
      results.push({
        name,
        group: entry.group || 'root',
        filename: entry.filename,
        beforeBytes,
        afterBytes,
        freedBytes: Math.max(0, beforeBytes - afterBytes),
        ...compactResult,
      });
    } catch (err) {
      results.push({
        name,
        group: entry.group || 'root',
        filename: entry.filename,
        beforeBytes,
        afterBytes: getFileSizeBytes(entry),
        freedBytes: 0,
        compacted: false,
        error: err.message,
      });
    }
  }

  const totalFreedBytes = results.reduce((sum, item) => sum + (Number(item.freedBytes) || 0), 0);
  return {
    completedAt: new Date().toISOString(),
    totalFreedBytes,
    totalFreedMb: round2(totalFreedBytes / 1024 / 1024),
    results,
  };
}

function getRetentionDays(targetName, options) {
  const perTarget = options.retentionDaysByTarget || {};
  const targetOverride = perTarget[targetName];
  const generic = options.retentionDays;
  const selected = targetOverride != null ? targetOverride : generic;
  const fallback = CLEANUP_TARGETS[targetName].defaultRetentionDays;
  return Math.max(1, Number(selected) || fallback);
}

async function cleanupOldRecords(options = {}) {
  const targets = normalizeCleanupTargets(options.targets || 'safe');
  const dryRun = options.dryRun !== false;
  const now = options.now instanceof Date ? options.now : new Date();
  const results = [];

  for (const targetName of targets) {
    const config = CLEANUP_TARGETS[targetName];
    const dbEntry = DATABASES[targetName];
    const retentionDays = getRetentionDays(targetName, options);
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const query = config.query(cutoff);
    const matched = await countSafe(dbEntry.db, query);
    let removed = 0;

    if (!dryRun && matched > 0) {
      removed = await dbEntry.db.remove(query, { multi: true });
    }

    results.push({
      target: targetName,
      label: config.label,
      retentionDays,
      cutoff: cutoff.toISOString(),
      dateField: config.dateField,
      matched: matched || 0,
      removed,
      dryRun,
    });
  }

  return {
    completedAt: new Date().toISOString(),
    dryRun,
    targets,
    totalMatched: results.reduce((sum, item) => sum + item.matched, 0),
    totalRemoved: results.reduce((sum, item) => sum + item.removed, 0),
    results,
  };
}

module.exports = {
  CLEANUP_TARGETS,
  getDatabaseStatus,
  compactDatabases,
  cleanupOldRecords,
  normalizeDatabaseNames,
  normalizeCleanupTargets,
};
