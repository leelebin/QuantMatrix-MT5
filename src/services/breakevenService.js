const DEFAULT_BREAKEVEN_CONFIG = Object.freeze({
  enabled: true,
  triggerAtrMultiple: 0.8,
  includeSpreadCompensation: true,
  extraBufferPips: 0,
  trailStartAtrMultiple: 1.5,
  trailDistanceAtrMultiple: 1.0,
});

const LEGACY_BREAKEVEN_CONFIG = Object.freeze({
  enabled: true,
  triggerAtrMultiple: 1.0,
  includeSpreadCompensation: true,
  extraBufferPips: 0,
  trailStartAtrMultiple: 1.5,
  trailDistanceAtrMultiple: 1.0,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneConfig(config) {
  return {
    enabled: Boolean(config.enabled),
    triggerAtrMultiple: Number(config.triggerAtrMultiple),
    includeSpreadCompensation: Boolean(config.includeSpreadCompensation),
    extraBufferPips: Number(config.extraBufferPips),
    trailStartAtrMultiple: Number(config.trailStartAtrMultiple),
    trailDistanceAtrMultiple: Number(config.trailDistanceAtrMultiple),
  };
}

function roundConfigNumber(value) {
  return parseFloat(Number(value).toFixed(4));
}

function buildValidationError(details, message = 'Validation failed') {
  const error = new Error(message);
  error.statusCode = 400;
  error.details = details;
  return error;
}

function normalizeBooleanField(value, field, errors) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value === 'true') return true;
  if (value === 'false') return false;

  errors.push({ field, message: 'Must be a boolean' });
  return false;
}

function normalizePositiveNumberField(value, field, errors, { allowZero = false } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num) || (allowZero ? num < 0 : num <= 0)) {
    errors.push({
      field,
      message: allowZero ? 'Must be a number greater than or equal to 0' : 'Must be a number greater than 0',
    });
    return null;
  }

  return roundConfigNumber(num);
}

function getDefaultBreakevenConfig() {
  return cloneConfig(DEFAULT_BREAKEVEN_CONFIG);
}

function getLegacyBreakevenConfig() {
  return cloneConfig(LEGACY_BREAKEVEN_CONFIG);
}

function getDefaultTradeManagement() {
  return {
    breakeven: getDefaultBreakevenConfig(),
  };
}

function normalizeBreakevenConfig(
  input = {},
  {
    partial = false,
    defaults = DEFAULT_BREAKEVEN_CONFIG,
    baseConfig = defaults,
  } = {}
) {
  if (input == null) {
    input = {};
  }

  if (!isPlainObject(input)) {
    throw buildValidationError([
      { field: 'tradeManagement.breakeven', message: 'Must be an object' },
    ]);
  }

  const errors = [];
  const cleaned = partial ? {} : cloneConfig(defaults);

  if (!partial || Object.prototype.hasOwnProperty.call(input, 'enabled')) {
    cleaned.enabled = normalizeBooleanField(
      input.enabled,
      'tradeManagement.breakeven.enabled',
      errors
    );
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, 'triggerAtrMultiple')) {
    cleaned.triggerAtrMultiple = normalizePositiveNumberField(
      input.triggerAtrMultiple,
      'tradeManagement.breakeven.triggerAtrMultiple',
      errors
    );
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, 'includeSpreadCompensation')) {
    cleaned.includeSpreadCompensation = normalizeBooleanField(
      input.includeSpreadCompensation,
      'tradeManagement.breakeven.includeSpreadCompensation',
      errors
    );
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, 'extraBufferPips')) {
    cleaned.extraBufferPips = normalizePositiveNumberField(
      input.extraBufferPips,
      'tradeManagement.breakeven.extraBufferPips',
      errors,
      { allowZero: true }
    );
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, 'trailStartAtrMultiple')) {
    cleaned.trailStartAtrMultiple = normalizePositiveNumberField(
      input.trailStartAtrMultiple,
      'tradeManagement.breakeven.trailStartAtrMultiple',
      errors
    );
  }

  if (!partial || Object.prototype.hasOwnProperty.call(input, 'trailDistanceAtrMultiple')) {
    cleaned.trailDistanceAtrMultiple = normalizePositiveNumberField(
      input.trailDistanceAtrMultiple,
      'tradeManagement.breakeven.trailDistanceAtrMultiple',
      errors
    );
  }

  const effectiveConfig = partial
    ? { ...cloneConfig(baseConfig || defaults), ...cleaned }
    : cleaned;

  if (
    Number.isFinite(effectiveConfig.trailStartAtrMultiple)
    && Number.isFinite(effectiveConfig.triggerAtrMultiple)
    && effectiveConfig.trailStartAtrMultiple < effectiveConfig.triggerAtrMultiple
  ) {
    errors.push({
      field: 'tradeManagement.breakeven.trailStartAtrMultiple',
      message: 'Must be greater than or equal to triggerAtrMultiple',
    });
  }

  if (
    Number.isFinite(effectiveConfig.trailDistanceAtrMultiple)
    && effectiveConfig.trailDistanceAtrMultiple <= 0
  ) {
    errors.push({
      field: 'tradeManagement.breakeven.trailDistanceAtrMultiple',
      message: 'Must be greater than 0',
    });
  }

  if (
    Number.isFinite(effectiveConfig.extraBufferPips)
    && effectiveConfig.extraBufferPips < 0
  ) {
    errors.push({
      field: 'tradeManagement.breakeven.extraBufferPips',
      message: 'Must be greater than or equal to 0',
    });
  }

  if (errors.length > 0) {
    throw buildValidationError(errors);
  }

  return cleaned;
}

