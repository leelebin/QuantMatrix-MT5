const fs = require('fs');
const os = require('os');
const path = require('path');

const mt5Module = require('./mt5Service');
const paperTradingService = require('./paperTradingService');
const dataSyncSchedulerService = require('./dataSyncSchedulerService');
const notificationHubService = require('./notificationHubService');
const DecisionAudit = require('../models/DecisionAudit');

const ALERT_TYPES = Object.freeze({
  MT5_LIVE_DISCONNECTED: 'MT5_LIVE_DISCONNECTED',
  MT5_PAPER_DISCONNECTED: 'MT5_PAPER_DISCONNECTED',
  PAPER_RUNTIME_STOPPED: 'PAPER_RUNTIME_STOPPED',
  SYMBOL_CUSTOM_RUNTIME_STOPPED: 'SYMBOL_CUSTOM_RUNTIME_STOPPED',
  DATA_SYNC_FAILED: 'DATA_SYNC_FAILED',
  MEMORY_HIGH: 'MEMORY_HIGH',
  NO_SIGNAL_SCAN_ACTIVITY: 'NO_SIGNAL_SCAN_ACTIVITY',
  SERVER_STARTED: 'SERVER_STARTED',
  SERVER_STOPPING: 'SERVER_STOPPING',
});

const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_SUMMARY_INTERVAL_MINUTES = 360;
const DEFAULT_MEMORY_ALERT_MB = 800;
const DEFAULT_NO_SCAN_MINUTES = 0;

class RuntimeHeartbeatService {
  constructor() {
    this.timer = null;
    this.lastHeartbeatAt = null;
    this.lastSummaryAt = null;
    this.activeAlerts = new Map();
    this.lastSnapshot = null;
    this.symbolCustomRuntimeService = loadOptionalSymbolCustomRuntime();
    this.nowFn = () => new Date();
    this.memoryUsageFn = () => process.memoryUsage();
  }

  start() {
    if (!isHeartbeatEnabled()) {
      return this.getStatus();
    }

    if (this.timer) {
      return this.getStatus();
    }

    this.notifyServerStarted().catch((error) => {
      console.warn(`[Heartbeat] Failed to send server started alert: ${error.message}`);
    });

    this.checkNow({ reason: 'startup' }).catch((error) => {
      console.warn(`[Heartbeat] Initial check failed: ${error.message}`);
    });

    this.timer = setInterval(() => {
      this.checkNow().catch((error) => {
        console.warn(`[Heartbeat] Check failed: ${error.message}`);
      });
    }, getIntervalMinutes() * 60 * 1000);

    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }

