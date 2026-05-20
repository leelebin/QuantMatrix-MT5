const { notificationDeliveriesDb } = require('../config/db');

const STATUS = Object.freeze({
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
});

let memoryRows = [];
let memoryId = 0;

function hasDb() {
  return notificationDeliveriesDb
    && typeof notificationDeliveriesDb.insert === 'function'
    && typeof notificationDeliveriesDb.find === 'function';
}

function clone(row) {
  return row ? { ...row } : row;
}

function matches(row, query = {}) {
  return Object.entries(query).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (Object.prototype.hasOwnProperty.call(expected, '$in')) {
        return expected.$in.includes(row[key]);
      }
      return row[key] === expected;
    }
    return row[key] === expected;
  });
}

function sortRows(rows, sortSpec = {}) {
  const entries = Object.entries(sortSpec);
  return rows.slice().sort((a, b) => {
    for (const [key, direction] of entries) {
      const dir = direction < 0 ? -1 : 1;
      const aValue = a[key] instanceof Date ? a[key].getTime() : a[key];
      const bValue = b[key] instanceof Date ? b[key].getTime() : b[key];
      if (aValue < bValue) return -1 * dir;
      if (aValue > bValue) return 1 * dir;
    }
    return 0;
  });
}

async function memoryInsert(row) {
  const stored = { ...row, _id: row._id || `notification-${++memoryId}` };
  memoryRows.push(stored);
  return clone(stored);
}

async function memoryFind(query = {}, sortSpec = {}, limit = 0) {
  let rows = memoryRows.filter((row) => matches(row, query));
  if (sortSpec && Object.keys(sortSpec).length > 0) {
    rows = sortRows(rows, sortSpec);
  }
  if (limit > 0) rows = rows.slice(0, limit);
  return rows.map(clone);
}

async function memoryFindOne(query = {}) {
  return clone(memoryRows.find((row) => matches(row, query)) || null);
}

async function memoryUpdate(id, patch) {
  const index = memoryRows.findIndex((row) => row._id === id);
  if (index === -1) return 0;
  memoryRows[index] = { ...memoryRows[index], ...patch };
  return 1;
}

async function dbFind(query = {}, sortSpec = {}, limit = 0) {
  if (!hasDb()) return memoryFind(query, sortSpec, limit);
  let cursor = notificationDeliveriesDb.find(query);
  if (sortSpec && Object.keys(sortSpec).length > 0) cursor = cursor.sort(sortSpec);
  if (limit > 0) cursor = cursor.limit(limit);
  return await cursor;
}

const NotificationDelivery = {
  STATUS,

  async create(delivery = {}) {
    const now = delivery.createdAt || new Date();
    const nextAttemptAt = delivery.nextAttemptAt === undefined ? now : delivery.nextAttemptAt;
    const row = {
      type: delivery.type || 'generic',
      scope: delivery.scope || 'system',
      priority: Number.isFinite(Number(delivery.priority)) ? Number(delivery.priority) : 5,
      title: delivery.title || '',
      message: String(delivery.message || ''),
      status: delivery.status || STATUS.PENDING,
      attempts: Number.isFinite(Number(delivery.attempts)) ? Number(delivery.attempts) : 0,
      lastError: delivery.lastError || null,
      telegramMessageId: delivery.telegramMessageId || null,
      dedupeKey: delivery.dedupeKey || null,
      createdAt: now,
      nextAttemptAt,
      sentAt: delivery.sentAt || null,
    };

    if (!hasDb()) return memoryInsert(row);
    return await notificationDeliveriesDb.insert(row);
  },

  async update(id, patch = {}) {
    if (!id) return 0;
    if (!hasDb()) return memoryUpdate(id, patch);
    return await notificationDeliveriesDb.update({ _id: id }, { $set: patch });
  },

  async findById(id) {
    if (!id) return null;
    if (!hasDb()) return memoryFindOne({ _id: id });
    return await notificationDeliveriesDb.findOne({ _id: id });
  },

  async findActiveByDedupeKey(dedupeKey) {
    if (!dedupeKey) return null;
    const query = {
      dedupeKey,
      status: { $in: [STATUS.PENDING, STATUS.SENT] },
    };
    if (!hasDb()) return memoryFindOne(query);
    return await notificationDeliveriesDb.findOne(query);
  },

  async findNextPending(now = new Date()) {
    const rows = await dbFind(
      { status: STATUS.PENDING },
      { priority: -1, createdAt: 1 },
      0
    );
    const nowMs = toTimestamp(now);
    return rows.find((row) => !row.nextAttemptAt || toTimestamp(row.nextAttemptAt) <= nowMs) || null;
  },

  async findNextFuturePending(now = new Date()) {
    const rows = await dbFind(
      { status: STATUS.PENDING },
      { nextAttemptAt: 1, priority: -1, createdAt: 1 },
      0
    );
    const nowMs = toTimestamp(now);
    return rows
      .filter((row) => row.nextAttemptAt && toTimestamp(row.nextAttemptAt) > nowMs)
      .sort((a, b) => {
        const aTime = toTimestamp(a.nextAttemptAt);
        const bTime = toTimestamp(b.nextAttemptAt);
        if (aTime !== bTime) return aTime - bTime;
        if (a.priority !== b.priority) return (b.priority || 0) - (a.priority || 0);
        return toTimestamp(a.createdAt) - toTimestamp(b.createdAt);
      })[0] || null;
  },

  async listRecent(filters = {}) {
    const query = {};
    if (filters.status) query.status = String(filters.status).toUpperCase();
    if (filters.type) query.type = String(filters.type);
    if (filters.scope) query.scope = String(filters.scope);

    const limit = normalizeLimit(filters.limit, 50);
    return await dbFind(query, { createdAt: -1 }, limit);
  },

  async countByStatus(status) {
    const normalized = String(status || '').toUpperCase();
    if (!normalized) return 0;
    if (!hasDb()) return memoryRows.filter((row) => row.status === normalized).length;
    return await notificationDeliveriesDb.count({ status: normalized });
  },

  async requeueFailed(limit = 50) {
    const rows = await dbFind(
      { status: STATUS.FAILED },
      { createdAt: 1 },
      normalizeLimit(limit, 50)
    );
    for (const row of rows) {
      await NotificationDelivery.update(row._id, {
        status: STATUS.PENDING,
        attempts: 0,
        lastError: null,
        nextAttemptAt: new Date(),
      });
    }
    return rows.length;
  },

  async clearAll() {
    if (!hasDb()) {
      memoryRows = [];
      memoryId = 0;
      return 0;
    }
    return await notificationDeliveriesDb.remove({}, { multi: true });
  },

  async markSent(id, telegramMessageId) {
    return await NotificationDelivery.update(id, {
      status: STATUS.SENT,
      lastError: null,
      telegramMessageId: telegramMessageId || null,
      nextAttemptAt: null,
      sentAt: new Date(),
    });
  },

  async markFailed(id, attempts, errorMessage) {
    return await NotificationDelivery.update(id, {
      status: STATUS.FAILED,
      attempts,
      lastError: errorMessage || 'Telegram send failed',
      nextAttemptAt: null,
    });
  },

  async markPendingRetry(id, attempts, errorMessage, nextAttemptAt = new Date()) {
    return await NotificationDelivery.update(id, {
      status: STATUS.PENDING,
      attempts,
      lastError: errorMessage || 'Telegram send failed',
      nextAttemptAt,
    });
  },

  _resetForTests() {
    memoryRows = [];
    memoryId = 0;
  },
};

function normalizeLimit(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 500);
}

function toTimestamp(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

module.exports = NotificationDelivery;