function normalizeProfileTradeManagement(
  input,
  {
    partial = false,
    existingTradeManagement = null,
  } = {}
) {
  const existing = isPlainObject(existingTradeManagement)
    ? existingTradeManagement
    : getDefaultTradeManagement();

  if (partial && input === undefined) {
    return undefined;
  }

  if (input == null) {
    input = {};
  }

  if (!isPlainObject(input)) {
    throw buildValidationError([
      { field: 'tradeManagement', message: 'Must be an object' },
    ]);
  }

  const cleaned = partial ? {} : getDefaultTradeManagement();

  const hasBreakeven = Object.prototype.hasOwnProperty.call(input, 'breakeven');

  if (!partial || hasBreakeven) {
    const baseConfig = getProfileBreakeven({ tradeManagement: existing });
    const sourceConfig = hasBreakeven ? input.breakeven : baseConfig;
    cleaned.breakeven = normalizeBreakevenConfig(sourceConfig, {
      partial,
      defaults: baseConfig,
      baseConfig,
    });
  }

  // Accept optional profile-level exitPlan default (new). Old profiles work
  // without it because resolveEffectiveExitPlan lifts breakeven into an
  // exitPlan shape transparently.
  if (Object.prototype.hasOwnProperty.call(input, 'exitPlan')) {
    if (input.exitPlan == null) {
      cleaned.exitPlan = null;
    } else {
      cleaned.exitPlan = normalizeExitPlan(input.exitPlan, { baseConfig: DEFAULT_EXIT_PLAN });
    }
  }

  if (partial && Object.keys(cleaned).length === 0) {
    return undefined;
  }

  return cleaned;
}

function normalizeStrategyTradeManagement(input, { activeProfile = null } = {}) {
  if (input === undefined) {
    return undefined;
  }

  if (input == null || !isPlainObject(input)) {
    throw buildValidationError([
      { field: 'tradeManagement', message: 'Must be an object' },
    ]);
  }

  const cleaned = {};
  const hasBreakevenOverride = Object.prototype.hasOwnProperty.call(input, 'breakevenOverride');
  const hasExitPlanOverride = Object.prototype.hasOwnProperty.call(input, 'exitPlanOverride');

  if (!hasBreakevenOverride && !hasExitPlanOverride) {
    return undefined;
  }

  if (hasBreakevenOverride) {
    if (input.breakevenOverride === null) {
      cleaned.breakevenOverride = null;
    } else {
      const baseConfig = getProfileBreakeven(activeProfile);
      cleaned.breakevenOverride = normalizeBreakevenConfig(input.breakevenOverride, {
        partial: true,
        baseConfig,
      });
    }
  }

  if (hasExitPlanOverride) {
    if (input.exitPlanOverride === null) {
      cleaned.exitPlanOverride = null;
    } else {
      // Resolve base from profile so override merges consistently.
      const profileBase = resolveEffectiveExitPlan(activeProfile, null, null);
      cleaned.exitPlanOverride = normalizeExitPlan(input.exitPlanOverride, {
        baseConfig: profileBase,
      });
    }
  }

  return cleaned;
}

