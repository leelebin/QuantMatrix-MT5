const { SYMBOL_PLAYBOOKS } = require('../src/config/symbolPlaybooks');
const { getSymbolPlaybooks } = require('../src/controllers/symbolPlaybookController');

function createRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    },
  };
}

describe('symbol playbook controller', () => {
  test('returns all configured symbol playbooks in API shape', async () => {
    const res = createRes();

    await getSymbolPlaybooks({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual(expect.objectContaining({
      success: true,
      count: Object.keys(SYMBOL_PLAYBOOKS).length,
      playbooks: expect.any(Array),
    }));

    expect(res.payload.playbooks).toHaveLength(Object.keys(SYMBOL_PLAYBOOKS).length);

    for (const playbook of res.payload.playbooks) {
      expect(Object.keys(playbook).sort()).toEqual([
        'allowedSetups',
        'beStyle',
        'category',
        'liveBias',
        'notes',
        'preferredEntryStyle',
        'riskWeight',
        'role',
        'symbol',
      ].sort());
      expect(playbook).toEqual(expect.objectContaining({
        symbol: expect.any(String),
        role: expect.any(String),
        category: expect.any(String),
        allowedSetups: expect.any(Array),
        preferredEntryStyle: expect.any(String),
        riskWeight: expect.any(Number),
        beStyle: expect.any(String),
        liveBias: expect.any(String),
      }));
    }

    expect(res.payload.playbooks.find((playbook) => playbook.symbol === 'XAUUSD')).toEqual({
      symbol: 'XAUUSD',
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
      notes: null,
    });
  });
});
