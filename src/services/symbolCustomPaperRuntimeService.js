const symbolCustomEngine = require('./symbolCustomEngine');
const { PLACEHOLDER_SYMBOL_CUSTOM } = require('../symbolCustom/logics/PlaceholderSymbolCustom');
const {
  USDJPY_JPY_MACRO_REVERSAL_V1,
} = require('../symbolCustom/logics/UsdjpyJpyMacroReversalV1');

const SYMBOL_CUSTOM_PAPER_ENABLED_ENV = 'SYMBOL_CUSTOM_PAPER_ENABLED';
const SYMBOL_CUSTOM_PAPER_RUNTIME_DISABLED = 'SYMBOL_CUSTOM_PAPER_RUNTIME_DISABLED';
const SYMBOL_CUSTOM_PAPER_SIGNAL_HANDLER_NOT_AVAILABLE = 'SYMBOL_CUSTOM_PAPER_SIGNAL_HANDLER_NOT_AVAILABLE';
const SYMBOL_CUSTOM_CANDLE_PROVIDER_REQUIRED = 'SYMBOL_CUSTOM_CANDLE_PROVIDER_REQUIRED';
const SYMBOL_CUSTOM_PAPER_LIVE_ENABLED_BLOCKED = 'SYMBOL_CUSTOM_PAPER_LIVE_ENABLED_BLOCKED';
const SYMBOL_CUSTOM_PAPER_LOGIC_NOT_ALLOWED = 'SYMBOL_CUSTOM_PAPER_LOGIC_NOT_ALLOWED';
const DEFAULT_SCAN_INTERVAL_MS = 60 * 1000;
const MAX_LAST_SIGNALS = 20;

let running = false;
let timer = null;
let runtimeGetCandlesFn = null;
let runtimeActiveProfile = null;
let lastScanAt = null;
let lastError = null;
let activePaperCustoms = 0;
let lastSignalCount = 0;
let lastSignals = [];

function isEnabled() {
  return process.env[SYMBOL_CUSTOM_PAPER_ENABLED_ENV] === 'true';
}

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function buildHttpError(message, statusCode, details = []) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function isPaperTradeSignal(signal = {}) {
  return signal.signal === 'BUY' || signal.signal === 'SELL' || signal.signal === 'CLOSE';
}

function getLogicName(symbolCustom = {}) {
  return String(
    symbolCustom.logicName
      || symbolCustom.registryLogicName
      || symbolCustom.symbolCustomName
      || ''
  ).trim();
}

function isPlaceholderSymbolCustom(symbolCustom = {}) {
  return getLogicName(symbolCustom) === PLACEHOLDER_SYMBOL_CUSTOM;
}

function buildIgnoredPaperSignal(symbolCustom = {}, reasonCode, reason) {
  const logicName = getLogicName(symbolCustom);
  return symbolCustomEngine.buildSymbolCustomSignal(
    symbolCustom,
    {
      signal: 'NONE',
      status: 'IGNORED',
      reason,
      reasonCode,
    },
    {
      scope: 'paper',
      logicName,
      timestamp: new Date(),
    }
  );
}

function getPaperRuntimeGate(symbolCustom = {}) {
  const logicName = getLogicName(symbolCustom);
  if (symbolCustom.paperEnabled !== true) {
    return {
      allowed: false,
      reasonCode: 'SYMBOL_CUSTOM_PAPER_NOT_ENABLED',
      reason: 'SymbolCustom paperEnabled is not true',
    };
  }

  if (symbolCustom.liveEnabled === true) {
    return {
      allowed: false,
      reasonCode: SYMBOL_CUSTOM_PAPER_LIVE_ENABLED_BLOCKED,
      reason: 'SymbolCustom paper runtime rejects records with liveEnabled=true',
    };
  }

  if (logicName !== USDJPY_JPY_MACRO_REVERSAL_V1) {
    return {
      allowed: false,
      reasonCode: SYMBOL_CUSTOM_PAPER_LOGIC_NOT_ALLOWED,
      reason: 'Only USDJPY_JPY_MACRO_REVERSAL_V1 is paper-trial allowed',
    };
  }

  return { allowed: true, reasonCode: null, reason: null };
}

