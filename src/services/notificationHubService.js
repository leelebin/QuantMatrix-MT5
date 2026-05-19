const notificationService = require('./notificationService');
const NotificationDelivery = require('../models/NotificationDelivery');

const DEFAULT_RATE_LIMIT_MS = 1000;
const DEFAULT_CHUNK_LIMIT = 3900;
const MAX_ATTEMPTS = 3;
const MAX_CUSTOM_MESSAGE_LENGTH = 12000;

class NotificationHubService {
  constructor() {
    this.sending = false;
    this.timer = null;
    this.backoffUntil = 0;
    this.lastSentAt = 0;
  }

  async enqueueTelegram({
    type = 'generic',
    scope = 'system',
    priority = 5,
    title = '',
    message = '',
    dedupeKey = null,
    immediate = false,
  } = {}) {
    const configured = this.isTelegramConfigured();
    const normalizedMessage = String(message || '').trim();
    const chunks = splitMessage(normalizedMessage, getChunkLimit());
    const deliveries = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const chunkDedupeKey = dedupeKey
        ? (chunks.length > 1 ? `${dedupeKey}:part:${index + 1}` : dedupeKey)
        : null;

      if (chunkDedupeKey) {
        const existing = await NotificationDelivery.findActiveByDedupeKey(chunkDedupeKey);
        if (existing) {
          deliveries.push(await NotificationDelivery.create({
            type,
            scope,
            priority,
            title: withPartSuffix(title, index, chunks.length),
            message: chunk,
            status: NotificationDelivery.STATUS.SKIPPED,
            attempts: 0,
            lastError: 'Duplicate notification delivery skipped',
            dedupeKey: chunkDedupeKey,
          }));
          continue;
        }
      }

      deliveries.push(await NotificationDelivery.create({
        type,
        scope,
        priority,
        title: withPartSuffix(title, index, chunks.length),
        message: chunk,
        status: configured ? NotificationDelivery.STATUS.PENDING : NotificationDelivery.STATUS.SKIPPED,
        attempts: 0,
        lastError: configured ? null : 'Telegram is not configured',
        dedupeKey: chunkDedupeKey,
      }));
    }

    const queued = deliveries.filter((delivery) => delivery.status === NotificationDelivery.STATUS.PENDING).length;
    const skipped = deliveries.filter((delivery) => delivery.status === NotificationDelivery.STATUS.SKIPPED).length;

    if (queued > 0) {
      if (immediate) {
        await this.flushPending();
      } else {
        this._scheduleDrain(0);
      }
    }

    return {
      configured,
      queued,
      skipped,
      deliveries,
    };
  }

  async sendNow(message) {
    if (!this.isTelegramConfigured()) {
      throw new Error('Telegram not configured');
    }

    const chunks = splitMessage(String(message || '').trim(), getChunkLimit());
    const responses = [];
    for (const chunk of chunks) {
      responses.push(await this._sendRaw(chunk));
    }
    return responses.length === 1 ? responses[0] : responses;
  }

  async retryFailed(limit = 50) {
    const requeued = await NotificationDelivery.requeueFailed(limit);
    if (requeued > 0) {
      this._scheduleDrain(0);
    }
    return { requeued };
  }

  async flushPending() {
    return await this._drainQueue();
  }

  async getStatus() {
    const [queueLength, recentSent, recentFailed] = await Promise.all([
      NotificationDelivery.countByStatus(NotificationDelivery.STATUS.PENDING),
      NotificationDelivery.countByStatus(NotificationDelivery.STATUS.SENT),
      NotificationDelivery.countByStatus(NotificationDelivery.STATUS.FAILED),
    ]);

    return {
      telegramConfigured: this.isTelegramConfigured(),
      queueLength,
      sending: this.sending,
      recentSent,
      recentFailed,
      backoffUntil: this.backoffUntil ? new Date(this.backoffUntil).toISOString() : null,
      rateLimitMs: getRateLimitMs(),
    };
  }

  async listRecentDeliveries(filters = {}) {
    return await NotificationDelivery.listRecent(filters);
  }

  isTelegramConfigured() {
    if (notificationService && typeof notificationService.getStatus === 'function') {
      return notificationService.getStatus().telegramConfigured === true;
    }
    return notificationService?.enabled === true;
  }

  _scheduleDrain(delayMs = 0) {
    if (this.timer) return;
    const delay = Math.max(0, delayMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      this._drainQueue().catch((error) => {
        console.warn(`[NotificationHub] Queue drain failed: ${error.message}`);
      });
    }, delay);

    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  async _drainQueue() {
    if (this.sending) return { sent: 0 };
    this.sending = true;
    let sent = 0;

    try {
      while (true) {
        const now = Date.now();
        if (this.backoffUntil && now < this.backoffUntil) {
          this._scheduleDrain(this.backoffUntil - now);
          break;
        }

        const waitMs = getRateLimitMs() - (now - this.lastSentAt);
        if (waitMs > 0) {
          this._scheduleDrain(waitMs);
          break;
        }

        const delivery = await NotificationDelivery.findNextPending();
        if (!delivery) break;

        const wasSent = await this._sendDelivery(delivery);
        if (wasSent) sent += 1;
      }
    } finally {
      this.sending = false;
    }

    return { sent };
  }

  async _sendDelivery(delivery) {
    if (!this.isTelegramConfigured()) {
      await NotificationDelivery.update(delivery._id, {
        status: NotificationDelivery.STATUS.SKIPPED,
        lastError: 'Telegram is not configured',
      });
      return false;
    }

    const attempts = Number(delivery.attempts || 0) + 1;

    try {
      const result = await this._sendRaw(delivery.message);
      this.lastSentAt = Date.now();
      await NotificationDelivery.update(delivery._id, { attempts });
      await NotificationDelivery.markSent(delivery._id, extractTelegramMessageId(result));
      return true;
    } catch (error) {
      const errorMessage = normalizeErrorMessage(error);
      if (isRateLimited(error)) {
        const retryAfterMs = getRetryAfterMs(error);
        this.backoffUntil = Date.now() + retryAfterMs;
        await NotificationDelivery.markPendingRetry(delivery._id, attempts, errorMessage);
        this._scheduleDrain(retryAfterMs);
        return false;
      }

      if (attempts >= MAX_ATTEMPTS) {
        await NotificationDelivery.markFailed(delivery._id, attempts, errorMessage);
        return false;
      }

      await NotificationDelivery.markPendingRetry(delivery._id, attempts, errorMessage);
      this._scheduleDrain(getRetryDelayMs(attempts));
      return false;
    }
  }

  async _sendRaw(message) {
    const sender = notificationService.sendTelegramRaw || notificationService.sendTelegram;
    return await sender.call(notificationService, message);
  }

  _resetForTests() {
    if (this.timer) clearTimeout(this.timer);
    this.sending = false;
    this.timer = null;
    this.backoffUntil = 0;
    this.lastSentAt = 0;
    NotificationDelivery._resetForTests();
  }

  async _clearDeliveriesForTests() {
    await NotificationDelivery.clearAll();
    NotificationDelivery._resetForTests();
  }
}

