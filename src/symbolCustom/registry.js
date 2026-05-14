const PlaceholderSymbolCustom = require('./logics/PlaceholderSymbolCustom');
const UsdjpyJpyMacroReversalV1 = require('./logics/UsdjpyJpyMacroReversalV1');

const { PLACEHOLDER_SYMBOL_CUSTOM } = PlaceholderSymbolCustom;
const { USDJPY_JPY_MACRO_REVERSAL_V1 } = UsdjpyJpyMacroReversalV1;

const SYMBOL_CUSTOM_REGISTRY = Object.freeze({
  [PLACEHOLDER_SYMBOL_CUSTOM]: PlaceholderSymbolCustom,
  [USDJPY_JPY_MACRO_REVERSAL_V1]: UsdjpyJpyMacroReversalV1,
});

function normalizeSymbolCustomName(symbolCustomName) {
  return String(symbolCustomName || '').trim();
}

function getSymbolCustomLogic(symbolCustomName) {
  const normalizedName = normalizeSymbolCustomName(symbolCustomName);
  const SymbolCustomClass = SYMBOL_CUSTOM_REGISTRY[normalizedName];
  return SymbolCustomClass ? new SymbolCustomClass() : null;
}

function listRegisteredSymbolCustomLogics() {
  return Object.keys(SYMBOL_CUSTOM_REGISTRY).map((name) => ({
    name,
  }));
}

function isSymbolCustomRegistered(symbolCustomName) {
  const normalizedName = normalizeSymbolCustomName(symbolCustomName);
  return Boolean(SYMBOL_CUSTOM_REGISTRY[normalizedName]);
}

module.exports = {
  SYMBOL_CUSTOM_REGISTRY,
  getSymbolCustomLogic,
  listRegisteredSymbolCustomLogics,
  isSymbolCustomRegistered,
};
