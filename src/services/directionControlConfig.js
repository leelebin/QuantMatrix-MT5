const DIRECTION_CONTROL_ACTIONS = Object.freeze({
  TIGHTEN_SL_OR_EXIT_ON_PULLBACK: 'TIGHTEN_SL_OR_EXIT_ON_PULLBACK',
});

const DEFAULT_WOULD_HAVE_ACTION = DIRECTION_CONTROL_ACTIONS.TIGHTEN_SL_OR_EXIT_ON_PULLBACK;

const DEFAULT_DIRECTION_CONTROL_CONFIG = Object.freeze({
  schemaVersion: 1,
  enabled: false,
  mode: 'audit',
  minBarsAfterEntry: 2,
  cooldownBars: 3,
  firstTriggerOnly: true,
  triggerMode: 'score_or_critical',
  triggerScore: 2,
  requiredCategories: 2,
  checks: {
    adverseR: {
      enabled: true,
      category: 'loss_state',
      thresholdR: -0.6,
      score: 1,
      critical: false,
    },
    failedFollowThrough: {
      enabled: true,
      category: 'follow_through',
      minFavourableR: 0.25,
      currentRThreshold: -0.35,
      score: 1,
      critical: false,
    },
    opposingSignal: {
      enabled: true,
      category: 'opposing_signal',
      useClosedBarOnly: true,
      allowRepaintSignal: false,
      maxSignalAgeBars: 2,
      score: 1,
      critical: false,
    },
    structureBreak: {
      enabled: true,
      category: 'structure',
      type: 'entry_thesis_level',
      levels: ['zone_boundary', 'pinbar_extreme', 'entry_swing'],
      fallbackType: 'recent_swing',
      lookbackBars: 8,
      confirmByClose: true,
      bufferAtr: 0.1,
      score: 2,
      critical: true,
    },
    emaInvalidation: {
      enabled: false,
      category: 'trend_filter',
      period: 50,
      confirmByClose: true,
      score: 1,
      critical: false,
    },
    higherTrendFlip: {
      enabled: false,
      category: 'higher_trend',
      confirmByClose: true,
      score: 2,
      critical: false,
    },
  },
  wouldHaveAction: DEFAULT_WOULD_HAVE_ACTION,
  promotionCriteria: {
    minTriggeredTrades: 100,
    minOutOfSampleTriggeredTrades: 50,
    minNetHypotheticalImpactR: 5,
    maxRecoveredToTpRate: 0.25,
    minTriggeredThenHitSlRate: 0.55,
  },
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finiteNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function nonNegativeInteger(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return Math.floor(num);
}

function positiveInteger(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.floor(num);
}

function normalizeBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function normalizeString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeAction(value) {
  const raw = normalizeString(value, DEFAULT_WOULD_HAVE_ACTION);
  return Object.values(DIRECTION_CONTROL_ACTIONS).includes(raw)
    ? raw
    : DEFAULT_WOULD_HAVE_ACTION;
}

function normalizeCheck(name, input, defaultCheck) {
  const source = isPlainObject(input) ? input : {};
  const normalized = { ...clone(defaultCheck) };

  normalized.enabled = normalizeBoolean(source.enabled, normalized.enabled);
  normalized.category = normalizeString(source.category, normalized.category);
  normalized.score = finiteNumber(source.score, normalized.score);
  normalized.critical = normalizeBoolean(source.critical, normalized.critical);

  if (name === 'adverseR') {
    normalized.thresholdR = finiteNumber(source.thresholdR, normalized.thresholdR);
  }

  if (name === 'failedFollowThrough') {
    normalized.minFavourableR = finiteNumber(source.minFavourableR, normalized.minFavourableR);
    normalized.currentRThreshold = finiteNumber(source.currentRThreshold, normalized.currentRThreshold);
  }

  if (name === 'opposingSignal') {
    normalized.useClosedBarOnly = normalizeBoolean(source.useClosedBarOnly, normalized.useClosedBarOnly);
    normalized.allowRepaintSignal = normalizeBoolean(source.allowRepaintSignal, normalized.allowRepaintSignal);
    normalized.maxSignalAgeBars = nonNegativeInteger(source.maxSignalAgeBars, normalized.maxSignalAgeBars);
  }

  if (name === 'structureBreak') {
    normalized.type = normalizeString(source.type, normalized.type);
    normalized.fallbackType = normalizeString(source.fallbackType, normalized.fallbackType);
    normalized.lookbackBars = positiveInteger(source.lookbackBars, normalized.lookbackBars);
    normalized.confirmByClose = normalizeBoolean(source.confirmByClose, normalized.confirmByClose);
    normalized.bufferAtr = finiteNumber(source.bufferAtr, normalized.bufferAtr);
    normalized.levels = Array.isArray(source.levels) && source.levels.length > 0
      ? source.levels.map((level) => String(level)).filter(Boolean)
      : clone(normalized.levels);
  }

  if (name === 'emaInvalidation') {
    normalized.period = positiveInteger(source.period, normalized.period);
    normalized.confirmByClose = normalizeBoolean(source.confirmByClose, normalized.confirmByClose);
  }

  if (name === 'higherTrendFlip') {
    normalized.confirmByClose = normalizeBoolean(source.confirmByClose, normalized.confirmByClose);
  }

  return normalized;
}

function normalizePromotionCriteria(input) {
  const defaults = DEFAULT_DIRECTION_CONTROL_CONFIG.promotionCriteria;
  const source = isPlainObject(input) ? input : {};
  return {
    minTriggeredTrades: nonNegativeInteger(source.minTriggeredTrades, defaults.minTriggeredTrades),
    minOutOfSampleTriggeredTrades: nonNegativeInteger(
      source.minOutOfSampleTriggeredTrades,
      defaults.minOutOfSampleTriggeredTrades
    ),
    minNetHypotheticalImpactR: finiteNumber(
      source.minNetHypotheticalImpactR,
      defaults.minNetHypotheticalImpactR
    ),
    maxRecoveredToTpRate: finiteNumber(source.maxRecoveredToTpRate, defaults.maxRecoveredToTpRate),
    minTriggeredThenHitSlRate: finiteNumber(
      source.minTriggeredThenHitSlRate,
      defaults.minTriggeredThenHitSlRate
    ),
  };
}

function normalizeDirectionControlConfig(input = null) {
  const defaults = clone(DEFAULT_DIRECTION_CONTROL_CONFIG);
  if (!isPlainObject(input)) {
    return defaults;
  }

  const normalized = {
    ...defaults,
    schemaVersion: 1,
    enabled: normalizeBoolean(input.enabled, defaults.enabled),
    mode: 'audit',
    minBarsAfterEntry: nonNegativeInteger(input.minBarsAfterEntry, defaults.minBarsAfterEntry),
    cooldownBars: nonNegativeInteger(input.cooldownBars, defaults.cooldownBars),
    firstTriggerOnly: normalizeBoolean(input.firstTriggerOnly, defaults.firstTriggerOnly),
    triggerMode: normalizeString(input.triggerMode, defaults.triggerMode),
    triggerScore: finiteNumber(input.triggerScore, defaults.triggerScore),
    requiredCategories: nonNegativeInteger(input.requiredCategories, defaults.requiredCategories),
    wouldHaveAction: normalizeAction(input.wouldHaveAction),
    promotionCriteria: normalizePromotionCriteria(input.promotionCriteria),
    checks: {},
  };

  const checksInput = isPlainObject(input.checks) ? input.checks : {};
  for (const [name, defaultCheck] of Object.entries(defaults.checks)) {
    normalized.checks[name] = normalizeCheck(name, checksInput[name], defaultCheck);
  }

  return normalized;
}

function resolveDirectionControlConfig({
  strategyInstance = null,
  symbolCustom = null,
  source = null,
} = {}) {
  const normalizedSource = String(source || '').toLowerCase();
  if (normalizedSource === 'symbolcustom' || symbolCustom) {
    return normalizeDirectionControlConfig(symbolCustom?.exitConfig?.directionControl);
  }

  return normalizeDirectionControlConfig(
    strategyInstance?.tradeManagement?.directionControl
      || strategyInstance?.effectiveTradeManagement?.directionControl
      || null
  );
}

module.exports = {
  DEFAULT_DIRECTION_CONTROL_CONFIG,
  DIRECTION_CONTROL_ACTIONS,
  normalizeDirectionControlConfig,
  resolveDirectionControlConfig,
};