function getRateLimitMs() {
  const configured = Number(process.env.NOTIFICATION_SEND_INTERVAL_MS);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  return DEFAULT_RATE_LIMIT_MS;
}

function getChunkLimit() {
  const configured = Number(process.env.NOTIFICATION_TELEGRAM_CHUNK_LIMIT);
  if (Number.isFinite(configured) && configured > 1000 && configured <= DEFAULT_CHUNK_LIMIT) {
    return Math.floor(configured);
  }
  return DEFAULT_CHUNK_LIMIT;
}

function splitMessage(message, limit = DEFAULT_CHUNK_LIMIT) {
  const text = String(message || '').trim();
  if (!text) return [''];
  if (text.length <= limit) return [text];

  const chunks = [];
  const lines = text.split('\n');
  let current = '';

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    if (line.length <= limit) {
      current = line;
      continue;
    }

    for (let offset = 0; offset < line.length; offset += limit) {
      chunks.push(line.slice(offset, offset + limit));
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function withPartSuffix(title, index, total) {
  const cleanTitle = String(title || '').trim();
  if (total <= 1) return cleanTitle;
  const suffix = ` (${index + 1}/${total})`;
  return cleanTitle ? `${cleanTitle}${suffix}` : `Part${suffix}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sanitizeHtml(value) {
  return escapeHtml(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function validateCustomMessage(value) {
  const message = String(value || '').trim();
  if (!message) {
    const error = new Error('Message is required');
    error.statusCode = 400;
    throw error;
  }
  if (message.length > MAX_CUSTOM_MESSAGE_LENGTH) {
    const error = new Error(`Message is too long. Max ${MAX_CUSTOM_MESSAGE_LENGTH} characters.`);
    error.statusCode = 400;
    throw error;
  }
  return message;
}

function extractTelegramMessageId(result) {
  return result?.result?.message_id || result?.message_id || null;
}

function isRateLimited(error) {
  return Number(error?.statusCode) === 429;
}

function getRetryAfterMs(error) {
  const retryAfter = Number(error?.retryAfter);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.max(1000, retryAfter * 1000);
  }
  return 5000;
}

function getRetryDelayMs(attempts) {
  return Math.min(30000, 1000 * Math.pow(2, Math.max(0, attempts - 1)));
}

function normalizeErrorMessage(error) {
  return error?.message || String(error || 'Telegram send failed');
}

const notificationHubService = new NotificationHubService();

module.exports = notificationHubService;
module.exports._internals = {
  escapeHtml,
  sanitizeHtml,
  splitMessage,
  validateCustomMessage,
  getRetryAfterMs,
  MAX_ATTEMPTS,
  MAX_CUSTOM_MESSAGE_LENGTH,
};