    console.log(`[Heartbeat] Runtime heartbeat started (${getIntervalMinutes()}m interval)`);
    return this.getStatus();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.getStatus();
  }

  async notifyServerStarted() {
    if (!isHeartbeatEnabled()) return { skipped: true };
    const snapshot = await this.collectSnapshot();
    return this._sendLifecycle({
      code: ALERT_TYPES.SERVER_STARTED,
      title: 'Server started',
      message: buildLifecycleMessage('Server started', snapshot),
    });
  }

  async notifyServerStopping(reason = 'shutdown') {
    if (!isHeartbeatEnabled()) return { skipped: true };
    const snapshot = await this.collectSnapshot();
    return this._sendLifecycle({
      code: ALERT_TYPES.SERVER_STOPPING,
      title: 'Server stopping',
      message: buildLifecycleMessage(`Server stopping (${reason})`, snapshot),
    });
  }

  async checkNow(options = {}) {
    const now = this._now();
    const snapshot = await this.collectSnapshot(now);
    const alerts = evaluateSnapshot(snapshot);
    const alertMap = new Map(alerts.map((alert) => [alert.code, alert]));
    const sentAlerts = [];
    const resolvedAlerts = [];

    this.lastHeartbeatAt = now.toISOString();
    this.lastSnapshot = snapshot;

    for (const alert of alerts) {
      const active = this.activeAlerts.get(alert.code);
      if (active) {
        active.lastSeenAt = now.toISOString();
        active.snapshot = alert.snapshot;
        continue;
      }

      const activeAlert = {
        ...alert,
        startedAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
      };
      this.activeAlerts.set(alert.code, activeAlert);
      await this._sendAlert(activeAlert, snapshot);
      sentAlerts.push(activeAlert);
    }

    for (const [code, active] of [...this.activeAlerts.entries()]) {
      if (alertMap.has(code)) continue;
      this.activeAlerts.delete(code);
      await this._sendResolved(active, snapshot);
      resolvedAlerts.push(active);
    }

    const summarySent = await this._sendSummaryIfDue(snapshot, {
      force: options.forceSummary === true,
      reason: options.reason || 'scheduled',
      now,
    });

    return {
      snapshot,
      sentAlerts,
      resolvedAlerts,
      summarySent,
      activeAlerts: this._listActiveAlerts(),
    };
  }

  async sendTestHeartbeat() {
    const snapshot = await this.collectSnapshot();
    return notificationHubService.enqueueTelegram({
      type: 'heartbeat_test',
      scope: 'runtime',
      priority: 8,
      title: 'Test heartbeat',
      message: buildSummaryMessage(snapshot, { title: 'Runtime heartbeat test' }),
      immediate: true,
    });
  }

  async collectSnapshot(now = this._now()) {
    const liveMt5 = getScopedMt5Service('live');
    const paperMt5 = getScopedMt5Service('paper');
    const [paperRuntime, symbolCustomRuntime, decisionAuditActivity] = await Promise.all([
      getPaperRuntimeStatus(),
      getSymbolCustomRuntimeStatus(this.symbolCustomRuntimeService),
      getDecisionAuditActivity(now),
    ]);
    const dataSync = safeCall(() => dataSyncSchedulerService.getStatus(), null);
    const memory = this.memoryUsageFn();

    return {
      checkedAt: now.toISOString(),
      host: os.hostname(),
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      memory: {
        rssBytes: memory.rss || 0,
        rssMb: bytesToMb(memory.rss || 0),
        heapUsedMb: bytesToMb(memory.heapUsed || 0),
      },
      mt5: {
        live: buildMt5Snapshot(liveMt5, 'live'),
        paper: buildMt5Snapshot(paperMt5, 'paper'),
      },
      paperRuntime,
      symbolCustomRuntime,
      dataSync,
      decisionAudit: decisionAuditActivity,
    };
  }

  getStatus() {
    return {
      enabled: isHeartbeatEnabled(),
      running: Boolean(this.timer),
      intervalMinutes: getIntervalMinutes(),
      summaryIntervalMinutes: getSummaryIntervalMinutes(),
      memoryAlertMb: getMemoryAlertMb(),
      noScanMinutes: getNoScanMinutes(),
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastSummaryAt: this.lastSummaryAt,
      activeAlerts: this._listActiveAlerts(),
      lastSnapshot: this.lastSnapshot,
    };
  }

  _sendLifecycle({ code, title, message }) {
    return notificationHubService.enqueueTelegram({
      type: 'heartbeat',
      scope: 'runtime',
      priority: 8,
      title,
      message,
      dedupeKey: `heartbeat:${code}:${process.pid}:${Date.now()}`,
      immediate: true,
    });
  }

  async _sendAlert(alert, snapshot) {
    return notificationHubService.enqueueTelegram({
      type: 'heartbeat_alert',
      scope: 'runtime',
      priority: alert.priority || 9,
      title: alert.title,
      message: buildAlertMessage(alert, snapshot),
      dedupeKey: `heartbeat:${alert.code}:active:${alert.startedAt}`,
      immediate: true,
    });
  }

  async _sendResolved(alert, snapshot) {
    return notificationHubService.enqueueTelegram({
      type: 'heartbeat_resolved',
      scope: 'runtime',
      priority: 7,
      title: `${alert.code} resolved`,
      message: buildResolvedMessage(alert, snapshot),
      immediate: true,
    });
  }

  async _sendSummaryIfDue(snapshot, options = {}) {
    const now = options.now || this._now();
    const summaryIntervalMs = getSummaryIntervalMinutes() * 60 * 1000;
    if (!this.lastSummaryAt && options.force !== true) {
      this.lastSummaryAt = now.toISOString();
      return false;
    }

    const due = options.force === true
      || (now.getTime() - new Date(this.lastSummaryAt).getTime()) >= summaryIntervalMs;

    if (!due) return false;

    await notificationHubService.enqueueTelegram({
      type: 'heartbeat_summary',
      scope: 'runtime',
      priority: 3,
      title: 'Heartbeat summary',
      message: buildSummaryMessage(snapshot, {
        title: options.reason === 'startup' ? 'Runtime heartbeat startup summary' : 'Runtime heartbeat summary',
      }),
      dedupeKey: options.force === true ? null : `heartbeat:summary:${toDateBucket(now, getSummaryIntervalMinutes())}`,
      immediate: true,
    });
    this.lastSummaryAt = now.toISOString();
    return true;
  }

  _listActiveAlerts() {
    return Array.from(this.activeAlerts.values()).map((alert) => ({
      code: alert.code,
      title: alert.title,
      severity: alert.severity,
      startedAt: alert.startedAt,
      lastSeenAt: alert.lastSeenAt,
      message: alert.message,
    }));
  }

  _now() {
    return this.nowFn();
  }

  _resetForTests() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.lastHeartbeatAt = null;
    this.lastSummaryAt = null;
    this.activeAlerts.clear();
    this.lastSnapshot = null;
    this.symbolCustomRuntimeService = null;
    this.nowFn = () => new Date();
    this.memoryUsageFn = () => process.memoryUsage();
  }

  _setNowForTests(value) {
    this.nowFn = typeof value === 'function' ? value : () => new Date(value);
  }

  _setMemoryUsageForTests(value) {
    this.memoryUsageFn = typeof value === 'function' ? value : () => value;
  }

  _setSymbolCustomRuntimeForTests(service) {
    this.symbolCustomRuntimeService = service;
  }
}

