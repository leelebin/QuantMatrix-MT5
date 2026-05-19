function loadProvider({
  connected = true,
  candles = [{ time: '2026-05-18T00:00:00.000Z', open: 147, high: 148, low: 146, close: 147.5, volume: 10 }],
  connectImpl,
} = {}) {
  jest.resetModules();

  const mt5Service = {
    isConnected: jest.fn(() => connected),
    connect: jest.fn(connectImpl || (async () => {
      connected = true;
      return { success: true };
    })),
    getCandles: jest.fn(async () => candles),
  };

  jest.doMock('../src/services/mt5Service', () => mt5Service);

  return {
    provider: require('../src/services/symbolCustomPaperCandleProviderService'),
    mt5Service,
  };
}

describe('symbolCustomPaperCandleProviderService', () => {
  afterEach(() => {
    jest.dontMock('../src/services/mt5Service');
    delete process.env.SYMBOL_CUSTOM_PAPER_CANDLE_LIMIT;
  });

  test('connects before fetching candles when MT5 is disconnected', async () => {
    const { provider, mt5Service } = loadProvider({ connected: false });

    const candles = await provider.getSymbolCustomPaperCandles({
      symbol: 'USDJPY',
      timeframes: { setupTimeframe: '15m', entryTimeframe: '5m', higherTimeframe: '1h' },
    });

    expect(mt5Service.connect).toHaveBeenCalledTimes(1);
    expect(mt5Service.getCandles).toHaveBeenCalledTimes(3);
    expect(candles.entry).toHaveLength(1);
  });

  test('does not connect again when MT5 is already connected', async () => {
    const { provider, mt5Service } = loadProvider({ connected: true });

    await provider.getSymbolCustomPaperCandles({
      symbol: 'USDJPY',
      timeframes: { setupTimeframe: '15m', entryTimeframe: '5m', higherTimeframe: '1h' },
    });

    expect(mt5Service.connect).not.toHaveBeenCalled();
    expect(mt5Service.getCandles).toHaveBeenCalledTimes(3);
  });

  test('deduplicates identical setup entry and higher timeframes', async () => {
    const { provider, mt5Service } = loadProvider({ connected: false });

    await provider.getSymbolCustomPaperCandles({
      symbol: 'USDJPY',
      timeframes: { setupTimeframe: '5m', entryTimeframe: '5m', higherTimeframe: '5m' },
    });

    expect(mt5Service.connect).toHaveBeenCalledTimes(1);
    expect(mt5Service.getCandles).toHaveBeenCalledTimes(1);
    expect(mt5Service.getCandles).toHaveBeenCalledWith('USDJPY', '5m', null, provider.DEFAULT_PAPER_CANDLE_LIMIT);
  });

  test('uses fallback paper timeframes when setup or higher are missing', async () => {
    const { provider } = loadProvider({ connected: true });

    expect(provider.resolvePaperTimeframes({ entryTimeframe: '5m' })).toEqual({
      setup: '5m',
      entry: '5m',
      higher: '5m',
    });
  });

  test('source does not reference order placement APIs or trading services', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src/services/symbolCustomPaperCandleProviderService.js'),
      'utf8'
    );

    expect(source).not.toMatch(/placeOrder|preflightOrder|closePosition|tradeExecutor|riskManager/);
  });
});
