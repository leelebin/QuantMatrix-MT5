const mt5Service = require('../src/services/mt5Service');

describe('MT5 preflight allowed handling', () => {
  test('treats allowed=true with retcode 0 Done as sendable', () => {
    const preflight = { allowed: true, retcode: 0, comment: 'Done' };

    expect(mt5Service.isOrderAllowed(preflight)).toBe(true);
  });

  test('keeps market-closed rejections blocked with a message', () => {
    const preflight = { allowed: false, retcode: 10018, retcodeName: 'MARKET_CLOSED' };

    expect(mt5Service.isOrderAllowed(preflight)).toBe(false);
    expect(mt5Service.getPreflightMessage(preflight)).toBeTruthy();
  });

  test('surfaces inconsistent retcode=0 Done state for regression debugging', () => {
    const preflight = { allowed: false, retcode: 0, comment: 'Done' };

    expect(mt5Service.isOrderAllowed(preflight)).toBe(false);
    expect(mt5Service.getPreflightMessage(preflight))
      .toBe('preflight inconsistent (retcode=0/Done but allowed=false)');
  });
});
