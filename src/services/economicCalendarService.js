const https = require('https');
const fs = require('fs');
const path = require('path');
const { getAffectedCurrencies, normalizeNewsBlackoutConfig } = require('../config/newsBlackout');

const CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
const CALENDAR_TIMEZONE = 'America/New_York';
const DAY_MS = 24 * 60 * 60 * 1000;
const DISK_CACHE_PATH = path.resolve(process.cwd(), 'data', 'economic-calendar.json');
const DISK_CACHE_LABEL = 'data/economic-calendar.json';

const cache = {
  events: [],
  fetchedAt: null,
};

let refreshTimer = null;

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function stripCdata(value = '') {
  return String(value)
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .trim();
}

function extractTag(block, tagName) {
  const match = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i'));
  if (!match) {
    return '';
  }

  return stripCdata(match[1]).replace(/<[^>]+>/g, '').trim();
}

function normalizeImpact(rawImpact) {
  const text = String(rawImpact || '').trim().toLowerCase();
  if (text === 'high') return 'High';
  if (text === 'medium') return 'Medium';
  if (text === 'low') return 'Low';
  return null;
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

function zonedTimeToUtc({ year, month, day, hour, minute }, timeZone = CALENDAR_TIMEZONE) {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = localAsUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offset = getTimeZoneOffsetMs(new Date(candidate), timeZone);
    const nextCandidate = localAsUtc - offset;
    if (nextCandidate === candidate) {
      break;
    }
    candidate = nextCandidate;
  }

  return candidate;
}

function parseEventTime(dateText, timeText) {
  const normalizedDate = String(dateText || '').trim();
  const normalizedTime = String(timeText || '').trim().toLowerCase();
  const dateMatch = normalizedDate.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  const timeMatch = normalizedTime.match(/^(\d{1,2}):(\d{2})(am|pm)$/);

  if (!dateMatch || !timeMatch) {
    return null;
  }

  const month = Number(dateMatch[1]);
  const day = Number(dateMatch[2]);
  const year = Number(dateMatch[3]);
  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const meridiem = timeMatch[3];

  if (meridiem === 'pm' && hour !== 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  const utcMs = zonedTimeToUtc({ year, month, day, hour, minute });
  return new Date(utcMs).toISOString();
}

function parseCalendarXml(xml) {
  const events = [];
  const eventRegex = /<event>([\s\S]*?)<\/event>/gi;
  let match;

  while ((match = eventRegex.exec(String(xml || '')))) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const currency = extractTag(block, 'country');
    const impact = normalizeImpact(extractTag(block, 'impact'));
    const time = parseEventTime(extractTag(block, 'date'), extractTag(block, 'time'));

    if (!title || !currency || !impact || !time) {
      continue;
    }

    events.push({
      title,
      country: currency,
      currency,
      impact,
      time,
    });
  }

  return events.sort((left, right) => new Date(left.time) - new Date(right.time));
}

function readResponseBody(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
    response.on('error', reject);
  });
}

