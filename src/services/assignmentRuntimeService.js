const Strategy = require('../models/Strategy');
const StrategyInstance = require('../models/StrategyInstance');
const { getInstrument, INSTRUMENT_CATEGORIES } = require('../config/instruments');
const { getStrategyExecutionConfig } = require('../config/strategyExecution');
const { getStrategyInstance } = require('./strategyInstanceService');
const { DEFAULT_NEWS_BLACKOUT_CONFIG } = require('../config/newsBlackout');
const { DEFAULT_EXECUTION_POLICY } = require('./executionPolicyService');
const { getPrimaryExecutionTimeframe } = require('../utils/timeframe');

const CATEGORY_GROUPS = Object.freeze({
  FOREX: 'forex',
  METALS: 'metals',
  ENERGY: 'energy',
  CRYPTO: 'crypto',
  INDICES: 'indices',
});

const SIGNAL_SCAN_BUCKETS = Object.freeze([
  { cadenceMs: 15 * 1000, label: '15s' },
  { cadenceMs: 30 * 1000, label: '30s' },
  { cadenceMs: 180 * 1000, label: '180s' },
]);

const POSITION_STATE_PRIORITY = Object.freeze([
  'news_fast_mode',
  'just_opened',
  'protected',
  'normal',
]);

const POSITION_MONITOR_CADENCE_MS = Object.freeze({
  [CATEGORY_GROUPS.FOREX]: Object.freeze({
    just_opened: Object.freeze({ lightCadenceMs: 15 * 1000, heavyCadenceMs: 60 * 1000 }),
    normal: Object.freeze({ lightCadenceMs: 30 * 1000, heavyCadenceMs: 180 * 1000 }),
    protected: Object.freeze({ lightCadenceMs: 60 * 1000, heavyCadenceMs: 180 * 1000 }),
    news_fast_mode: Object.freeze({ lightCadenceMs: 15 * 1000, heavyCadenceMs: 60 * 1000 }),
  }),
  [CATEGORY_GROUPS.METALS]: Object.freeze({
    just_opened: Object.freeze({ lightCadenceMs: 15 * 1000, heavyCadenceMs: 60 * 1000 }),
    normal: Object.freeze({ lightCadenceMs: 15 * 1000, heavyCadenceMs: 60 * 1000 }),
    protected: Object.freeze({ lightCadenceMs: 30 * 1000, heavyCadenceMs: 180 * 1000 }),
    news_fast_mode: Object.freeze({ lightCadenceMs: 15 * 1000, heavyCadenceMs: 60 * 1000 }),
  }),
  [CATEGORY_GROUPS.ENERGY]: Object.freeze({
    just_opened: Object.freeze({ lightCadenceMs: 15 * 1000, heavyCadenceMs: 60 * 1000 }),
    normal: Object.freeze({ lightCadenceMs: 15 * 1000, heavyCadenceMs: 60 * 1000 }),
    protected: Object.freeze({ lightCadenceMs: 30 * 1000, heavyCadenceMs: 180 * 1000 }),
    news_fast_mode: Object.freeze({ lightCadenceMs: 15 * 1000, heavyCadenceMs: 60 * 1000 }),
  }),
  [CATEGORY_GROUPS.CRYPTO]: Object.freeze({
    just_opened: Object.freeze({ lightCadenceMs: 15 * 1000, heavyCadenceMs: 60 * 1000 }),
    normal: Object.freeze({ lightCadenceMs: 15 * 1000, heavyCadenceMs: 60 * 1000 }),
    protected: Object.freeze({ lightCadenceMs: 30 * 1000, heavyCadenceMs: 180 * 1000 }),
    news_fast_mode: Object.freeze({ lightCadenceMs: 15 * 1000, heavyCadenceMs: 60 * 1000 }),
  }),
  [CATEGORY_GROUPS.INDICES]: Object.freeze({
    just_opened: Object.freeze({ lightCadenceMs: 15 * 1000, heavyCadenceMs: 60 * 1000 }),
    normal: Object.freeze({ lightCadenceMs: 15 * 1000, heavyCadenceMs: 60 * 1000 }),
    protected: Object.freeze({ lightCadenceMs: 30 * 1000, heavyCadenceMs: 180 * 1000 }),
    news_fast_mode: Object.freeze({ lightCadenceMs: 15 * 1000, heavyCadenceMs: 60 * 1000 }),
  }),
});

