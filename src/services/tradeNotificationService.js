const os = require('os');

const notificationService = require('./notificationService');

const DEFAULT_MERGE_WINDOW_MS = 10000;
const MAX_REASON_LENGTH = 120;

class TradeNotificationService {
  constructor() {
    this.pendingOpenEvents = new Map();
  }

  async notifyTradeOpened(event = {}) {
    const normalized = normalizeOpenEvent(event);
    if (!normalized) {
      return { queued: false, reason: 'invalid_open_event' };
    }

    const key = findMergeKey(this.pendingOpenEvents, normalized) || buildDedupeKey(normalized);
    let pending = this.pendingOpenEvents.get(key);

    if (!pending) {
      pending = {
        key,
        fingerprint: buildFingerprint(normalized),
        firstTimestamp: normalized.timestamp,
        events: {},
        timer: null,
      };
      pending.timer = setTimeout(() => {
        this.flushOpenEvent(key).catch((error) => {
          console.warn(`[TradeNotify] Failed to send open notification: ${error.message}`);
        });
      }, getMergeWindowMs());

      if (typeof pending.timer.unref === 'function') {
        pending.timer.unref();
      }

      this.pendingOpenEvents.set(key, pending);
    }

    pending.events[normalized.scope] = normalized;
    return { queued: true, key };
  }

  async notifyDataSyncResult(result = {}) {
    const message = buildDataSyncMessage(result);
    await this.sendTelegram(message);
    return { sent: notificationService.enabled === true, message };
  }

  async flushOpenEvent(key) {
    const pending = this.pendingOpenEvents.get(key);
    if (!pending) return null;

    this.pendingOpenEvents.delete(key);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }

    const message = buildOpenMessage(pending.events);
    if (!message) return null;

    await this.sendTelegram(message);
    return message;
  }

  async flushAll() {
    const keys = Array.from(this.pendingOpenEvents.keys());
    const messages = [];
    for (const key of keys) {
      const message = await this.flushOpenEvent(key);
      if (message) messages.push(message);
    }
    return messages;
  }

  async sendTelegram(message) {
    if (!notificationService.enabled) {
      return null;
    }

    try {
      return await notificationService.sendTelegram(message);
    } catch (error) {
      console.warn(`[TradeNotify] Telegram send failed: ${error.message}`);
      return null;
    }
  }

  _resetForTests() {
    for (const pending of this.pendingOpenEvents.values()) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    this.pendingOpenEvents.clear();
  }
}

