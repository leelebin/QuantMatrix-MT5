const fs = require('fs');
const path = require('path');

const bootStartedAt = Date.now();
const timeline = [];
let envFileOverride;

const parseDisabledValue = (value) => String(value || '').trim().toLowerCase() === 'false';

const readEnvFileOverride = () => {
  if (envFileOverride !== undefined) {
    return envFileOverride;
  }

  envFileOverride = null;

  try {
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath)) {
      return envFileOverride;
    }

    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/^\s*BOOT_PROFILER\s*=\s*["']?([^"'\r\n#]+)["']?/m);
    if (match) {
      envFileOverride = match[1].trim();
    }
  } catch (_error) {
    envFileOverride = null;
  }

  return envFileOverride;
};

const isEnabled = () => {
  if (process.env.BOOT_PROFILER !== undefined) {
    return !parseDisabledValue(process.env.BOOT_PROFILER);
  }

  const fileValue = readEnvFileOverride();
  return !parseDisabledValue(fileValue);
};

const elapsedSinceBoot = (timestamp) => Math.max(0, timestamp - bootStartedAt);

const logEntry = (entry) => {
  if (entry.type === 'mark') {
    console.log(`[BOOT] ${entry.label} at ${entry.endedAtMs}ms`);
    return;
  }

  console.log(`[BOOT] ${entry.label} took ${entry.durationMs}ms`);
};

const addEntry = (entry) => {
  if (!isEnabled()) {
    return null;
  }

  timeline.push(entry);
  logEntry(entry);
  return entry;
};

const createDurationEntry = (label, start, end) => ({
  label,
  type: 'measure',
  startedAtMs: elapsedSinceBoot(start),
  endedAtMs: elapsedSinceBoot(end),
  durationMs: Math.max(0, end - start),
  timestamp: new Date(end).toISOString()
});

const mark = (label) => {
  const now = Date.now();
  return addEntry({
    label,
    type: 'mark',
    startedAtMs: elapsedSinceBoot(now),
    endedAtMs: elapsedSinceBoot(now),
    durationMs: 0,
    timestamp: new Date(now).toISOString()
  });
};

const measure = (label, fn) => {
  const start = Date.now();

  try {
    return fn();
  } finally {
    addEntry(createDurationEntry(label, start, Date.now()));
  }
};

const measureAsync = async (label, fn) => {
  const start = Date.now();

  try {
    return await fn();
  } finally {
    addEntry(createDurationEntry(label, start, Date.now()));
  }
};

const getBootTimeline = () => timeline.map((entry) => ({ ...entry }));

const getSlowBootSteps = (thresholdMs = 1000) =>
  getBootTimeline().filter((entry) => Number(entry.durationMs) > thresholdMs);

const printBootTimeline = () => {
  if (!isEnabled()) {
    return;
  }

  getBootTimeline().forEach(logEntry);
};

module.exports = {
  mark,
  measure,
  measureAsync,
  getBootTimeline,
  getSlowBootSteps,
  printBootTimeline
};