function applyPaperRuntimeSafetyGate(symbolCustoms = []) {
  const allowed = [];
  const ignoredSignals = [];
  (Array.isArray(symbolCustoms) ? symbolCustoms : []).forEach((symbolCustom) => {
    const gate = getPaperRuntimeGate(symbolCustom);
    if (gate.allowed) {
      allowed.push(symbolCustom);
      return;
    }
    ignoredSignals.push(buildIgnoredPaperSignal(symbolCustom, gate.reasonCode, gate.reason));
  });

  return { allowed, ignoredSignals };
}

function rememberSignal(signal) {
  lastSignals = [cloneValue(signal), ...lastSignals].slice(0, MAX_LAST_SIGNALS);
}

function buildPaperSignalPayload(signal = {}) {
  const rawMetadata = cloneValue(signal.metadata || {});
  const setupType = signal.setupType || rawMetadata.setupType || rawMetadata.setup || 'symbol_custom';
  const candidatePreset = signal.candidatePreset || rawMetadata.candidatePreset || null;
  const parameterSnapshot = cloneValue(
    signal.parameterSnapshot
      || rawMetadata.parameterSnapshot
      || signal.parameters
      || {}
  );
  const metadata = {
    ...rawMetadata,
    source: 'symbolCustom',
    symbolCustomId: signal.symbolCustomId || null,
    symbolCustomName: signal.symbolCustomName,
    logicName: signal.logicName,
    setupType,
    strategy: signal.symbolCustomName,
    strategyType: 'SymbolCustom',
    candidatePreset,
    scope: 'paper',
    parameterSnapshot,
  };

  return {
    ...cloneValue(signal),
    scope: 'paper',
    source: 'symbolCustom',
    setupType,
    strategy: signal.symbolCustomName,
    strategyType: 'SymbolCustom',
    candidatePreset,
    parameterSnapshot,
    symbolCustomId: signal.symbolCustomId || null,
    symbolCustomName: signal.symbolCustomName,
    logicName: signal.logicName,
    metadata,
  };
}

function resolvePaperSignalHandler(service, options = {}) {
  const candidateService = options.paperTradingService || service;
  for (const methodName of ['submitSymbolCustomSignal', 'submitExternalPaperSignal']) {
    if (candidateService && typeof candidateService[methodName] === 'function') {
      return {
        handler: candidateService[methodName],
        context: candidateService,
        methodName,
      };
    }
  }

  return { handler: null, context: null, methodName: null };
}

function getDefaultPaperTradingService() {
  return require('./paperTradingService');
}

async function handleSymbolCustomPaperSignal(signal, options = {}) {
  const payload = buildPaperSignalPayload(signal);
  rememberSignal(payload);

  if (!isPaperTradeSignal(payload)) {
    console.log(
      `[SymbolCustom] Paper signal ignored source=symbolCustom scope=paper `
      + `symbolCustomName=${payload.symbolCustomName || 'UNKNOWN'} `
      + `logicName=${payload.logicName || 'UNKNOWN'} signal=${payload.signal || 'NONE'}`
    );
    return {
      success: true,
      action: 'ignored',
      signal: payload,
    };
  }

  const paperTradingService = options.paperTradingService || getDefaultPaperTradingService();
  const { handler, context, methodName } = resolvePaperSignalHandler(paperTradingService, options);
  if (!handler) {
    throw buildHttpError(SYMBOL_CUSTOM_PAPER_SIGNAL_HANDLER_NOT_AVAILABLE, 500);
  }

  if (methodName === 'submitExternalPaperSignal') {
    await handler.call(context, payload, { source: 'symbolCustom' });
  } else {
    await handler.call(context, payload);
  }

  console.log(
    `[SymbolCustom] Paper signal submitted source=symbolCustom scope=paper `
    + `symbolCustomName=${payload.symbolCustomName || 'UNKNOWN'} `
    + `logicName=${payload.logicName || 'UNKNOWN'} signal=${payload.signal}`
  );

  return {
    success: true,
    action: 'paper_submitted',
    signal: payload,
  };
}

function resetScanCounters() {
  activePaperCustoms = 0;
  lastSignalCount = 0;
}

function buildDisabledScanResult() {
  return {
    success: false,
    enabled: false,
    forced: false,
    scanned: 0,
    submitted: 0,
    ignored: 0,
    activePaperCustoms: 0,
    signalCount: 0,
    signals: [],
    results: [],
    reasonCode: SYMBOL_CUSTOM_PAPER_RUNTIME_DISABLED,
  };
}

