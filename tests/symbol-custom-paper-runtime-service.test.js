const ORIGINAL_SYMBOL_CUSTOM_PAPER_ENABLED = process.env.SYMBOL_CUSTOM_PAPER_ENABLED;

function loadRuntime({
  symbolCustoms = [],
  logicResults = {},
} = {}) {
  jest.resetModules();

  const SymbolCustom = {
    findAll: jest.fn(async () => symbolCustoms.map((record) => ({ ...record }))),
  };

  const paperTradingService = {
    submitSymbolCustomSignal: jest.fn(async () => ({ success: true })),
    submitExternalPaperSignal: jest.fn(async () => ({ success: true })),
    _executePaperTrade: jest.fn(async () => ({ success: true })),
  };

  const tradeExecutor = {
    executeTrade: jest.fn(),
  };

  const placeholderAnalyze = jest.fn(async () => ({
    signal: 'NONE',
    reason: 'Placeholder SymbolCustom has no active trading logic',
  }));

  const getSymbolCustomLogic = jest.fn((logicName) => {
    if (logicName === 'UNKNOWN_SYMBOL_CUSTOM') return null;

    const result = logicResults[logicName] || {
      signal: 'NONE',
      reason: 'Placeholder SymbolCustom has no active trading logic',
    };

    return {
      name: logicName,
      validateContext: jest.fn(() => ({ valid: true, errors: [] })),
      analyze: logicName === 'PLACEHOLDER_SYMBOL_CUSTOM'
        ? placeholderAnalyze
        : jest.fn(async () => result),
    };
  });

  jest.doMock('../src/models/SymbolCustom', () => SymbolCustom);
  jest.doMock('../src/services/paperTradingService', () => paperTradingService);
  jest.doMock('../src/services/tradeExecutor', () => tradeExecutor);
  jest.doMock('../src/symbolCustom/registry', () => ({
    getSymbolCustomLogic,
  }));

  return {
    runtime: require('../src/services/symbolCustomPaperRuntimeService'),
    engine: require('../src/services/symbolCustomEngine'),
    SymbolCustom,
    paperTradingService,
    tradeExecutor,
    getSymbolCustomLogic,
    placeholderAnalyze,
  };
}

