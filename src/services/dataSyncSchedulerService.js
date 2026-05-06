const childProcess = require('child_process');
const path = require('path');

const { resolveConfig } = require('./dataSyncService');
const tradeNotificationService = require('./tradeNotificationService');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SYNC_SCRIPT = path.join(REPO_ROOT, 'scripts', 'sync-data-to-cloud.js');
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_TIME = '23:59';
const DEFAULT_TIMEZONE = 'Asia/Kuala_Lumpur';

class DataSyncSchedulerService {
  constructor() {
    this.timer = null;
    this.running = false;
    this.started = false;
    this.dailyTime = DEFAULT_DAILY_TIME;
    this.timezone = DEFAULT_TIMEZONE;
    this.nextRunAt = null;
    this.lastRun = null;
  }

  start() {
    if (this.started) {
      return this.getStatus();
    }

    if (!parseBoolean(process.env.DATA_SYNC_SCHEDULE_ENABLED, false)) {
      console.log('[DataSync] Scheduler disabled (DATA_SYNC_SCHEDULE_ENABLED=false)');
      return this.getStatus();
    }

    this.dailyTime = normalizeDailyTime(process.env.DATA_SYNC_DAILY_TIME || DEFAULT_DAILY_TIME);
    this.timezone = process.env.DATA_SYNC_TIMEZONE || DEFAULT_TIMEZONE;
    validateTimeZone(this.timezone);

    this.started = true;
    this.scheduleNext();
    console.log(`[DataSync] Scheduler started (${this.dailyTime} ${this.timezone})`);
    return this.getStatus();
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.started = false;
    this.nextRunAt = null;
    console.log('[DataSync] Scheduler stopped');
  }

  scheduleNext(fromDate = new Date()) {
    if (!this.started) return;

    const nextRun = getNextRunAt(fromDate, this.dailyTime, this.timezone);
    this.nextRunAt = nextRun.toISOString();
    const delayMs = Math.max(1000, nextRun.getTime() - Date.now());

    this.timer = setTimeout(() => {
      this.timer = null;
      this.runScheduled().finally(() => {
        if (this.started) {
          this.scheduleNext(new Date(Date.now() + 1000));
        }
      });
    }, delayMs);

    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  async runScheduled() {
    return this.runNow({
      reason: 'daily_settlement',
      force: false,
      notify: parseBoolean(process.env.DATA_SYNC_NOTIFY_TELEGRAM, true),
      trigger: 'schedule',
    });
  }

  async runNow(options = {}) {
    if (this.running) {
      const result = {
        success: false,
        provider: 'rclone',
        remote: process.env.DATA_SYNC_REMOTE || 'quantmatrix-drive',
        remotePath: null,
        zipPath: null,
        manifestPath: null,
        uploadedFiles: [],
        error: {
          code: 'RUN_IN_PROGRESS',
          message: 'Data sync is already running.',
        },
      };
      this.lastRun = summarizeRun(result, options.trigger || 'manual');
      return result;
    }

    this.running = true;
    const trigger = options.trigger || 'manual';

    try {
      const result = await runSyncScript({
        reason: options.reason || 'manual',
        force: Boolean(options.force),
      });

      this.lastRun = summarizeRun(result, trigger);

      if (options.notify !== false && parseBoolean(process.env.DATA_SYNC_NOTIFY_TELEGRAM, true)) {
        await this.sendTelegramResult(result);
      }

      return result;
    } catch (error) {
      const result = {
        success: false,
        provider: 'rclone',
        remote: process.env.DATA_SYNC_REMOTE || 'quantmatrix-drive',
        remotePath: null,
        zipPath: null,
        manifestPath: null,
        uploadedFiles: [],
        error: {
          code: error.code || 'DATA_SYNC_FAILED',
          message: error.message || String(error),
        },
      };

      this.lastRun = summarizeRun(result, trigger);

      if (options.notify !== false && parseBoolean(process.env.DATA_SYNC_NOTIFY_TELEGRAM, true)) {
        await this.sendTelegramResult(result);
      }

      return result;
    } finally {
      this.running = false;
    }
  }

  async sendTelegramResult(result) {
    await tradeNotificationService.notifyDataSyncResult(result);
  }

  getStatus() {
    const config = resolveConfig();
    return {
      schedulerEnabled: parseBoolean(process.env.DATA_SYNC_SCHEDULE_ENABLED, false),
      running: this.running,
      started: this.started,
      dailyTime: this.dailyTime,
      timezone: this.timezone,
      nextRunAt: this.nextRunAt,
      lastRun: this.lastRun,
      dataSyncEnabled: config.enabled,
      provider: config.provider,
      remote: config.remote,
      remotePath: config.remoteBasePath,
      notifyTelegram: parseBoolean(process.env.DATA_SYNC_NOTIFY_TELEGRAM, true),
    };
  }
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeDailyTime(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid DATA_SYNC_DAILY_TIME "${value}". Expected HH:mm.`);
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid DATA_SYNC_DAILY_TIME "${value}". Expected HH:mm.`);
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function validateTimeZone(timeZone) {
  new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
}

function getTimeZoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(date);
  const lookup = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = part.value;
    }
  }

  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  };
}

