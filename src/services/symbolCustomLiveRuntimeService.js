const SymbolCustom = require('../models/SymbolCustom');
const Position = require('../models/Position');
const symbolCustomEngine = require('./symbolCustomEngine');
const {
  XAUUSD_EMA50_PULLBACK_TREND_V1,
} = require('../symbolCustom/logics/XauusdEma50PullbackTrendV1');

const SYMBOL_CUSTOM_LIVE_ENABLED_ENV = 'SYMBOL_CUSTOM_LIVE_ENABLED';
const SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED_ENV = 'SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED';
const SYMBOL_CUSTOM_LIVE_ALLOWED_LOGICS_ENV = 'SYMBOL_CUSTOM_LIVE_ALLOWED_LOGICS';
const SYMBOL_CUSTOM_LIVE_RUNTIME_DISABLED = 'SYMBOL_CUSTOM_LIVE_RUNTIME_DISABLED';
const SYMBOL_CUSTOM_LIVE_EXECUTION_DISABLED = 'SYMBOL_CUSTOM_LIVE_EXECUTION_DISABLED';
const SYMBOL_CUSTOM_LIVE_SIGNAL_HANDLER_NOT_AVAILABLE = 'SYMBOL_CUSTOM_LIVE_SIGNAL_HANDLER_NOT_AVAILABLE';
const SYMBOL_CUSTOM_LIVE_LOGIC_NOT_ALLOWED = 'SYMBOL_CUSTOM_LIVE_LOGIC_NOT_ALLOWED';
const SYMBOL_CUSTOM_LIVE_NOT_PRIMARY = 'SYMBOL_CUSTOM_LIVE_NOT_PRIMARY';
const SYMBOL_CUSTOM_CANDLE_PROVIDER_REQUIRED = 'SYMBOL_CUSTOM_CANDLE_PROVIDER_REQUIRED';
const SYMBOL_CUSTOM_LIVE_DUPLICATE_SIGNAL = 'SYMBOL_CUSTOM_LIVE_DUPLICATE_SIGNAL';
const SYMBOL_CUSTOM_LIVE_OPEN_POSITION_EXISTS = 'SYMBOL_CUSTOM_LIVE_OPEN_POSITION_EXISTS';
const DEFAULT_SCAN_INTERVAL_MS = 60 * 1000;
const MAX_LAST_SIGNALS = 20;
const MAX_SUBMITTED_SIGNAL_KEYS = 200;
const DEFAULT_LIVE_ALLOWED_LOGICS = Object.freeze([
  XAUUSD_EMA50_PULLBACK_TREND_V1,
]);
const LIVE_ALLOWED_LOGICS = DEFAULT_LIVE_ALLOWED_LOGICS;

let running = false;
let timer = null;
let runtimeGetCandlesFn = null;
let runtimeActiveProfile = null;
let lastScanAt = null;
let lastError = null;
let activeLiveCustoms = 0;
let lastSignalCount = 0;
let lastSignals = [];
let lastScanSummary = null;
let submittedSignalKeys = new Map();

function isEnabled() {
  return process.env[SYMBOL_CUSTOM_LIVE_ENABLED_ENV] === 'true';
}

function isExecutionEnabled() {
  return process.env[SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED_ENV] === 'true';
}

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function parseLiveAllowedLogics(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getLiveAllowedLogics() {
  const configured = parseLiveAllowedLogics(process.env[SYMBOL_CUSTOM_LIVE_ALLOWED_LOGICS_ENV]);
  return configured.length > 0 ? configured : [...DEFAULT_LIVE_ALLOWED_LOGICS];
}

function buildHttpError(message, statusCode, details = []) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function getLogicName(symbolCustom = {}) {
  return String(
    symbolCustom.logicName
      || symbolCustom.registryLogicName
      || symbolCustom.symbolCustomName
      || ''
  ).trim();
}

function isLiveTradeSignal(signal = {}) {
  return signal.signal === 'BUY' || signal.signal === 'SELL';
}

function parseTimeframeMs(timeframe) {
  const match = String(timeframe || '').trim().toLowerCase().match(/^(\d+)\s*([smhd])$/);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = match[2];
  if (unit === 's') return value * 1000;
  if (unit === 'm') return value * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'd') return value * 24 * 60 * 60 * 1000;
  return null;
}

