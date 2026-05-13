const SymbolCustom = require('../models/SymbolCustom');

const SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1 = 'SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1';
const DEFAULT_ALLOW_MULTIPLE_LIVE_SYMBOL_CUSTOMS_PER_SYMBOL = false;

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
  return SymbolCustom.findAll(buildListFilter(filter));
}

async function getSymbolCustom(id) {
  return SymbolCustom.findById(id);
}

async function getSymbolCustomsBySymbol(symbol) {
  return SymbolCustom.findBySymbol(symbol);
}

async function createSymbolCustom(payload = {}, options = {}) {
  const created = await SymbolCustom.create(payload);
  if (created.isPrimaryLive === true) {
    await enforceSinglePrimaryLive(created.symbol, created._id, options);
  }

  return buildMutationResult(await SymbolCustom.findById(created._id), payload);
}

async function updateSymbolCustom(id, payload = {}, options = {}) {
  const updated = await SymbolCustom.update(id, payload);
  if (!updated) {
    return null;
  }

  if (updated.isPrimaryLive === true) {
    await enforceSinglePrimaryLive(updated.symbol, updated._id, options);
  }

  return buildMutationResult(await SymbolCustom.findById(updated._id), payload);
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

  return buildMutationResult(await SymbolCustom.findById(effectiveRecord._id), overrides);
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
};
