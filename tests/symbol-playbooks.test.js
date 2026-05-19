const {
  SYMBOL_PLAYBOOKS,
  getSymbolPlaybook,
} = require('../src/config/symbolPlaybooks');

describe('symbol playbooks', () => {
  const requiredFields = [
    'role',
    'category',
    'allowedSetups',
    'preferredEntryStyle',
    'riskWeight',
    'beStyle',
    'liveBias',
  ];

  test('configured symbols can be read by symbol', () => {
    expect(getSymbolPlaybook('XAUUSD')).toEqual(expect.objectContaining({
      role: 'growth_engine',
      category: 'metals',
      allowedSetups: [
        'event_breakout',
        'trend_pullback',
        'momentum_continuation',
        'safe_haven_rotation',
      ],
      preferredEntryStyle: 'pullback_after_breakout',
      riskWeight: 1.0,
      beStyle: 'medium_loose',
      liveBias: 'allowed_observe',
    }));

    expect(getSymbolPlaybook('btcusd')).toEqual(expect.objectContaining({
      role: 'crypto_momentum',
      category: 'crypto',
      liveBias: 'signal_only',
    }));
  });

  test('unknown symbols return the fallback playbook', () => {
    expect(getSymbolPlaybook('UNKNOWN')).toEqual({
      role: 'unclassified',
      category: 'unknown',
      allowedSetups: [],
      preferredEntryStyle: 'none',
      riskWeight: 0,
      beStyle: 'default',
      liveBias: 'paper_first',
      notes: 'No symbol playbook configured.',
    });
  });

  test('each playbook has the required metadata fields', () => {
    Object.entries(SYMBOL_PLAYBOOKS).forEach(([symbol, playbook]) => {
      requiredFields.forEach((field) => {
        expect(playbook).toHaveProperty(field);
      });

      expect(typeof playbook.riskWeight).toBe('number');
      expect(Array.isArray(playbook.allowedSetups)).toBe(true);
      expect(getSymbolPlaybook(symbol)).toEqual(expect.objectContaining(playbook));
    });
  });
});
