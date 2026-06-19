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
      riskConfig: { maxRiskPerTradePct: 1 },
      sessionFilter: { enabled: false },
      newsFilter: { enabled: false },
      beConfig: { enabled: false },
      entryConfig: { confirmation: 'stub' },
      exitConfig: { style: 'stub' },
    }, getCandlesFn, { scope: 'paper', timestamp });

    expect(signal).toEqual({
      scope: 'paper',
      source: 'symbolCustom',
      symbol: 'USDJPY',
      symbolCustomId: 'sc-1',
      symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
      signal: 'NONE',
      status: 'NO_SIGNAL',
      reason: 'Placeholder SymbolCustom has no active trading logic',
      reasonCode: undefined,
      sl: null,
      tp: null,
      stopLoss: null,
      takeProfit: null,
      setupTimeframe: '15m',
      entryTimeframe: '5m',
      higherTimeframe: '1h',
      parameters: { lookbackBars: 50 },
      riskConfig: { maxRiskPerTradePct: 1 },
      sessionFilter: { enabled: false },
      newsFilter: { enabled: false },
      beConfig: { enabled: false },
      entryConfig: { confirmation: 'stub' },
      exitConfig: { style: 'stub' },
      metadata: {},
      timestamp,
    });
    expect(getCandlesFn).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'USDJPY',
      scope: 'paper',
      timeframes: { setupTimeframe: '15m', entryTimeframe: '5m', higherTimeframe: '1h' },
    }));
  });

  test('live scope is blocked before candle fetch when live flags are not ready', async () => {
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
      reasonCode: engine.SYMBOL_CUSTOM_LIVE_NOT_ENABLED,
    }));
    expect(getCandlesFn).not.toHaveBeenCalled();
  });

  test('live scope can run analysis only after explicit live readiness flags pass', async () => {
    const { engine } = loadEngine();
    const getCandlesFn = jest.fn(async () => ({
      entry: [{ close: 2000 }],
    }));

    const signal = await engine.analyzeSymbolCustom({
      _id: 'sc-live-ready',
      symbol: 'XAUUSD',
      symbolCustomName: 'PLACEHOLDER_SYMBOL_CUSTOM',
      logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
      status: 'live_ready',
      liveEnabled: true,
      allowLive: true,
      parameters: { enabled: true },
      timeframes: { setupTimeframe: '30m', entryTimeframe: '30m', higherTimeframe: '30m' },
    }, getCandlesFn, { scope: 'live' });

    expect(signal).toEqual(expect.objectContaining({
      scope: 'live',
      source: 'symbolCustom',
      symbolCustomId: 'sc-live-ready',
      signal: 'NONE',
      status: 'NO_SIGNAL',
    }));
    expect(getCandlesFn).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'XAUUSD',
      scope: 'live',
    }));
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
    }, null, { scope: 'paper' });

    expect(signal).toEqual(expect.objectContaining({
      scope: 'paper',
      logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
      signal: 'NONE',
    }));
  });

  test('backtest scope is valid and remains SymbolCustom-only', async () => {
    const { engine } = loadEngine();

    const signal = await engine.analyzeSymbolCustom({
      _id: 'sc-backtest',
      symbol: 'USDJPY',
      symbolCustomName: 'PLACEHOLDER_SYMBOL_CUSTOM',
      timeframes: {},
      parameters: {},
    }, null, { scope: 'backtest' });

    expect(signal).toEqual(expect.objectContaining({
      scope: 'backtest',
      source: 'symbolCustom',
      logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
      signal: 'NONE',
    }));
  });

  test('normalized SymbolCustom signal preserves execution scoring fields', () => {
    const { engine } = loadEngine();
    const timestamp = new Date('2026-05-14T03:04:05.000Z');

    const signal = engine.buildSymbolCustomSignal(
      {
        _id: 'sc-confidence',
        symbol: 'USDJPY',
        symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
        logicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
        parameters: {},
      },
      {
        signal: 'BUY',
        confidence: 0.73,
        marketQualityScore: 0.82,
        marketQualityThreshold: 0.6,
        sl: 146.8,
        tp: 148.2,
        metadata: {
          setupType: 'jpy_macro_reversal',
          candidatePreset: 'buy_session_conservative',
        },
      },
      {
        scope: 'paper',
        logicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
        timestamp,
      }
    );

    expect(signal).toEqual(expect.objectContaining({
      scope: 'paper',
      source: 'symbolCustom',
      signal: 'BUY',
      confidence: 0.73,
      rawConfidence: 0.73,
      marketQualityScore: 0.82,
      marketQualityThreshold: 0.6,
      sl: 146.8,
      tp: 148.2,
      timestamp,
    }));
    expect(signal.metadata).toEqual(expect.objectContaining({
      setupType: 'jpy_macro_reversal',
      candidatePreset: 'buy_session_conservative',
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
