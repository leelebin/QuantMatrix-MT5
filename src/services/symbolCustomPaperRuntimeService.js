const symbolCustomEngine = require('./symbolCustomEngine');

const SYMBOL_CUSTOM_PAPER_ENABLED_ENV = 'SYMBOL_CUSTOM_PAPER_ENABLED';
const DEFAULT_SCAN_INTERVAL_MS = 60 * 1000;
const MAX_LAST_SIGNALS = 20;

let running = false;
let timer = null;
let runtimeGetCandlesFn = null;
let runtimeActiveProfile = null;
let lastScanAt = null;
let lastError = null;
let activePaperCustoms = 0;
let lastSignals = [];

function isEnabled() {
  return process.env[SYMBOL_CUSTOM_PAPER_ENABLED_ENV] === 'true';
}

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isPaperTradeSignal(signal = {}) {
  return signal.signal === 'BUY' || signal.signal === 'SELL';
}

function rememberSignal(signal) {
  lastSignals = [cloneValue(signal), ...lastSignals].slice(0, MAX_LAST_SIGNALS);
}

function buildPaperSignalPayload(signal = {}) {
  const metadata = {
    ...(cloneValue(signal.metadata || {})),
    source: 'symbolCustom',
    symbolCustomId: signal.symbolCustomId || null,
    symbolCustomName: signal.symbolCustomName,
    logicName: signal.logicName,
    setupType: 'symbol_custom',
    strategy: signal.symbolCustomName,
    strategyType: 'SymbolCustom',
  };

  return {
    ...cloneValue(signal),
    scope: 'paper',
    source: 'symbolCustom',
    setupType: 'symbol_custom',
    strategy: signal.symbolCustomName,
    strategyType: 'SymbolCustom',
    symbolCustomId: signal.symbolCustomId || null,
    symbolCustomName: signal.symbolCustomName,
    logicName: signal.logicName,
    metadata,
  };
}

function resolvePaperSignalHandler(service, options = {}) {
  if (typeof options.paperSignalHandler === 'function') {
    return {
      handler: options.paperSignalHandler,
      context: options.paperSignalHandlerContext || null,
    };
  }

  const candidateService = options.paperTradingService || service;
  for (const methodName of ['submitSignal', 'executeSignal', 'handleSignal', '_executePaperTrade']) {
    if (candidateService && typeof candidateService[methodName] === 'function') {
      return {
        handler: candidateService[methodName],
        context: candidateService,
      };
    }
  }

  return { handler: null, context: null };
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
  const { handler, context } = resolvePaperSignalHandler(paperTradingService, options);
  if (!handler) {
    const error = new Error('SYMBOL_CUSTOM_PAPER_SIGNAL_HANDLER_NOT_AVAILABLE');
    error.statusCode = 500;
    throw error;
  }

  await handler.call(context, payload);

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

async function runPaperScan({ getCandlesFn, activeProfile } = {}) {
  try {
    const signals = await symbolCustomEngine.analyzeAllPaperSymbolCustoms(
      getCandlesFn || runtimeGetCandlesFn,
      {
        scope: 'paper',
        activeProfile: activeProfile || runtimeActiveProfile,
      }
    );

    activePaperCustoms = signals.length;
    lastScanAt = new Date();
    lastError = null;

    const results = [];
    for (const signal of signals) {
      results.push(await handleSymbolCustomPaperSignal(signal));
    }

    return {
      success: true,
      scanned: signals.length,
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
    lastSignals: cloneValue(lastSignals),
  };
}

module.exports = {
  SYMBOL_CUSTOM_PAPER_ENABLED_ENV,
  isEnabled,
  runPaperScan,
  handleSymbolCustomPaperSignal,
  start,
  stop,
  isRunning,
  getStatus,
};
