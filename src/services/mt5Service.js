/**
 * MT5 Connection Service
 * Manages connection to MetaTrader 5 via Python bridge (direct broker connection)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const dotenv = require('dotenv');
const symbolResolver = require('./symbolResolver');
const { createSymbolResolver } = symbolResolver;

const ACCOUNT_MODE_NAMES = {
  0: 'DEMO',
  1: 'CONTEST',
  2: 'REAL',
};

function normalizeTerminalPath(rawPath) {
  if (!rawPath) return null;

  const trimmed = String(rawPath).trim();
  if (!trimmed) return null;

  const unquoted = (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  )
    ? trimmed.slice(1, -1).trim()
    : trimmed;

  return unquoted
    .replace(/[\\/]+/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function isStrictRuntimeIsolationEnabled(rawValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return true;
  }

  return !['false', '0', 'no', 'off'].includes(String(rawValue).trim().toLowerCase());
}

function readAccountField(accountInfo = {}, names = []) {
  const nested = accountInfo && typeof accountInfo.accountInfo === 'object'
    ? accountInfo.accountInfo
    : {};

  for (const source of [accountInfo || {}, nested || {}]) {
    for (const name of names) {
      if (source[name] !== undefined && source[name] !== null && source[name] !== '') {
        return source[name];
      }
    }
  }

  return null;
}

function normalizeBooleanFlag(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    return ['true', '1', 'yes', 'y'].includes(value.trim().toLowerCase());
  }
  return false;
}

function normalizeTradeModeName(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return null;
  }

  if (typeof rawValue === 'number') {
    return ACCOUNT_MODE_NAMES[rawValue] || null;
  }

  const normalized = String(rawValue).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (!normalized) return null;
  if (/^\d+$/.test(normalized)) {
    return ACCOUNT_MODE_NAMES[Number(normalized)] || null;
  }
  if (normalized.includes('REAL')) return 'REAL';
  if (normalized.includes('CONTEST')) return 'CONTEST';
  if (normalized.includes('DEMO')) return 'DEMO';
  return null;
}

function normalizeAccountMode(accountInfo = {}) {
  const modeCandidates = [
    readAccountField(accountInfo, ['tradeModeName', 'trade_mode_name', 'modeName', 'accountModeName']),
    readAccountField(accountInfo, ['tradeMode', 'trade_mode', 'mode', 'accountMode']),
  ];

  let tradeModeName = 'UNKNOWN';
  for (const candidate of modeCandidates) {
    const normalized = normalizeTradeModeName(candidate);
    if (normalized) {
      tradeModeName = normalized;
      break;
    }
  }

  const realFlag = normalizeBooleanFlag(readAccountField(accountInfo, ['isReal', 'real']));
  const demoFlag = normalizeBooleanFlag(readAccountField(accountInfo, ['isDemo', 'demo']));
  const contestFlag = normalizeBooleanFlag(readAccountField(accountInfo, ['isContest', 'contest']));

  if (tradeModeName === 'UNKNOWN') {
    if (realFlag) tradeModeName = 'REAL';
    else if (contestFlag) tradeModeName = 'CONTEST';
    else if (demoFlag) tradeModeName = 'DEMO';
  }

  return {
    tradeModeName,
    isReal: tradeModeName === 'REAL',
    isDemo: tradeModeName === 'DEMO',
    isContest: tradeModeName === 'CONTEST',
  };
}

class MT5Service {
  constructor(options = {}) {
    this.scope = options.scope || 'live';
    this.envPrefix = options.envPrefix || (this.scope === 'paper' ? 'MT5_PAPER' : 'MT5_LIVE');
    this.legacyPrefix = options.legacyPrefix || 'MT5';
    this.symbolResolver = options.symbolResolver || symbolResolver;
    this.process = null;
    this.connected = false;
    this.ready = false;
    this.connecting = false;
    this._pendingRequests = new Map();
    this._requestId = 0;
    this._rl = null;
  }

  /**
   * Start the Python bridge process
   */
  _logPrefix() {
    return `[MT5:${this.scope}]`;
  }

  _envName(key, prefix = this.envPrefix) {
    return `${prefix}_${key}`;
  }

  _readEnvFileValues() {
    const envPath = path.resolve(process.cwd(), '.env');
    try {
      return dotenv.parse(fs.readFileSync(envPath, 'utf8'));
    } catch (_) {
      return {};
    }
  }

  _readRawEnv(name, envFileValues = this._readEnvFileValues()) {
    return process.env[name]
      || (Object.prototype.hasOwnProperty.call(envFileValues, name) ? envFileValues[name] : undefined);
  }

  reloadConnectionEnvFromFile() {
    const envFileValues = this._readEnvFileValues();
    const prefixes = [this.envPrefix, this.legacyPrefix];
    const keys = ['LOGIN', 'PASSWORD', 'SERVER', 'PATH'];
    const updated = {};

    prefixes.forEach((prefix) => {
      keys.forEach((key) => {
        const name = this._envName(key, prefix);
        if (Object.prototype.hasOwnProperty.call(envFileValues, name)) {
          process.env[name] = envFileValues[name];
          updated[name] = envFileValues[name];
        }
      });
    });

    return updated;
  }

  _readScopedEnv(key) {
    const envFileValues = this._readEnvFileValues();
    const scopedName = this._envName(key);
    const scopedValue = this._readRawEnv(scopedName, envFileValues);
    if (scopedValue) {
      return {
        value: scopedValue,
        name: scopedName,
        scoped: true,
      };
    }

    const legacyName = this._envName(key, this.legacyPrefix);
    const legacyValue = this._readRawEnv(legacyName, envFileValues);
    return {
      value: legacyValue,
      name: legacyName,
      scoped: false,
    };
  }

  getConnectionConfig() {
    const login = this._readScopedEnv('LOGIN');
    const password = this._readScopedEnv('PASSWORD');
    const server = this._readScopedEnv('SERVER');
    const terminalPath = this._readScopedEnv('PATH');

    return {
      scope: this.scope,
      login: login.value,
      password: password.value,
      server: server.value,
      path: terminalPath.value || null,
      env: {
        login: login.name,
        password: password.name,
        server: server.name,
        path: terminalPath.name,
      },
      usesLegacy: !login.scoped || !password.scoped || !server.scoped,
      pathScoped: Boolean(terminalPath.value) && terminalPath.scoped,
      pathUsesLegacy: Boolean(terminalPath.value) && !terminalPath.scoped,
    };
  }

  getPublicConnectionConfig() {
    const config = this.getConnectionConfig();
    return {
      scope: config.scope,
      login: config.login ? String(config.login) : null,
      server: config.server || null,
      pathConfigured: Boolean(config.path),
      pathScoped: config.pathScoped === true,
      pathUsesLegacy: config.pathUsesLegacy === true,
      env: config.env,
      usesLegacy: config.usesLegacy,
    };
  }

  getAccountConfigMatch(accountInfo = {}, config = this.getConnectionConfig()) {
    const expectedLogin = config.login ? String(config.login).trim() : '';
    const expectedServer = config.server ? String(config.server).trim().toLowerCase() : '';
    const actualLoginValue = readAccountField(accountInfo, ['login', 'accountLogin', 'account_login']);
    const actualServerValue = readAccountField(accountInfo, ['server', 'accountServer', 'account_server']);
    const actualLogin = actualLoginValue != null ? String(actualLoginValue).trim() : '';
    const actualServer = actualServerValue ? String(actualServerValue).trim().toLowerCase() : '';
    const loginMatches = !expectedLogin || actualLogin === expectedLogin;
    const serverMatches = !expectedServer || actualServer === expectedServer;

    return {
      matches: loginMatches && serverMatches,
      loginMatches,
      serverMatches,
      expected: {
        login: expectedLogin || null,
        server: config.server || null,
      },
      actual: {
        login: actualLoginValue ?? null,
        server: actualServerValue || null,
      },
    };
  }

  ensureAccountMatchesConfig(accountInfo = {}, config = this.getConnectionConfig()) {
    const match = this.getAccountConfigMatch(accountInfo, config);
    if (!match.matches) {
      throw new Error(
        `MT5 ${this.scope} connected account does not match configuration. `
        + `Expected ${match.expected.login || '--'}@${match.expected.server || '--'}, `
        + `got ${match.actual.login || '--'}@${match.actual.server || '--'}. `
        + 'Check MT5_LIVE_* / MT5_PAPER_* and use separate MT5 terminal paths when running live and paper together.'
      );
    }
    return match;
  }

  normalizeAccountMode(accountInfo = {}) {
    return normalizeAccountMode(accountInfo);
  }

  buildPublicAccountIdentity(accountInfo = {}) {
    const mode = this.normalizeAccountMode(accountInfo);
    return {
      login: readAccountField(accountInfo, ['login', 'accountLogin', 'account_login']),
      server: readAccountField(accountInfo, ['server', 'accountServer', 'account_server']),
      tradeModeName: mode.tradeModeName,
      isReal: mode.isReal,
      isDemo: mode.isDemo,
      balance: readAccountField(accountInfo, ['balance']),
      equity: readAccountField(accountInfo, ['equity']),
      currency: readAccountField(accountInfo, ['currency']),
    };
  }

  validateRuntimeAccountIdentity(accountInfo = {}, config = this.getConnectionConfig(), options = {}) {
    const {
      throwOnError = true,
      log = true,
    } = options;
    const strict = this._isStrictRuntimeIsolationEnabled();
    const match = this.getAccountConfigMatch(accountInfo, config);
    const account = this.buildPublicAccountIdentity(accountInfo);
    const mode = this.normalizeAccountMode(accountInfo);
    const warnings = [];
    const errors = [];

    if (!match.matches) {
      const mismatchParts = [];
      if (!match.loginMatches) mismatchParts.push('login');
      if (!match.serverMatches) mismatchParts.push('server');
      const message = `MT5 ${this.scope} connected account mismatch (${mismatchParts.join(', ')}): `
        + `expected ${match.expected.login || '--'}@${match.expected.server || '--'}, `
        + `got ${match.actual.login || '--'}@${match.actual.server || '--'}.`;
      if (strict) errors.push(message);
      else warnings.push(`${message} MT5_STRICT_RUNTIME_ISOLATION=false, continuing with identity mismatch risk.`);
    }

    if (this.scope === 'paper') {
      if (mode.isReal) {
        errors.push(
          `Paper MT5 runtime must not use a REAL account. Current account mode: ${mode.tradeModeName}. `
          + 'Configure MT5_PAPER_* with a DEMO or CONTEST account.'
        );
      } else if (!mode.isDemo && !mode.isContest) {
        errors.push(
          `Paper MT5 runtime requires a DEMO or CONTEST account. Current account mode: ${mode.tradeModeName}.`
        );
      }
    } else if (this.scope === 'live' && !mode.isReal) {
      const message = `Live MT5 runtime expects a REAL account. Current account mode: ${mode.tradeModeName}.`;
      if (strict) errors.push(message);
      else warnings.push(
        `${message} MT5_STRICT_RUNTIME_ISOLATION=false, continuing; live trading still requires a REAL account before orders run.`
      );
    }

    const validation = {
      ok: errors.length === 0,
      warnings,
      errors,
      strict,
    };

    if (log && errors.length > 0) {
      console.error(`${this._logPrefix()} Account identity validation failed: ${errors.join(' ')}`);
    }
    if (log && warnings.length > 0) {
      console.warn(`${this._logPrefix()} Account identity validation warning: ${warnings.join(' ')}`);
    }

    if (throwOnError && errors.length > 0) {
      const error = new Error(`MT5 ${this.scope} account identity validation failed. ${errors.join(' ')}`);
      error.code = 'MT5_ACCOUNT_IDENTITY_VALIDATION_FAILED';
      error.details = {
        scope: this.scope,
        strict,
        account,
        validation,
        expected: match.expected,
        actual: match.actual,
        config: {
          login: config.login ? String(config.login) : null,
          server: config.server || null,
          path: config.path || null,
          env: config.env,
        },
      };
      throw error;
    }

    return validation;
  }

  buildRuntimeIdentityStatus(accountInfo = null, validationOverride = null) {
    const config = this.getConnectionConfig();
    const account = accountInfo ? this.buildPublicAccountIdentity(accountInfo) : null;
    const validation = validationOverride || (
      accountInfo
        ? this.validateRuntimeAccountIdentity(accountInfo, config, { throwOnError: false, log: false })
        : {
            ok: false,
            warnings: [],
            errors: this.isConnected()
              ? [`MT5 ${this.scope} runtime is connected but account info is unavailable.`]
              : [],
            strict: this._isStrictRuntimeIsolationEnabled(),
          }
    );

    return {
      scope: this.scope,
      connected: this.isConnected(),
      mt5Path: config.path || null,
      account,
      validation,
    };
  }

  getConnectionDiagnostics(config = this.getConnectionConfig(), extra = {}) {
    const peerConfig = this.peerService ? this.peerService.getPublicConnectionConfig() : null;
    const recommendedPathEnv = `${this.envPrefix}_PATH`;
    const pathEnvName = config.path ? config.env.path : recommendedPathEnv;
    const likelyReasons = [];

    if (!config.path) {
      likelyReasons.push(
        `${pathEnvName} is not configured, so MetaTrader5 may attach to the already-open/default terminal instead of the ${this.scope} terminal.`
      );
    } else {
      likelyReasons.push(
        `${pathEnvName} is configured, but the terminal may be missing, blocked by Windows/UAC, updating, or waiting on a login prompt.`
      );
    }

    if (this.peerService?.connected) {
      likelyReasons.push(
        `${this.peerService.scope} MT5 runtime is already connected. Live and paper should use separate MT5 terminal paths.`
      );
    }

    likelyReasons.push(
      `Broker credentials/server may be rejected for ${config.login || '--'}@${config.server || '--'}, or this machine/VPS cannot open the MT5 terminal.`
    );

    return {
      scope: this.scope,
      expectedAccount: {
        login: config.login ? String(config.login) : null,
        server: config.server || null,
      },
      config: {
        login: config.login ? String(config.login) : null,
        server: config.server || null,
        pathConfigured: Boolean(config.path),
        path: config.path || null,
        usesLegacy: config.usesLegacy,
        env: {
          ...config.env,
          path: pathEnvName,
        },
      },
      peer: peerConfig ? {
        scope: peerConfig.scope,
        connected: Boolean(this.peerService?.connected),
        login: peerConfig.login,
        server: peerConfig.server,
        pathConfigured: peerConfig.pathConfigured,
        usesLegacy: peerConfig.usesLegacy,
      } : null,
      likelyReasons,
      ...extra,
    };
  }

  _checkTerminalIsolation(config) {
    if (!this.peerService || !this._isPeerRuntimeActive()) {
      return;
    }

    const peerConfig = this.peerService.getConnectionConfig();
    const currentPath = config.pathScoped ? normalizeTerminalPath(config.path) : null;
    const peerPath = peerConfig.pathScoped ? normalizeTerminalPath(peerConfig.path) : null;
    const strict = this._isStrictRuntimeIsolationEnabled();
    const reasons = [];
    const currentPathEnv = `${this.envPrefix}_PATH`;
    const peerPathEnv = `${this.peerService.envPrefix}_PATH`;

    if (!currentPath) {
      reasons.push(`${currentPathEnv} is required when live and paper MT5 runtimes run together`);
      if (config.pathUsesLegacy) {
        reasons.push(`${this.scope} is currently falling back to ${config.env.path}; set ${currentPathEnv} explicitly`);
      }
    }

    if (!peerPath) {
      reasons.push(`${peerPathEnv} is required when live and paper MT5 runtimes run together`);
      if (peerConfig.pathUsesLegacy) {
        reasons.push(`${this.peerService.scope} is currently falling back to ${peerConfig.env.path}; set ${peerPathEnv} explicitly`);
      }
    }

    if (currentPath && peerPath && currentPath === peerPath) {
      reasons.push(
        `${currentPathEnv} and ${peerPathEnv} resolve to the same terminal path (${currentPath})`
      );
    }

    if (reasons.length === 0) {
      return;
    }

    const message = [
      `MT5 runtime path isolation failed while starting ${this.scope}; ${this.peerService.scope} runtime is already active.`,
      ...reasons,
      'Use two separate MT5 installations and point MT5_LIVE_PATH / MT5_PAPER_PATH at different terminal64.exe files.',
    ].join(' ');

    const details = {
      scope: this.scope,
      peerScope: this.peerService.scope,
      strict,
      reasons,
      current: {
        scope: this.scope,
        expectedPathEnv: currentPathEnv,
        configuredPathEnv: config.env.path,
        path: config.path || null,
        normalizedPath: currentPath,
        pathScoped: config.pathScoped === true,
        pathUsesLegacy: config.pathUsesLegacy === true,
      },
      peer: {
        scope: this.peerService.scope,
        expectedPathEnv: peerPathEnv,
        configuredPathEnv: peerConfig.env.path,
        path: peerConfig.path || null,
        normalizedPath: peerPath,
        connected: Boolean(this.peerService.connected),
        connecting: Boolean(this.peerService.connecting),
        pathScoped: peerConfig.pathScoped === true,
        pathUsesLegacy: peerConfig.pathUsesLegacy === true,
      },
    };

    if (strict) {
      console.error(`${this._logPrefix()} ${message} MT5_STRICT_RUNTIME_ISOLATION=true.`);
      const error = new Error(`${message} Set MT5_STRICT_RUNTIME_ISOLATION=false only if you accept the account-mixing risk.`);
      error.code = 'MT5_RUNTIME_ISOLATION_FAILED';
      error.details = details;
      throw error;
    }

    console.warn(
      `${this._logPrefix()} Runtime path isolation warning: ${message} `
      + 'MT5_STRICT_RUNTIME_ISOLATION=false, continuing with account-mixing risk.'
    );
  }

  _isPeerRuntimeActive() {
    return Boolean(this.peerService && (this.peerService.connected || this.peerService.connecting));
  }

  _isStrictRuntimeIsolationEnabled() {
    const envFileValues = this._readEnvFileValues();
    return isStrictRuntimeIsolationEnabled(
      this._readRawEnv('MT5_STRICT_RUNTIME_ISOLATION', envFileValues)
    );
  }

  _startBridge() {
    return new Promise((resolve, reject) => {
      const bridgePath = path.resolve(process.cwd(), 'mt5_bridge.py');
      const pythonCmd = process.env.PYTHON_PATH || 'python';

      this.process = spawn(pythonCmd, [bridgePath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this._rl = readline.createInterface({ input: this.process.stdout });

      // Handle responses from Python bridge
      this._rl.on('line', (line) => {
        try {
          const response = JSON.parse(line);

          // Handle ready signal
          if (response.id === 'ready') {
            this.ready = true;
            resolve();
            return;
          }

          // Handle command responses
          const pending = this._pendingRequests.get(response.id);
          if (pending) {
            this._pendingRequests.delete(response.id);
            if (response.success) {
              pending.resolve(response.result);
            } else {
              pending.reject(this._createBridgeError(pending.method || 'unknown', response));
            }
          }
        } catch (e) {
        console.error(`${this._logPrefix()} Bridge failed to parse response:`, line);
        }
      });

      // Log stderr from Python bridge
      this.process.stderr.on('data', (data) => {
        console.error(`${this._logPrefix()} Bridge`, data.toString().trim());
      });

      this.process.on('error', (err) => {
        console.error(`${this._logPrefix()} Bridge process error:`, err.message);
        this.connected = false;
        this.ready = false;
        this.connecting = false;
        if (!this.ready) {
          reject(new Error(`Failed to start MT5 ${this.scope} bridge: ${err.message}`));
        }
      });

      this.process.on('exit', (code) => {
        console.log(`${this._logPrefix()} Bridge process exited with code ${code}`);
        this.connected = false;
        this.ready = false;
        this.connecting = false;

        // Reject all pending requests
        for (const [id, pending] of this._pendingRequests) {
          pending.reject(new Error('MT5 bridge process exited'));
        }
        this._pendingRequests.clear();
      });

      // Timeout for bridge startup
      setTimeout(() => {
        if (!this.ready) {
          reject(new Error(`MT5 ${this.scope} bridge startup timeout. Ensure Python and MetaTrader5 package are installed.`));
        }
      }, 15000);
    });
  }

  /**
   * Send a command to the Python bridge
   */
  _sendCommand(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.ready) {
        reject(new Error('MT5 bridge not started'));
        return;
      }

      const id = String(++this._requestId);
      const command = JSON.stringify({ id, method, params }) + '\n';

      this._pendingRequests.set(id, { method, resolve, reject });

      // Timeout for individual commands
      const timeout = setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          this._pendingRequests.delete(id);
          const error = new Error(`MT5 ${this.scope} command timed out: ${method}`);
          error.code = 'MT5_COMMAND_TIMEOUT';
          error.method = method;
          error.timeoutMs = 30000;
          error.details = {
            scope: this.scope,
            method,
            timeoutMs: error.timeoutMs,
          };
          reject(error);
        }
      }, 30000);

      // Wrap resolve/reject to clear timeout
      const origResolve = this._pendingRequests.get(id).resolve;
      const origReject = this._pendingRequests.get(id).reject;
      this._pendingRequests.set(id, {
        method,
        resolve: (val) => { clearTimeout(timeout); origResolve(val); },
        reject: (err) => { clearTimeout(timeout); origReject(err); },
      });

      this.process.stdin.write(command);
    });
  }

  _createBridgeError(method, response = {}) {
    const error = new Error(response.error || `MT5 ${method} failed`);
    error.method = method;
    if (response.code != null) error.code = response.code;
    if (response.codeName) error.codeName = response.codeName;
    if (response.details) error.details = response.details;
    return error;
  }

  async connect() {
    const config = this.getConnectionConfig();
    const { login, password, server } = config;

    if (!login) {
      throw new Error(`${config.env.login} not configured in .env`);
    }
    if (!password) {
      throw new Error(`${config.env.password} not configured in .env`);
    }
    if (!server) {
      throw new Error(`${config.env.server} not configured in .env`);
    }
    this.connecting = true;
    try {
      this._checkTerminalIsolation(config);

    // Start the Python bridge if not running
    if (!this.ready) {
      console.log(`${this._logPrefix()} Starting Python bridge...`);
      await this._startBridge();
      console.log(`${this._logPrefix()} Python bridge ready`);
    }

    // Connect to MT5 with broker credentials
    console.log(`${this._logPrefix()} Connecting to ${server} with login ${login}...`);
    try {
      await this._sendCommand('connect', {
        login,
        password,
        server,
        path: config.path || null,
      });
    } catch (err) {
      const diagnostics = this.getConnectionDiagnostics(config, {
        method: 'connect',
        timeoutMs: err.timeoutMs || null,
        originalMessage: err.message,
      });
      if (err.code === 'MT5_COMMAND_TIMEOUT' || /timeout/i.test(err.message || '')) {
        const timeoutText = err.timeoutMs ? ` after ${Math.round(err.timeoutMs / 1000)}s` : '';
        const error = new Error(
          `MT5 ${this.scope} connect timed out${timeoutText} while connecting `
          + `${config.login || '--'}@${config.server || '--'}. `
          + diagnostics.likelyReasons[0]
        );
        error.code = 'MT5_CONNECT_TIMEOUT';
        error.method = 'connect';
        error.details = diagnostics;
        throw error;
      }

      err.details = {
        ...(err.details || {}),
        diagnostics,
      };
      throw err;
    }

    this.connected = true;
    try {
      const accountInfo = await this.getAccountInfo();
      this.validateRuntimeAccountIdentity(accountInfo, config);
    } catch (err) {
      await this.disconnect();
      throw err;
    }
    console.log(`${this._logPrefix()} Connected successfully`);

    // Fire-and-forget alias discovery for symbols with aliases. Missing
    // symbols are logged but do NOT block startup — trading simply skips
    // them when orders are later attempted. Runs in the background so the
    // connect handshake returns immediately.
    this._runSymbolDiscovery();

    return true;
    } finally {
      this.connecting = false;
    }
  }

  _runSymbolDiscovery() {
    setImmediate(() => {
      this.symbolResolver.discoverAll(this).catch((err) => {
        console.warn(`${this._logPrefix()} Symbol alias discovery failed:`, err.message);
      });
    });
  }

  async disconnect() {
    if (this.ready) {
      try {
        await this._sendCommand('disconnect');
      } catch (e) {
        // Ignore disconnect errors
      }
    }

    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    if (this._rl) {
      this._rl.close();
      this._rl = null;
    }

    this.connected = false;
    this.ready = false;
    this.connecting = false;
    console.log(`${this._logPrefix()} Disconnected`);
  }

  isConnected() {
    return this.connected;
  }

  async getAccountInfo() {
    this._ensureConnected();
    return await this._sendCommand('getAccountInfo');
  }

  getAccountModeName(accountInfo = {}) {
    return this.normalizeAccountMode(accountInfo).tradeModeName;
  }

  isRealAccount(accountInfo = {}) {
    return this.normalizeAccountMode(accountInfo).isReal;
  }

  isDemoLikeAccount(accountInfo = {}) {
    const mode = this.normalizeAccountMode(accountInfo);
    return mode.isDemo || mode.isContest;
  }

  ensurePaperTradingAccount(accountInfo = {}) {
    const mode = this.getAccountModeName(accountInfo);
    if (!this.isDemoLikeAccount(accountInfo)) {
      throw new Error(`Paper trading requires a DEMO or CONTEST MT5 account. Current account mode: ${mode}`);
    }
    if (accountInfo.tradeAllowed === false) {
      throw new Error('The connected MT5 account does not allow trading.');
    }
  }

  ensureLiveAccountReady(accountInfo = {}) {
    const mode = this.getAccountModeName(accountInfo);
    if (!this.isRealAccount(accountInfo)) {
      throw new Error(`Live trading requires a REAL MT5 account. Current account mode: ${mode}. Use paper trading for demo accounts.`);
    }

    if (accountInfo.tradeAllowed === false) {
      throw new Error('The connected MT5 account does not allow trading.');
    }
  }

  ensureLiveTradingAllowed(accountInfo = {}) {
    if (String(process.env.ALLOW_LIVE_TRADING || '').toLowerCase() !== 'true') {
      throw new Error('Live trading is locked. Set ALLOW_LIVE_TRADING=true only after verifying the real account.');
    }

    this.ensureLiveAccountReady(accountInfo);
  }

  async getPositions() {
    this._ensureConnected();
    return await this._sendCommand('getPositions');
  }

  async getOrders() {
    this._ensureConnected();
    return await this._sendCommand('getOrders');
  }

  /**
   * Translate a canonical symbol (BTCUSD) to the broker-side name
   * (BTCUSDm, etc.) using the cached symbol resolver. For symbols
   * without a known alias this is a no-op — the canonical name is
   * returned unchanged. Keeps database records stable regardless of
   * which broker the session connects to.
   */
  _resolveSymbol(symbol) {
    return this.symbolResolver.resolveForBroker(symbol);
  }

  async preflightOrder(symbol, type, volume, stopLoss, takeProfit, comment = '') {
    this._ensureConnected();
    const broker = this._resolveSymbol(symbol);
    return await this._sendCommand('preflightOrder', {
      symbol: broker,
      type,
      volume,
      sl: stopLoss,
      tp: takeProfit,
      comment: comment || `QM-${type}-${symbol}`,
    });
  }

  /**
   * Place a market order
   * @param {string} symbol - Trading symbol
   * @param {string} type - 'BUY' or 'SELL'
   * @param {number} volume - Lot size
   * @param {number} stopLoss - Stop loss price
   * @param {number} takeProfit - Take profit price
   * @param {string} comment - Order comment
   */
  async placeOrder(symbol, type, volume, stopLoss, takeProfit, comment = '') {
    this._ensureConnected();
    const broker = this._resolveSymbol(symbol);

    const result = await this._sendCommand('placeOrder', {
      symbol: broker,
      type,
      volume,
      sl: stopLoss,
      tp: takeProfit,
      comment: comment || `QM-${type}-${symbol}`,
    });

    console.log(`${this._logPrefix()} Order placed: ${type} ${volume} ${symbol}${broker !== symbol ? ` (broker: ${broker})` : ''} | SL: ${stopLoss} TP: ${takeProfit}`);
    return result;
  }

  /**
   * Close a position
   * @param {string} positionId - MT5 position ID
   */
  async closePosition(positionId) {
    this._ensureConnected();
    const result = await this._sendCommand('closePosition', { positionId });
    console.log(`${this._logPrefix()} Position closed: ${positionId}`);
    return result;
  }

  /**
   * Modify position stop loss / take profit
   * @param {string} positionId - MT5 position ID
   * @param {number} stopLoss - New stop loss
   * @param {number} takeProfit - New take profit
   */
  async modifyPosition(positionId, stopLoss, takeProfit) {
    this._ensureConnected();
    return await this._sendCommand('modifyPosition', {
      positionId,
      sl: stopLoss,
      tp: takeProfit,
    });
  }

  /**
   * Partially close a position by volume.
   * @param {string} positionId - MT5 position ID
   * @param {number} volume - Volume (lots) to close. Must be less than the
   *                         position's current volume and >= minLot.
   */
  async partialClosePosition(positionId, volume) {
    this._ensureConnected();
    const result = await this._sendCommand('partialClosePosition', {
      positionId,
      volume,
    });
    console.log(`${this._logPrefix()} Partial close: ${positionId} volume=${volume}`);
    return result;
  }

  /**
   * Get historical candles
   * @param {string} symbol - Trading symbol
   * @param {string} timeframe - e.g. '1h', '4h', '1d'
   * @param {Date} startTime - Start date
   * @param {number} limit - Number of candles
   */
  async getCandles(symbol, timeframe, startTime, limit = 500, endTime = null) {
    this._ensureConnected();
    return await this._sendCommand('getCandles', {
      symbol: this._resolveSymbol(symbol),
      timeframe,
      startTime: startTime instanceof Date ? startTime.toISOString() : startTime,
      endTime: endTime instanceof Date ? endTime.toISOString() : endTime,
      limit,
    });
  }

  /**
   * Get current price for a symbol
   * @param {string} symbol - Trading symbol
   */
  async getPrice(symbol) {
    this._ensureConnected();
    return await this._sendCommand('getPrice', { symbol: this._resolveSymbol(symbol) });
  }

  /**
   * Get deal history (closed trades)
   * @param {Date} startTime - Start date
   * @param {Date} endTime - End date
   */
  /**
   * Look up symbol info by exact broker name. Returns null if the broker
   * does not recognise the symbol. Does not throw on "not found" — only
   * throws on bridge/connection errors.
   */
  async getSymbolInfo(symbol) {
    this._ensureConnected();
    return await this._sendCommand('getSymbolInfo', { symbol });
  }

  async getResolvedSymbolInfo(symbol) {
    this._ensureConnected();
    return await this._sendCommand('getSymbolInfo', { symbol: this._resolveSymbol(symbol) });
  }

  async calculateOrderProfit(symbol, type, volume, openPrice, closePrice) {
    this._ensureConnected();
    return await this._sendCommand('calculateOrderProfit', {
      symbol: this._resolveSymbol(symbol),
      type,
      volume,
      openPrice,
      closePrice,
    });
  }

  /**
   * List broker symbols, optionally filtered by MT5 group pattern
   * (e.g. "*BTC*,*ETH*"). Used by the alias resolver discovery fallback.
   */
  async listSymbols({ group = null, limit = 5000 } = {}) {
    this._ensureConnected();
    return await this._sendCommand('listSymbols', { group, limit });
  }

  async getDeals(startTime, endTime) {
    this._ensureConnected();
    return await this._sendCommand('getDeals', {
      startTime: startTime instanceof Date ? startTime.toISOString() : startTime,
      endTime: endTime instanceof Date ? endTime.toISOString() : endTime,
    });
  }

  async getDealsByOrder(orderId, startTime = null, endTime = null) {
    this._ensureConnected();
    return await this._sendCommand('getDeals', {
      ticket: orderId,
      startTime: startTime instanceof Date ? startTime.toISOString() : startTime,
      endTime: endTime instanceof Date ? endTime.toISOString() : endTime,
    });
  }

  async getDealsByPosition(positionId, startTime = null, endTime = null) {
    this._ensureConnected();
    return await this._sendCommand('getDeals', {
      positionId,
      startTime: startTime instanceof Date ? startTime.toISOString() : startTime,
      endTime: endTime instanceof Date ? endTime.toISOString() : endTime,
    });
  }

  sortDealsByTime(deals = []) {
    return [...deals].sort((a, b) => {
      const timeDiff = new Date(a.time).getTime() - new Date(b.time).getTime();
      if (timeDiff !== 0) return timeDiff;
      return (a.timeMsc || 0) - (b.timeMsc || 0);
    });
  }

  _isEntryDeal(deal = {}) {
    const entryName = String(deal.entryName || '').toUpperCase();
    return entryName === 'IN' || entryName === 'INOUT';
  }

  _isExitDeal(deal = {}) {
    const entryName = String(deal.entryName || '').toUpperCase();
    return entryName === 'OUT' || entryName === 'OUT_BY' || entryName === 'INOUT';
  }

  _sumWeightedPrice(deals = []) {
    const totalVolume = deals.reduce((sum, deal) => sum + (Number(deal.volume) || 0), 0);
    if (totalVolume <= 0) return null;

    const weightedPrice = deals.reduce((sum, deal) => (
      sum + ((Number(deal.price) || 0) * (Number(deal.volume) || 0))
    ), 0);

    return weightedPrice / totalVolume;
  }

  _getNetDealProfit(deal = {}) {
    return (Number(deal.profit) || 0)
      + (Number(deal.swap) || 0)
      + (Number(deal.commission) || 0)
      + (Number(deal.fee) || 0);
  }

  summarizePositionDeals(deals = []) {
    const orderedDeals = this.sortDealsByTime(deals);
    const entryDeals = orderedDeals.filter((deal) => this._isEntryDeal(deal));
    const exitDeals = orderedDeals.filter((deal) => this._isExitDeal(deal));
    const lastExitDeal = exitDeals.length > 0 ? exitDeals[exitDeals.length - 1] : null;

    return {
      deals: orderedDeals,
      entryDeals,
      exitDeals,
      entryPrice: this._sumWeightedPrice(entryDeals),
      exitPrice: this._sumWeightedPrice(exitDeals),
      entryTime: entryDeals[0]?.time || orderedDeals[0]?.time || null,
      exitTime: lastExitDeal?.time || null,
      positionId: lastExitDeal?.positionId || entryDeals[0]?.positionId || orderedDeals[0]?.positionId || null,
      entryVolume: entryDeals.reduce((sum, deal) => sum + (Number(deal.volume) || 0), 0),
      exitVolume: exitDeals.reduce((sum, deal) => sum + (Number(deal.volume) || 0), 0),
      realizedProfit: orderedDeals.reduce((sum, deal) => sum + this._getNetDealProfit(deal), 0),
      commission: orderedDeals.reduce((sum, deal) => sum + (Number(deal.commission) || 0), 0),
      swap: orderedDeals.reduce((sum, deal) => sum + (Number(deal.swap) || 0), 0),
      fee: orderedDeals.reduce((sum, deal) => sum + (Number(deal.fee) || 0), 0),
      exitReason: lastExitDeal?.reasonName || null,
      lastExitDeal,
    };
  }

  async getPositionDealSummary(positionId, startTime = null, endTime = null) {
    const deals = await this.getDealsByPosition(positionId, startTime, endTime);
    return this.summarizePositionDeals(deals);
  }

  isOrderAllowed(preflight = {}) {
    // `allowed` is computed on the Python bridge side from MT5 order_check retcodes.
    return preflight.allowed === true;
  }

  getPreflightMessage(preflight = {}) {
    if (preflight.allowed === false) {
      if (preflight.retcode === 0 && preflight.comment === 'Done') {
        return 'preflight inconsistent (retcode=0/Done but allowed=false)';
      }

      if (preflight.retcodeName === 'MARKET_CLOSED') {
        return 'Market closed';
      }

      if (preflight.comment && preflight.comment !== 'Done') {
        return preflight.comment;
      }

      if (preflight.retcodeName && preflight.retcodeName !== String(preflight.retcode ?? '')) {
        return preflight.retcodeName.replaceAll('_', ' ');
      }
    }

    return preflight.comment
      || preflight.symbolInfo?.tradeModeName
      || 'MT5 order preflight rejected';
  }

  _ensureConnected() {
    if (!this.connected) {
      throw new Error('MT5 not connected. Call connect() first.');
    }
  }
}

// Singleton instances. The default export remains the live service for
// backwards compatibility with existing dashboard/backtest code paths.
const liveMt5Service = new MT5Service({
  scope: 'live',
  envPrefix: 'MT5_LIVE',
  symbolResolver,
});
const paperMt5Service = new MT5Service({
  scope: 'paper',
  envPrefix: 'MT5_PAPER',
  symbolResolver: createSymbolResolver(),
});
liveMt5Service.peerService = paperMt5Service;
paperMt5Service.peerService = liveMt5Service;

function getScopedService(scope = 'live') {
  return String(scope).toLowerCase() === 'paper' ? paperMt5Service : liveMt5Service;
}

liveMt5Service.MT5Service = MT5Service;
liveMt5Service.live = liveMt5Service;
liveMt5Service.paper = paperMt5Service;
liveMt5Service.getScopedService = getScopedService;

module.exports = liveMt5Service;
