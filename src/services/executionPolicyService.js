const DEFAULT_EXECUTION_POLICY = Object.freeze({
  minExecutionScore: 0.60,
  cooldownBarsAfterLoss: 3,
  maxSameDirectionPositionsPerSymbol: 1,
  maxSameDirectionPositionsPerCategory: 2,
  duplicateEntryWindowBars: 1,
});

function buildValidationError(details, message = 'Validation failed') {
  const error = new Error(message);
  error.statusCode = 400;
  error.details = details;
  return error;
}

function roundNumber(value, digits = 4) {
  return parseFloat(Number(value).toFixed(digits));
}

function normalizePositiveInteger(value, field, errors, { allowZero = false } = {}) {
  const numeric = Number(value);
  const valid = Number.isFinite(numeric) && Number.isInteger(numeric) && (allowZero ? numeric >= 0 : numeric > 0);
  if (!valid) {
    errors.push({
      field,
      message: allowZero ? 'Must be an integer greater than or equal to 0' : 'Must be an integer greater than 0',
    });
    return null;
  }

  return numeric;
}

function normalizeRatio(value, field, errors) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
    errors.push({
      field,
      message: 'Must be a number between 0 and 1',
    });
    return null;
  }

  return roundNumber(numeric, 4);
}

function cloneExecutionPolicy(policy = DEFAULT_EXECUTION_POLICY) {
  return {
    minExecutionScore: Number(policy.minExecutionScore),
    cooldownBarsAfterLoss: Number(policy.cooldownBarsAfterLoss),
    maxSameDirectionPositionsPerSymbol: Number(policy.maxSameDirectionPositionsPerSymbol),
    maxSameDirectionPositionsPerCategory: Number(policy.maxSameDirectionPositionsPerCategory),
    duplicateEntryWindowBars: Number(policy.duplicateEntryWindowBars),
  };
}

function normalizeExecutionPolicy(input, { partial = false, defaults = DEFAULT_EXECUTION_POLICY } = {}) {
  if (partial && input === undefined) {
    return undefined;
  }

  const base = cloneExecutionPolicy(defaults);
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const cleaned = partial ? {} : cloneExecutionPolicy(base);
  const errors = [];

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'minExecutionScore')) {
    const value = normalizeRatio(source.minExecutionScore, 'executionPolicy.minExecutionScore', errors);
    if (value !== null) cleaned.minExecutionScore = value;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'cooldownBarsAfterLoss')) {
    const value = normalizePositiveInteger(
      source.cooldownBarsAfterLoss,
      'executionPolicy.cooldownBarsAfterLoss',
      errors,
      { allowZero: true }
    );
    if (value !== null) cleaned.cooldownBarsAfterLoss = value;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'maxSameDirectionPositionsPerSymbol')) {
    const value = normalizePositiveInteger(
      source.maxSameDirectionPositionsPerSymbol,
      'executionPolicy.maxSameDirectionPositionsPerSymbol',
      errors
    );
    if (value !== null) cleaned.maxSameDirectionPositionsPerSymbol = value;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'maxSameDirectionPositionsPerCategory')) {
    const value = normalizePositiveInteger(
      source.maxSameDirectionPositionsPerCategory,
      'executionPolicy.maxSameDirectionPositionsPerCategory',
      errors
    );
    if (value !== null) cleaned.maxSameDirectionPositionsPerCategory = value;
  }

  if (!partial || Object.prototype.hasOwnProperty.call(source, 'duplicateEntryWindowBars')) {
    const value = normalizePositiveInteger(
      source.duplicateEntryWindowBars,
      'executionPolicy.duplicateEntryWindowBars',
      errors,
      { allowZero: true }
    );
    if (value !== null) cleaned.duplicateEntryWindowBars = value;
  }

  const effective = partial
    ? { ...cloneExecutionPolicy(base), ...cleaned }
    : cleaned;

  if (
    Number.isFinite(effective.maxSameDirectionPositionsPerCategory)
    && Number.isFinite(effective.maxSameDirectionPositionsPerSymbol)
    && effective.maxSameDirectionPositionsPerCategory < effective.maxSameDirectionPositionsPerSymbol
  ) {
    errors.push({
      field: 'executionPolicy.maxSameDirectionPositionsPerCategory',
      message: 'Must be greater than or equal to maxSameDirectionPositionsPerSymbol',
    });
  }

  if (errors.length > 0) {
    throw buildValidationError(errors);
  }

  return cleaned;
}

function resolveExecutionPolicy(strategyPolicy = null, instancePolicy = null) {
  let effective = cloneExecutionPolicy(DEFAULT_EXECUTION_POLICY);

  if (strategyPolicy && typeof strategyPolicy === 'object') {
    effective = {
      ...effective,
      ...normalizeExecutionPolicy(strategyPolicy, { partial: true, defaults: effective }),
    };
  }

  if (instancePolicy && typeof instancePolicy === 'object') {
    effective = {
      ...effective,
      ...normalizeExecutionPolicy(instancePolicy, { partial: true, defaults: effective }),
    };
  }

  return effective;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function calculateExecutionScore(signal = {}, policy = DEFAULT_EXECUTION_POLICY, context = {}) {
  const rawConfidence = clamp01(Number(signal.confidence));
  const marketQualityScore = Number(signal.marketQualityScore);
  const marketQualityThreshold = Number(signal.marketQualityThreshold);
  const qualityFactor = Number.isFinite(marketQualityScore) && Number.isFinite(marketQualityThreshold) && marketQualityThreshold > 0
    ? clamp01(marketQualityScore / marketQualityThreshold)
    : 1;

  const sameDirectionSymbolPositions = Math.max(0, Number(context.sameDirectionSymbolPositions) || 0);
  const sameDirectionCategoryPositions = Math.max(0, Number(context.sameDirectionCategoryPositions) || 0);
  const duplicatePenalty = context.duplicatePenalty ? 0.15 : 0;
  const symbolPenalty = sameDirectionSymbolPositions * 0.15;
  const categoryPenalty = sameDirectionCategoryPositions * 0.10;

  const score = clamp01((rawConfidence * qualityFactor) - symbolPenalty - categoryPenalty - duplicatePenalty);

  return {
    rawConfidence,
    qualityFactor,
    score: roundNumber(score, 4),
    minExecutionScore: Number(policy.minExecutionScore),
    details: {
      rawConfidence: roundNumber(rawConfidence, 4),
      qualityFactor: roundNumber(qualityFactor, 4),
      sameDirectionSymbolPositions,
      sameDirectionCategoryPositions,
      symbolPenalty: roundNumber(symbolPenalty, 4),
      categoryPenalty: roundNumber(categoryPenalty, 4),
      duplicatePenalty: roundNumber(duplicatePenalty, 4),
    },
  };
}

module.exports = {
  DEFAULT_EXECUTION_POLICY,
  cloneExecutionPolicy,
  normalizeExecutionPolicy,
  resolveExecutionPolicy,
  calculateExecutionScore,
};