describe('symbolCustomPaperRuntimeService', () => {
  afterEach(() => {
    if (ORIGINAL_SYMBOL_CUSTOM_PAPER_ENABLED === undefined) {
      delete process.env.SYMBOL_CUSTOM_PAPER_ENABLED;
    } else {
      process.env.SYMBOL_CUSTOM_PAPER_ENABLED = ORIGINAL_SYMBOL_CUSTOM_PAPER_ENABLED;
    }
    jest.dontMock('../src/models/SymbolCustom');
    jest.dontMock('../src/services/paperTradingService');
    jest.dontMock('../src/services/tradeExecutor');
    jest.dontMock('../src/symbolCustom/registry');
  });

  test('env SYMBOL_CUSTOM_PAPER_ENABLED=false keeps runtime stopped', () => {
    process.env.SYMBOL_CUSTOM_PAPER_ENABLED = 'false';
    const { runtime } = loadRuntime();

    const result = runtime.start({ intervalMs: 1000 });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      enabled: false,
      running: false,
    }));
    expect(runtime.isRunning()).toBe(false);
  });

  test('SYMBOL_CUSTOM_PAPER_ENABLED=false makes runPaperScan return disabled without scanning', async () => {
    process.env.SYMBOL_CUSTOM_PAPER_ENABLED = 'false';
    const { runtime, SymbolCustom } = loadRuntime({
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

    const result = await runtime.runPaperScan({});

    expect(result).toEqual(expect.objectContaining({
      success: false,
      enabled: false,
      forced: false,
      scanned: 0,
      submitted: 0,
      ignored: 0,
      reasonCode: runtime.SYMBOL_CUSTOM_PAPER_RUNTIME_DISABLED,
    }));
    expect(SymbolCustom.findAll).not.toHaveBeenCalled();
  });

  test('env SYMBOL_CUSTOM_PAPER_ENABLED=true allows runtime start and stop', () => {
    process.env.SYMBOL_CUSTOM_PAPER_ENABLED = 'true';
    const { runtime } = loadRuntime();

    const result = runtime.start({ intervalMs: 1000000 });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      enabled: true,
      running: true,
    }));
    expect(runtime.isRunning()).toBe(true);

    const stopResult = runtime.stop();
    expect(stopResult).toEqual(expect.objectContaining({ running: false }));
    expect(runtime.isRunning()).toBe(false);
  });

  test('paperEnabled=false SymbolCustom records are skipped', async () => {
    const { runtime, SymbolCustom } = loadRuntime({
      symbolCustoms: [
        {
          _id: 'sc-disabled',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_DISABLED',
          logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
          paperEnabled: false,
        },
      ],
    });

    const result = await runtime.runPaperScan({ force: true });

    expect(SymbolCustom.findAll).toHaveBeenCalledWith({ paperEnabled: true });
    expect(result.scanned).toBe(0);
    expect(result.activePaperCustoms).toBe(0);
    expect(result.signalCount).toBe(0);
    expect(result.signals).toEqual([]);
  });

  test('paperEnabled=true placeholder is scanned and returns NONE without opening paper trade', async () => {
    const { runtime, paperTradingService } = loadRuntime({
      symbolCustoms: [
        {
          _id: 'sc-placeholder',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_PLACEHOLDER',
          logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
          paperEnabled: true,
          timeframes: { setupTimeframe: '15m', entryTimeframe: '5m', higherTimeframe: '1h' },
        },
      ],
    });

    const result = await runtime.runPaperScan({ force: true });

    expect(result.scanned).toBe(1);
    expect(result.activePaperCustoms).toBe(1);
    expect(result.signalCount).toBe(1);
    expect(result.submitted).toBe(0);
    expect(result.ignored).toBe(1);
    expect(result.signals[0]).toEqual(expect.objectContaining({
      source: 'symbolCustom',
      scope: 'paper',
      signal: 'NONE',
      symbolCustomId: 'sc-placeholder',
      symbolCustomName: 'USDJPY_PLACEHOLDER',
    }));
    expect(paperTradingService.submitSymbolCustomSignal).not.toHaveBeenCalled();
    expect(paperTradingService._executePaperTrade).not.toHaveBeenCalled();
  });

  test('BUY and SELL mock logic submits only to paperTradingService with SymbolCustom metadata', async () => {
    const { runtime, paperTradingService, tradeExecutor } = loadRuntime({
      symbolCustoms: [
        {
          _id: 'sc-buy',
          symbol: 'GBPJPY',
          symbolCustomName: 'GBPJPY_BUY_MOCK',
          logicName: 'BUY_MOCK_SYMBOL_CUSTOM',
          paperEnabled: true,
          parameters: { lookbackBars: 20 },
        },
      ],
      logicResults: {
        BUY_MOCK_SYMBOL_CUSTOM: {
          signal: 'BUY',
          reason: 'mock buy signal',
          sl: 190.1,
          tp: 191.2,
        },
      },
    });

    const result = await runtime.runPaperScan({
      force: true,
      getCandlesFn: jest.fn(async () => ({ entry: [{ close: 190.5 }] })),
    });

    expect(result.submitted).toBe(1);
    expect(paperTradingService.submitSymbolCustomSignal).toHaveBeenCalledTimes(1);
    expect(paperTradingService.submitSymbolCustomSignal).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'paper',
      source: 'symbolCustom',
      symbol: 'GBPJPY',
      symbolCustomId: 'sc-buy',
      symbolCustomName: 'GBPJPY_BUY_MOCK',
      logicName: 'BUY_MOCK_SYMBOL_CUSTOM',
      setupType: 'symbol_custom',
      strategy: 'GBPJPY_BUY_MOCK',
      strategyType: 'SymbolCustom',
      signal: 'BUY',
      metadata: expect.objectContaining({
        source: 'symbolCustom',
        symbolCustomId: 'sc-buy',
        symbolCustomName: 'GBPJPY_BUY_MOCK',
        logicName: 'BUY_MOCK_SYMBOL_CUSTOM',
        setupType: 'symbol_custom',
        strategy: 'GBPJPY_BUY_MOCK',
        strategyType: 'SymbolCustom',
      }),
    }));
    expect(paperTradingService.submitExternalPaperSignal).not.toHaveBeenCalled();
    expect(paperTradingService._executePaperTrade).not.toHaveBeenCalled();
    expect(tradeExecutor.executeTrade).not.toHaveBeenCalled();
  });

  test('runtime can call submitExternalPaperSignal public wrapper when submitSymbolCustomSignal is unavailable', async () => {
    const { runtime, paperTradingService } = loadRuntime({
      symbolCustoms: [
        {
          _id: 'sc-sell',
          symbol: 'AUDUSD',
          symbolCustomName: 'AUDUSD_SELL_MOCK',
          logicName: 'SELL_MOCK_SYMBOL_CUSTOM',
          paperEnabled: true,
        },
      ],
      logicResults: {
        SELL_MOCK_SYMBOL_CUSTOM: {
          signal: 'SELL',
          reason: 'mock sell signal',
        },
      },
    });
    delete paperTradingService.submitSymbolCustomSignal;

    await runtime.runPaperScan({
      force: true,
      getCandlesFn: jest.fn(async () => ({ entry: [{ close: 0.66 }] })),
    });

    expect(paperTradingService.submitExternalPaperSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'symbolCustom',
        signal: 'SELL',
        strategyType: 'SymbolCustom',
      }),
      { source: 'symbolCustom' }
    );
    expect(paperTradingService._executePaperTrade).not.toHaveBeenCalled();
  });

  test('runtime returns clear error when no public paper signal wrapper exists', async () => {
    const { runtime, paperTradingService } = loadRuntime({
      symbolCustoms: [
        {
          _id: 'sc-no-wrapper',
          symbol: 'GBPJPY',
          symbolCustomName: 'GBPJPY_NO_WRAPPER',
          logicName: 'BUY_MOCK_SYMBOL_CUSTOM',
          paperEnabled: true,
        },
      ],
      logicResults: {
        BUY_MOCK_SYMBOL_CUSTOM: {
          signal: 'BUY',
          reason: 'mock buy signal',
        },
      },
    });
    delete paperTradingService.submitSymbolCustomSignal;
    delete paperTradingService.submitExternalPaperSignal;

    await expect(runtime.runPaperScan({
      force: true,
      getCandlesFn: jest.fn(async () => ({ entry: [{ close: 190.5 }] })),
    })).rejects.toMatchObject({
      statusCode: 500,
      message: runtime.SYMBOL_CUSTOM_PAPER_SIGNAL_HANDLER_NOT_AVAILABLE,
    });
    expect(paperTradingService._executePaperTrade).not.toHaveBeenCalled();
  });

  test('live scope is blocked by symbolCustomEngine', async () => {
    const { engine } = loadRuntime();

    const signal = await engine.analyzeSymbolCustom({
      _id: 'sc-live',
      symbol: 'AUDUSD',
      symbolCustomName: 'AUDUSD_LIVE',
      logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
    }, jest.fn(), { scope: 'live' });

    expect(signal).toEqual(expect.objectContaining({
      scope: 'live',
      source: 'symbolCustom',
      signal: 'NONE',
      status: 'BLOCKED',
      reasonCode: engine.SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_2,
    }));
  });

  test('unknown logic returns a clear error during paper scan', async () => {
    const { runtime } = loadRuntime({
      symbolCustoms: [
        {
          _id: 'sc-unknown',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_UNKNOWN',
          logicName: 'UNKNOWN_SYMBOL_CUSTOM',
          paperEnabled: true,
        },
      ],
    });

    await expect(runtime.runPaperScan({
      force: true,
      getCandlesFn: jest.fn(async () => ({ entry: [] })),
    })).rejects.toMatchObject({
      statusCode: 400,
      message: 'SYMBOL_CUSTOM_LOGIC_NOT_REGISTERED',
    });
  });

  test('missing candle provider for non-placeholder logic returns a clear error', async () => {
    const { runtime } = loadRuntime({
      symbolCustoms: [
        {
          _id: 'sc-buy-no-candles',
          symbol: 'GBPJPY',
          symbolCustomName: 'GBPJPY_BUY_MOCK',
          logicName: 'BUY_MOCK_SYMBOL_CUSTOM',
          paperEnabled: true,
        },
      ],
      logicResults: {
        BUY_MOCK_SYMBOL_CUSTOM: {
          signal: 'BUY',
          reason: 'mock buy signal',
        },
      },
    });

    await expect(runtime.runPaperScan({ force: true })).rejects.toMatchObject({
      statusCode: 400,
      message: runtime.SYMBOL_CUSTOM_CANDLE_PROVIDER_REQUIRED,
      details: [expect.objectContaining({
        symbolCustomId: 'sc-buy-no-candles',
        logicName: 'BUY_MOCK_SYMBOL_CUSTOM',
      })],
    });
  });

  test('getStatus returns runtime structure with last signal snapshot', async () => {
    const { runtime } = loadRuntime({
      symbolCustoms: [
        {
          _id: 'sc-status',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_STATUS',
          logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
          paperEnabled: true,
        },
      ],
    });

    await runtime.runPaperScan({ force: true });
    const status = runtime.getStatus();

    expect(status).toEqual(expect.objectContaining({
      enabled: false,
      running: false,
      lastScanAt: expect.any(Date),
      lastError: null,
      activePaperCustoms: 1,
      lastSignalCount: 1,
      lastSignals: expect.any(Array),
    }));
    expect(status.lastSignals[0]).toEqual(expect.objectContaining({
      source: 'symbolCustom',
      scope: 'paper',
      signal: 'NONE',
    }));
  });

  test('scan once does not touch live execution path', async () => {
    const { runtime, tradeExecutor } = loadRuntime({
      symbolCustoms: [
        {
          _id: 'sc-scan-once',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_SCAN_ONCE',
          logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
          paperEnabled: true,
        },
      ],
    });

    const result = await runtime.runPaperScan({ force: true });

    expect(result.success).toBe(true);
    expect(result.signals[0].signal).toBe('NONE');
    expect(tradeExecutor.executeTrade).not.toHaveBeenCalled();
  });
});