function getProfileBreakeven(profile) {
  const configured = profile?.tradeManagement?.breakeven;
  if (!isPlainObject(configured)) {
    return getDefaultBreakevenConfig();
  }

  try {
    return normalizeBreakevenConfig(configured, {
      partial: false,
      defaults: DEFAULT_BREAKEVEN_CONFIG,
      baseConfig: DEFAULT_BREAKEVEN_CONFIG,
    });
  } catch (err) {
    return getDefaultBreakevenConfig();
  }
}

function resolveEffectiveBreakeven(activeProfile, strategy = null) {
  const profileConfig = getProfileBreakeven(activeProfile);
  const override = strategy?.tradeManagement?.breakevenOverride;

  if (!isPlainObject(override)) {
    return profileConfig;
  }

  try {
    const sparseOverride = normalizeBreakevenConfig(override, {
      partial: true,
      baseConfig: profileConfig,
    });
    return {
      ...profileConfig,
      ...sparseOverride,
    };
  } catch (err) {
    return profileConfig;
  }
}

function getPositionBreakevenConfig(position) {
  if (isPlainObject(position?.breakevenConfig)) {
    try {
      return normalizeBreakevenConfig(position.breakevenConfig, {
        partial: false,
        defaults: DEFAULT_BREAKEVEN_CONFIG,
        baseConfig: DEFAULT_BREAKEVEN_CONFIG,
      });
    } catch (err) {
      // Fall back to legacy behavior for malformed historical records.
    }
  }

  return getLegacyBreakevenConfig();
}

function hasPositionBreakevenSnapshot(position) {
  return isPlainObject(position?.breakevenConfig);
}

function getPriceDecimals(instrument) {
  if (!instrument || !Number.isFinite(Number(instrument.pipSize))) {
    return 5;
  }

  const pipSize = Number(instrument.pipSize);
  if (pipSize < 0.001) return 5;
  if (pipSize < 0.01) return 3;
  return 2;
}

function roundPrice(value, instrument) {
  return parseFloat(Number(value).toFixed(getPriceDecimals(instrument)));
}

// ─── exitPlan layer (additive) ──────────────────────────────────────────────
// The exitPlan is a richer contract that lives alongside breakevenConfig and
// describes the full exit behaviour of a trade: breakeven phase, trailing
// phase (with mode variants), partial take-profits and an optional time-based
// exit. Strategies supply a default via buildExitPlan() and may override at
// runtime via evaluateExit() for adaptive behaviour.

const DEFAULT_EXIT_PLAN = Object.freeze({
  breakeven: {
    enabled: true,
    triggerAtrMultiple: 0.8,
    includeSpreadCompensation: true,
    extraBufferPips: 0,
  },
  trailing: {
    enabled: true,
    startAtrMultiple: 1.5,
    distanceAtrMultiple: 1.0,
    mode: 'atr',
  },
  partials: [],
  timeExit: null,
  adaptiveEvaluator: null,
});

const VALID_TRAILING_MODES = new Set(['atr', 'structure', 'chandelier']);

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
}

function clonePartial(entry) {
  return {
    atProfitAtr: Number(entry.atProfitAtr),
    closeFraction: Number(entry.closeFraction),
    label: entry.label ? String(entry.label) : null,
  };
}

function cloneExitPlan(plan) {
  return {
    breakeven: {
      enabled: Boolean(plan.breakeven.enabled),
      triggerAtrMultiple: Number(plan.breakeven.triggerAtrMultiple),
      includeSpreadCompensation: Boolean(plan.breakeven.includeSpreadCompensation),
      extraBufferPips: Number(plan.breakeven.extraBufferPips),
    },
    trailing: {
      enabled: Boolean(plan.trailing.enabled),
      startAtrMultiple: Number(plan.trailing.startAtrMultiple),
      distanceAtrMultiple: Number(plan.trailing.distanceAtrMultiple),
      mode: plan.trailing.mode || 'atr',
    },
    partials: Array.isArray(plan.partials)
      ? plan.partials.map((entry) => clonePartial(entry))
      : [],
    timeExit: plan.timeExit
      ? {
          maxHoldMinutes: Number(plan.timeExit.maxHoldMinutes),
          reason: plan.timeExit.reason ? String(plan.timeExit.reason) : 'TIME_EXIT',
        }
      : null,
    adaptiveEvaluator: plan.adaptiveEvaluator ? String(plan.adaptiveEvaluator) : null,
  };
}

function getDefaultExitPlan() {
  return cloneExitPlan(DEFAULT_EXIT_PLAN);
}