function getMergeWindowMs() {
  const configured = Number(process.env.TELEGRAM_TRADE_OPEN_MERGE_WINDOW_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_MERGE_WINDOW_MS;
}

function normalizeOpenEvent(event) {
  const scope = String(event.scope || '').toLowerCase();
  if (scope !== 'paper' && scope !== 'live') return null;

  const symbol = String(event.symbol || '').trim().toUpperCase();
  const side = String(event.side || event.type || event.signal || '').trim().toUpperCase();
  if (!symbol || (side !== 'BUY' && side !== 'SELL')) return null;

  const timestamp = toValidDate(event.timestamp || event.openedAt || event.createdAt) || new Date();

  return {
    scope,
    symbol,
    side,
    strategy: cleanText(event.strategy || 'Unknown'),
    timeframe: cleanText(event.timeframe || event.setupTimeframe || event.entryTimeframe || ''),
    entryPrice: firstDefined(event.entryPrice, event.entry, event.openPrice),
    stopLoss: firstDefined(event.stopLoss, event.currentSl, event.sl, event.initialSl, event.finalSl),
    takeProfit: firstDefined(event.takeProfit, event.currentTp, event.tp, event.initialTp, event.finalTp),
    volume: firstDefined(event.volume, event.lotSize, event.originalLotSize),
    riskPercent: firstDefined(event.riskPercent, event.plannedRiskPercent),
    confidence: firstDefined(event.confidence, event.rawConfidence),
    quality: firstDefined(event.quality, event.executionQuality, event.executionScore),
    reason: cleanReason(event.reason || event.signalReason || event.entryReason || event.setupReason || event.triggerReason),
    orderId: firstDefined(event.orderId, event.mt5OrderId),
    positionId: firstDefined(event.positionId, event.mt5PositionId, event._id),
    timestamp,
  };
}

function buildDedupeKey(event) {
  const bucket = Math.floor(event.timestamp.getTime() / getMergeWindowMs());
  return `${buildFingerprint(event)}|${bucket}`;
}

function buildFingerprint(event) {
  return [
    event.symbol,
    event.strategy.toLowerCase(),
    event.side,
    event.timeframe.toLowerCase(),
  ].join('|');
}

function findMergeKey(pendingOpenEvents, event) {
  const fingerprint = buildFingerprint(event);
  const windowMs = getMergeWindowMs();

  for (const [key, pending] of pendingOpenEvents.entries()) {
    if (pending.fingerprint !== fingerprint || !pending.firstTimestamp) continue;
    if (Math.abs(event.timestamp.getTime() - pending.firstTimestamp.getTime()) <= windowMs) {
      return key;
    }
  }

  return null;
}

function buildOpenMessage(events = {}) {
  const paper = events.paper || null;
  const live = events.live || null;
  const source = live || paper;
  if (!source) return null;

  const label = live && paper
    ? 'LIVE/PAPER OPEN'
    : live
      ? 'LIVE OPEN'
      : 'PAPER OPEN';

  const lines = [
    `[${label}]`,
    joinCompact([
      `${source.symbol} ${source.side}`,
      source.strategy,
      source.timeframe,
    ], ' | '),
    joinCompact([
      formatField('Entry', source.entryPrice),
      formatField('SL', source.stopLoss),
      formatField('TP', source.takeProfit),
    ], ' | '),
  ];

  const detailLine = joinCompact([
    formatField('Vol', source.volume),
    formatRiskPercent(source.riskPercent),
    formatQuality(source),
  ], ' | ');

  if (detailLine) lines.push(detailLine);
  if (source.reason) lines.push(`Reason: ${escapeHtml(source.reason)}`);

  return lines.filter(Boolean).join('\n');
}

function buildDataSyncMessage(result = {}) {
  const success = Boolean(result.success) && !result.uploadSkipped;
  if (success) {
    return [
      `[DATA SYNC ${'\u2705'}]`,
      `Files ${Number(result.fileCount || 0)} | Size ${formatBytes(result.totalBytes)}`,
      `Remote: ${escapeHtml(formatRemotePath(result.remotePath))}`,
      `Host: ${escapeHtml(os.hostname())}`,
    ].join('\n');
  }

  if (result.uploadSkipped && result.skipReason === 'DATA_SYNC_DISABLED') {
    return [
      `[DATA SYNC ${'\u26A0\uFE0F'}]`,
      'Local snapshot created',
      'Cloud upload: disabled',
      `Files ${Number(result.fileCount || 0)} | Size ${formatBytes(result.totalBytes)}`,
      `Host: ${escapeHtml(os.hostname())}`,
    ].join('\n');
  }

  const errorCode = normalizeDataSyncFailureCode(
    result.error?.code || (result.uploadSkipped ? 'DATA_SYNC_DISABLED' : 'UPLOAD_FAILED')
  );

  return [
    `[DATA SYNC ${'\u274C'}]`,
    `Error: ${escapeHtml(errorCode)}`,
    `Host: ${escapeHtml(os.hostname())}`,
  ].join('\n');
}

function normalizeDataSyncFailureCode(code) {
  if (code === 'RCLONE_NOT_FOUND' || code === 'SNAPSHOT_FAILED' || code === 'DATA_SYNC_DISABLED') {
    return code;
  }
  if (code === 'RUN_IN_PROGRESS') {
    return code;
  }
  return 'UPLOAD_FAILED';
}

function formatRemotePath(remotePath) {
  const trimmed = String(remotePath || '').replace(/\/+$/, '');
  const colonIndex = trimmed.indexOf(':');
  return colonIndex === -1 ? trimmed : trimmed.slice(colonIndex + 1);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function toValidDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanReason(value) {
  const text = cleanText(value);
  if (!text) return '';
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH - 3)}...` : text;
}

function joinCompact(parts, separator) {
  return parts.filter(Boolean).join(separator);
}

function formatField(label, value) {
  if (value === undefined || value === null || value === '') return null;
  return `${label} ${escapeHtml(formatNumber(value))}`;
}

function formatPercent(label, value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return `${label} ${escapeHtml(String(value))}`;
  }

  const percent = Math.abs(numeric) <= 1 ? numeric * 100 : numeric;
  return `${label} ${trimTrailingZeros(percent.toFixed(2))}%`;
}

function formatRiskPercent(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return `Risk ${escapeHtml(String(value))}`;
  }

  const percent = Math.abs(numeric) <= 0.05 ? numeric * 100 : numeric;
  return `Risk ${trimTrailingZeros(percent.toFixed(2))}%`;
}

function formatQuality(event) {
  if (event.quality !== undefined && event.quality !== null && event.quality !== '') {
    return `Q ${escapeHtml(formatQualityValue(event.quality))}`;
  }

  if (event.confidence !== undefined && event.confidence !== null && event.confidence !== '') {
    return formatPercent('Conf', event.confidence);
  }

  return null;
}

function formatQualityValue(value) {
  if (typeof value === 'string') return cleanText(value);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  if (numeric >= 0 && numeric <= 1) return `${trimTrailingZeros((numeric * 100).toFixed(0))}%`;
  return trimTrailingZeros(numeric.toFixed(2));
}

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  const decimals = Math.abs(numeric) >= 100 ? 2 : 5;
  return trimTrailingZeros(numeric.toFixed(decimals));
}

function trimTrailingZeros(value) {
  return String(value).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const tradeNotificationService = new TradeNotificationService();

module.exports = tradeNotificationService;
module.exports._internals = {
  buildDataSyncMessage,
  buildDedupeKey,
  buildFingerprint,
  buildOpenMessage,
  findMergeKey,
  formatBytes,
  formatRemotePath,
  formatRiskPercent,
  normalizeDataSyncFailureCode,
  normalizeOpenEvent,
};
