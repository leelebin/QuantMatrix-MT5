class BaseSymbolCustom {
  constructor(meta = {}) {
    this.name = meta.name || null;
    this.symbol = meta.symbol || null;
    this.description = meta.description || '';
  }

  getDefaultParameterSchema() {
    return [];
  }

  getDefaultParameters() {
    return {};
  }

  validateContext(context = {}) {
    return { valid: true, errors: [] };
  }

  analyze(context = {}) {
    return {
      signal: 'NONE',
      reason: 'BaseSymbolCustom does not implement analyze()',
      symbolCustomName: this.name,
      symbol: this.symbol,
    };
  }

  buildBacktestContext(context = {}) {
    return context;
  }
}

module.exports = BaseSymbolCustom;