function breakevenConfigToExitPlan(breakevenConfig) {
  const normalized = normalizeBreakevenConfig(breakevenConfig, {
    partial: false,
    defaults: DEFAULT_BREAKEVEN_CONFIG,
    baseConfig: DEFAULT_BREAKEVEN_CONFIG,
  });
  return {
    breakeven: {
      enabled: normalized.enabled,
      triggerAtrMultiple: normalized.triggerAtrMultiple,
      includeSpreadCompensation: normalized.includeSpreadCompensation,
      extraBufferPips: normalized.extraBufferPips,
    },
    trailing: {
      enabled: normalized.enabled,
      startAtrMultiple: normalized.trailStartAtrMultiple,
      distanceAtrMultiple: normalized.trailDistanceAtrMultiple,
      mode: 'atr',
    },
    partials: [],
    timeExit: null,
    adaptiveEvaluator: null,
  };
}

function exitPlanToBreakevenConfig(plan) {
  return {
    enabled: plan.breakeven.enabled && plan.trailing.enabled,
    triggerAtrMultiple: plan.breakeven.triggerAtrMultiple,
    includeSpreadCompensation: plan.breakeven.includeSpreadCompensation,
    extraBufferPips: plan.breakeven.extraBufferPips,
    trailStartAtrMultiple: plan.trailing.startAtrMultiple,
    trailDistanceAtrMultiple: plan.trailing.distanceAtrMultiple,
  };
}

function normalizeBreakevenSubPlan(input, errors, basePath, base) {
  const out = {
    enabled: base.enabled,
    triggerAtrMultiple: base.triggerAtrMultiple,
    includeSpreadCompensation: base.includeSpreadCompensation,
    extraBufferPips: base.extraBufferPips,
  };
  if (!isPlainObject(input)) {
    return out;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'enabled')) {
    out.enabled = normalizeBooleanField(input.enabled, `${basePath}.enabled`, errors);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'triggerAtrMultiple')) {
    const val = normalizePositiveNumberField(
      input.triggerAtrMultiple,
      `${basePath}.triggerAtrMultiple`,
      errors
    );
    if (val !== null) out.triggerAtrMultiple = val;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'includeSpreadCompensation')) {
    out.includeSpreadCompensation = normalizeBooleanField(
      input.includeSpreadCompensation,
      `${basePath}.includeSpreadCompensation`,
      errors
    );
  }
  if (Object.prototype.hasOwnProperty.call(input, 'extraBufferPips')) {
    const val = normalizePositiveNumberField(
      input.extraBufferPips,
      `${basePath}.extraBufferPips`,
      errors,
      { allowZero: true }
    );
    if (val !== null) out.extraBufferPips = val;
  }
  return out;
}

function normalizeTrailingSubPlan(input, errors, basePath, base) {
  const out = {
    enabled: base.enabled,
    startAtrMultiple: base.startAtrMultiple,
    distanceAtrMultiple: base.distanceAtrMultiple,
    mode: base.mode || 'atr',
  };
  if (!isPlainObject(input)) {
    return out;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'enabled')) {
    out.enabled = normalizeBooleanField(input.enabled, `${basePath}.enabled`, errors);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'startAtrMultiple')) {
    const val = normalizePositiveNumberField(
      input.startAtrMultiple,
      `${basePath}.startAtrMultiple`,
      errors
    );
    if (val !== null) out.startAtrMultiple = val;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'distanceAtrMultiple')) {
    const val = normalizePositiveNumberField(
      input.distanceAtrMultiple,
      `${basePath}.distanceAtrMultiple`,
      errors
    );
    if (val !== null) out.distanceAtrMultiple = val;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'mode')) {
    const mode = String(input.mode || 'atr');
    if (!VALID_TRAILING_MODES.has(mode)) {
      errors.push({ field: `${basePath}.mode`, message: `Must be one of ${[...VALID_TRAILING_MODES].join(', ')}` });
    } else {
      out.mode = mode;
    }
  }
  return out;
}

