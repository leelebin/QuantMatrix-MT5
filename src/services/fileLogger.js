const fs = require('fs');
const path = require('path');

const LOG_DIR = path.resolve(process.cwd(), 'logs');
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_ROTATIONS = 5;

let initialized = false;

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function rotateIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stats = fs.statSync(filePath);
    if (stats.size < MAX_FILE_BYTES) return;

    // Cascade rotate: .N -> .N+1 (drop oldest)
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const src = `${filePath}.${i}`;
      const dst = `${filePath}.${i + 1}`;
      if (fs.existsSync(src)) {
        try {
          fs.renameSync(src, dst);
        } catch (_) {}
      }
    }
    try {
      fs.renameSync(filePath, `${filePath}.1`);
    } catch (_) {}
  } catch (_) {
    // Rotation failures should never crash the process
  }
}

function writeLine(fileName, line) {
  try {
    ensureDir();
    const filePath = path.join(LOG_DIR, fileName);
    rotateIfNeeded(filePath);
    fs.appendFileSync(filePath, line.endsWith('\n') ? line : line + '\n');
  } catch (_) {
    // Never throw from logging
  }
}

function fmtPayload(payload) {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch (_) {
    return String(payload);
  }
}

function system(message, payload) {
  const line = `${new Date().toISOString()} [SYS] ${message} ${fmtPayload(payload)}`.trim();
  writeLine('system.log', line);
}

function error(message, payload) {
  const line = `${new Date().toISOString()} [ERR] ${message} ${fmtPayload(payload)}`.trim();
  writeLine('error.log', line);
  writeLine('system.log', line);
}

function signalAudit(record) {
  const line = `${new Date().toISOString()} ${fmtPayload(record)}`;
  writeLine('signal_audit.log', line);
}

function executionAudit(record) {
  const line = `${new Date().toISOString()} ${fmtPayload(record)}`;
  writeLine('execution_audit.log', line);
}

// Install console.log/error mirroring once. Keeps console working.
function install() {
  if (initialized) return;
  initialized = true;
  ensureDir();

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  const mirror = (level, origFn) => (...args) => {
    try {
      const line =
        `${new Date().toISOString()} [${level}] ` +
        args
          .map((a) => (typeof a === 'string' ? a : fmtPayload(a)))
          .join(' ');
      writeLine('system.log', line);
      if (level === 'ERROR') writeLine('error.log', line);
    } catch (_) {}
    origFn(...args);
  };

  console.log = mirror('LOG', origLog);
  console.warn = mirror('WARN', origWarn);
  console.error = mirror('ERROR', origError);
}

module.exports = {
  install,
  system,
  error,
  signalAudit,
  executionAudit,
  LOG_DIR,
};