const warnedCategoryFallbacks = new Set();

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapCategoryToGroup(rawCategory) {
  switch (rawCategory) {
    case INSTRUMENT_CATEGORIES.METALS:
      return CATEGORY_GROUPS.METALS;
    case INSTRUMENT_CATEGORIES.ENERGY:
      return CATEGORY_GROUPS.ENERGY;
    case INSTRUMENT_CATEGORIES.CRYPTO:
      return CATEGORY_GROUPS.CRYPTO;
    case INSTRUMENT_CATEGORIES.INDICES:
      return CATEGORY_GROUPS.INDICES;
    case INSTRUMENT_CATEGORIES.FOREX_MAJOR:
    case INSTRUMENT_CATEGORIES.FOREX_CROSS:
      return CATEGORY_GROUPS.FOREX;
    default:
      return null;
  }
}

function warnCategoryFallbackOnce(symbol, rawCategory, source = 'runtime') {
  const key = `${source}:${symbol}:${rawCategory || 'null'}`;
  if (warnedCategoryFallbacks.has(key)) {
    return;
  }

  warnedCategoryFallbacks.add(key);
  console.warn(
    `[Runtime] Unknown instrument category for ${symbol}: ${rawCategory || 'null'}; falling back to forex cadence`
  );
}

function resolveCategoryContext(symbol, rawCategory = undefined, { warnSource = null } = {}) {
  const instrument = getInstrument(symbol);
  const categoryValue = rawCategory !== undefined ? rawCategory : instrument?.category;
  const mapped = mapCategoryToGroup(categoryValue);
  if (mapped) {
    return {
      category: mapped,
      rawCategory: categoryValue || null,
      categoryFallback: false,
    };
  }

  if (warnSource) {
    warnCategoryFallbackOnce(symbol, categoryValue, warnSource);
  }

  return {
    category: CATEGORY_GROUPS.FOREX,
    rawCategory: categoryValue || null,
    categoryFallback: true,
  };
}

function getSignalCadenceMs(executionConfig = {}, category = CATEGORY_GROUPS.FOREX) {
  const timeframe = getPrimaryExecutionTimeframe(executionConfig);
  if (timeframe === '1m') {
    return 15 * 1000;
  }

  if (timeframe === '5m' || timeframe === '15m') {
    if (category === CATEGORY_GROUPS.CRYPTO || category === CATEGORY_GROUPS.INDICES) {
      return 15 * 1000;
    }
    return 30 * 1000;
  }

  return 180 * 1000;
}

function getSignalBucketDefinitionByCadence(cadenceMs) {
  return SIGNAL_SCAN_BUCKETS.find((bucket) => bucket.cadenceMs === cadenceMs) || null;
}

function getPositionCadenceProfile(category = CATEGORY_GROUPS.FOREX, state = 'normal') {
  const categoryProfile = POSITION_MONITOR_CADENCE_MS[category] || POSITION_MONITOR_CADENCE_MS[CATEGORY_GROUPS.FOREX];
  return categoryProfile[state] || categoryProfile.normal;
}

function getScanReason(state = 'normal', forcedSync = false) {
  if (forcedSync) {
    return 'forced_sync';
  }

  if (state === 'news_fast_mode') return 'news_fast_mode';
  if (state === 'just_opened') return 'just_opened';
  if (state === 'protected') return 'protected';
  return 'cadence';
}

function normalizeAssignmentScope(scope) {
  return String(scope || 'paper').toLowerCase() === 'live' ? 'live' : 'paper';
}

function buildFallbackInstance(strategy, symbol, scope = 'paper') {
  const normalizedScope = normalizeAssignmentScope(scope);
  const paperEnabled = strategy.enabled !== false;
  const liveEnabled = false;
  return {
    strategyName: strategy.name,
    symbol,
    parameters: {},
    enabled: paperEnabled,
    paperEnabled,
    liveEnabled,
    enabledForScope: normalizedScope === 'live' ? liveEnabled : paperEnabled,
    newsBlackout: cloneValue(DEFAULT_NEWS_BLACKOUT_CONFIG),
    executionPolicy: cloneValue(DEFAULT_EXECUTION_POLICY),
    effectiveBreakeven: null,
    effectiveExitPlan: null,
    effectiveTradeManagement: null,
    source: 'strategy_default',
  };
}

function isInstanceEnabledForScope(strategyInstance = {}, scope = 'paper') {
  const normalizedScope = normalizeAssignmentScope(scope);
  if (strategyInstance.enabledForScope !== undefined) {
    return strategyInstance.enabledForScope !== false;
  }
  if (normalizedScope === 'live') {
    return strategyInstance.liveEnabled !== undefined
      ? strategyInstance.liveEnabled === true
      : strategyInstance.enabled !== false;
  }
  if (strategyInstance.paperEnabled !== undefined) {
    return strategyInstance.paperEnabled !== false;
  }
  return strategyInstance.enabled !== false;
}

