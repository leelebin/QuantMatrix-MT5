const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const dotenv = require('dotenv');

const projectDir = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(projectDir, '.env') });

const notificationService = require('../src/services/notificationService');
const remoteAccessService = require('../src/services/remoteAccessService');

const NGROK_DOWNLOAD_URL = 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip';
const ngrokDir = path.join(projectDir, 'ngrok-portable');
const ngrokExePath = path.join(ngrokDir, 'ngrok.exe');
const ngrokZipPath = path.join(projectDir, 'ngrok-v3-stable-windows-amd64.zip');
const trafficPolicyPath = path.join(projectDir, 'data', 'ngrok-traffic-policy.json');
const logsDir = path.join(projectDir, 'logs');
const ngrokOutLog = path.join(logsDir, 'ngrok.out.log');
const ngrokErrLog = path.join(logsDir, 'ngrok.err.log');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson(url, timeoutMs = 2000) {
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

async function waitForLocalServer(port, timeoutMs = 120000) {
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = await requestJson(healthUrl, 2000);
      if (payload && payload.success) {
        return payload;
      }
    } catch (err) {}

    await sleep(1500);
  }

  throw new Error(`Timed out waiting for QuantMatrix on port ${port}`);
}

function ensureLogsDir() {
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(path.dirname(trafficPolicyPath), { recursive: true });
}

function findNgrokInPath() {
  const result = spawnSync('cmd', ['/c', 'where ngrok'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });

  if (result.status !== 0) {
    return '';
  }

  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().endsWith('ngrok.exe')) || '';
}

function runPowershell(script) {
  const result = spawnSync('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    cwd: projectDir,
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'PowerShell command failed').trim());
  }
}

function downloadNgrok() {
  console.log('[RemoteAccess] Downloading ngrok agent...');
  fs.mkdirSync(ngrokDir, { recursive: true });
  runPowershell(`Invoke-WebRequest -Uri '${NGROK_DOWNLOAD_URL}' -OutFile '${ngrokZipPath}'`);
  runPowershell(`Expand-Archive -LiteralPath '${ngrokZipPath}' -DestinationPath '${ngrokDir}' -Force`);
  if (fs.existsSync(ngrokZipPath)) {
    fs.unlinkSync(ngrokZipPath);
  }

  if (!fs.existsSync(ngrokExePath)) {
    throw new Error('ngrok.exe was not found after download');
  }

  return ngrokExePath;
}

function resolveNgrokExecutable() {
  const configuredPath = String(process.env.NGROK_PATH || '').trim();
  if (configuredPath && fs.existsSync(configuredPath)) {
    return configuredPath;
  }

  if (fs.existsSync(ngrokExePath)) {
    return ngrokExePath;
  }

  const fromPath = findNgrokInPath();
  if (fromPath) {
    return fromPath;
  }

  return downloadNgrok();
}

function generatePassword() {
  return crypto.randomBytes(18).toString('base64url');
}

function resolveBasicAuth(existingState, reuseExistingTunnel) {
  const envUser = String(process.env.NGROK_BASIC_AUTH_USER || '').trim();
  const envPassword = String(process.env.NGROK_BASIC_AUTH_PASSWORD || '').trim();
  const stateUser = String((existingState.basicAuth && existingState.basicAuth.username) || '').trim();
  const statePassword = String((existingState.basicAuth && existingState.basicAuth.password) || '').trim();

  if (reuseExistingTunnel) {
    if (stateUser && statePassword) {
      if ((envUser && envUser !== stateUser) || (envPassword && envPassword !== statePassword)) {
        console.warn('[RemoteAccess] Existing ngrok tunnel detected; reusing stored outer-access credentials until the tunnel is restarted.');
      }

      return {
        username: stateUser,
        password: statePassword,
        generated: false,
      };
    }

    throw new Error(
      'An ngrok tunnel is already active, but its outer-access credentials are unknown. Stop the current ngrok tunnel and run start-remote.bat again.'
    );
  }

  const username = envUser || stateUser || 'qmremote';
  const password = envPassword || statePassword || generatePassword();

  if (password.length < 8) {
    throw new Error('NGROK_BASIC_AUTH_PASSWORD must be at least 8 characters long');
  }

  return {
    username,
    password,
    generated: !envPassword && !statePassword,
  };
}

function writeTrafficPolicyFile(username, password) {
  ensureLogsDir();
  const policy = {
    on_http_request: [
      {
        actions: [
          {
            type: 'basic-auth',
            config: {
              realm: 'QuantMatrix Remote',
              credentials: [`${username}:${password}`],
            },
          },
        ],
      },
    ],
  };

  fs.writeFileSync(trafficPolicyPath, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
  return trafficPolicyPath;
}

function launchNgrok(ngrokExecutable, port, authtoken, policyFile) {
  ensureLogsDir();

  const outFd = fs.openSync(ngrokOutLog, 'a');
  const errFd = fs.openSync(ngrokErrLog, 'a');

  const args = [
    'http',
    `http://127.0.0.1:${port}`,
    '--authtoken',
    authtoken,
    '--traffic-policy-file',
    policyFile,
  ];

  const child = spawn(ngrokExecutable, args, {
    cwd: projectDir,
    detached: true,
    stdio: ['ignore', outFd, errFd],
    windowsHide: true,
  });

  child.unref();
  return child.pid;
}

async function waitForNgrokUrl(timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const publicUrl = await remoteAccessService.getActiveNgrokPublicUrl();
    if (publicUrl) {
      return publicUrl;
    }
    await sleep(1000);
  }

  throw new Error('Timed out waiting for ngrok to publish a public HTTPS URL');
}