function normalizePartials(input, errors, basePath) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    errors.push({ field: basePath, message: 'Must be an array' });
    return [];
  }
  const cleaned = [];
  input.forEach((entry, idx) => {
    if (!isPlainObject(entry)) {
      errors.push({ field: `${basePath}[${idx}]`, message: 'Must be an object' });
      return;
    }
    const atProfitAtr = Number(entry.atProfitAtr);
    const closeFraction = Number(entry.closeFraction);
    if (!Number.isFinite(atProfitAtr) || atProfitAtr <= 0) {
      errors.push({ field: `${basePath}[${idx}].atProfitAtr`, message: 'Must be greater than 0' });
      return;
    }
    if (!Number.isFinite(closeFraction) || closeFraction <= 0 || closeFraction >= 1) {
      errors.push({
        field: `${basePath}[${idx}].closeFraction`,
        message: 'Must be greater than 0 and less than 1',
      });
      return;
    }
    cleaned.push({
      atProfitAtr: roundConfigNumber(atProfitAtr),
      closeFraction: roundConfigNumber(closeFraction),
      label: entry.label ? String(entry.label) : null,
    });
  });
  cleaned.sort((a, b) => a.atProfitAtr - b.atProfitAtr);
  return cleaned;
}

function normalizeTimeExit(input, errors, basePath) {
  if (input === undefined || input === null) return null;
  if (!isPlainObject(input)) {
    errors.push({ field: basePath, message: 'Must be an object or null' });
    return null;
  }
  const maxHoldMinutes = Number(input.maxHoldMinutes);
  if (!Number.isFinite(maxHoldMinutes) || maxHoldMinutes <= 0) {
    errors.push({ field: `${basePath}.maxHoldMinutes`, message: 'Must be greater than 0' });
    return null;
  }
  return {
    maxHoldMinutes: Math.round(maxHoldMinutes),
    reason: input.reason ? String(input.reason) : 'TIME_EXIT',
  };
}

function normalizeExitPlan(input, { baseConfig = DEFAULT_EXIT_PLAN } = {}) {
  if (input == null) {
    return cloneExitPlan(baseConfig);
  }
  if (!isPlainObject(input)) {
    throw buildValidationError([{ field: 'exitPlan', message: 'Must be an object' }]);
  }

  const base = cloneExitPlan(baseConfig);
  const errors = [];
  const breakeven = normalizeBreakevenSubPlan(input.breakeven, errors, 'exitPlan.breakeven', base.breakeven);
  const trailing = normalizeTrailingSubPlan(input.trailing, errors, 'exitPlan.trailing', base.trailing);
  const partials = Object.prototype.hasOwnProperty.call(input, 'partials')
    ? normalizePartials(input.partials, errors, 'exitPlan.partials')
    : base.partials;
  const timeExit = Object.prototype.hasOwnProperty.call(input, 'timeExit')
    ? normalizeTimeExit(input.timeExit, errors, 'exitPlan.timeExit')
    : base.timeExit;
  const adaptiveEvaluator = Object.prototype.hasOwnProperty.call(input, 'adaptiveEvaluator')
    ? (input.adaptiveEvaluator == null ? null : String(input.adaptiveEvaluator))
    : base.adaptiveEvaluator;

  if (
    isFiniteNumber(trailing.startAtrMultiple)
    && isFiniteNumber(breakeven.triggerAtrMultiple)
    && trailing.enabled
    && trailing.startAtrMultiple < breakeven.triggerAtrMultiple
  ) {
    errors.push({
      field: 'exitPlan.trailing.startAtrMultiple',
      message: 'Must be greater than or equal to breakeven.triggerAtrMultiple when trailing is enabled',
    });
  }

  if (errors.length > 0) {
    throw buildValidationError(errors);
  }

  return { breakeven, trailing, partials, timeExit, adaptiveEvaluator };
}

