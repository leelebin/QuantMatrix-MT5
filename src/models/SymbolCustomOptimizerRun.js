const { symbolCustomOptimizerRunsDb } = require('../config/db');

const VALID_STATUSES = Object.freeze([
  'queued',
  'running',
  'completed',
  'failed',
  'stub',
]);

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Date);
}

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeRequiredString(value, field, errors, { uppercase = false } = {}) {
  if (typeof value !== 'string') {
    errors.push({ field, message: 'Must be a non-empty string' });
    return undefined;
  }

  const normalized = uppercase ? normalizeSymbol(value) : value.trim();
  if (!normalized) {
    errors.push({ field, message: 'Must be a non-empty string' });
    return undefined;
  }

  return normalized;
}

function normalizeOptionalString(value, field, errors) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    errors.push({ field, message: 'Must be a string' });
    return undefined;
  }
  return value.trim();
}

function normalizeNumber(value, field, errors, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    errors.push({ field, message: 'Must be a number' });
    return undefined;
  }
  return number;
}

function normalizeArray(value, field, errors, fallback = []) {
  if (value === undefined) return cloneValue(fallback);
  if (!Array.isArray(value)) {
    errors.push({ field, message: 'Must be an array' });
    return undefined;
  }
  return cloneValue(value);
}

function buildValidationError(errors) {
  const error = new Error('Validation failed');
  error.statusCode = 400;
  error.details = errors;
  return error;
}

const SymbolCustomOptimizerRun = {
  validatePayload(payload = {}) {
    const errors = [];
    const source = isPlainObject(payload) ? payload : {};

    if (!isPlainObject(payload)) {
      errors.push({ field: 'payload', message: 'Must be an object' });
    }

    const status = String(source.status || 'queued').trim();
    if (!VALID_STATUSES.includes(status)) {
      errors.push({ field: 'status', message: `Must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const cleaned = {
      symbolCustomId: normalizeRequiredString(source.symbolCustomId, 'symbolCustomId', errors),
      symbol: normalizeRequiredString(source.symbol, 'symbol', errors, { uppercase: true }),
      symbolCustomName: normalizeRequiredString(source.symbolCustomName, 'symbolCustomName', errors),
      logicName: normalizeOptionalString(source.logicName, 'logicName', errors),
      status,
      parameterSchema: normalizeArray(source.parameterSchema, 'parameterSchema', errors),
      parameterGridPreview: normalizeArray(source.parameterGridPreview, 'parameterGridPreview', errors),
      totalCombinations: normalizeNumber(source.totalCombinations, 'totalCombinations', errors, 0),
      maxCombinations: normalizeNumber(source.maxCombinations, 'maxCombinations', errors, 50),
      results: normalizeArray(source.results, 'results', errors),
      bestResult: source.bestResult === undefined ? null : cloneValue(source.bestResult),
      message: normalizeOptionalString(source.message, 'message', errors),
      error: normalizeOptionalString(source.error, 'error', errors),
      completedAt: source.completedAt || null,
    };

    for (const key of Object.keys(cleaned)) {
      if (cleaned[key] === undefined) {
        delete cleaned[key];
      }
    }

    if (errors.length > 0) {
      throw buildValidationError(errors);
    }

    return cleaned;
  },

  async create(payload) {
    const cleaned = this.validatePayload(payload);
    const now = new Date();
    return symbolCustomOptimizerRunsDb.insert({
      ...cleaned,
      createdAt: now,
      updatedAt: now,
    });
  },

  async findAll(filter = {}) {
    return symbolCustomOptimizerRunsDb.find(filter || {}).sort({ createdAt: -1 });
  },

  async findById(id) {
    return symbolCustomOptimizerRunsDb.findOne({ _id: id });
  },

  async remove(id) {
    const existing = await this.findById(id);
    if (!existing) return null;

    await symbolCustomOptimizerRunsDb.remove({ _id: id }, {});
    return existing;
  },
};

module.exports = SymbolCustomOptimizerRun;
module.exports.VALID_STATUSES = VALID_STATUSES;