function buildTelegramMessage(publicUrl, basicAuth, urlChanged, previousUrl) {
  let message = '\u{1F310} <b>QuantMatrix Remote Access</b>\n\n';
  message += `<b>Public URL:</b> ${publicUrl}\n`;
  message += `<b>Outer Access User:</b> ${basicAuth.username}\n`;
  message += `<b>Outer Access Password:</b> ${basicAuth.password}\n`;
  message += `<b>Status:</b> ${urlChanged ? 'Updated public address' : 'Remote access refreshed'}\n`;
  if (previousUrl && previousUrl !== publicUrl) {
    message += `<b>Previous URL:</b> ${previousUrl}\n`;
  }
  message += `<b>Time:</b> ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;
  return message;
}

async function maybeNotifyTelegram(publicUrl, basicAuth, previousState) {
  if (!remoteAccessService.isRemoteUrlNotifyEnabled()) {
    return false;
  }

  if (!notificationService.enabled) {
    console.log('[RemoteAccess] Telegram notifications are disabled; skipping remote URL notification.');
    return false;
  }

  const previousUrl = String(previousState.lastNotifiedUrl || '');
  const previousUser = String((previousState.lastNotifiedBasicAuth && previousState.lastNotifiedBasicAuth.username) || '');
  const previousPassword = String((previousState.lastNotifiedBasicAuth && previousState.lastNotifiedBasicAuth.password) || '');
  const shouldNotify = publicUrl !== previousUrl
    || basicAuth.username !== previousUser
    || basicAuth.password !== previousPassword;

  if (!shouldNotify) {
    return false;
  }

  await notificationService.sendTelegram(
    buildTelegramMessage(publicUrl, basicAuth, publicUrl !== previousUrl, previousUrl)
  );

  remoteAccessService.updateRemoteAccessState({
    lastNotifiedUrl: publicUrl,
    lastNotifiedAt: new Date().toISOString(),
    lastNotifiedBasicAuth: {
      username: basicAuth.username,
      password: basicAuth.password,
    },
  });

  return true;
}

async function main() {
  notificationService.init();

  const port = remoteAccessService.getAppPort();
  console.log(`[RemoteAccess] Waiting for local QuantMatrix server on port ${port}...`);
  await waitForLocalServer(port);

  const existingState = remoteAccessService.readRemoteAccessState();
  const existingPublicUrl = await remoteAccessService.getActiveNgrokPublicUrl();
  const reuseExistingTunnel = Boolean(existingPublicUrl);
  const basicAuth = resolveBasicAuth(existingState, reuseExistingTunnel);

  let publicUrl = existingPublicUrl;
  let ngrokPid = existingState.ngrokPid || null;

  if (!publicUrl) {
    const authtoken = String(process.env.NGROK_AUTHTOKEN || '').trim();
    if (!authtoken) {
      throw new Error('NGROK_AUTHTOKEN is required in .env before remote access can be started');
    }

    const ngrokExecutable = resolveNgrokExecutable();
    const policyFile = writeTrafficPolicyFile(basicAuth.username, basicAuth.password);
    ngrokPid = launchNgrok(ngrokExecutable, port, authtoken, policyFile);
    console.log('[RemoteAccess] ngrok launched, waiting for public HTTPS URL...');
    publicUrl = await waitForNgrokUrl();
  } else {
    console.log('[RemoteAccess] Reusing existing ngrok tunnel.');
  }

  remoteAccessService.updateRemoteAccessState({
    managedBy: 'quantmatrix',
    localPort: port,
    ngrokPid,
    publicSource: 'ngrok',
    publicUrl,
    tunnelActive: true,
    basicAuth: {
      username: basicAuth.username,
      password: basicAuth.password,
    },
  });

  const notified = await maybeNotifyTelegram(publicUrl, basicAuth, existingState);

  console.log('[RemoteAccess] Remote access is ready.');
  console.log(`[RemoteAccess] Public URL: ${publicUrl}`);
  console.log(`[RemoteAccess] Outer access username: ${basicAuth.username}`);
  console.log(`[RemoteAccess] Outer access password: ${basicAuth.password}`);
  if (notified) {
    console.log('[RemoteAccess] Telegram notification sent.');
  }
}

main().catch((err) => {
  console.error('[RemoteAccess] Failed to start remote access:', err.message);
  process.exit(1);
});