function resolveEffectiveExitPlan(activeProfile, strategy = null, signalExitPlan = null) {
  // Precedence: signal > strategy.exitPlanOverride > strategy.breakevenOverride (legacy) > profile.exitPlan > profile.breakeven (legacy) > default
  let base = getDefaultExitPlan();

  // profile.tradeManagement.breakeven (legacy) lifted into exitPlan shape
  const profileBreakeven = activeProfile?.tradeManagement?.breakeven;
  if (isPlainObject(profileBreakeven)) {
    try {
      base = breakevenConfigToExitPlan(profileBreakeven);
    } catch (err) {
      // fall back to defaults
    }
  }

  // profile.tradeManagement.exitPlan (new, if present)
  const profileExitPlan = activeProfile?.tradeManagement?.exitPlan;
  if (isPlainObject(profileExitPlan)) {
    try {
      base = normalizeExitPlan(profileExitPlan, { baseConfig: base });
    } catch (err) {
      // keep prior base
    }
  }

  // strategy.tradeManagement.breakevenOverride (legacy) — sparse merge over breakeven+trailing
  const strategyBreakevenOverride = strategy?.tradeManagement?.breakevenOverride;
  if (isPlainObject(strategyBreakevenOverride)) {
    try {
      const partialOverride = normalizeBreakevenConfig(strategyBreakevenOverride, {
        partial: true,
        baseConfig: exitPlanToBreakevenConfig(base),
      });
      // Only copy the fields that were actually provided — avoid passing
      // `undefined` into normalizeExitPlan, which treats own-properties as
      // intentional overrides and would reject them.
      const breakevenPatch = {};
      if (partialOverride.enabled !== undefined) breakevenPatch.enabled = partialOverride.enabled;
      if (partialOverride.triggerAtrMultiple !== undefined) breakevenPatch.triggerAtrMultiple = partialOverride.triggerAtrMultiple;
      if (partialOverride.includeSpreadCompensation !== undefined) breakevenPatch.includeSpreadCompensation = partialOverride.includeSpreadCompensation;
      if (partialOverride.extraBufferPips !== undefined) breakevenPatch.extraBufferPips = partialOverride.extraBufferPips;
      const trailingPatch = {};
      if (partialOverride.enabled !== undefined) trailingPatch.enabled = partialOverride.enabled;
      if (partialOverride.trailStartAtrMultiple !== undefined) trailingPatch.startAtrMultiple = partialOverride.trailStartAtrMultiple;
      if (partialOverride.trailDistanceAtrMultiple !== undefined) trailingPatch.distanceAtrMultiple = partialOverride.trailDistanceAtrMultiple;
      const patch = {};
      if (Object.keys(breakevenPatch).length > 0) patch.breakeven = breakevenPatch;
      if (Object.keys(trailingPatch).length > 0) patch.trailing = trailingPatch;
      if (Object.keys(patch).length > 0) {
        base = normalizeExitPlan(patch, { baseConfig: base });
      }
    } catch (err) {
      // ignore override
    }
  }

  // strategy.tradeManagement.exitPlanOverride (new) — sparse
  const strategyExitPlanOverride = strategy?.tradeManagement?.exitPlanOverride;
  if (isPlainObject(strategyExitPlanOverride)) {
    try {
      base = normalizeExitPlan(strategyExitPlanOverride, { baseConfig: base });
    } catch (err) {
      // ignore override
    }
  }

  // signal.exitPlan — highest priority (owned by the strategy's analyze())
  if (isPlainObject(signalExitPlan)) {
    try {
      base = normalizeExitPlan(signalExitPlan, { baseConfig: base });
    } catch (err) {
      // ignore bad signal-level plan
    }
  }

  return base;
}

function getPositionExitPlan(position) {
  if (isPlainObject(position?.exitPlan)) {
    try {
      return normalizeExitPlan(position.exitPlan, { baseConfig: DEFAULT_EXIT_PLAN });
    } catch (err) {
      // fall through to breakevenConfig fallback
    }
  }
  if (isPlainObject(position?.breakevenConfig)) {
    try {
      return breakevenConfigToExitPlan(position.breakevenConfig);
    } catch (err) {
      // fall through
    }
  }
  return breakevenConfigToExitPlan(LEGACY_BREAKEVEN_CONFIG);
}

/**
 * Execute the BE / trailing phase of an exitPlan.
 * Returns { shouldUpdate, newSl, phase, planUsed }.
 *
 * phase values: 'initial' | 'breakeven' | 'trailing' | 'disabled' | 'none'
 *
 * trailing.mode is respected:
 *   - 'atr' (default): SL = currentPrice - distance*ATR
 *   - 'chandelier': SL anchored to max-favourable excursion, not current price
 *   - 'structure': caller must supply structureLevel via position.structureAnchor
 */