function evaluateSnapshot(snapshot) {
  const alerts = [];
  if (snapshot.mt5.live.configured && !snapshot.mt5.live.connected) {
    alerts.push(createAlert(ALERT_TYPES.MT5_LIVE_DISCONNECTED, 'MT5 live disconnected', 'Live MT5 is not connected.', snapshot.mt5.live));
  }
  if (snapshot.mt5.paper.configured && !snapshot.mt5.paper.connected) {
    alerts.push(createAlert(ALERT_TYPES.MT5_PAPER_DISCONNECTED, 'MT5 paper disconnected', 'Paper MT5 is not connected.', snapshot.mt5.paper));
  }
  if (isPaperRuntimeExpected(snapshot.paperRuntime) && !snapshot.paperRuntime.running) {
    alerts.push(createAlert(ALERT_TYPES.PAPER_RUNTIME_STOPPED, 'Paper runtime stopped', 'Paper trading runtime is expected but not running.', snapshot.paperRuntime));
  }
  if (isSymbolCustomRuntimeExpected(snapshot.symbolCustomRuntime) && !snapshot.symbolCustomRuntime.running) {
    alerts.push(createAlert(ALERT_TYPES.SYMBOL_CUSTOM_RUNTIME_STOPPED, 'SymbolCustom runtime stopped', 'SymbolCustom paper runtime is expected but not running.', snapshot.symbolCustomRuntime));
  }
  if (snapshot.dataSync?.lastRun && snapshot.dataSync.lastRun.success === false) {
    alerts.push(createAlert(
      ALERT_TYPES.DATA_SYNC_FAILED,
      'Data sync failed',
      `Last data sync failed${snapshot.dataSync.lastRun.errorCode ? `: ${snapshot.dataSync.lastRun.errorCode}` : '.'}`,
      snapshot.dataSync.lastRun
    ));
  }
  if (snapshot.memory.rssMb >= getMemoryAlertMb()) {
    alerts.push(createAlert(
      ALERT_TYPES.MEMORY_HIGH,
      'Memory high',
      `Process RSS is ${snapshot.memory.rssMb} MB (threshold ${getMemoryAlertMb()} MB).`,
      snapshot.memory
    ));
  }
  if (shouldAlertNoScanActivity() && snapshot.decisionAudit.recentCount === 0 && getNoScanMinutes() > 0) {
    alerts.push(createAlert(
      ALERT_TYPES.NO_SIGNAL_SCAN_ACTIVITY,
      'No signal scan activity',
      `No decision audit activity in the last ${getNoScanMinutes()} minutes.`,
      snapshot.decisionAudit
    ));
  }
  return alerts;
}

function createAlert(code, title, message, details) {
  return {
    code,
    title,
    message,
    details,
    severity: code === ALERT_TYPES.MEMORY_HIGH ? 'warning' : 'critical',
    priority: code === ALERT_TYPES.MEMORY_HIGH ? 8 : 9,
  };
}

function buildAlertMessage(alert, snapshot) {
  return [
    '<b>[HEARTBEAT ALERT]</b>',
    `<b>Type:</b> ${escapeHtml(alert.code)}`,
    `<b>Status:</b> ACTIVE`,
    `<b>Host:</b> ${escapeHtml(snapshot.host)}`,
    `<b>Time:</b> ${escapeHtml(snapshot.checkedAt)}`,
    `<b>Message:</b> ${escapeHtml(alert.message)}`,
    `<b>Uptime:</b> ${formatDuration(snapshot.uptimeSeconds)}`,
  ].join('\n');
}