function normalizeSignalTime(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function resolveSignalCandleBucket(signal = {}) {
  const explicitTime = normalizeSignalTime(
    signal.entryCandleTime
      || signal.setupCandleTime
      || signal.metadata?.entryCandleTime
      || signal.metadata?.setupCandleTime
  );
  if (explicitTime !== null) {
    return new Date(explicitTime).toISOString();
  }

  const timeframe = signal.entryTimeframe
    || signal.setupTimeframe
    || signal.parameterSnapshot?.entryTimeframe
    || signal.parameterSnapshot?.setupTimeframe
    || signal.metadata?.parameterSnapshot?.entryTimeframe
    || signal.metadata?.parameterSnapshot?.setupTimeframe;
  const timeframeMs = parseTimeframeMs(timeframe);
  const signalTime = normalizeSignalTime(signal.timestamp || signal.metadata?.timestamp || new Date());
  if (!timeframeMs || signalTime === null) {
    return signalTime === null ? 'unknown-time' : new Date(signalTime).toISOString();
  }

  return new Date(Math.floor(signalTime / timeframeMs) * timeframeMs).toISOString();
}

function buildLiveSignalDedupeKey(signal = {}) {
  return [
    signal.symbolCustomId || signal.symbolCustomName || signal.logicName || 'unknown-custom',
    signal.symbol || 'unknown-symbol',
    signal.logicName || 'unknown-logic',
    signal.signal || 'NONE',
    resolveSignalCandleBucket(signal),
  ].join('|');
}

function rememberSubmittedSignalKey(key) {
  if (!key) return;
  submittedSignalKeys.set(key, new Date().toISOString());
  while (submittedSignalKeys.size > MAX_SUBMITTED_SIGNAL_KEYS) {
    const oldestKey = submittedSignalKeys.keys().next().value;
    submittedSignalKeys.delete(oldestKey);
  }
}

function buildIgnoredLiveSignal(symbolCustom = {}, reasonCode, reason) {
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
      scope: 'live',
      logicName,
      timestamp: new Date(),
    }
  );
}

function getLiveRuntimeGate(symbolCustom = {}) {
  const logicName = getLogicName(symbolCustom);
  const readiness = symbolCustomEngine.evaluateSymbolCustomLiveReadiness(symbolCustom);
  if (!readiness.allowed) {
    return readiness;
  }

  if (!getLiveAllowedLogics().includes(logicName)) {
    return {
      allowed: false,
      reasonCode: SYMBOL_CUSTOM_LIVE_LOGIC_NOT_ALLOWED,
      reason: `SymbolCustom logic is not live-runtime allowed: ${logicName || 'UNKNOWN'}`,
    };
  }

  if (symbolCustom.isPrimaryLive !== true) {
    return {
      allowed: false,
      reasonCode: SYMBOL_CUSTOM_LIVE_NOT_PRIMARY,
      reason: 'SymbolCustom live runtime requires isPrimaryLive=true',
    };
  }

  return { allowed: true, reasonCode: null, reason: null };
}

function applyLiveRuntimeSafetyGate(symbolCustoms = []) {
  const allowed = [];
  const ignoredSignals = [];
  (Array.isArray(symbolCustoms) ? symbolCustoms : []).forEach((symbolCustom) => {
    const gate = getLiveRuntimeGate(symbolCustom);
    if (gate.allowed) {
      allowed.push(symbolCustom);
      return;
    }
    ignoredSignals.push(buildIgnoredLiveSignal(symbolCustom, gate.reasonCode, gate.reason));
  });

  return { allowed, ignoredSignals };
}

function rememberSignal(signal) {
  lastSignals = [cloneValue(signal), ...lastSignals].slice(0, MAX_LAST_SIGNALS);
}

function buildScanSignalSummary(signals = [], results = []) {
  return (Array.isArray(signals) ? signals : []).map((signal, index) => {
    const result = Array.isArray(results) ? results[index] : null;
    return {
      symbol: signal.symbol || null,
      logicName: signal.logicName || signal.symbolCustomName || null,
      symbolCustomName: signal.symbolCustomName || null,
      signal: signal.signal || null,
      status: signal.status || null,
      action: result?.action || null,
      reasonCode: result?.reasonCode || signal.reasonCode || null,
      openPositionId: result?.openPositionId || null,
      mt5PositionId: result?.mt5PositionId || null,
    };
  });
}

