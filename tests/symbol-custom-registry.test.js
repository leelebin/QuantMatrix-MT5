const BaseSymbolCustom = require('../src/symbolCustom/BaseSymbolCustom');
const PlaceholderSymbolCustom = require('../src/symbolCustom/logics/PlaceholderSymbolCustom');
const {
  SYMBOL_CUSTOM_REGISTRY,
  getSymbolCustomLogic,
  listRegisteredSymbolCustomLogics,
  isSymbolCustomRegistered,
} = require('../src/symbolCustom/registry');

describe('SymbolCustom registry framework', () => {
  test('BaseSymbolCustom default analyze returns NONE', () => {
    const logic = new BaseSymbolCustom({
      name: 'BASE_TEST',
      symbol: 'USDJPY',
    });

    expect(logic.analyze()).toEqual({
      signal: 'NONE',
      reason: 'BaseSymbolCustom does not implement analyze()',
      symbolCustomName: 'BASE_TEST',
      symbol: 'USDJPY',
    });
  });

  test('PlaceholderSymbolCustom analyze returns NONE and never BUY/SELL', () => {
    const logic = new PlaceholderSymbolCustom({ symbol: 'GBPJPY' });
    const result = logic.analyze();

    expect(result).toEqual({
      signal: 'NONE',
      reason: 'Placeholder SymbolCustom has no active trading logic',
      symbolCustomName: 'PLACEHOLDER_SYMBOL_CUSTOM',
      symbol: 'GBPJPY',
    });
    expect(result.signal).not.toBe('BUY');
    expect(result.signal).not.toBe('SELL');
  });

  test('registry can find PLACEHOLDER_SYMBOL_CUSTOM', () => {
    const logic = getSymbolCustomLogic('PLACEHOLDER_SYMBOL_CUSTOM');

    expect(logic).toBeInstanceOf(PlaceholderSymbolCustom);
    expect(logic.name).toBe('PLACEHOLDER_SYMBOL_CUSTOM');
    expect(isSymbolCustomRegistered('PLACEHOLDER_SYMBOL_CUSTOM')).toBe(true);
    expect(SYMBOL_CUSTOM_REGISTRY.PLACEHOLDER_SYMBOL_CUSTOM).toBe(PlaceholderSymbolCustom);
  });

  test('registry returns null for an unknown name', () => {
    expect(getSymbolCustomLogic('UNKNOWN_SYMBOL_CUSTOM')).toBeNull();
    expect(isSymbolCustomRegistered('UNKNOWN_SYMBOL_CUSTOM')).toBe(false);
  });

  test('listRegisteredSymbolCustomLogics returns an array', () => {
    const registered = listRegisteredSymbolCustomLogics();

    expect(Array.isArray(registered)).toBe(true);
    expect(registered).toEqual([
      { name: 'PLACEHOLDER_SYMBOL_CUSTOM' },
    ]);
  });
});
