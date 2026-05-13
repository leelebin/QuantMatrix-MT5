const BaseSymbolCustom = require('../BaseSymbolCustom');

const PLACEHOLDER_SYMBOL_CUSTOM = 'PLACEHOLDER_SYMBOL_CUSTOM';

class PlaceholderSymbolCustom extends BaseSymbolCustom {
  constructor(meta = {}) {
    super({
      ...meta,
      name: PLACEHOLDER_SYMBOL_CUSTOM,
      description: meta.description || 'Placeholder SymbolCustom logic',
    });
  }

  analyze(context = {}) {
    return {
      signal: 'NONE',
      reason: 'Placeholder SymbolCustom has no active trading logic',
      symbolCustomName: this.name,
      symbol: this.symbol,
    };
  }
}

module.exports = PlaceholderSymbolCustom;
module.exports.PLACEHOLDER_SYMBOL_CUSTOM = PLACEHOLDER_SYMBOL_CUSTOM;
