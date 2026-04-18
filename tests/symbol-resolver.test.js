/**
 * Tests for the symbol alias resolver.
 * Verifies canonical→broker mapping, env overrides, discovery against a
 * mock MT5 service, status reporting and safe failure.
 */

describe('symbolResolver', () => {
  let symbolResolver;

  beforeEach(() => {
    jest.resetModules();
    // Reload the module so the singleton cache starts fresh for each test.
    symbolResolver = require('../src/services/symbolResolver');
    symbolResolver.clear();
    // Clean env overrides that might leak between tests.
    Object.keys(process.env)
      .filter((k) => k.startsWith('QM_SYMBOL_ALIAS_'))
      .forEach((k) => { delete process.env[k]; });
  });

  test('getCandidates returns canonical as fallback for unknown symbol', () => {
    const candidates = symbolResolver.getCandidates('EURUSD');
    expect(candidates[candidates.length - 1]).toBe('EURUSD');
  });

  test('getCandidates returns all crypto aliases for BTCUSD', () => {
    const candidates = symbolResolver.getCandidates('BTCUSD');
    expect(candidates).toContain('BTCUSD');
    expect(candidates).toContain('BTCUSDm');
    expect(candidates).toContain('BTCUSDT');
  });

  test('env override is prepended to built-in alias list', () => {
    process.env.QM_SYMBOL_ALIAS_BTCUSD = 'BTCUSD.foo,BTCUSD.bar';
    const candidates = symbolResolver.getCandidates('BTCUSD');
    expect(candidates[0]).toBe('BTCUSD.foo');
    expect(candidates[1]).toBe('BTCUSD.bar');
    // built-ins still present
    expect(candidates).toContain('BTCUSDm');
  });

  test('resolveForBroker returns canonical when no resolution cached', () => {
    expect(symbolResolver.resolveForBroker('EURUSD')).toBe('EURUSD');
  });

  test('discover resolves to first matching broker name', async () => {
    const mt5Mock = {
      getSymbolInfo: jest.fn(async (name) => (
        name === 'BTCUSDm' ? { symbol: 'BTCUSDm', tradeModeName: 'FULL', digits: 2, visible: true } : null
      )),
    };

    const result = await symbolResolver.discover('BTCUSD', mt5Mock);
    expect(result.status).toBe('ok');
    expect(result.broker).toBe('BTCUSDm');
    // Should have stopped at the first match — tried includes BTCUSD (no match) and BTCUSDm (match)
    expect(result.tried.find((t) => t.name === 'BTCUSDm').matched).toBe(true);
    expect(symbolResolver.resolveForBroker('BTCUSD')).toBe('BTCUSDm');
  });

  test('discover marks symbol MISSING when no candidate matches', async () => {
    const mt5Mock = { getSymbolInfo: jest.fn(async () => null) };
    const result = await symbolResolver.discover('BTCUSD', mt5Mock);
    expect(result.status).toBe('missing');
    expect(result.broker).toBeNull();
    expect(symbolResolver.isBrokerAvailable('BTCUSD')).toBe(false);
  });

  test('discover marks symbol ERROR when bridge throws', async () => {
    const mt5Mock = {
      getSymbolInfo: jest.fn(async () => { throw new Error('bridge dead'); }),
    };
    const result = await symbolResolver.discover('BTCUSD', mt5Mock);
    expect(result.status).toBe('error');
    expect(result.error).toBe('bridge dead');
    expect(symbolResolver.isBrokerAvailable('BTCUSD')).toBe(false);
  });

  test('isBrokerAvailable is optimistic for untested canonical symbols', () => {
    // Never discovered — should be treated as available (so backtests work offline).
    expect(symbolResolver.isBrokerAvailable('ETHUSD')).toBe(true);
  });

  test('discoverAll reports resolved/missing/errors buckets', async () => {
    const mt5Mock = {
      getSymbolInfo: jest.fn(async (name) => {
        if (name === 'EURUSD') return { symbol: 'EURUSD', tradeModeName: 'FULL' };
        if (name === 'BTCUSDm') return { symbol: 'BTCUSDm', tradeModeName: 'FULL' };
        if (name === 'ETHUSDERR') throw new Error('boom');
        return null;
      }),
    };

    const report = await symbolResolver.discoverAll(mt5Mock, {
      symbols: ['EURUSD', 'BTCUSD', 'ADAUSD'],
      concurrency: 2,
    });

    expect(report.total).toBe(3);
    expect(report.resolved.map((r) => r.canonical).sort()).toEqual(['BTCUSD', 'EURUSD']);
    expect(report.missing.map((r) => r.canonical)).toEqual(['ADAUSD']);
    expect(symbolResolver.resolveForBroker('BTCUSD')).toBe('BTCUSDm');
    expect(symbolResolver.resolveForBroker('EURUSD')).toBe('EURUSD');
  });

  test('setManualResolution overrides the broker name', () => {
    symbolResolver.setManualResolution('XRPUSD', 'XRPUSD.myBroker');
    expect(symbolResolver.resolveForBroker('XRPUSD')).toBe('XRPUSD.myBroker');
    const resolution = symbolResolver.getResolution('XRPUSD');
    expect(resolution.status).toBe('ok');
  });

  test('getStatusReport covers every canonical in the instruments config', () => {
    const report = symbolResolver.getStatusReport();
    // Should include at least one forex + one crypto canonical.
    const canonicals = report.map((r) => r.canonical);
    expect(canonicals).toContain('EURUSD');
    expect(canonicals).toContain('BTCUSD');
    // Entries default to UNKNOWN before any discovery runs.
    expect(report.every((r) => ['unknown', 'ok', 'missing', 'error', 'canonical', 'pending'].includes(r.status))).toBe(true);
  });

  test('envAliasKey sanitizes special characters', () => {
    expect(symbolResolver.envAliasKey('BTCUSD')).toBe('QM_SYMBOL_ALIAS_BTCUSD');
    expect(symbolResolver.envAliasKey('BTC/USD')).toBe('QM_SYMBOL_ALIAS_BTC_USD');
  });
});