function fetchCalendarXml() {
  return new Promise((resolve, reject) => {
    const request = https.get(CALENDAR_URL, { headers: { 'User-Agent': 'QuantMatrix/1.0' } }, async (response) => {
      try {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Calendar fetch failed with status ${response.statusCode}`));
          return;
        }

        const body = await readResponseBody(response);
        resolve(body);
      } catch (error) {
        reject(error);
      }
    });

    request.on('error', reject);
    request.setTimeout(10000, () => {
      request.destroy(new Error('Calendar fetch timed out'));
    });
  });
}

async function writeDiskCache(events, fetchedAt) {
  const directory = path.dirname(DISK_CACHE_PATH);
  const tempPath = `${DISK_CACHE_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.mkdir(directory, { recursive: true });

  const payload = JSON.stringify({
    events,
    fetchedAt: fetchedAt.toISOString(),
  }, null, 2);

  await fs.promises.writeFile(tempPath, payload, 'utf8');
  try {
    await fs.promises.rename(tempPath, DISK_CACHE_PATH);
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'EPERM') {
      await fs.promises.rm(DISK_CACHE_PATH, { force: true });
      await fs.promises.rename(tempPath, DISK_CACHE_PATH);
    } else {
      throw error;
    }
  }
}

async function loadDiskCache() {
  const raw = await fs.promises.readFile(DISK_CACHE_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const events = Array.isArray(parsed) ? parsed : parsed.events;
  const fetchedAt = Array.isArray(parsed) ? null : parsed.fetchedAt;

  return {
    events: Array.isArray(events) ? events : [],
    fetchedAt: fetchedAt ? new Date(fetchedAt) : null,
  };
}

function setCache(events, fetchedAt = new Date()) {
  cache.events = cloneValue(events || []);
  cache.fetchedAt = fetchedAt ? new Date(fetchedAt) : null;
}

async function fetchCalendar() {
  const xml = await fetchCalendarXml();
  const events = parseCalendarXml(xml);
  const fetchedAt = new Date();
  setCache(events, fetchedAt);
  await writeDiskCache(events, fetchedAt);
  console.log(`[EconCalendar] fetched ${events.length} events`);
  return getCachedEvents();
}

async function ensureCalendar() {
  const isFresh = cache.fetchedAt
    && (Date.now() - cache.fetchedAt.getTime()) < DAY_MS
    && Array.isArray(cache.events)
    && cache.events.length > 0;

  if (isFresh) {
    return getCachedEvents();
  }

  try {
    return await fetchCalendar();
  } catch (error) {
    try {
      const diskCache = await loadDiskCache();
      setCache(diskCache.events, diskCache.fetchedAt || new Date());
      console.warn('[EconCalendar] offline, using cached events');
      return getCachedEvents();
    } catch (_) {
      console.warn(`[EconCalendar] offline, no cached events available (${error.message})`);
      setCache([], null);
      return [];
    }
  }
}

function scheduleRefresh(delayMs) {
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    try {
      await fetchCalendar();
    } catch (error) {
      console.warn(`[EconCalendar] scheduled refresh failed: ${error.message}`);
      await ensureCalendar();
    } finally {
      scheduleRefresh(DAY_MS);
    }
  }, delayMs);

  if (typeof refreshTimer.unref === 'function') {
    refreshTimer.unref();
  }
}

function scheduleDaily() {
  if (refreshTimer) {
    return;
  }

  const now = new Date();
  const nextMidnightUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0
  );

  scheduleRefresh(Math.max(0, nextMidnightUtc - now.getTime()));
}

function getCachedEvents() {
  return cloneValue(cache.events || []);
}

async function getCacheStatus() {
  const memoryExists = Boolean(cache.fetchedAt || (Array.isArray(cache.events) && cache.events.length > 0));
  const memoryEntryCount = Array.isArray(cache.events) ? cache.events.length : 0;
  const memorySizeBytes = memoryExists
    ? Buffer.byteLength(JSON.stringify({
      events: cache.events || [],
      fetchedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
    }), 'utf8')
    : 0;

  let diskExists = false;
  let diskSizeBytes = 0;
  let diskUpdatedAt = null;

  try {
    const stats = await fs.promises.stat(DISK_CACHE_PATH);
    diskExists = true;
    diskSizeBytes = stats.size || 0;
    diskUpdatedAt = stats.mtime ? stats.mtime.toISOString() : null;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  return {
    key: 'economic-calendar',
    label: 'Economic Calendar',
    totalSizeBytes: memorySizeBytes + diskSizeBytes,
    memory: {
      key: 'economic-calendar-memory',
      label: 'Economic Calendar Memory Cache',
      exists: memoryExists,
      entryCount: memoryEntryCount,
      fetchedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
      sizeBytes: memorySizeBytes,
    },
    disk: {
      key: 'economic-calendar-disk',
      label: DISK_CACHE_LABEL,
      path: DISK_CACHE_LABEL,
      exists: diskExists,
      sizeBytes: diskSizeBytes,
      updatedAt: diskUpdatedAt,
    },
  };
}

async function clearCache() {
  setCache([], null);
  await fs.promises.rm(DISK_CACHE_PATH, { force: true });
  return getCacheStatus();
}

function isInBlackout(symbol, nowDate, config) {
  const currencies = getAffectedCurrencies(symbol);
  if (!currencies.length) {
    return { blocked: false };
  }

  const currentTime = nowDate instanceof Date ? nowDate : new Date(nowDate);
  if (Number.isNaN(currentTime.getTime())) {
    return { blocked: false };
  }

  const effectiveConfig = normalizeNewsBlackoutConfig(config);
  const allowedImpacts = new Set(effectiveConfig.impactLevels || []);
  const nowMs = currentTime.getTime();

  for (const event of cache.events || []) {
    if (!allowedImpacts.has(event.impact)) {
      continue;
    }
    if (!currencies.includes(event.currency)) {
      continue;
    }

    const eventMs = new Date(event.time).getTime();
    if (Number.isNaN(eventMs)) {
      continue;
    }

    const startMs = eventMs - (effectiveConfig.beforeMinutes * 60 * 1000);
    const endMs = eventMs + (effectiveConfig.afterMinutes * 60 * 1000);
    if (nowMs >= startMs && nowMs <= endMs) {
      return {
        blocked: true,
        event: cloneValue(event),
      };
    }
  }

  return { blocked: false };
}

function clearTimer() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

module.exports = {
  fetchCalendar,
  ensureCalendar,
  scheduleDaily,
  isInBlackout,
  getCachedEvents,
  getCacheStatus,
  clearCache,
  _parseCalendarXml: parseCalendarXml,
  _setCacheForTests(events, fetchedAt = new Date()) {
    setCache(events, fetchedAt);
  },
  _clearCacheForTests() {
    clearTimer();
    setCache([], null);
  },
};