function calculateExitAdjustment(position, currentPrice, instrument, exitPlan = null) {
  const { type, entryPrice, currentSl, atrAtEntry } = position || {};
  const currentMarketPrice = Number(currentPrice);

  if (
    !instrument
    || !Number.isFinite(currentMarketPrice)
    || !Number.isFinite(Number(entryPrice))
    || !Number.isFinite(Number(currentSl))
    || !Number.isFinite(Number(atrAtEntry))
    || Number(atrAtEntry) <= 0
  ) {
    return { shouldUpdate: false, newSl: currentSl, phase: 'none' };
  }

  const plan = exitPlan
    ? normalizeExitPlan(exitPlan, { baseConfig: DEFAULT_EXIT_PLAN })
    : getPositionExitPlan(position);

  if (!plan.breakeven.enabled && !plan.trailing.enabled) {
    return { shouldUpdate: false, newSl: currentSl, phase: 'disabled', planUsed: plan };
  }

  const atr = Number(atrAtEntry);
  const spreadCompensation = plan.breakeven.includeSpreadCompensation
    ? Number(instrument.spread || 0) * Number(instrument.pipSize || 0)
    : 0;
  const bufferDistance = Number(plan.breakeven.extraBufferPips || 0) * Number(instrument.pipSize || 0);
  const currentStop = Number(currentSl);
  const positionEntry = Number(entryPrice);
  const profitDistance = type === 'BUY'
    ? currentMarketPrice - positionEntry
    : positionEntry - currentMarketPrice;

  let newSl = currentStop;
  let phase = 'initial';

  // Trailing takes precedence when both thresholds are met.
  if (plan.trailing.enabled && profitDistance >= plan.trailing.startAtrMultiple * atr) {
    const distance = plan.trailing.distanceAtrMultiple * atr;
    if (plan.trailing.mode === 'chandelier') {
      const anchor = Number(position?.maxFavourablePrice);
      if (Number.isFinite(anchor) && anchor > 0) {
        newSl = type === 'BUY' ? anchor - distance : anchor + distance;
      } else {
        newSl = type === 'BUY' ? currentMarketPrice - distance : currentMarketPrice + distance;
      }
    } else if (plan.trailing.mode === 'structure') {
      const anchor = Number(position?.structureAnchor);
      if (Number.isFinite(anchor) && anchor > 0) {
        newSl = type === 'BUY' ? anchor - distance : anchor + distance;
      } else {
        newSl = type === 'BUY' ? currentMarketPrice - distance : currentMarketPrice + distance;
      }
    } else {
      newSl = type === 'BUY' ? currentMarketPrice - distance : currentMarketPrice + distance;
    }
    phase = 'trailing';
  } else if (plan.breakeven.enabled && profitDistance >= plan.breakeven.triggerAtrMultiple * atr) {
    newSl = type === 'BUY'
      ? positionEntry + spreadCompensation + bufferDistance
      : positionEntry - spreadCompensation - bufferDistance;
    phase = 'breakeven';
  }

  if (type === 'BUY' && newSl <= currentStop) {
    return { shouldUpdate: false, newSl: currentSl, phase, planUsed: plan };
  }
  if (type === 'SELL' && newSl >= currentStop) {
    return { shouldUpdate: false, newSl: currentSl, phase, planUsed: plan };
  }

  return {
    shouldUpdate: true,
    newSl: roundPrice(newSl, instrument),
    phase,
    planUsed: plan,
  };
}

/**
 * Evaluate partial take-profit triggers that haven't been executed yet.
 * Returns an array of { index, atProfitAtr, closeFraction, label } describing
 * which partials should fire now. Callers are responsible for persisting
 * position.partialsExecutedIndices to prevent re-firing.
 */
function findPartialTriggers(position, currentPrice, exitPlan = null) {
  const { type, entryPrice, atrAtEntry } = position || {};
  const price = Number(currentPrice);
  if (
    !Number.isFinite(price)
    || !Number.isFinite(Number(entryPrice))
    || !Number.isFinite(Number(atrAtEntry))
    || Number(atrAtEntry) <= 0
  ) {
    return [];
  }

  const plan = exitPlan
    ? normalizeExitPlan(exitPlan, { baseConfig: DEFAULT_EXIT_PLAN })
    : getPositionExitPlan(position);

  if (!plan.partials || plan.partials.length === 0) return [];

  const atr = Number(atrAtEntry);
  const profitDistance = type === 'BUY'
    ? price - Number(entryPrice)
    : Number(entryPrice) - price;
  const executed = new Set(position.partialsExecutedIndices || []);

  const triggers = [];
  plan.partials.forEach((partial, index) => {
    if (executed.has(index)) return;
    if (profitDistance >= partial.atProfitAtr * atr) {
      triggers.push({ index, ...partial });
    }
  });
  return triggers;
}

/**
 * Return { exceeded: boolean, reason: string } for position.openedAt against
 * plan.timeExit.maxHoldMinutes. Uses Date.now() if openedAt unparseable.
 */