function assertCandleProviderAvailable(symbolCustoms, getCandlesFn) {
  if (typeof getCandlesFn === 'function') {
    return;
  }

  const requiresCandles = symbolCustoms.filter((symbolCustom) => !isPlaceholderSymbolCustom(symbolCustom));
  if (requiresCandles.length === 0) {
    return;
  }

  throw buildHttpError(SYMBOL_CUSTOM_CANDLE_PROVIDER_REQUIRED, 400, requiresCandles.map((symbolCustom) => ({
    symbolCustomId: symbolCustom._id || null,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName: getLogicName(symbolCustom),
  })));
}

async function runPaperScan({ getCandlesFn, activeProfile, force = false } = {}) {
  const forced = force === true;
  const enabled = isEnabled();

  if (!enabled && !forced) {
    resetScanCounters();
    return buildDisabledScanResult();
  }

  try {
    const effectiveGetCandlesFn = getCandlesFn || runtimeGetCandlesFn;
    const activeSymbolCustoms = await symbolCustomEngine.listActivePaperSymbolCustoms();
    activePaperCustoms = activeSymbolCustoms.length;
    const gated = applyPaperRuntimeSafetyGate(activeSymbolCustoms);
    assertCandleProviderAvailable(gated.allowed, effectiveGetCandlesFn);

    const analyzedSignals = await symbolCustomEngine.analyzeAllPaperSymbolCustoms(
      effectiveGetCandlesFn,
      {
        scope: 'paper',
        activeProfile: activeProfile || runtimeActiveProfile,
        symbolCustoms: gated.allowed,
      }
    );
    const signals = [...gated.ignoredSignals, ...analyzedSignals];

    lastSignalCount = signals.length;
    lastScanAt = new Date();
    lastError = null;

    const results = [];
    for (const signal of signals) {
      results.push(await handleSymbolCustomPaperSignal(signal));
    }

    return {
      success: true,
      enabled,
      forced,
      scanned: activePaperCustoms,
      activePaperCustoms,
      signalCount: signals.length,
      submitted: results.filter((result) => result.action === 'paper_submitted').length,
      ignored: results.filter((result) => result.action === 'ignored').length,
      signals,
      results,
    };
  } catch (error) {
    lastError = error.message;
    throw error;
  }
}

function getScanIntervalMs(options = {}) {
  const requested = Number(options.intervalMs || process.env.SYMBOL_CUSTOM_PAPER_SCAN_INTERVAL_MS);
  return Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_SCAN_INTERVAL_MS;
}

function start(options = {}) {
  if (!isEnabled()) {
    return {
      success: false,
      enabled: false,
      running: false,
      message: 'SymbolCustom paper runtime disabled',
    };
  }

  if (running) {
    return {
      success: true,
      enabled: true,
      running: true,
      message: 'SymbolCustom paper runtime already running',
    };
  }

  runtimeGetCandlesFn = typeof options.getCandlesFn === 'function' ? options.getCandlesFn : null;
  runtimeActiveProfile = options.activeProfile || null;
  running = true;

  timer = setInterval(() => {
    runPaperScan({}).catch((error) => {
      lastError = error.message;
      console.error(`[SymbolCustom] Paper runtime scan failed: ${error.message}`);
    });
  }, getScanIntervalMs(options));

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    success: true,
    enabled: true,
    running: true,
    message: 'SymbolCustom paper runtime started',
  };
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  running = false;
  runtimeGetCandlesFn = null;
  runtimeActiveProfile = null;

  return {
    success: true,
    enabled: isEnabled(),
    running,
    message: 'SymbolCustom paper runtime stopped',
  };
}

function isRunning() {
  return running;
}

function getStatus() {
  return {
    enabled: isEnabled(),
    running,
    lastScanAt,
    lastError,
    activePaperCustoms,
    lastSignalCount,
    lastSignals: cloneValue(lastSignals),
  };
}

module.exports = {
  SYMBOL_CUSTOM_PAPER_ENABLED_ENV,
  SYMBOL_CUSTOM_PAPER_RUNTIME_DISABLED,
  SYMBOL_CUSTOM_PAPER_SIGNAL_HANDLER_NOT_AVAILABLE,
  SYMBOL_CUSTOM_CANDLE_PROVIDER_REQUIRED,
  SYMBOL_CUSTOM_PAPER_LIVE_ENABLED_BLOCKED,
  SYMBOL_CUSTOM_PAPER_LOGIC_NOT_ALLOWED,
  isEnabled,
  runPaperScan,
  handleSymbolCustomPaperSignal,
  start,
  stop,
  isRunning,
  getStatus,
};
