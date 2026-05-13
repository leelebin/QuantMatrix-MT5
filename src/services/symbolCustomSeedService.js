const SymbolCustom = require('../models/SymbolCustom');
const { getDefaultSymbolCustomDrafts } = require('../config/defaultSymbolCustoms');

async function ensureDefaultSymbolCustomDrafts(defaultDrafts = getDefaultSymbolCustomDrafts()) {
  const created = [];
  const existing = [];

  for (const draft of defaultDrafts) {
    const existingDraft = await SymbolCustom.findByName(draft.symbol, draft.symbolCustomName);
    if (existingDraft) {
      existing.push(existingDraft);
      continue;
    }

    created.push(await SymbolCustom.create(draft));
  }

  return {
    created,
    existing,
    createdCount: created.length,
    existingCount: existing.length,
    totalCount: created.length + existing.length,
    symbolCustoms: [...existing, ...created],
  };
}

module.exports = {
  ensureDefaultSymbolCustomDrafts,
};