function buildResolvedMessage(alert, snapshot) {
  return [
    '<b>[HEARTBEAT RESOLVED]</b>',
    `<b>Type:</b> ${escapeHtml(alert.code)}`,
    `<b>Status:</b> RESOLVED`,
    `<b>Host:</b> ${escapeHtml(snapshot.host)}`,
    `<b>Time:</b> ${escapeHtml(snapshot.checkedAt)}`,
    `<b>Message:</b> ${escapeHtml(alert.message)}`,
  ].join('\n');
}

function buildLifecycleMessage(title, snapshot) {
  return [
    '<b>[HEARTBEAT]</b>',
    `<b>${escapeHtml(title)}</b>`,
    `<b>Host:</b> ${escapeHtml(snapshot.host)}`,
    `<b>PID:</b> ${snapshot.pid}`,
    `<b>Uptime:</b> ${formatDuration(snapshot.uptimeSeconds)}`,
    `<b>RSS:</b> ${snapshot.memory.rssMb} MB`,
  ].join('\n');
}

function buildSummaryMessage(snapshot, options = {}) {
  const activeAlertCount = evaluateSnapshot(snapshot).length;
  const lines = [
    '<b>[HEARTBEAT SUMMARY]</b>',
    `<b>${escapeHtml(options.title || 'Runtime heartbeat summary')}</b>`,
    `<b>Host:</b> ${escapeHtml(snapshot.host)}`,
    `<b>Checked:</b> ${escapeHtml(snapshot.checkedAt)}`,
    `<b>Uptime:</b> ${formatDuration(snapshot.uptimeSeconds)} | <b>RSS:</b> ${snapshot.memory.rssMb} MB`,
    `<b>MT5:</b> live ${formatBool(snapshot.mt5.live.connected)} | paper ${formatBool(snapshot.mt5.paper.connected)}`,
    `<b>Runtime:</b> paper ${formatBool(snapshot.paperRuntime.running)} | SymbolCustom ${formatOptionalRuntime(snapshot.symbolCustomRuntime)}`,
    `<b>Data Sync:</b> ${formatDataSync(snapshot.dataSync)}`,
    `<b>Decision Audit:</b> ${formatDecisionAudit(snapshot.decisionAudit)}`,
    `<b>Active Alerts:</b> ${activeAlertCount}`,
  ];
  return lines.join('\n');
}

function buildMt5Snapshot(service, scope) {
  const connected = safeCall(() => Boolean(service?.isConnected?.()), Boolean(service?.connected));
  const publicConfig = safeCall(() => service?.getPublicConnectionConfig?.(), null);
  const runtimeIdentity = safeCall(() => service?.buildRuntimeIdentityStatus?.(), null);
  return {
    scope,
    connected,
    configured: isMt5Configured(publicConfig, service),
    config: publicConfig,
    runtimeIdentity,
  };
}

async function getPaperRuntimeStatus() {
  try {
    if (typeof paperTradingService.getStatus === 'function') {
      const status = await paperTradingService.getStatus();
      return {
        available: true,
        enabled: Boolean(status.enabled),
        running: Boolean(status.running),
        connected: Boolean(status.connected),
        lastScanAt: status.positionMonitor?.lastScanAt || null,
      };
    }
  } catch (error) {
    return {
      available: true,
      enabled: parseBoolean(process.env.PAPER_TRADING_ENABLED, false),
      running: false,
      connected: false,
      error: error.message,
    };
  }

  return {
    available: true,
    enabled: parseBoolean(process.env.PAPER_TRADING_ENABLED, false),
    running: Boolean(paperTradingService.running),
    connected: false,
  };
}

async function getSymbolCustomRuntimeStatus(service) {
  if (!service) {
    return { available: false, enabled: false, running: false };
  }

  try {
    if (typeof service.getStatus === 'function') {
      const status = await service.getStatus();
      return {
        available: true,
        enabled: Boolean(status.enabled),
        running: Boolean(status.running),
        lastScanAt: status.lastScanAt || status.lastHeartbeatAt || null,
      };
    }
  } catch (error) {
    return {
      available: true,
      enabled: true,
      running: false,
      error: error.message,
    };
  }

  return {
    available: true,
    enabled: Boolean(service.enabled),
    running: Boolean(service.running),
  };
}