function buildLiveScanSummary(scan = {}) {
  return {
    at: new Date().toISOString(),
    enabled: Boolean(scan.enabled),
    executionEnabled: isExecutionEnabled(),
    scanned: Number(scan.scanned || scan.activeLiveCustoms || 0),
    activeLiveCustoms: Number(scan.activeLiveCustoms || scan.scanned || 0),
    signalCount: Number(scan.signalCount || 0),
    submitted: Number(scan.submitted || 0),
    executionDisabled: Number(scan.executionDisabled || 0),
    duplicateSkipped: Number(scan.duplicateSkipped || 0),
    openPositionSkipped: Number(scan.openPositionSkipped || 0),
    ignored: Number(scan.ignored || 0),
    signals: buildScanSignalSummary(scan.signals, scan.results),
  };
}

function recordLiveScanSummary(scan) {
  lastScanSummary = buildLiveScanSummary(scan);
  console.log(`[SymbolCustom] Live scan summary ${JSON.stringify(lastScanSummary)}`);
}

function buildLiveSignalPayload(signal = {}) {
  const rawMetadata = cloneValue(signal.metadata || {});
  const setupType = signal.setupType || rawMetadata.setupType || rawMetadata.setup || 'symbol_custom';
  const candidatePreset = signal.candidatePreset || rawMetadata.candidatePreset || null;
  const confidence = signal.confidence ?? rawMetadata.confidence;
  const rawConfidence = signal.rawConfidence ?? rawMetadata.rawConfidence ?? confidence;
  const marketQualityScore = signal.marketQualityScore ?? rawMetadata.marketQualityScore;
  const marketQualityThreshold = signal.marketQualityThreshold ?? rawMetadata.marketQualityThreshold;
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
    scope: 'live',
    ...(confidence !== undefined ? { confidence } : {}),
    ...(rawConfidence !== undefined ? { rawConfidence } : {}),
    ...(marketQualityScore !== undefined ? { marketQualityScore } : {}),
    ...(marketQualityThreshold !== undefined ? { marketQualityThreshold } : {}),
    parameterSnapshot,
  };

  return {
    ...cloneValue(signal),
    scope: 'live',
    source: 'symbolCustom',
    setupType,
    strategy: signal.symbolCustomName,
    strategyType: 'SymbolCustom',
    candidatePreset,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(rawConfidence !== undefined ? { rawConfidence } : {}),
    ...(marketQualityScore !== undefined ? { marketQualityScore } : {}),
    ...(marketQualityThreshold !== undefined ? { marketQualityThreshold } : {}),
    parameterSnapshot,
    symbolCustomId: signal.symbolCustomId || null,
    symbolCustomName: signal.symbolCustomName,
    logicName: signal.logicName,
    metadata,
  };
}

function resolveLiveSignalHandler(service) {
  const candidateService = service || require('./tradeExecutor');
  if (candidateService && typeof candidateService.executeTrade === 'function') {
    return {
      handler: candidateService.executeTrade,
      context: candidateService,
      methodName: 'executeTrade',
    };
  }

  return { handler: null, context: null, methodName: null };
}

function normalizeComparableText(value) {
  return String(value || '').trim().toUpperCase();
}

function positionMatchesSymbolCustomSignal(position = {}, signal = {}) {
  const status = normalizeComparableText(position.status);
  if (status && status !== 'OPEN') return false;
  if (normalizeComparableText(position.symbol) !== normalizeComparableText(signal.symbol)) return false;

  const signalNames = new Set([
    signal.symbolCustomId,
    signal.symbolCustomName,
    signal.logicName,
    signal.strategy,
  ].map(normalizeComparableText).filter(Boolean));
  const positionNames = [
    position.symbolCustomId,
    position.symbolCustomName,
    position.logicName,
    position.strategy,
  ].map(normalizeComparableText).filter(Boolean);

  return positionNames.some((name) => signalNames.has(name));
}

async function findOpenSymbolCustomPosition(signal = {}, positionModel = Position) {
  if (!positionModel || typeof positionModel.findAll !== 'function') return null;
  const positions = await positionModel.findAll({ status: 'OPEN' });
  return (Array.isArray(positions) ? positions : [])
    .find((position) => positionMatchesSymbolCustomSignal(position, signal)) || null;
}

