const SymbolCustom = require('../models/SymbolCustom');
const SymbolCustomOptimizerRun = require('../models/SymbolCustomOptimizerRun');

const PHASE_1_OPTIMIZER_STUB_MESSAGE = 'SymbolCustom optimizer execution is not implemented in Phase 1';
const DEFAULT_MAX_COMBINATIONS = 50;

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

function buildHttpError(message, statusCode, details = undefined) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeLimit(value, fallback = DEFAULT_MAX_COMBINATIONS) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundGridNumber(value) {
  return Number(Number(value).toFixed(10));
}

function getSchemaKey(item = {}) {
  return String(item.key || item.name || '').trim();
}

function applyParameterOverrides(parameterSchema = [], parameterOverrides = {}) {
  const overrides = isPlainObject(parameterOverrides) ? parameterOverrides : {};
  return (Array.isArray(parameterSchema) ? parameterSchema : []).map((item) => {
    const key = getSchemaKey(item);
    const override = key ? overrides[key] : undefined;
    if (Array.isArray(override)) {
      return {
        ...cloneValue(item),
        type: 'enum',
        options: cloneValue(override),
      };
    }
    if (isPlainObject(override)) {
      return {
        ...cloneValue(item),
        ...cloneValue(override),
      };
    }
    if (override !== undefined) {
      return {
        ...cloneValue(item),
        default: override,
        defaultValue: override,
      };
    }
    return cloneValue(item);
  });
}

function buildNumberDimension(item, key) {
  const min = normalizeNumber(item.min);
  const max = normalizeNumber(item.max);
  const step = normalizeNumber(item.step);
  const defaultValue = normalizeNumber(item.defaultValue ?? item.default);

  if (min != null && max != null && step != null && step > 0 && max >= min) {
    const count = Math.floor((max - min) / step) + 1;
    return {
      key,
      count,
      valueAt(index) {
        return roundGridNumber(min + (index * step));
      },
    };
  }

  if (defaultValue != null) {
    return {
      key,
      count: 1,
      valueAt() {
        return defaultValue;
      },
    };
  }

  return null;
}

function buildEnumDimension(item, key) {
  const rawOptions = Array.isArray(item.options) ? item.options : [];
  const defaultValue = item.defaultValue ?? item.default;
  const options = rawOptions.length > 0 ? cloneValue(rawOptions) : (defaultValue === undefined ? [] : [defaultValue]);
  if (!options.length) return null;

  const ordered = defaultValue !== undefined && options.some((option) => option === defaultValue)
    ? [defaultValue, ...options.filter((option) => option !== defaultValue)]
    : options;

  return {
    key,
    count: ordered.length,
    valueAt(index) {
      return ordered[index];
    },
  };
}

function buildBooleanDimension(item, key) {
  const defaultValue = typeof item.defaultValue === 'boolean'
    ? item.defaultValue
    : (typeof item.default === 'boolean' ? item.default : false);
  const values = [defaultValue, !defaultValue];

  return {
    key,
    count: values.length,
    valueAt(index) {
      return values[index];
    },
  };
}

function buildDimension(item) {
  const key = getSchemaKey(item);
  if (!key) return null;

  const type = String(item.type || '').trim().toLowerCase();
  if (type === 'number') return buildNumberDimension(item, key);
  if (type === 'enum' || type === 'select') return buildEnumDimension(item, key);
  if (type === 'boolean' || type === 'bool') return buildBooleanDimension(item, key);

  const defaultValue = item.defaultValue ?? item.default;
  if (defaultValue !== undefined) {
    return {
      key,
      count: 1,
      valueAt() {
        return defaultValue;
      },
    };
  }

  return null;
}

function buildCombinationAt(dimensions, index) {
  let cursor = index;
  const combination = {};

  for (let dimensionIndex = dimensions.length - 1; dimensionIndex >= 0; dimensionIndex -= 1) {
    const dimension = dimensions[dimensionIndex];
    const valueIndex = cursor % dimension.count;
    combination[dimension.key] = dimension.valueAt(valueIndex);
    cursor = Math.floor(cursor / dimension.count);
  }

  return combination;
}

function buildParameterGridPreview(parameterSchema = [], maxCombinations = DEFAULT_MAX_COMBINATIONS) {
  const limit = normalizeLimit(maxCombinations);
  const dimensions = (Array.isArray(parameterSchema) ? parameterSchema : [])
    .map(buildDimension)
    .filter(Boolean);

  const totalCombinations = dimensions.reduce((total, dimension) => total * dimension.count, 1);
  const previewCount = Math.min(limit, totalCombinations);
  const parameterGridPreview = [];

  for (let index = 0; index < previewCount; index += 1) {
    parameterGridPreview.push(buildCombinationAt(dimensions, index));
  }

  return {
    parameterGridPreview,
    totalCombinations,
    maxCombinations: limit,
  };
}

function resolveLogicName(symbolCustom = {}) {
  return String(symbolCustom.logicName || symbolCustom.registryLogicName || symbolCustom.symbolCustomName || '').trim();
}

function buildListFilter(filter = {}) {
  const query = {};
  const symbol = normalizeSymbol(filter.symbol);
  if (symbol) query.symbol = symbol;

  for (const field of ['symbolCustomId', 'symbolCustomName', 'logicName', 'status']) {
    const value = String(filter[field] || '').trim();
    if (value) query[field] = value;
  }

  return query;
}

async function createOptimizerRun({ symbolCustomId, parameterOverrides, maxCombinations } = {}) {
  if (!symbolCustomId) {
    throw buildHttpError('symbolCustomId is required', 400, [
      { field: 'symbolCustomId', message: 'Required' },
    ]);
  }

  const symbolCustom = await SymbolCustom.findById(symbolCustomId);
  if (!symbolCustom) {
    throw buildHttpError('SymbolCustom not found', 404);
  }

  const parameterSchema = applyParameterOverrides(symbolCustom.parameterSchema || [], parameterOverrides || {});
  const preview = buildParameterGridPreview(parameterSchema, maxCombinations);

  return SymbolCustomOptimizerRun.create({
    symbolCustomId: symbolCustom._id,
    symbol: symbolCustom.symbol,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName: resolveLogicName(symbolCustom),
    status: 'stub',
    parameterSchema,
    parameterGridPreview: preview.parameterGridPreview,
    totalCombinations: preview.totalCombinations,
    maxCombinations: preview.maxCombinations,
    results: [],
    bestResult: null,
    message: PHASE_1_OPTIMIZER_STUB_MESSAGE,
    error: null,
    completedAt: new Date(),
  });
}

async function listOptimizerRuns(filter = {}) {
  return SymbolCustomOptimizerRun.findAll(buildListFilter(filter));
}

async function getOptimizerRun(id) {
  return SymbolCustomOptimizerRun.findById(id);
}

async function deleteOptimizerRun(id) {
  return SymbolCustomOptimizerRun.remove(id);
}

module.exports = {
  PHASE_1_OPTIMIZER_STUB_MESSAGE,
  DEFAULT_MAX_COMBINATIONS,
  createOptimizerRun,
  listOptimizerRuns,
  getOptimizerRun,
  deleteOptimizerRun,
  buildParameterGridPreview,
};