function isTimeExitTriggered(position, nowMs = Date.now(), exitPlan = null) {
  const plan = exitPlan
    ? normalizeExitPlan(exitPlan, { baseConfig: DEFAULT_EXIT_PLAN })
    : getPositionExitPlan(position);
  if (!plan.timeExit || !plan.timeExit.maxHoldMinutes) {
    return { exceeded: false, reason: null };
  }
  const opened = position?.openedAt ? new Date(position.openedAt).getTime() : null;
  if (!opened || !Number.isFinite(opened)) {
    return { exceeded: false, reason: null };
  }
  const elapsedMinutes = (nowMs - opened) / 60000;
  if (elapsedMinutes >= plan.timeExit.maxHoldMinutes) {
    return { exceeded: true, reason: plan.timeExit.reason || 'TIME_EXIT', elapsedMinutes };
  }
  return { exceeded: false, reason: null };
}

function calculateBreakevenStop(position, currentPrice, instrument, config = null) {
  const { type, entryPrice, currentSl, atrAtEntry } = position || {};
  const currentMarketPrice = Number(currentPrice);

  if (
    !instrument
    || !Number.isFinite(currentMarketPrice)
    || !Number.isFinite(Number(entryPrice))
    || !Number.isFinite(Number(currentSl))
    || !Number.isFinite(Number(atrAtEntry))
    || Number(atrAtEntry) <= 0
  ) {
    return { shouldUpdate: false, newSl: currentSl, phase: 'none' };
  }

  const effectiveConfig = config
    ? normalizeBreakevenConfig(config, {
        partial: false,
        defaults: DEFAULT_BREAKEVEN_CONFIG,
        baseConfig: DEFAULT_BREAKEVEN_CONFIG,
      })
    : getPositionBreakevenConfig(position);

  if (!effectiveConfig.enabled) {
    return { shouldUpdate: false, newSl: currentSl, phase: 'disabled', configUsed: effectiveConfig };
  }

  const atr = Number(atrAtEntry);
  const spreadCompensation = effectiveConfig.includeSpreadCompensation
    ? Number(instrument.spread || 0) * Number(instrument.pipSize || 0)
    : 0;
  const bufferDistance = Number(effectiveConfig.extraBufferPips || 0) * Number(instrument.pipSize || 0);
  const currentStop = Number(currentSl);
  const positionEntry = Number(entryPrice);
  const profitDistance = type === 'BUY'
    ? currentMarketPrice - positionEntry
    : positionEntry - currentMarketPrice;

  let newSl = currentStop;
  let phase = 'initial';

  if (type === 'BUY') {
    if (profitDistance >= effectiveConfig.trailStartAtrMultiple * atr) {
      newSl = currentMarketPrice - (effectiveConfig.trailDistanceAtrMultiple * atr);
      phase = 'trailing';
    } else if (profitDistance >= effectiveConfig.triggerAtrMultiple * atr) {
      newSl = positionEntry + spreadCompensation + bufferDistance;
      phase = 'breakeven';
    }

    if (newSl <= currentStop) {
      return { shouldUpdate: false, newSl: currentSl, phase, configUsed: effectiveConfig };
    }
  } else {
    if (profitDistance >= effectiveConfig.trailStartAtrMultiple * atr) {
      newSl = currentMarketPrice + (effectiveConfig.trailDistanceAtrMultiple * atr);
      phase = 'trailing';
    } else if (profitDistance >= effectiveConfig.triggerAtrMultiple * atr) {
      newSl = positionEntry - spreadCompensation - bufferDistance;
      phase = 'breakeven';
    }

    if (newSl >= currentStop) {
      return { shouldUpdate: false, newSl: currentSl, phase, configUsed: effectiveConfig };
    }
  }

  return {
    shouldUpdate: true,
    newSl: roundPrice(newSl, instrument),
    phase,
    configUsed: effectiveConfig,
  };
}

module.exports = {
  DEFAULT_BREAKEVEN_CONFIG,
  LEGACY_BREAKEVEN_CONFIG,
  DEFAULT_EXIT_PLAN,
  buildValidationError,
  getDefaultBreakevenConfig,
  getLegacyBreakevenConfig,
  getDefaultTradeManagement,
  normalizeBreakevenConfig,
  normalizeProfileTradeManagement,
  normalizeStrategyTradeManagement,
  getProfileBreakeven,
  resolveEffectiveBreakeven,
  getPositionBreakevenConfig,
  hasPositionBreakevenSnapshot,
  calculateBreakevenStop,
  // exitPlan layer
  getDefaultExitPlan,
  normalizeExitPlan,
  resolveEffectiveExitPlan,
  getPositionExitPlan,
  calculateExitAdjustment,
  findPartialTriggers,
  isTimeExitTriggered,
  breakevenConfigToExitPlan,
  exitPlanToBreakevenConfig,
};