async function handleSymbolCustomLiveSignal(signal, options = {}) {
  const payload = buildLiveSignalPayload(signal);
  rememberSignal(payload);

  if (!isLiveTradeSignal(payload)) {
    return {
      success: true,
      action: 'ignored',
      signal: payload,
    };
  }

  if (!isExecutionEnabled()) {
    return {
      success: true,
      action: 'live_execution_disabled',
      reasonCode: SYMBOL_CUSTOM_LIVE_EXECUTION_DISABLED,
      signal: payload,
    };
  }

  const dedupeKey = buildLiveSignalDedupeKey(payload);
  if (submittedSignalKeys.has(dedupeKey)) {
    return {
      success: true,
      action: 'duplicate_skipped',
      reasonCode: SYMBOL_CUSTOM_LIVE_DUPLICATE_SIGNAL,
      dedupeKey,
      signal: payload,
    };
  }
  rememberSubmittedSignalKey(dedupeKey);

  const openPosition = await findOpenSymbolCustomPosition(payload, options.positionModel);
  if (openPosition) {
    return {
      success: true,
      action: 'open_position_skipped',
      reasonCode: SYMBOL_CUSTOM_LIVE_OPEN_POSITION_EXISTS,
      dedupeKey,
      openPositionId: openPosition._id || null,
      mt5PositionId: openPosition.mt5PositionId || null,
      signal: payload,
    };
  }

  const { handler, context } = resolveLiveSignalHandler(options.tradeExecutor);
  if (!handler) {
    throw buildHttpError(SYMBOL_CUSTOM_LIVE_SIGNAL_HANDLER_NOT_AVAILABLE, 500);
  }

  const execution = await handler.call(context, payload);
  return {
    success: true,
    action: 'live_submitted',
    signal: payload,
    execution,
  };
}

function resetScanCounters() {
  activeLiveCustoms = 0;
  lastSignalCount = 0;
}

function buildDisabledScanResult() {
  return {
    success: false,
    enabled: false,
    executionEnabled: isExecutionEnabled(),
    scanned: 0,
    submitted: 0,
    executionDisabled: 0,
    duplicateSkipped: 0,
    openPositionSkipped: 0,
    ignored: 0,
    activeLiveCustoms: 0,
    signalCount: 0,
    signals: [],
    results: [],
    reasonCode: SYMBOL_CUSTOM_LIVE_RUNTIME_DISABLED,
  };
}

function assertCandleProviderAvailable(symbolCustoms, getCandlesFn) {
  if (typeof getCandlesFn === 'function') {
    return;
  }

  if (!Array.isArray(symbolCustoms) || symbolCustoms.length === 0) {
    return;
  }

  throw buildHttpError(SYMBOL_CUSTOM_CANDLE_PROVIDER_REQUIRED, 400, symbolCustoms.map((symbolCustom) => ({
    symbolCustomId: symbolCustom._id || null,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName: getLogicName(symbolCustom),
  })));
}

async function listActiveLiveSymbolCustoms() {
  const symbolCustoms = await SymbolCustom.findAll({ liveEnabled: true });
  return symbolCustoms.filter((symbolCustom) => symbolCustom.liveEnabled === true);
}

async function runLiveScan({ getCandlesFn, activeProfile, tradeExecutor } = {}) {
  const enabled = isEnabled();

  if (!enabled) {
    resetScanCounters();
    lastScanSummary = buildLiveScanSummary({
      enabled: false,
      scanned: 0,
      activeLiveCustoms: 0,
      signalCount: 0,
      signals: [],
      results: [],
    });
    return buildDisabledScanResult();
  }

  try {
    const effectiveGetCandlesFn = getCandlesFn || runtimeGetCandlesFn;
    const activeSymbolCustoms = await listActiveLiveSymbolCustoms();
    activeLiveCustoms = activeSymbolCustoms.length;
    const gated = applyLiveRuntimeSafetyGate(activeSymbolCustoms);
    assertCandleProviderAvailable(gated.allowed, effectiveGetCandlesFn);

    const analyzedSignals = [];
    for (const symbolCustom of gated.allowed) {
      analyzedSignals.push(await symbolCustomEngine.analyzeSymbolCustom(
        symbolCustom,
        effectiveGetCandlesFn,
        {
          scope: 'live',
          liveAnalysisAllowed: true,
          activeProfile: activeProfile || runtimeActiveProfile,
        }
      ));
    }

    const signals = [...gated.ignoredSignals, ...analyzedSignals];
    lastSignalCount = signals.length;
    lastScanAt = new Date();
    lastError = null;

    const results = [];
    for (const signal of signals) {
      results.push(await handleSymbolCustomLiveSignal(signal, { tradeExecutor }));
    }

    const scanResult = {
      success: true,
      enabled,
      executionEnabled: isExecutionEnabled(),
      scanned: activeLiveCustoms,
      activeLiveCustoms,
      signalCount: signals.length,
      submitted: results.filter((result) => result.action === 'live_submitted').length,
      executionDisabled: results.filter((result) => result.action === 'live_execution_disabled').length,
      duplicateSkipped: results.filter((result) => result.action === 'duplicate_skipped').length,
      openPositionSkipped: results.filter((result) => result.action === 'open_position_skipped').length,
      ignored: results.filter((result) => result.action === 'ignored').length,
      signals,
      results,
    };
    recordLiveScanSummary(scanResult);
    return scanResult;
  } catch (error) {
    lastError = error.message;
    throw error;
  }
}