function isExplicitInstanceEnabledForScope(strategyInstance = {}, scope = 'paper') {
  const normalizedScope = normalizeAssignmentScope(scope);
  if (normalizedScope === 'live') {
    return strategyInstance.liveEnabled === true;
  }
  return strategyInstance.paperEnabled === true;
}

function buildAssignmentKey(strategyName, symbol) {
  return `${strategyName}:${symbol}`;
}

function upsertRuntimeCandidate(candidates, { strategy, symbol, source }) {
  if (!strategy || !strategy.name || !symbol) {
    return;
  }

  const taskKey = buildAssignmentKey(strategy.name, symbol);
  const existing = candidates.get(taskKey);
  if (existing) {
    existing.sources.add(source);
    return;
  }

  candidates.set(taskKey, {
    strategy,
    symbol,
    sources: new Set([source]),
  });
}

function buildRuntimeSource(sources = new Set()) {
  const orderedSources = ['legacy', 'strategyInstance'].filter((source) => sources.has(source));
  return orderedSources.join('+') || 'unknown';
}

async function listActiveAssignments({ activeProfile = null, symbolFilter = null, scope = 'paper' } = {}) {
  const normalizedScope = normalizeAssignmentScope(scope);
  const filterSet = Array.isArray(symbolFilter) && symbolFilter.length > 0
    ? new Set(symbolFilter)
    : null;
  const strategies = await Strategy.findAll();
  const strategyByName = new Map(strategies.map((strategy) => [strategy.name, strategy]));
  const candidates = new Map();
  const assignments = [];

  for (const strategy of strategies) {
    const uniqueSymbols = [...new Set(Array.isArray(strategy.symbols) ? strategy.symbols : [])];
    for (const symbol of uniqueSymbols) {
      if (filterSet && !filterSet.has(symbol)) {
        continue;
      }

      upsertRuntimeCandidate(candidates, { strategy, symbol, source: 'legacy' });
    }
  }

  const strategyInstances = await StrategyInstance.findAll();
  for (const instance of strategyInstances) {
    if (!isExplicitInstanceEnabledForScope(instance, normalizedScope)) {
      continue;
    }

    const strategy = strategyByName.get(instance.strategyName);
    if (!strategy) {
      continue;
    }

    if (filterSet && !filterSet.has(instance.symbol)) {
      continue;
    }

    upsertRuntimeCandidate(candidates, {
      strategy,
      symbol: instance.symbol,
      source: 'strategyInstance',
    });
  }

  for (const candidate of candidates.values()) {
    const { strategy, symbol } = candidate;
    const executionConfig = getStrategyExecutionConfig(symbol, strategy.name);
    if (!executionConfig) {
      continue;
    }

    let strategyInstance = null;
    try {
      strategyInstance = await getStrategyInstance(symbol, strategy.name, {
        activeProfile,
        scope: normalizedScope,
        skipRuntimeDefaultsMigration: true,
      });
    } catch (error) {
      strategyInstance = buildFallbackInstance(strategy, symbol, normalizedScope);
    }
    if (!isInstanceEnabledForScope(strategyInstance, normalizedScope)) {
      continue;
    }

    const categoryContext = resolveCategoryContext(symbol, executionConfig.category, { warnSource: 'signal' });
    const cadenceTimeframe = getPrimaryExecutionTimeframe(executionConfig);
    const cadenceMs = getSignalCadenceMs(executionConfig, categoryContext.category);
    const runtimeSource = buildRuntimeSource(candidate.sources);

    assignments.push({
      symbol,
      strategyType: strategy.name,
      strategyDisplayName: strategy.displayName || strategy.name,
      strategyId: strategy._id,
      strategyEnabled: strategy.enabled !== false,
      strategyInstance,
      assignmentScope: normalizedScope,
      assignmentSource: runtimeSource,
      runtimeSource,
      executionConfig,
      cadenceTimeframe,
      cadenceMs,
      category: categoryContext.category,
      rawCategory: categoryContext.rawCategory,
      categoryFallback: categoryContext.categoryFallback,
    });
  }

  return assignments;
}

function buildAssignmentStats(assignments = []) {
  const activeSymbols = new Set();
  assignments.forEach((assignment) => {
    if (assignment && assignment.symbol) {
      activeSymbols.add(assignment.symbol);
    }
  });

  return {
    activeAssignments: assignments.length,
    activeSymbols: activeSymbols.size,
  };
}

