const Strategy = require('../models/Strategy');
const StrategyInstance = require('../models/StrategyInstance');
const RiskProfile = require('../models/RiskProfile');
const breakevenService = require('./breakevenService');
const {
  DEFAULT_NEWS_BLACKOUT_CONFIG,
  normalizeNewsBlackoutConfig,
} = require('../config/newsBlackout');
const { getInstrument } = require('../config/instruments');
const { resolveStrategyParameters } = require('../config/strategyParameters');
const {
  resolveExecutionPolicy,
} = require('./executionPolicyService');

function cloneValue(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

function mergeObjects(baseValue, overrideValue) {
  const base = baseValue && typeof baseValue === 'object' && !Array.isArray(baseValue)
    ? cloneValue(baseValue)
    : {};
  const override = overrideValue && typeof overrideValue === 'object' && !Array.isArray(overrideValue)
    ? cloneValue(overrideValue)
    : {};

  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && base[key]
      && typeof base[key] === 'object'
      && !Array.isArray(base[key])
    ) {
      merged[key] = mergeObjects(base[key], value);
    } else {
      merged[key] = cloneValue(value);
    }
  }

  return merged;
}

let runtimeDefaultsMigrationPromise = null;

async function ensureRuntimeDefaultsMigrated() {
  if (runtimeDefaultsMigrationPromise) {
    return runtimeDefaultsMigrationPromise;
  }

  runtimeDefaultsMigrationPromise = (async () => {
    if (typeof StrategyInstance.migrateLegacyNewsBlackoutDefaults !== 'function') {
      return { migrated: 0, skipped: 0 };
    }

    return StrategyInstance.migrateLegacyNewsBlackoutDefaults();
  })();

  try {
    return await runtimeDefaultsMigrationPromise;
  } catch (error) {
    runtimeDefaultsMigrationPromise = null;
    throw error;
  }
}

function buildEffectiveInstancePayload({
  strategy,
  storedInstance,
  activeProfile,
  symbol,
}) {
  const instrument = getInstrument(symbol);
  const strategyDefaultParameters = cloneValue(strategy?.parameters || {});
  const instanceParameters = cloneValue(storedInstance?.parameters || {});
  const mergedTradeManagement = mergeObjects(
    strategy?.tradeManagement || {},
    storedInstance?.tradeManagement || {}
  );
  const mergedStrategy = {
    ...strategy,
    tradeManagement: Object.keys(mergedTradeManagement).length > 0 ? mergedTradeManagement : null,
  };

  const effectiveParameters = resolveStrategyParameters({
    strategyType: strategy?.name,
    instrument,
    storedParameters: strategyDefaultParameters,
    overrides: instanceParameters,
  });

  const effectiveBreakeven = breakevenService.resolveEffectiveBreakeven(activeProfile, mergedStrategy);
  const effectiveExitPlan = breakevenService.resolveEffectiveExitPlan(activeProfile, mergedStrategy, null);

  return {
    _id: storedInstance?._id || null,
    strategyName: strategy?.name || null,
    symbol,
    parameters: effectiveParameters,
    enabled: storedInstance?.enabled !== undefined ? storedInstance.enabled : true,
    newsBlackout: normalizeNewsBlackoutConfig(
      storedInstance?.newsBlackout,
      DEFAULT_NEWS_BLACKOUT_CONFIG
    ),
    tradeManagement: cloneValue(storedInstance?.tradeManagement || null),
    executionPolicy: resolveExecutionPolicy(
      strategy?.executionPolicy || null,
      storedInstance?.executionPolicy || null
    ),
    effectiveBreakeven,
    effectiveExitPlan,
    effectiveTradeManagement: {
      breakeven: effectiveBreakeven,
      exitPlan: effectiveExitPlan,
    },
    source: storedInstance ? 'instance' : 'strategy_default',
    hasStoredInstance: Boolean(storedInstance),
    storedParameters: instanceParameters,
    strategyDefaultParameters,
    storedExecutionPolicy: cloneValue(storedInstance?.executionPolicy || null),
    storedTradeManagement: cloneValue(storedInstance?.tradeManagement || null),
    createdAt: storedInstance?.createdAt || null,
    updatedAt: storedInstance?.updatedAt || null,
  };
}

async function getStrategyInstance(symbol, strategyName, options = {}) {
  await ensureRuntimeDefaultsMigrated();

  const strategy = await Strategy.findByName(strategyName);
  if (!strategy) {
    const error = new Error(`Strategy definition not found for ${strategyName}`);
    error.statusCode = 404;
    throw error;
  }

  const [storedInstance, activeProfile] = await Promise.all([
    StrategyInstance.findByKey(strategyName, symbol),
    options.activeProfile !== undefined ? options.activeProfile : RiskProfile.getActive(),
  ]);

  return buildEffectiveInstancePayload({
    strategy,
    storedInstance,
    activeProfile,
    symbol,
  });
}

module.exports = {
  getStrategyInstance,
  buildEffectiveInstancePayload,
  ensureRuntimeDefaultsMigrated,
};
