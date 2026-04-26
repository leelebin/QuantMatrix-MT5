const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const DEFAULT_NGROK_API_URL = 'http://127.0.0.1:4040/api/tunnels';

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizeBaseUrl(value) {
  if (!value) return '';
  return String(value).trim().replace(/\/+$/, '');
}

function getAppPort() {
  return Number(process.env.PORT || 5000);
}

function getLocalBaseUrl() {
  const configured = normalizeBaseUrl(process.env.FRONTEND_URL);
  if (configured) return configured;
  return `http://localhost:${getAppPort()}`;
}

function getConfiguredPublicBaseUrl() {
  return normalizeBaseUrl(process.env.PUBLIC_BASE_URL);
}

function getRemoteAccessStateFilePath() {
  const override = String(process.env.REMOTE_ACCESS_STATE_FILE || '').trim();
  if (override) return override;
  return path.resolve(process.cwd(), 'data', 'remote-access-state.json');
}

function ensureStateDir() {
  const stateFile = getRemoteAccessStateFilePath();
  const stateDir = path.dirname(stateFile);
  fs.mkdirSync(stateDir, { recursive: true });
  return stateFile;
}

function readRemoteAccessState() {
  const stateFile = getRemoteAccessStateFilePath();
  if (!fs.existsSync(stateFile)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.warn('[RemoteAccess] Failed to parse state file:', err.message);
    return {};
  }
}

function writeRemoteAccessState(nextState) {
  const stateFile = ensureStateDir();
  fs.writeFileSync(stateFile, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
  return nextState;
}

function updateRemoteAccessState(patch) {
  const current = readRemoteAccessState();
  const next = {
    ...current,
    ...patch,
    basicAuth: {
      ...(current.basicAuth || {}),
      ...((patch && patch.basicAuth) || {}),
    },
    updatedAt: new Date().toISOString(),
  };
  return writeRemoteAccessState(next);
}

function isSelfRegistrationAllowed() {
  return parseBoolean(process.env.ALLOW_SELF_REGISTRATION, false);
}

function isRemoteUrlNotifyEnabled() {
  return parseBoolean(process.env.REMOTE_URL_NOTIFY, true);
}

function getNgrokApiUrl() {
  return normalizeBaseUrl(process.env.NGROK_API_URL) || DEFAULT_NGROK_API_URL;
}

function getTrustProxySetting() {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === null || raw === '') {
    return process.env.NGROK_AUTHTOKEN ? 1 : false;
  }

  const normalized = String(raw).trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return 1;

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  return raw;
}

function fetchJson(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https://') ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });

    req.on('error', reject);
  });
}

function tunnelMatchesPort(tunnel, port) {
  const addr = String((tunnel && tunnel.config && tunnel.config.addr) || '').toLowerCase();
  if (!addr) return false;

  const portText = String(port);
  return addr === portText
    || addr.endsWith(`:${portText}`)
    || addr.includes(`localhost:${portText}`)
    || addr.includes(`127.0.0.1:${portText}`);
}

function pickHttpsTunnel(payload, port = getAppPort()) {
  const tunnels = Array.isArray(payload && payload.tunnels) ? payload.tunnels : [];
  const httpsTunnels = tunnels.filter((tunnel) => String(tunnel.public_url || '').startsWith('https://'));
  const matchingTunnel = httpsTunnels.find((tunnel) => tunnelMatchesPort(tunnel, port));
  return matchingTunnel || httpsTunnels[0] || null;
}

async function getActiveNgrokPublicUrl() {
  try {
    const payload = await fetchJson(getNgrokApiUrl());
    const tunnel = pickHttpsTunnel(payload);
    return normalizeBaseUrl(tunnel && tunnel.public_url);
  } catch (err) {
    return '';
  }
}

async function getPublicBaseUrl() {
  const activeNgrokUrl = await getActiveNgrokPublicUrl();
  if (activeNgrokUrl) {
    const currentState = readRemoteAccessState();
    if (currentState.publicUrl !== activeNgrokUrl || currentState.publicSource !== 'ngrok') {
      updateRemoteAccessState({
        publicUrl: activeNgrokUrl,
        publicSource: 'ngrok',
        tunnelActive: true,
      });
    }
    return activeNgrokUrl;
  }

  const configuredPublicBaseUrl = getConfiguredPublicBaseUrl();
  if (configuredPublicBaseUrl) {
    return configuredPublicBaseUrl;
  }

  return getLocalBaseUrl();
}

async function buildResetPasswordUrl(resetToken) {
  const baseUrl = await getPublicBaseUrl();
  return `${baseUrl}/reset-password/${encodeURIComponent(resetToken)}`;
}

module.exports = {
  buildResetPasswordUrl,
  getActiveNgrokPublicUrl,
  getAppPort,
  getConfiguredPublicBaseUrl,
  getLocalBaseUrl,
  getNgrokApiUrl,
  getPublicBaseUrl,
  getRemoteAccessStateFilePath,
  getTrustProxySetting,
  isRemoteUrlNotifyEnabled,
  isSelfRegistrationAllowed,
  parseBoolean,
  readRemoteAccessState,
  updateRemoteAccessState,
  writeRemoteAccessState,
};
