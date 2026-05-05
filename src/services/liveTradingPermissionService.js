const fs = require('fs');
const path = require('path');

const ENV_KEY = 'ALLOW_LIVE_TRADING';

function isAllowLiveTradingEnabled() {
  return String(process.env[ENV_KEY] || '').toLowerCase() === 'true';
}

function resolveEnvPath() {
  return path.resolve(process.cwd(), '.env');
}

async function persistAllowLiveTrading(enabled, envPath = resolveEnvPath()) {
  const value = enabled ? 'true' : 'false';
  let content = '';
  let exists = true;

  try {
    content = await fs.promises.readFile(envPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    exists = false;
  }

  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const linePattern = new RegExp(`^\\s*${ENV_KEY}\\s*=.*$`, 'm');
  let nextContent;

  if (linePattern.test(content)) {
    nextContent = content.replace(linePattern, `${ENV_KEY}=${value}`);
  } else if (content.length > 0) {
    const suffix = content.endsWith('\n') || content.endsWith('\r\n') ? '' : newline;
    nextContent = `${content}${suffix}${ENV_KEY}=${value}${newline}`;
  } else {
    nextContent = `${ENV_KEY}=${value}${newline}`;
  }

  await fs.promises.writeFile(envPath, nextContent, 'utf8');
  return {
    persisted: true,
    created: !exists,
    path: envPath,
  };
}

async function setAllowLiveTrading(enabled, options = {}) {
  const persist = options.persist !== false;

  if (!persist) {
    process.env[ENV_KEY] = enabled ? 'true' : 'false';
    return {
      enabled: isAllowLiveTradingEnabled(),
      persisted: false,
      path: null,
    };
  }

  const result = await persistAllowLiveTrading(enabled, options.envPath);
  process.env[ENV_KEY] = enabled ? 'true' : 'false';
  return {
    enabled: isAllowLiveTradingEnabled(),
    ...result,
  };
}

module.exports = {
  ENV_KEY,
  isAllowLiveTradingEnabled,
  persistAllowLiveTrading,
  setAllowLiveTrading,
};
