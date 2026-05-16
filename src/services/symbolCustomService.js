const SymbolCustom = require('../models/SymbolCustom');
const { getSymbolCustomLogic } = require('../symbolCustom/registry');

const SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1 = 'SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1';
const DEFAULT_ALLOW_MULTIPLE_LIVE_SYMBOL_CUSTOMS_PER_SYMBOL = false;

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

function normalizeBooleanFilter(value) {
  if (value === true || value === false) return value;
  if (value === undefined || value === null || value === '') return undefined;

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function buildListFilter(filter = {}) {
  const query = {};
  const symbol = normalizeSymbol(filter.symbol);
  if (symbol) query.symbol = symbol;

  const status = String(filter.status || '').trim();
  if (status) query.status = status;

  for (const field of ['paperEnabled', 'liveEnabled', 'isPrimaryLive']) {
    const normalized = normalizeBooleanFilter(filter[field]);
    if (normalized !== undefined) {
      query[field] = normalized;
    }
  }

  return query;
}

function buildWarnings(payload = {}) {
  return payload.liveEnabled === true
    ? [SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1]
    : [];
}

function buildMutationResult(symbolCustom, payload = {}) {
  return {
    symbolCustom,
    warnings: buildWarnings(payload),
  };
}

function getLogicName(symbolCustom = {}) {
  return String(
    symbolCustom.logicName
    || symbolCustom.registryLogicName
    || symbolCustom.symbolCustomName
    || ''
  ).trim();
}

function getSchemaFieldKey(field = {}) {
  return String(field.key || field.name || '').trim();
}

function getDefaultLogicSchema(logic) {
  if (!logic || typeof logic.getDefaultParameterSchema !== 'function') return [];
  const schema = logic.getDefaultParameterSchema();
  return Array.isArray(schema) ? cloneValue(schema) : [];
}

function getDefaultLogicParameters(logic) {
  if (!logic || typeof logic.getDefaultParameters !== 'function') return {};
  const parameters = logic.getDefaultParameters();
  return isPlainObject(parameters) ? cloneValue(parameters) : {};
}

function buildSchemaSyncStatus(symbolCustom) {
  if (!symbolCustom) return null;

  const logicName = getLogicName(symbolCustom);
  const logic = getSymbolCustomLogic(logicName);
  if (!logic) {
    return {
      logicName,
      registered: false,
      missingParameters: [],
      missingSchemaFields: [],
      hasMissing: false,
    };
  }

  const defaultSchema = getDefaultLogicSchema(logic);
  const defaultParameters = getDefaultLogicParameters(logic);
  const existingParameters = isPlainObject(symbolCustom.parameters) ? symbolCustom.parameters : {};
  const existingSchema = Array.isArray(symbolCustom.parameterSchema) ? symbolCustom.parameterSchema : [];
  const existingSchemaKeys = new Set(existingSchema.map(getSchemaFieldKey).filter(Boolean));

  const missingParameters = Object.keys(defaultParameters)
    .filter((key) => !Object.prototype.hasOwnProperty.call(existingParameters, key));
  const missingSchemaFields = defaultSchema
    .map(getSchemaFieldKey)
    .filter((key) => key && !existingSchemaKeys.has(key));

  return {
    logicName,
    registered: true,
    missingParameters,
    missingSchemaFields,
    hasMissing: missingParameters.length > 0 || missingSchemaFields.length > 0,
  };
}

function withSchemaSyncStatus(symbolCustom) {
  if (!symbolCustom) return symbolCustom;
  return {
    ...symbolCustom,
    schemaSyncStatus: buildSchemaSyncStatus(symbolCustom),
  };
}

function buildLogicNotRegisteredError(logicName) {
  const error = new Error('SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED');
  error.statusCode = 400;
  error.reasonCode = 'SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED';
  error.details = [{ field: 'logicName', message: `SymbolCustom logic is not registered: ${logicName || '--'}` }];
  return error;
}

async function enforceSinglePrimaryLive(symbol, primaryId, options = {}) {
  const allowMultiple = options.allowMultipleLiveSymbolCustomsPerSymbol
    ?? DEFAULT_ALLOW_MULTIPLE_LIVE_SYMBOL_CUSTOMS_PER_SYMBOL;

  if (allowMultiple || !symbol || !primaryId) {
    return;
  }

  const records = await SymbolCustom.findBySymbol(symbol);
  await Promise.all(
    records
      .filter((record) => record._id !== primaryId && record.isPrimaryLive === true)
      .map((record) => SymbolCustom.update(record._id, { isPrimaryLive: false }))
  );
}

async function listSymbolCustoms(filter = {}) {
  const rows = await SymbolCustom.findAll(buildListFilter(filter));
  return rows.map(withSchemaSyncStatus);
}

async function getSymbolCustom(id) {
  return withSchemaSyncStatus(await SymbolCustom.findById(id));
}

async function getSymbolCustomsBySymbol(symbol) {
  const rows = await SymbolCustom.findBySymbol(symbol);
  return rows.map(withSchemaSyncStatus);
}

async function createSymbolCustom(payload = {}, options = {}) {
  const created = await SymbolCustom.create(payload);
  if (created.isPrimaryLive === true) {
    await enforceSinglePrimaryLive(created.symbol, created._id, options);
  }

  return buildMutationResult(withSchemaSyncStatus(await SymbolCustom.findById(created._id)), payload);
}

async function updateSymbolCustom(id, payload = {}, options = {}) {
  const updated = await SymbolCustom.update(id, payload);
  if (!updated) {
    return null;
  }

  if (updated.isPrimaryLive === true) {
    await enforceSinglePrimaryLive(updated.symbol, updated._id, options);
  }

  return buildMutationResult(withSchemaSyncStatus(await SymbolCustom.findById(updated._id)), payload);
}

async function deleteSymbolCustom(id) {
  return SymbolCustom.remove(id);
}

async function duplicateSymbolCustom(id, overrides = {}, options = {}) {
  const duplicated = await SymbolCustom.duplicate(id, overrides);
  if (!duplicated) {
    return null;
  }

  let effectiveRecord = duplicated;
  const postDuplicatePatch = {};
  for (const field of ['paperEnabled', 'liveEnabled', 'isPrimaryLive', 'allowLive']) {
    if (overrides[field] !== undefined) {
      postDuplicatePatch[field] = overrides[field];
    }
  }

  if (Object.keys(postDuplicatePatch).length > 0) {
    effectiveRecord = await SymbolCustom.update(duplicated._id, postDuplicatePatch);
  }

  if (effectiveRecord.isPrimaryLive === true) {
    await enforceSinglePrimaryLive(effectiveRecord.symbol, effectiveRecord._id, options);
  }

  return buildMutationResult(withSchemaSyncStatus(await SymbolCustom.findById(effectiveRecord._id)), overrides);
}

async function syncSymbolCustomSchemaFromLogic(id, _options = {}) {
  const existing = await SymbolCustom.findById(id);
  if (!existing) return null;

  const logicName = getLogicName(existing);
  const logic = getSymbolCustomLogic(logicName);
  if (!logic) {
    throw buildLogicNotRegisteredError(logicName);
  }

  const defaultSchema = getDefaultLogicSchema(logic);
  const defaultParameters = getDefaultLogicParameters(logic);
  const existingSchema = Array.isArray(existing.parameterSchema) ? cloneValue(existing.parameterSchema) : [];
  const existingParameters = isPlainObject(existing.parameters) ? cloneValue(existing.parameters) : {};
  const schemaKeys = new Set(existingSchema.map(getSchemaFieldKey).filter(Boolean));
  const mergedSchema = [...existingSchema];
  const mergedParameters = { ...existingParameters };
  const addedSchemaFields = [];
  const addedParameters = [];
  const keptParameters = [];

  defaultSchema.forEach((field) => {
    const key = getSchemaFieldKey(field);
    if (!key || schemaKeys.has(key)) return;
    mergedSchema.push(cloneValue(field));
    schemaKeys.add(key);
    addedSchemaFields.push(key);
  });

  Object.keys(defaultParameters).forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(mergedParameters, key)) {
      keptParameters.push(key);
      return;
    }
    mergedParameters[key] = cloneValue(defaultParameters[key]);
    addedParameters.push(key);
  });

  const updated = await SymbolCustom.update(id, {
    parameterSchema: mergedSchema,
    parameters: mergedParameters,
  });

  return {
    symbolCustom: withSchemaSyncStatus(updated),
    addedParameters,
    keptParameters,
    addedSchemaFields,
  };
}

module.exports = {
  SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1,
  DEFAULT_ALLOW_MULTIPLE_LIVE_SYMBOL_CUSTOMS_PER_SYMBOL,
  listSymbolCustoms,
  getSymbolCustom,
  getSymbolCustomsBySymbol,
  createSymbolCustom,
  updateSymbolCustom,
  deleteSymbolCustom,
  duplicateSymbolCustom,
  syncSymbolCustomSchemaFromLogic,
  buildSchemaSyncStatus,
};