function getTimeZoneOffsetMs(date, timeZone) {
  const parts = getTimeZoneParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  return asUtc - date.getTime();
}

function zonedTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = localAsUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offset = getTimeZoneOffsetMs(new Date(candidate), timeZone);
    const nextCandidate = localAsUtc - offset;
    if (nextCandidate === candidate) break;
    candidate = nextCandidate;
  }

  return new Date(candidate);
}

function getNextRunAt(now, dailyTime, timeZone) {
  const [hourText, minuteText] = normalizeDailyTime(dailyTime).split(':');
  const nowParts = getTimeZoneParts(now, timeZone);
  const target = {
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
    hour: Number(hourText),
    minute: Number(minuteText),
  };

  let candidate = zonedTimeToUtc(target, timeZone);
  if (candidate.getTime() <= now.getTime()) {
    candidate = zonedTimeToUtc({
      ...target,
      day: target.day + 1,
    }, timeZone);
  }

  if (candidate.getTime() - now.getTime() > DAY_MS + (60 * 60 * 1000)) {
    throw new Error(`Unable to calculate next data sync run for ${dailyTime} ${timeZone}.`);
  }

  return candidate;
}

function runSyncScript({ reason, force }) {
  return new Promise((resolve, reject) => {
    const args = [SYNC_SCRIPT, `--reason=${reason}`];
    if (force) args.push('--force');

    const child = childProcess.spawn(process.execPath, args, {
      cwd: REPO_ROOT,
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

    child.on('error', reject);

    child.on('close', (exitCode) => {
      const parsed = parseJsonOutput(stdout);
      if (parsed) {
        resolve(parsed);
        return;
      }

      reject(Object.assign(new Error(stderr.trim() || `Data sync exited with code ${exitCode}`), {
        code: exitCode === 0 ? 'DATA_SYNC_PARSE_FAILED' : 'DATA_SYNC_FAILED',
        exitCode,
      }));
    });
  });
}

function parseJsonOutput(output) {
  const trimmed = String(output || '').trim();
  if (!trimmed) return null;

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  } catch (_) {
    return null;
  }
}

function summarizeRun(result, trigger) {
  return {
    trigger,
    finishedAt: new Date().toISOString(),
    success: Boolean(result.success),
    partial: Boolean(result.partial),
    uploadSkipped: Boolean(result.uploadSkipped),
    errorCode: result.error ? result.error.code : null,
    remotePath: result.remotePath || null,
    zipPath: result.zipPath || null,
    manifestPath: result.manifestPath || null,
    fileCount: result.fileCount || 0,
    totalBytes: result.totalBytes || 0,
  };
}

function formatDate(result) {
  const fromRemote = String(result.remotePath || '').match(/(\d{4}-\d{2}-\d{2})\/?$/);
  if (fromRemote) return fromRemote[1];

  const fromZip = path.basename(result.zipPath || '').match(/quantmatrix-data-snapshot-(\d{4}-\d{2}-\d{2})-\d{6}\.zip$/);
  if (fromZip) return fromZip[1];

  return new Date().toISOString().slice(0, 10);
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function buildSuccessMessage(result) {
  const lines = [
    '[DATA SYNC ✅]',
    `Date: ${formatDate(result)}`,
    `Files: ${result.fileCount || 0}`,
    `Size: ${formatBytes(result.totalBytes)}`,
    `Remote: ${stripTrailingSlash(result.remotePath)}`,
  ];

  if (result.partial) {
    lines.push('Partial: yes');
  }

  lines.push(`Host: ${os.hostname()}`);
  return lines.join('\n');
}

function buildFailureMessage(result) {
  const rawCode = result.error && result.error.code
    ? result.error.code
    : (result.uploadSkipped ? 'DATA_SYNC_DISABLED' : 'DATA_SYNC_FAILED');
  const code = normalizeFailureCode(rawCode);

  return [
    '[DATA SYNC ❌]',
    `Date: ${formatDate(result)}`,
    `Error: ${code}`,
    `Host: ${os.hostname()}`,
  ].join('\n');
}

function normalizeFailureCode(code) {
  if (code === 'RCLONE_NOT_FOUND' || code === 'SNAPSHOT_FAILED' || code === 'DATA_SYNC_DISABLED') {
    return code;
  }
  if (code === 'RUN_IN_PROGRESS') {
    return code;
  }
  return 'UPLOAD_FAILED';
}

module.exports = new DataSyncSchedulerService();
module.exports._internals = {
  getNextRunAt,
  normalizeDailyTime,
};