function getScanIntervalMs(options = {}) {
  const requested = Number(options.intervalMs || process.env.SYMBOL_CUSTOM_LIVE_SCAN_INTERVAL_MS);
  return Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_SCAN_INTERVAL_MS;
}

function start(options = {}) {
  if (!isEnabled()) {
    return {
      success: false,
      enabled: false,
      executionEnabled: isExecutionEnabled(),
      running: false,
      message: 'SymbolCustom live runtime disabled',
    };
  }

  if (running) {
    return {
      success: true,
      enabled: true,
      executionEnabled: isExecutionEnabled(),
      running: true,
      message: 'SymbolCustom live runtime already running',
    };
  }

  runtimeGetCandlesFn = typeof options.getCandlesFn === 'function' ? options.getCandlesFn : null;
  runtimeActiveProfile = options.activeProfile || null;
  running = true;

  timer = setInterval(() => {
    runLiveScan({}).catch((error) => {
      lastError = error.message;
      console.error(`[SymbolCustom] Live runtime scan failed: ${error.message}`);
    });
  }, getScanIntervalMs(options));

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    success: true,
    enabled: true,
    executionEnabled: isExecutionEnabled(),
    running: true,
    message: 'SymbolCustom live runtime started',
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
  submittedSignalKeys = new Map();

  return {
    success: true,
    enabled: isEnabled(),
    executionEnabled: isExecutionEnabled(),
    allowedLogics: getLiveAllowedLogics(),
    running,
    message: 'SymbolCustom live runtime stopped',
  };
}

function isRunning() {
  return running;
}

function getStatus() {
  return {
    enabled: isEnabled(),
    executionEnabled: isExecutionEnabled(),
    running,
    lastScanAt,
    lastError,
    activeLiveCustoms,
    lastSignalCount,
    lastSignals: cloneValue(lastSignals),
    lastScanSummary: cloneValue(lastScanSummary),
  };
}

module.exports = {
  SYMBOL_CUSTOM_LIVE_ENABLED_ENV,
  SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED_ENV,
  SYMBOL_CUSTOM_LIVE_ALLOWED_LOGICS_ENV,
  SYMBOL_CUSTOM_LIVE_RUNTIME_DISABLED,
  SYMBOL_CUSTOM_LIVE_EXECUTION_DISABLED,
  SYMBOL_CUSTOM_LIVE_SIGNAL_HANDLER_NOT_AVAILABLE,
  SYMBOL_CUSTOM_LIVE_LOGIC_NOT_ALLOWED,
  SYMBOL_CUSTOM_LIVE_NOT_PRIMARY,
  SYMBOL_CUSTOM_CANDLE_PROVIDER_REQUIRED,
  SYMBOL_CUSTOM_LIVE_DUPLICATE_SIGNAL,
  SYMBOL_CUSTOM_LIVE_OPEN_POSITION_EXISTS,
  DEFAULT_LIVE_ALLOWED_LOGICS,
  LIVE_ALLOWED_LOGICS,
  getLiveAllowedLogics,
  isEnabled,
  isExecutionEnabled,
  runLiveScan,
  handleSymbolCustomLiveSignal,
  buildLiveSignalDedupeKey,
  findOpenSymbolCustomPosition,
  getLiveRuntimeGate,
  applyLiveRuntimeSafetyGate,
  listActiveLiveSymbolCustoms,
  start,
  stop,
  isRunning,
  getStatus,
};
