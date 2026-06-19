const ORIGINAL_SYMBOL_CUSTOM_PAPER_ENABLED = process.env.SYMBOL_CUSTOM_PAPER_ENABLED;
const USDJPY_LOGIC = 'USDJPY_JPY_MACRO_REVERSAL_V1';
const XAU_MICRO_LOGIC = 'XAUUSD_MICROSTRUCTURE_SCALP_V1';
const XAU_EMA50_LOGIC = 'XAUUSD_EMA50_PULLBACK_TREND_V1';
const XAU_VOLUME_PROFILE_LOGIC = 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1';

function loadRuntime({
  symbolCustoms = [],
  logicResults = {},
} = {}) {
  jest.resetModules();

  const SymbolCustom = {
    findAll: jest.fn(async () => symbolCustoms.map((record) => ({ ...record }))),
  };

  const paperTradingService = {
    ensureConnected: jest.fn(async () => ({ success: true })),
    submitSymbolCustomSignal: jest.fn(async () => ({ success: true })),
    submitExternalPaperSignal: jest.fn(async () => ({ success: true })),
    _executePaperTrade: jest.fn(async () => ({ success: true })),
  };

  const tradeExecutor = {
    executeTrade: jest.fn(),
  };
  const riskManager = {
    calculateLotSize: jest.fn(),
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
  jest.doMock('../src/services/riskManager', () => riskManager);
  jest.doMock('../src/symbolCustom/registry', () => ({
    getSymbolCustomLogic,
  }));

  return {
    runtime: require('../src/services/symbolCustomPaperRuntimeService'),
    engine: require('../src/services/symbolCustomEngine'),
    SymbolCustom,
    paperTradingService,
    tradeExecutor,
    riskManager,
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
    jest.dontMock('../src/services/riskManager');
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

  test('liveEnabled=true SymbolCustom can still run through paper runtime observation', async () => {
    const { runtime, paperTradingService, tradeExecutor } = loadRuntime({
      symbolCustoms: [
        {
          _id: 'sc-live-flag',
          symbol: 'USDJPY',
          symbolCustomName: USDJPY_LOGIC,
          logicName: USDJPY_LOGIC,
          paperEnabled: true,
          liveEnabled: true,
        },
      ],
      logicResults: {
        [USDJPY_LOGIC]: {
          signal: 'BUY',
          confidence: 0.76,
          reason: 'mock buy signal while live flag is also enabled',
          sl: 147.1,
          tp: 148.2,
        },
      },
    });

    const result = await runtime.runPaperScan({
      force: true,
      getCandlesFn: jest.fn(async () => ({ entry: [{ close: 147.5 }] })),
    });

    expect(result.submitted).toBe(1);
    expect(result.ignored).toBe(0);
    expect(result.signals[0]).toEqual(expect.objectContaining({
      status: 'SIGNAL',
      signal: 'BUY',
      symbolCustomId: 'sc-live-flag',
    }));
    expect(paperTradingService.submitSymbolCustomSignal).toHaveBeenCalledTimes(1);
    expect(tradeExecutor.executeTrade).not.toHaveBeenCalled();
  });

  test('paperEnabled=true placeholder is ignored without opening paper trade', async () => {
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
      status: 'IGNORED',
      reasonCode: runtime.SYMBOL_CUSTOM_PAPER_LOGIC_NOT_ALLOWED,
      symbolCustomId: 'sc-placeholder',
      symbolCustomName: 'USDJPY_PLACEHOLDER',
    }));
    expect(paperTradingService.submitSymbolCustomSignal).not.toHaveBeenCalled();
    expect(paperTradingService._executePaperTrade).not.toHaveBeenCalled();
  });

  test('USDJPY paper logic submits only to paperTradingService with SymbolCustom metadata', async () => {
    const { runtime, paperTradingService, tradeExecutor, riskManager } = loadRuntime({
      symbolCustoms: [
        {
          _id: 'sc-buy',
          symbol: 'USDJPY',
          symbolCustomName: USDJPY_LOGIC,
          logicName: USDJPY_LOGIC,
          paperEnabled: true,
          liveEnabled: false,
          parameters: { lookbackBars: 20, enableBuy: true, enableSell: false },
        },
      ],
      logicResults: {
        [USDJPY_LOGIC]: {
          signal: 'BUY',
          confidence: 0.78,
          marketQualityScore: 0.9,
          marketQualityThreshold: 0.7,
          reason: 'mock buy signal',
          sl: 147.1,
          tp: 148.2,
          metadata: {
            source: 'symbolCustom',
            setupType: 'jpy_macro_reversal',
            candidatePreset: 'buy_session_conservative',
            scope: 'paper',
          },
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
      symbol: 'USDJPY',
      symbolCustomId: 'sc-buy',
      symbolCustomName: USDJPY_LOGIC,
      logicName: USDJPY_LOGIC,
      setupType: 'jpy_macro_reversal',
      strategy: USDJPY_LOGIC,
      strategyType: 'SymbolCustom',
      signal: 'BUY',
      confidence: 0.78,
      rawConfidence: 0.78,
      marketQualityScore: 0.9,
      marketQualityThreshold: 0.7,
      candidatePreset: 'buy_session_conservative',
      parameterSnapshot: expect.objectContaining({ lookbackBars: 20 }),
      metadata: expect.objectContaining({
        source: 'symbolCustom',
        symbolCustomId: 'sc-buy',
        symbolCustomName: USDJPY_LOGIC,
        logicName: USDJPY_LOGIC,
        setupType: 'jpy_macro_reversal',
        strategy: USDJPY_LOGIC,
        strategyType: 'SymbolCustom',
        confidence: 0.78,
        rawConfidence: 0.78,
        marketQualityScore: 0.9,
        marketQualityThreshold: 0.7,
        candidatePreset: 'buy_session_conservative',
        parameterSnapshot: expect.objectContaining({ lookbackBars: 20 }),
      }),
    }));
    expect(paperTradingService.submitExternalPaperSignal).not.toHaveBeenCalled();
    expect(paperTradingService._executePaperTrade).not.toHaveBeenCalled();
    expect(tradeExecutor.executeTrade).not.toHaveBeenCalled();
    expect(riskManager.calculateLotSize).not.toHaveBeenCalled();
  });

  test('connects paper trading service before submitting a SymbolCustom paper signal', async () => {
    const { runtime, paperTradingService } = loadRuntime({
      symbolCustoms: [
        {
          _id: 'sc-connect-first',
          symbol: 'USDJPY',
          symbolCustomName: USDJPY_LOGIC,
          logicName: USDJPY_LOGIC,
          paperEnabled: true,
          parameters: { enabled: true },
        },
      ],
      logicResults: {
        [USDJPY_LOGIC]: {
          signal: 'BUY',
          confidence: 0.7,
          reason: 'mock buy signal',
          sl: 147.1,
          tp: 148.2,
        },
      },
    });

    await runtime.runPaperScan({
      force: true,
      getCandlesFn: jest.fn(async () => ({ entry: [{ close: 147.5 }] })),
    });

    expect(paperTradingService.ensureConnected).toHaveBeenCalledWith({
      source: 'symbolCustomPaperRuntime',
    });
    expect(paperTradingService.ensureConnected.mock.invocationCallOrder[0]).toBeLessThan(
      paperTradingService.submitSymbolCustomSignal.mock.invocationCallOrder[0]
    );
  });

  test('XAUUSD microstructure paper logic is allowed through SymbolCustom paper wrapper', async () => {
    const { runtime, paperTradingService, tradeExecutor, riskManager } = loadRuntime({
      symbolCustoms: [
        {
          _id: 'sc-xau-micro',
          symbol: 'XAUUSD',
          symbolCustomName: XAU_MICRO_LOGIC,
          logicName: XAU_MICRO_LOGIC,
          paperEnabled: true,
          liveEnabled: false,
          parameters: { enabled: true, minSignalScore: 75 },
        },
      ],
      logicResults: {
        [XAU_MICRO_LOGIC]: {
          signal: 'BUY',
          confidence: 0.82,
          marketQualityScore: 82,
          marketQualityThreshold: 75,
          reason: 'mock microstructure buy signal',
          sl: 2347.75,
          tp: 2354.00,
          metadata: {
            source: 'symbolCustom',
            setupType: 'microstructure_scalp',
            candidatePreset: 'microstructure_scalp_default_xauusd',
            pattern: 'VWAP_RECLAIM_WITH_BULLISH_ABSORPTION',
            dataMode: 'candleProxy',
            scope: 'paper',
          },
        },
      },
    });

    const result = await runtime.runPaperScan({
      force: true,
      getCandlesFn: jest.fn(async () => ({ entry: [{ close: 2350.25 }] })),
    });

    expect(result.submitted).toBe(1);
    expect(paperTradingService.submitSymbolCustomSignal).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'paper',
      source: 'symbolCustom',
      symbol: 'XAUUSD',
      symbolCustomId: 'sc-xau-micro',
      symbolCustomName: XAU_MICRO_LOGIC,
      logicName: XAU_MICRO_LOGIC,
      setupType: 'microstructure_scalp',
      strategy: XAU_MICRO_LOGIC,
      strategyType: 'SymbolCustom',
      signal: 'BUY',
      confidence: 0.82,
      marketQualityScore: 82,
      marketQualityThreshold: 75,
      candidatePreset: 'microstructure_scalp_default_xauusd',
      metadata: expect.objectContaining({
        source: 'symbolCustom',
        symbolCustomName: XAU_MICRO_LOGIC,
        logicName: XAU_MICRO_LOGIC,
        setupType: 'microstructure_scalp',
        strategyType: 'SymbolCustom',
        candidatePreset: 'microstructure_scalp_default_xauusd',
      }),
    }));
    expect(paperTradingService._executePaperTrade).not.toHaveBeenCalled();
    expect(tradeExecutor.executeTrade).not.toHaveBeenCalled();
    expect(riskManager.calculateLotSize).not.toHaveBeenCalled();
  });

  test('XAUUSD volume profile paper logic is allowed through SymbolCustom paper wrapper', async () => {
    const { runtime, paperTradingService, tradeExecutor, riskManager } = loadRuntime({
      symbolCustoms: [
        {
          _id: 'sc-xau-volume-profile',
          symbol: 'XAUUSD',
          symbolCustomName: XAU_VOLUME_PROFILE_LOGIC,
          logicName: XAU_VOLUME_PROFILE_LOGIC,
          paperEnabled: true,
          liveEnabled: false,
          parameters: { enabled: true, minConfidence: 65 },
        },
      ],
      logicResults: {
        [XAU_VOLUME_PROFILE_LOGIC]: {
          signal: 'BUY',
          strategyName: 'XAUUSD Volume Profile',
          moduleName: 'BREAKOUT_CONTINUATION',
          confidence: 0.78,
          marketQualityScore: 78,
          marketQualityThreshold: 65,
          reason: 'mock volume profile buy signal',
          sl: 2347.75,
          tp: 2354.00,
          metadata: {
            source: 'symbolCustom',
            setupType: 'volume_profile_strategy',
            strategyName: 'XAUUSD Volume Profile',
            moduleName: 'BREAKOUT_CONTINUATION',
            candidatePreset: 'xauusd_m1_m5_volume_profile_strategy_v1',
            scope: 'paper',
          },
        },
      },
    });

    const result = await runtime.runPaperScan({
      force: true,
      getCandlesFn: jest.fn(async () => ({ entry: [{ close: 2350.25 }] })),
    });

    expect(result.submitted).toBe(1);
    expect(paperTradingService.submitSymbolCustomSignal).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'paper',
      source: 'symbolCustom',
      symbol: 'XAUUSD',
      symbolCustomId: 'sc-xau-volume-profile',
      symbolCustomName: XAU_VOLUME_PROFILE_LOGIC,
      logicName: XAU_VOLUME_PROFILE_LOGIC,
      setupType: 'volume_profile_strategy',
      strategy: XAU_VOLUME_PROFILE_LOGIC,
      strategyType: 'SymbolCustom',
      signal: 'BUY',
      confidence: 0.78,
      marketQualityScore: 78,
      marketQualityThreshold: 65,
      candidatePreset: 'xauusd_m1_m5_volume_profile_strategy_v1',
      metadata: expect.objectContaining({
        source: 'symbolCustom',
        symbolCustomName: XAU_VOLUME_PROFILE_LOGIC,
        logicName: XAU_VOLUME_PROFILE_LOGIC,
        setupType: 'volume_profile_strategy',
        strategyType: 'SymbolCustom',
        strategyName: 'XAUUSD Volume Profile',
        moduleName: 'BREAKOUT_CONTINUATION',
      }),
    }));
    expect(paperTradingService._executePaperTrade).not.toHaveBeenCalled();
    expect(tradeExecutor.executeTrade).not.toHaveBeenCalled();
    expect(riskManager.calculateLotSize).not.toHaveBeenCalled();
  });

  test('XAUUSD EMA50 paper logic is allowed even when liveEnabled is also true', async () => {
    const { runtime, paperTradingService, tradeExecutor, riskManager } = loadRuntime({
      symbolCustoms: [
        {
          _id: 'sc-xau-ema50',
          symbol: 'XAUUSD',
          symbolCustomName: XAU_EMA50_LOGIC,
          logicName: XAU_EMA50_LOGIC,
          paperEnabled: true,
          liveEnabled: true,
          parameters: { enabled: true, minSignalScore: 70 },
        },
      ],
      logicResults: {
        [XAU_EMA50_LOGIC]: {
          signal: 'BUY',
          confidence: 0.84,
          marketQualityScore: 84,
          marketQualityThreshold: 70,
          reason: 'mock ema50 pullback buy signal',
          sl: 2345.00,
          tp: 2358.00,
          metadata: {
            source: 'symbolCustom',
            setupType: 'ema50_pullback_trend',
            candidatePreset: 'xauusd_ema50_pullback_trend_v1',
            scope: 'paper',
          },
        },
      },
    });

    const result = await runtime.runPaperScan({
      force: true,
      getCandlesFn: jest.fn(async () => ({ entry: [{ close: 2350.25 }] })),
    });

    expect(result.submitted).toBe(1);
    expect(paperTradingService.submitSymbolCustomSignal).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'paper',
      source: 'symbolCustom',
      symbol: 'XAUUSD',
      symbolCustomId: 'sc-xau-ema50',
      symbolCustomName: XAU_EMA50_LOGIC,
      logicName: XAU_EMA50_LOGIC,
      setupType: 'ema50_pullback_trend',
      strategyType: 'SymbolCustom',
      signal: 'BUY',
      confidence: 0.84,
    }));
    expect(tradeExecutor.executeTrade).not.toHaveBeenCalled();
    expect(riskManager.calculateLotSize).not.toHaveBeenCalled();
  });

  test('runtime can call submitExternalPaperSignal public wrapper when submitSymbolCustomSignal is unavailable', async () => {
    const { runtime, paperTradingService } = loadRuntime({
      symbolCustoms: [
        {
          _id: 'sc-sell',
          symbol: 'USDJPY',
          symbolCustomName: USDJPY_LOGIC,
          logicName: USDJPY_LOGIC,
          paperEnabled: true,
          liveEnabled: false,
        },
      ],
      logicResults: {
        [USDJPY_LOGIC]: {
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
          symbol: 'USDJPY',
          symbolCustomName: USDJPY_LOGIC,
          logicName: USDJPY_LOGIC,
          paperEnabled: true,
          liveEnabled: false,
        },
      ],
      logicResults: {
        [USDJPY_LOGIC]: {
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

  test('live scope is blocked by symbolCustomEngine readiness gate', async () => {
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
      reasonCode: engine.SYMBOL_CUSTOM_LIVE_NOT_ENABLED,
    }));
  });

  test('unknown logic is ignored by paper runtime safety gate', async () => {
    const { runtime, paperTradingService } = loadRuntime({
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

    const result = await runtime.runPaperScan({
      force: true,
      getCandlesFn: jest.fn(async () => ({ entry: [] })),
    });

    expect(result.submitted).toBe(0);
    expect(result.ignored).toBe(1);
    expect(result.signals[0]).toEqual(expect.objectContaining({
      status: 'IGNORED',
      signal: 'NONE',
      reasonCode: runtime.SYMBOL_CUSTOM_PAPER_LOGIC_NOT_ALLOWED,
    }));
    expect(paperTradingService.submitSymbolCustomSignal).not.toHaveBeenCalled();
  });

  test('missing candle provider for non-placeholder logic returns a clear error', async () => {
    const { runtime } = loadRuntime({
      symbolCustoms: [
        {
          _id: 'sc-buy-no-candles',
          symbol: 'USDJPY',
          symbolCustomName: USDJPY_LOGIC,
          logicName: USDJPY_LOGIC,
          paperEnabled: true,
          liveEnabled: false,
        },
      ],
      logicResults: {
        [USDJPY_LOGIC]: {
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
        logicName: USDJPY_LOGIC,
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

  test('paper runtime source does not reference six strategy classes', () => {
    const fs = require('fs');
    const source = fs.readFileSync(require('path').join(__dirname, '..', 'src/services/symbolCustomPaperRuntimeService.js'), 'utf8');
    expect(source).not.toMatch(/TrendFollowingStrategy|MeanReversionStrategy|BreakoutStrategy|MomentumStrategy|MultiTimeframeStrategy|VolumeFlowHybridStrategy|src\/strategies|\.\.\/strategies/);
  });
});