describe('instruments config — crypto basket', () => {
  const instrumentsConfig = require('../src/config/instruments');

  test('exports CRYPTO category and CRYPTO_DEFAULT_SYMBOLS', () => {
    expect(instrumentsConfig.INSTRUMENT_CATEGORIES.CRYPTO).toBe('crypto');
    expect(instrumentsConfig.CRYPTO_DEFAULT_SYMBOLS).toEqual([
      'BTCUSD', 'ETHUSD', 'LTCUSD', 'XRPUSD',
      'BCHUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD',
    ]);
  });

  test('all 8 crypto instruments exist with required fields', () => {
    const expected = ['BTCUSD', 'ETHUSD', 'LTCUSD', 'XRPUSD', 'BCHUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD'];
    for (const symbol of expected) {
      const inst = instrumentsConfig.getInstrument(symbol);
      expect(inst).toBeTruthy();
      expect(inst.category).toBe('crypto');
      expect(typeof inst.pipSize).toBe('number');
      expect(inst.pipSize).toBeGreaterThan(0);
      expect(typeof inst.pipValue).toBe('number');
      expect(inst.minLot).toBe(0.01);
      expect(inst.riskParams.riskPercent).toBeLessThanOrEqual(0.01);
      expect(inst.timeframe).toBe('1h');
    }
  });

  test('no crypto symbol is assigned MeanReversion', () => {
    const crypto = instrumentsConfig.getInstrumentsByCategory('crypto');
    expect(crypto.length).toBeGreaterThan(0);
    expect(crypto.every((i) => i.strategyType !== 'MeanReversion')).toBe(true);
  });

  test('CRYPTO_SYMBOL_ALIASES provides broker variants for each canonical', () => {
    for (const symbol of instrumentsConfig.CRYPTO_DEFAULT_SYMBOLS) {
      const aliases = instrumentsConfig.CRYPTO_SYMBOL_ALIASES[symbol];
      expect(Array.isArray(aliases)).toBe(true);
      expect(aliases[0]).toBe(symbol);
      expect(aliases.length).toBeGreaterThanOrEqual(3);
    }
  });

  test('getAllSymbols now includes the crypto basket', () => {
    const all = instrumentsConfig.getAllSymbols();
    for (const symbol of instrumentsConfig.CRYPTO_DEFAULT_SYMBOLS) {
      expect(all).toContain(symbol);
    }
  });
});

describe('defaultAssignments — crypto inclusion', () => {
  const { DEFAULT_STRATEGY_SYMBOL_ASSIGNMENTS } = require('../src/config/defaultAssignments');

  test('Breakout and Momentum carry the crypto basket', () => {
    expect(DEFAULT_STRATEGY_SYMBOL_ASSIGNMENTS.Breakout).toEqual(expect.arrayContaining(['BTCUSD', 'ETHUSD']));
    expect(DEFAULT_STRATEGY_SYMBOL_ASSIGNMENTS.Momentum).toEqual(expect.arrayContaining(['LTCUSD', 'ADAUSD']));
  });

  test('MeanReversion does not carry any crypto symbol', () => {
    const crypto = ['BTCUSD', 'ETHUSD', 'LTCUSD', 'XRPUSD', 'BCHUSD', 'SOLUSD', 'ADAUSD', 'DOGEUSD'];
    for (const c of crypto) {
      expect(DEFAULT_STRATEGY_SYMBOL_ASSIGNMENTS.MeanReversion).not.toContain(c);
    }
  });
});
