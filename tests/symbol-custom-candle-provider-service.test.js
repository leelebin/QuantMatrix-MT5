function loadProvider({
  candlesByKey = {},
  getCandlesImpl = null,
  isConnected = true,
  includeIsConnected = true,
  includeConnect = true,
  connectImpl = null,
} = {}) {
  jest.resetModules();
  const connectionState = { connected: isConnected };
  const getCandles = jest.fn(getCandlesImpl || (async (symbol, timeframe) => (
    candlesByKey[`${symbol}:${timeframe}`] || []
  )));
  const connect = jest.fn(connectImpl || (async () => {
    connectionState.connected = true;
  }));
  const mt5Service = { getCandles };
  if (includeIsConnected) {
    mt5Service.isConnected = jest.fn(() => connectionState.connected);
  }
  if (includeConnect) {
    mt5Service.connect = connect;
  }

  jest.doMock('../src/services/mt5Service', () => mt5Service);

  return {
    service: require('../src/services/symbolCustomCandleProviderService'),
    mt5Service,
  };
}

describe('symbolCustomCandleProviderService', () => {
  afterEach(() => {
    jest.dontMock('../src/services/mt5Service');
  });

  test('normalizeTimeframe supports common MT5 aliases', () => {
    const { service } = loadProvider();

    expect(service.normalizeTimeframe('M15')).toBe('15m');
    expect(service.normalizeTimeframe('H1')).toBe('1h');
    expect(service.normalizeTimeframe('5 minutes')).toBe('5m');
    expect(service.normalizeTimeframe('4H')).toBe('4h');
  });

  test('entry timeframe is required', async () => {
    const { service } = loadProvider();

    await expect(service.getSymbolCustomCandles({
      symbol: 'USDJPY',
      timeframes: {},
      startDate: '2026-04-01',
      endDate: '2026-04-02',
    })).rejects.toMatchObject({
      statusCode: 400,
      message: service.SYMBOL_CUSTOM_ENTRY_TIMEFRAME_REQUIRED,
    });
  });

  test('explicit date range is required', async () => {
    const { service } = loadProvider();

    await expect(service.getSymbolCustomCandles({
      symbol: 'USDJPY',
      timeframes: { entryTimeframe: '5m' },
    })).rejects.toMatchObject({
      statusCode: 400,
      message: service.SYMBOL_CUSTOM_BACKTEST_DATE_RANGE_REQUIRED,
    });
  });

  test('maps MT5 not connected candle fetch error to friendly SymbolCustom error', async () => {
    const { service, mt5Service } = loadProvider({
      getCandlesImpl: async () => {
        throw new Error('MT5 not connected. Call connect() first.');
      },
    });

    await expect(service.getSymbolCustomCandles({
      symbol: 'USDJPY',
      timeframes: { entryTimeframe: '5m' },
      startDate: '2026-04-01',
      endDate: '2026-04-02',
    })).rejects.toMatchObject({
      statusCode: 503,
      message: service.SYMBOL_CUSTOM_MT5_NOT_CONNECTED_MESSAGE,
      reasonCode: service.SYMBOL_CUSTOM_MT5_NOT_CONNECTED,
      hint: service.SYMBOL_CUSTOM_MT5_NOT_CONNECTED_HINT,
      details: expect.arrayContaining([
        expect.objectContaining({
          field: 'mt5',
          message: service.SYMBOL_CUSTOM_MT5_NOT_CONNECTED_MESSAGE,
          reasonCode: service.SYMBOL_CUSTOM_MT5_NOT_CONNECTED,
          hint: service.SYMBOL_CUSTOM_MT5_NOT_CONNECTED_HINT,
        }),
      ]),
    });
    expect(mt5Service.getCandles).toHaveBeenCalledTimes(1);
  });

  test('connects MT5 before getCandles when disconnected', async () => {
    const { service, mt5Service } = loadProvider({
      isConnected: false,
      candlesByKey: {
        'USDJPY:5m': [
          { time: '2026-04-01T00:00:00.000Z', open: 100, high: 101, low: 99, close: 100.5 },
        ],
      },
    });

    await service.getSymbolCustomCandles({
      symbol: 'USDJPY',
      timeframes: { entryTimeframe: '5m' },
      startDate: '2026-04-01',
      endDate: '2026-04-02',
    });

    expect(mt5Service.connect).toHaveBeenCalledTimes(1);
    expect(mt5Service.getCandles).toHaveBeenCalledTimes(1);
    expect(mt5Service.connect.mock.invocationCallOrder[0]).toBeLessThan(
      mt5Service.getCandles.mock.invocationCallOrder[0]
    );
  });

  test('does not connect MT5 again when already connected', async () => {
    const { service, mt5Service } = loadProvider({
      isConnected: true,
      candlesByKey: {
        'USDJPY:5m': [
          { time: '2026-04-01T00:00:00.000Z', open: 100, high: 101, low: 99, close: 100.5 },
        ],
      },
    });

    await service.getSymbolCustomCandles({
      symbol: 'USDJPY',
      timeframes: { entryTimeframe: '5m' },
      startDate: '2026-04-01',
      endDate: '2026-04-02',
    });

    expect(mt5Service.isConnected).toHaveBeenCalled();
    expect(mt5Service.connect).not.toHaveBeenCalled();
    expect(mt5Service.getCandles).toHaveBeenCalledTimes(1);
  });

  test('connects MT5 when isConnected is unavailable but connect exists', async () => {
    const { service, mt5Service } = loadProvider({
      includeIsConnected: false,
      candlesByKey: {
        'USDJPY:5m': [
          { time: '2026-04-01T00:00:00.000Z', open: 100, high: 101, low: 99, close: 100.5 },
        ],
      },
    });

    await service.getSymbolCustomCandles({
      symbol: 'USDJPY',
      timeframes: { entryTimeframe: '5m' },
      startDate: '2026-04-01',
      endDate: '2026-04-02',
    });

    expect(mt5Service.isConnected).toBeUndefined();
    expect(mt5Service.connect).toHaveBeenCalledTimes(1);
    expect(mt5Service.getCandles).toHaveBeenCalledTimes(1);
  });

  test('same fallback timeframe connects once and fetches candles once', async () => {
    const entryCandles = [
      { time: '2026-04-01T00:00:00.000Z', open: 100, high: 101, low: 99, close: 100.5 },
    ];
    const { service, mt5Service } = loadProvider({
      isConnected: false,
      candlesByKey: {
        'USDJPY:5m': entryCandles,
      },
    });

    await service.getSymbolCustomCandles({
      symbol: 'USDJPY',
      timeframes: { entryTimeframe: '5m' },
      startDate: '2026-04-01',
      endDate: '2026-04-02',
    });

    expect(mt5Service.connect).toHaveBeenCalledTimes(1);
    expect(mt5Service.getCandles).toHaveBeenCalledTimes(1);
  });

  test('maps MT5 connect failure to friendly SymbolCustom error', async () => {
    const { service, mt5Service } = loadProvider({
      isConnected: false,
      connectImpl: async () => {
        throw new Error('Unable to connect to MT5 terminal');
      },
    });

    await expect(service.getSymbolCustomCandles({
      symbol: 'USDJPY',
      timeframes: { entryTimeframe: '5m' },
      startDate: '2026-04-01',
      endDate: '2026-04-02',
    })).rejects.toMatchObject({
      statusCode: 503,
      message: service.SYMBOL_CUSTOM_MT5_NOT_CONNECTED_MESSAGE,
      reasonCode: service.SYMBOL_CUSTOM_MT5_NOT_CONNECTED,
      hint: service.SYMBOL_CUSTOM_MT5_NOT_CONNECTED_HINT,
    });
    expect(mt5Service.connect).toHaveBeenCalledTimes(1);
    expect(mt5Service.getCandles).not.toHaveBeenCalled();
  });

  test('candle provider source does not reference order placement APIs', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'services', 'symbolCustomCandleProviderService.js'),
      'utf8'
    );

    expect(source).not.toMatch(/placeOrder|preflightOrder|closePosition|tradeExecutor|riskManager/);
  });

  test('returns setup entry and higher candles with fallback timeframes', async () => {
    const entryCandles = [
      { time: '2026-04-01T00:00:00.000Z', open: '100', high: '101', low: '99', close: '100.5', tickVolume: 10 },
      { time: '2026-04-01T00:05:00.000Z', open: 100.5, high: 102, low: 100, close: 101, volume: 12 },
    ];
    const { service, mt5Service } = loadProvider({
      candlesByKey: {
        'USDJPY:5m': entryCandles,
      },
    });

    const candles = await service.getSymbolCustomCandles({
      symbol: 'usdjpy',
      timeframes: { entryTimeframe: '5m' },
      startDate: '2026-04-01',
      endDate: '2026-04-02',
    });

    expect(mt5Service.getCandles).toHaveBeenCalledTimes(1);
    expect(mt5Service.getCandles).toHaveBeenCalledWith(
      'USDJPY',
      '5m',
      expect.any(Date),
      expect.any(Number),
      expect.any(Date)
    );
    expect(candles).toEqual({
      setup: [
        { time: '2026-04-01T00:00:00.000Z', open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
        { time: '2026-04-01T00:05:00.000Z', open: 100.5, high: 102, low: 100, close: 101, volume: 12 },
      ],
      entry: [
        { time: '2026-04-01T00:00:00.000Z', open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
        { time: '2026-04-01T00:05:00.000Z', open: 100.5, high: 102, low: 100, close: 101, volume: 12 },
      ],
      higher: [
        { time: '2026-04-01T00:00:00.000Z', open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
        { time: '2026-04-01T00:05:00.000Z', open: 100.5, high: 102, low: 100, close: 101, volume: 12 },
      ],
    });
  });

  test('buildCandleProviderForSymbolCustom reads through SymbolCustom defaults', async () => {
    const { service, mt5Service } = loadProvider({
      candlesByKey: {
        'AUDUSD:5m': [
          { time: '2026-04-01T00:00:00.000Z', open: 0.65, high: 0.66, low: 0.64, close: 0.655 },
        ],
        'AUDUSD:15m': [
          { time: '2026-04-01T00:00:00.000Z', open: 0.65, high: 0.66, low: 0.64, close: 0.655 },
        ],
        'AUDUSD:1h': [
          { time: '2026-04-01T00:00:00.000Z', open: 0.65, high: 0.66, low: 0.64, close: 0.655 },
        ],
      },
    });
    const provider = service.buildCandleProviderForSymbolCustom({
      symbol: 'AUDUSD',
      timeframes: {
        setupTimeframe: '15m',
        entryTimeframe: '5m',
        higherTimeframe: '1h',
      },
    });

    const candles = await provider({
      startDate: '2026-04-01',
      endDate: '2026-04-02',
    });

    expect(mt5Service.getCandles).toHaveBeenCalledTimes(3);
    expect(candles.setup).toHaveLength(1);
    expect(candles.entry).toHaveLength(1);
    expect(candles.higher).toHaveLength(1);
  });
});
