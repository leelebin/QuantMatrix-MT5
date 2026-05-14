function loadEngine({ symbolCustoms = [] } = {}) {
  jest.resetModules();

  const SymbolCustom = {
    findAll: jest.fn(async () => symbolCustoms.map((record) => ({ ...record }))),
  };
  const paperTradingService = {
    _executePaperTrade: jest.fn(),
    executeTrade: jest.fn(),
  };
  const tradeExecutor = {
    executeTrade: jest.fn(),
  };

  jest.doMock('../src/models/SymbolCustom', () => SymbolCustom);
  jest.doMock('../src/services/paperTradingService', () => paperTradingService);
  jest.doMock('../src/services/tradeExecutor', () => tradeExecutor);

  return {
    engine: require('../src/services/symbolCustomEngine'),
    SymbolCustom,
    paperTradingService,
    tradeExecutor,
  };
}

describe('symbolCustomEngine', () => {
  afterEach(() => {
    jest.dontMock('../src/models/SymbolCustom');
    jest.dontMock('../src/services/paperTradingService');
    jest.dontMock('../src/services/tradeExecutor');
  });

  test('paper scope placeholder returns a NONE SymbolCustom signal', async () => {
    const { engine } = loadEngine();
    const timestamp = new Date('2026-05-14T01:02:03.000Z');
    const getCandlesFn = jest.fn(async () => ({
      entry: [{ close: 151.25 }],
    }));

    const signal = await engine.analyzeSymbolCustom({
      _id: 'sc-1',
      symbol: 'USDJPY',
      symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
      paperEnabled: true,
      timeframes: { setupTimeframe: '15m', entryTimeframe: '5m', higherTimeframe: '1h' },
      parameters: { lookbackBars: 50 },
    }, getCandlesFn, { scope: 'paper', timestamp });

    expect(signal).toEqual({
      scope: 'paper',
      source: 'symbolCustom',
      symbol: 'USDJPY',
      symbolCustomId: 'sc-1',
      symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
      signal: 'NONE',
      status: undefined,
      reason: 'Placeholder SymbolCustom has no active trading logic',
      reasonCode: undefined,
      setupTimeframe: '15m',
      entryTimeframe: '5m',
      higherTimeframe: '1h',
      parameters: { lookbackBars: 50 },
      timestamp,
    });
    expect(getCandlesFn).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'USDJPY',
      scope: 'paper',
      timeframes: { setupTimeframe: '15m', entryTimeframe: '5m', higherTimeframe: '1h' },
    }));
  });

  test('live scope is blocked in Phase 1 before candle fetch or logic analysis', async () => {
    const { engine } = loadEngine();
    const getCandlesFn = jest.fn();

    const signal = await engine.analyzeSymbolCustom({
      _id: 'sc-live',
      symbol: 'GBPJPY',
      symbolCustomName: 'GBPJPY_VOLATILITY_BREAKOUT_V1',
      logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
    }, getCandlesFn, { scope: 'live' });

    expect(signal).toEqual(expect.objectContaining({
      scope: 'live',
      source: 'symbolCustom',
      signal: 'NONE',
      status: 'BLOCKED',
      reasonCode: engine.SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1,
    }));
    expect(getCandlesFn).not.toHaveBeenCalled();
  });

  test('unknown logic returns a clear error', async () => {
    const { engine } = loadEngine();

    await expect(engine.analyzeSymbolCustom({
      _id: 'sc-unknown',
      symbol: 'AUDUSD',
      symbolCustomName: 'AUDUSD_UNKNOWN',
      logicName: 'UNKNOWN_SYMBOL_CUSTOM',
    }, null, { scope: 'paper' })).rejects.toMatchObject({
      statusCode: 400,
      message: engine.SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED,
      details: expect.arrayContaining([
        expect.objectContaining({ field: 'logicName' }),
      ]),
    });
  });

  test('falls back to symbolCustomName when logicName is empty', async () => {
    const { engine } = loadEngine();

    const signal = await engine.analyzeSymbolCustom({
      _id: 'sc-placeholder-name',
      symbol: 'EURUSD',
      symbolCustomName: 'PLACEHOLDER_SYMBOL_CUSTOM',
      timeframes: {},
      parameters: {},
    }, null, { scope: 'backtest' });

    expect(signal).toEqual(expect.objectContaining({
      scope: 'backtest',
      logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
      signal: 'NONE',
    }));
  });

  test('analyzeAllPaperSymbolCustoms only includes paperEnabled=true records', async () => {
    const { engine, SymbolCustom } = loadEngine({
      symbolCustoms: [
        {
          _id: 'sc-paper',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_PAPER',
          logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
          paperEnabled: true,
          parameters: { lookbackBars: 40 },
        },
        {
          _id: 'sc-disabled',
          symbol: 'GBPJPY',
          symbolCustomName: 'GBPJPY_DISABLED',
          logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
          paperEnabled: false,
        },
      ],
    });

    const signals = await engine.analyzeAllPaperSymbolCustoms(null, {
      timestamp: new Date('2026-05-14T00:00:00.000Z'),
    });

    expect(SymbolCustom.findAll).toHaveBeenCalledWith({ paperEnabled: true });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toEqual(expect.objectContaining({
      source: 'symbolCustom',
      symbolCustomId: 'sc-paper',
      symbolCustomName: 'USDJPY_PAPER',
      signal: 'NONE',
    }));
  });

  test('does not call paperTradingService open trade or tradeExecutor', async () => {
    const { engine, paperTradingService, tradeExecutor } = loadEngine({
      symbolCustoms: [
        {
          _id: 'sc-paper',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_PAPER',
          logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
          paperEnabled: true,
        },
      ],
    });

    await engine.analyzeAllPaperSymbolCustoms(null, {});

    expect(paperTradingService._executePaperTrade).not.toHaveBeenCalled();
    expect(paperTradingService.executeTrade).not.toHaveBeenCalled();
    expect(tradeExecutor.executeTrade).not.toHaveBeenCalled();
  });
});
