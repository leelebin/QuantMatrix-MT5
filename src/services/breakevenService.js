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
  if (!Object.prototype.hasOwnProperty.call(input, 'breakevenOverride')) {
    return undefined;
  }

  if (input.breakevenOverride === null) {
    cleaned.breakevenOverride = null;
    return cleaned;
  }

  const baseConfig = getProfileBreakeven(activeProfile);
  cleaned.breakevenOverride = normalizeBreakevenConfig(input.breakevenOverride, {
    partial: true,
    baseConfig,
  });

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
};