async function getDecisionAuditActivity(now) {
  const minutes = getNoScanMinutes();
  if (minutes <= 0 || !shouldAlertNoScanActivity()) {
    return { enabled: false, recentCount: null, windowMinutes: minutes };
  }

  const cutoff = new Date(now.getTime() - minutes * 60 * 1000);
  try {
    const recentCount = await DecisionAudit.count({ createdAt: { $gte: cutoff } });
    return {
      enabled: true,
      recentCount,
      windowMinutes: minutes,
      cutoffAt: cutoff.toISOString(),
    };
  } catch (error) {
    return {
      enabled: true,
      recentCount: null,
      windowMinutes: minutes,
      cutoffAt: cutoff.toISOString(),
      error: error.message,
    };
  }
}

function getScopedMt5Service(scope) {
  if (typeof mt5Module.getScopedService === 'function') {
    return mt5Module.getScopedService(scope);
  }
  return mt5Module;
}

function isMt5Configured(publicConfig, service) {
  if (publicConfig) {
    return Boolean(publicConfig.login || publicConfig.server || publicConfig.pathConfigured);
  }
  return Boolean(service);
}

function isPaperRuntimeExpected(status) {
  return Boolean(status?.running || status?.enabled || parseBoolean(process.env.PAPER_TRADING_ENABLED, false));
}

function isSymbolCustomRuntimeExpected(status) {
  return Boolean(status?.available && (status.running || status.enabled));
}

function shouldAlertNoScanActivity() {
  return parseBoolean(process.env.TRADING_ENABLED, false)
    || parseBoolean(process.env.PAPER_TRADING_ENABLED, false)
    || parseBoolean(process.env.SYMBOL_CUSTOM_PAPER_ENABLED, false)
    || parseBoolean(process.env.TELEGRAM_ALERT_NO_SCAN_ALWAYS, false);
}

function loadOptionalSymbolCustomRuntime() {
  const servicePath = path.join(__dirname, 'symbolCustomPaperRuntimeService.js');
  if (!fs.existsSync(servicePath)) return null;
  return require(servicePath);
}

function isHeartbeatEnabled() {
  return parseBoolean(process.env.TELEGRAM_HEARTBEAT_ENABLED, false);
}

function getIntervalMinutes() {
  return getPositiveNumber(process.env.TELEGRAM_HEARTBEAT_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES);
}

function getSummaryIntervalMinutes() {
  return getPositiveNumber(process.env.TELEGRAM_HEARTBEAT_SUMMARY_INTERVAL_MINUTES, DEFAULT_SUMMARY_INTERVAL_MINUTES);
}

function getMemoryAlertMb() {
  return getPositiveNumber(process.env.TELEGRAM_ALERT_MEMORY_MB, DEFAULT_MEMORY_ALERT_MB);
}

function getNoScanMinutes() {
  return getNonNegativeNumber(process.env.TELEGRAM_ALERT_NO_SCAN_MINUTES, DEFAULT_NO_SCAN_MINUTES);
}

function getPositiveNumber(value, fallback) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return fallback;
}

function getNonNegativeNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  return fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function safeCall(fn, fallback) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

function bytesToMb(bytes) {
  return Math.round((Number(bytes || 0) / (1024 * 1024)) * 10) / 10;
}

function formatDuration(seconds) {
  const total = Math.max(0, Number(seconds || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}

function formatBool(value) {
  return value ? 'OK' : 'DOWN';
}

function formatOptionalRuntime(status) {
  if (!status?.available) return 'n/a';
  return formatBool(status.running);
}

function formatDataSync(status) {
  if (!status) return 'n/a';
  if (status.running) return 'running';
  if (!status.lastRun) return 'no run yet';
  return status.lastRun.success
    ? `last OK ${status.lastRun.finishedAt || ''}`.trim()
    : `last FAILED ${status.lastRun.errorCode || ''}`.trim();
}

function formatDecisionAudit(activity) {
  if (!activity?.enabled) return 'disabled';
  if (activity.recentCount === null) return activity.error ? `error ${activity.error}` : 'unknown';
  return `${activity.recentCount} records / ${activity.windowMinutes}m`;
}

function toDateBucket(date, minutes) {
  const bucketMs = minutes * 60 * 1000;
  return Math.floor(date.getTime() / bucketMs);
}

function escapeHtml(value) {
  return notificationHubService._internals.escapeHtml(value);
}

const runtimeHeartbeatService = new RuntimeHeartbeatService();

module.exports = runtimeHeartbeatService;
module.exports.ALERT_TYPES = ALERT_TYPES;
module.exports._internals = {
  buildAlertMessage,
  buildSummaryMessage,
  evaluateSnapshot,
  parseBoolean,
  shouldAlertNoScanActivity,
};
