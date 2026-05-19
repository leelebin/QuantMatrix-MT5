const os = require('os');

const notificationHubService = require('./notificationHubService');

const DEFAULT_MERGE_WINDOW_MS = 10000;
const MAX_REASON_LENGTH = 120;
const MAX_OPEN_MESSAGE_LENGTH = 1200;

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

    if (isOpenImmediateEnabled()) {
      const message = await this.flushOpenEvent(key);
      return { queued: true, key, flushed: Boolean(message) };
    }

    return { queued: true, key };
  }

  async notifyTradeClosed(event = {}) {
    const message = buildCloseMessage(event);
    if (!message) {
      return { queued: false, reason: 'invalid_close_event' };
    }

    const normalized = normalizeCloseEvent(event);
    const result = await this.sendTelegram(message, {
      type: 'trade_close',
      scope: normalized.scope,
      priority: normalized.scope === 'live' ? 9 : 7,
      title: `${normalized.symbol} ${normalized.side} closed`,
      dedupeKey: buildCloseDedupeKey(normalized),
      immediate: true,
    });

    return {
      queued: result.queued > 0,
      message,
      delivery: result,
    };
  }

  async notifyDataSyncResult(result = {}) {
    const message = buildDataSyncMessage(result);
    const delivery = await this.sendTelegram(message, {
      type: 'data_sync',
      scope: 'system',
      priority: result.success ? 3 : 6,
      title: 'Data sync',
      immediate: true,
    });
    return { sent: delivery.configured === true && delivery.queued > 0, message, delivery };
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

    await this.sendTelegram(message, {
      type: 'trade_open',
      scope: pending.events.live ? 'live' : 'paper',
      priority: pending.events.live ? 9 : 7,
      title: 'Trade open',
      dedupeKey: key,
      immediate: true,
    });
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

  async sendTelegram(message, options = {}) {
    try {
      return await notificationHubService.enqueueTelegram({
        type: options.type || 'trade',
        scope: options.scope || 'system',
        priority: options.priority ?? 5,
        title: options.title || '',
        message,
        dedupeKey: options.dedupeKey || null,
        immediate: options.immediate === true,
      });
    } catch (error) {
      console.warn(`[TradeNotify] Telegram enqueue failed: ${error.message}`);
      return { configured: false, queued: 0, skipped: 0, deliveries: [], error: error.message };
    }
  }

  getMergeWindowMs() {
    return getMergeWindowMs();
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

function isOpenImmediateEnabled() {
  return parseBoolean(process.env.TELEGRAM_TRADE_OPEN_IMMEDIATE, false);
}

function normalizeOpenEvent(event) {
  const scope = normalizeScope(event.scope);
  if (scope !== 'paper' && scope !== 'live') return null;

  const symbol = String(event.symbol || '').trim().toUpperCase();
  const side = String(event.side || event.type || event.signal || '').trim().toUpperCase();
  if (!symbol || (side !== 'BUY' && side !== 'SELL')) return null;

  const timestamp = toValidDate(event.timestamp || event.openedAt || event.createdAt) || new Date();

  return {
    scope,
    source: cleanText(event.source || ''),
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
    symbolCustomName: cleanText(event.symbolCustomName || ''),
    logicName: cleanText(event.logicName || ''),
    candidatePreset: compactValue(event.candidatePreset),
    parameterSnapshot: event.parameterSnapshot || null,
    setupType: cleanText(event.setupType || ''),
    timestamp,
  };
}

function normalizeCloseEvent(event = {}) {
  const scope = normalizeScope(event.scope || (event.source === 'symbolCustom' ? 'paper' : 'live'));
  const symbol = String(event.symbol || '').trim().toUpperCase();
  const side = String(event.side || event.type || event.signal || '').trim().toUpperCase();
  const openedAt = toValidDate(event.openedAt);
  const closedAt = toValidDate(event.closedAt) || new Date();

  return {
    scope: scope === 'paper' ? 'paper' : 'live',
    source: cleanText(event.source || ''),
    symbol,
    side,
    strategy: cleanText(event.strategy || 'Unknown'),
    timeframe: cleanText(event.timeframe || event.setupTimeframe || event.entryTimeframe || ''),
    entryPrice: firstDefined(event.entryPrice, event.entry, event.openPrice),
    exitPrice: firstDefined(event.exitPrice, event.closePrice),
    profitLoss: firstDefined(event.profitLoss, event.pnl),
    profitPips: event.profitPips,
    realizedRMultiple: event.realizedRMultiple,
    exitReason: cleanText(event.exitReason || event.reason || 'CLOSED'),
    holdingTime: event.holdingTime || formatDuration(event.holdingTimeMs, openedAt, closedAt),
    symbolCustomName: cleanText(event.symbolCustomName || ''),
    logicName: cleanText(event.logicName || ''),
    candidatePreset: compactValue(event.candidatePreset),
    parameterSnapshot: event.parameterSnapshot || null,
    setupType: cleanText(event.setupType || ''),
    positionId: firstDefined(event.positionId, event.mt5PositionId, event._id),
    closedAt,
  };
}

function buildDedupeKey(event) {
  const bucket = Math.floor(event.timestamp.getTime() / getMergeWindowMs());
  return `${buildFingerprint(event)}|${bucket}`;
}

function buildCloseDedupeKey(event) {
  const positionId = event.positionId || 'unknown-position';
  const closedAt = event.closedAt instanceof Date ? event.closedAt.getTime() : Date.now();
  return [
    'trade_close',
    event.scope,
    event.symbol,
    event.side,
    positionId,
    closedAt,
  ].join('|');
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

  const metadataSource = paper?.source === 'symbolCustom' ? paper : source;
  const label = getOpenScopeLabel({ live, paper });
  const lines = [
    `[${label} OPEN]`,
    joinCompact([
      `${source.symbol} ${source.side}`,
      source.strategy,
      source.timeframe,
    ], ' | '),
    joinCompact([
      formatField('Entry', source.entryPrice),
      formatField('SL', source.stopLoss),
      formatField('TP', source.takeProfit),
      formatField('Vol', source.volume),
    ], ' | '),
  ];

  const metadataLine = buildSymbolCustomLine(metadataSource);
  if (metadataLine) lines.push(metadataLine);

  const detailLine = joinCompact([
    formatRiskPercent(source.riskPercent),
    formatQuality(source),
    source.setupType ? `Setup ${escapeHtml(source.setupType)}` : null,
  ], ' | ');
  if (detailLine) lines.push(detailLine);

  if (source.reason) lines.push(`Reason: ${escapeHtml(source.reason)}`);
  return truncateMessage(lines.filter(Boolean).join('\n'), MAX_OPEN_MESSAGE_LENGTH);
}

function buildCloseMessage(event = {}) {
  const trade = normalizeCloseEvent(event);
  if (!trade.symbol || (trade.side !== 'BUY' && trade.side !== 'SELL')) return null;

  const lines = [
    `[${getScopeLabel(trade)} CLOSE]`,
    joinCompact([
      `${trade.symbol} ${trade.side}`,
      trade.strategy,
      trade.timeframe,
    ], ' | '),
    joinCompact([
      formatField('Entry', trade.entryPrice),
      formatField('Exit', trade.exitPrice),
      formatProfitLoss(trade.profitLoss),
      formatPips(trade.profitPips),
      formatRMultiple(trade.realizedRMultiple),
    ], ' | '),
    joinCompact([
      trade.exitReason ? `Reason ${escapeHtml(trade.exitReason)}` : null,
      trade.holdingTime ? `Duration ${escapeHtml(trade.holdingTime)}` : null,
    ], ' | '),
  ];

  const metadataLine = buildSymbolCustomLine(trade);
  if (metadataLine) lines.push(metadataLine);

  return lines.filter(Boolean).join('\n');
}

function getOpenScopeLabel({ live, paper }) {
  if (live && paper) {
    return paper.source === 'symbolCustom' ? 'LIVE/SYMBOLCUSTOM PAPER' : 'LIVE/PAPER';
  }
  if (live) return 'LIVE';
  if (paper?.source === 'symbolCustom') return 'SYMBOLCUSTOM PAPER';
  return 'PAPER';
}

function getScopeLabel(event) {
  if (event.scope === 'live') return 'LIVE';
  if (event.scope === 'paper' && event.source === 'symbolCustom') return 'SYMBOLCUSTOM PAPER';
  return 'PAPER';
}

function buildSymbolCustomLine(event) {
  if (!event || event.source !== 'symbolCustom') return null;
  return joinCompact([
    event.symbolCustomName ? `SymbolCustom ${escapeHtml(event.symbolCustomName)}` : 'SymbolCustom',
    event.logicName ? `Logic ${escapeHtml(event.logicName)}` : null,
    event.candidatePreset ? `Preset ${escapeHtml(event.candidatePreset)}` : null,
  ], ' | ');
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

function compactValue(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return cleanText(value);
  }
  if (typeof value === 'object') {
    return cleanText(value.name || value.id || value.key || JSON.stringify(value).slice(0, 80));
  }
  return cleanText(value);
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

function formatProfitLoss(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return `P/L ${escapeHtml(String(value))}`;
  return `P/L ${numeric >= 0 ? '+' : ''}${trimTrailingZeros(numeric.toFixed(2))}`;
}

function formatPips(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return `Pips ${escapeHtml(String(value))}`;
  return `Pips ${numeric >= 0 ? '+' : ''}${trimTrailingZeros(numeric.toFixed(1))}`;
}

function formatRMultiple(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return `R ${escapeHtml(String(value))}`;
  return `R ${numeric >= 0 ? '+' : ''}${trimTrailingZeros(numeric.toFixed(2))}`;
}

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  const decimals = Math.abs(numeric) >= 100 ? 2 : 5;
  return trimTrailingZeros(numeric.toFixed(decimals));
}

function formatDuration(holdingTimeMs, openedAt, closedAt) {
  const explicit = Number(holdingTimeMs);
  const ms = Number.isFinite(explicit)
    ? explicit
    : openedAt && closedAt
      ? closedAt.getTime() - openedAt.getTime()
      : null;
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return `${hours}h ${remainingMinutes}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function trimTrailingZeros(value) {
  return String(value).replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
}

function escapeHtml(value) {
  return notificationHubService._internals.escapeHtml(value);
}

function truncateMessage(message, maxLength) {
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength - 3)}...`;
}

function normalizeScope(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'paper' || normalized === 'live') return normalized;
  return normalized;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

const tradeNotificationService = new TradeNotificationService();

module.exports = tradeNotificationService;
module.exports._internals = {
  buildCloseMessage,
  buildDataSyncMessage,
  buildDedupeKey,
  buildFingerprint,
  buildOpenMessage,
  findMergeKey,
  formatBytes,
  formatRemotePath,
  formatRiskPercent,
  getMergeWindowMs,
  normalizeCloseEvent,
  normalizeDataSyncFailureCode,
  normalizeOpenEvent,
};