function buildSignalScanBucketStatus(assignments = [], bucketStates = new Map()) {
  return SIGNAL_SCAN_BUCKETS.map((bucket) => {
    const bucketAssignments = assignments.filter((assignment) => assignment.cadenceMs === bucket.cadenceMs);
    const activeSymbols = new Set(bucketAssignments.map((assignment) => assignment.symbol));
    const state = bucketStates.get(bucket.cadenceMs) || {};
    const nextScanAt = toIsoOrNull(state.nextScanAt);

    return {
      timeframe: bucket.label,
      cadenceMs: bucket.cadenceMs,
      cadenceLabel: bucket.label,
      assignmentCount: bucketAssignments.length,
      activeSymbols: activeSymbols.size,
      lastScanAt: toIsoOrNull(state.lastScanAt),
      nextScanAt,
      lastError: state.lastError || null,
      running: state.running === true,
      items: bucketAssignments.map((assignment) => ({
        symbol: assignment.symbol,
        strategy: assignment.strategyType,
        category: assignment.category,
        categoryFallback: assignment.categoryFallback === true,
        scanMode: 'signal',
        scanReason: 'cadence',
        nextScanAt,
      })),
    };
  });
}

function getFastMonitorIntervalMsForPositions(positions = []) {
  let fastestInterval = 30 * 1000;

  for (const position of positions) {
    const instrument = getInstrument(position.symbol);
    const categoryContext = resolveCategoryContext(position.symbol, instrument?.category);
    const cadence = getPositionCadenceProfile(categoryContext.category, 'normal').lightCadenceMs;
    if (cadence < fastestInterval) {
      fastestInterval = cadence;
    }
  }

  return fastestInterval;
}

class CadenceScheduler {
  constructor({ name, buildAssignments, runAssignments, onError, bucketDefinitions = SIGNAL_SCAN_BUCKETS } = {}) {
    this.name = name || 'cadence-scheduler';
    this.buildAssignments = buildAssignments;
    this.runAssignments = runAssignments;
    this.onError = onError;
    this.bucketDefinitions = bucketDefinitions;
    this.timers = new Map();
    this.states = new Map();
  }

  _ensureState(bucket) {
    if (!this.states.has(bucket.cadenceMs)) {
      this.states.set(bucket.cadenceMs, {
        cadenceMs: bucket.cadenceMs,
        lastScanAt: null,
        nextScanAt: null,
        lastError: null,
        running: false,
      });
    }

    return this.states.get(bucket.cadenceMs);
  }

  async _tick(bucket) {
    const state = this._ensureState(bucket);
    if (state.running) {
      return;
    }

    state.running = true;
    state.lastScanAt = new Date();
    state.nextScanAt = new Date(Date.now() + bucket.cadenceMs);
    state.lastError = null;

    try {
      const assignments = await this.buildAssignments(bucket);
      state.assignmentCount = Array.isArray(assignments) ? assignments.length : 0;
      state.activeSymbols = Array.isArray(assignments)
        ? new Set(assignments.map((assignment) => assignment.symbol)).size
        : 0;

      if (Array.isArray(assignments) && assignments.length > 0) {
        await this.runAssignments(assignments, bucket, cloneValue(state));
      }
    } catch (error) {
      state.lastError = error.message;
      if (typeof this.onError === 'function') {
        this.onError(error, bucket);
      }
    } finally {
      state.running = false;
    }
  }

  start() {
    for (const bucket of this.bucketDefinitions) {
      if (this.timers.has(bucket.cadenceMs)) {
        continue;
      }

      this._ensureState(bucket);
      this._tick(bucket);
      const timer = setInterval(() => {
        this._tick(bucket);
      }, bucket.cadenceMs);
      this.timers.set(bucket.cadenceMs, timer);
    }
  }

  stop() {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.states.clear();
  }

  getBucketStates() {
    return new Map(
      [...this.states.entries()].map(([key, value]) => [key, { ...value }])
    );
  }

  isRunning() {
    return this.timers.size > 0;
  }
}

module.exports = {
  CATEGORY_GROUPS,
  SIGNAL_SCAN_BUCKETS,
  POSITION_STATE_PRIORITY,
  POSITION_MONITOR_CADENCE_MS,
  CadenceScheduler,
  buildAssignmentStats,
  buildScanBucketStatus: buildSignalScanBucketStatus,
  buildSignalScanBucketStatus,
  getFastMonitorIntervalMsForPositions,
  getPositionCadenceProfile,
  getScanReason,
  getSignalBucketDefinitionByCadence,
  getSignalCadenceMs,
  isInstanceEnabledForScope,
  listActiveAssignments,
  normalizeAssignmentScope,
  resolveCategoryContext,
  toIsoOrNull,
  warnCategoryFallbackOnce,
};
