const PlaceholderSymbolCustom = require('./logics/PlaceholderSymbolCustom');

const { PLACEHOLDER_SYMBOL_CUSTOM } = PlaceholderSymbolCustom;

const SYMBOL_CUSTOM_REGISTRY = Object.freeze({
  [PLACEHOLDER_SYMBOL_CUSTOM]: PlaceholderSymbolCustom,
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
