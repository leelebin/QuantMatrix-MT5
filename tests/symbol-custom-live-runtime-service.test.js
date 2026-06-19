const ORIGINAL_SYMBOL_CUSTOM_LIVE_ENABLED = process.env.SYMBOL_CUSTOM_LIVE_ENABLED;
const ORIGINAL_SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED = process.env.SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED;
const ORIGINAL_SYMBOL_CUSTOM_LIVE_ALLOWED_LOGICS = process.env.SYMBOL_CUSTOM_LIVE_ALLOWED_LOGICS;
const EMA50_LOGIC = 'XAUUSD_EMA50_PULLBACK_TREND_V1';
const VOLUME_PROFILE_LOGIC = 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1';

function buildEngineSignal(symbolCustom = {}, rawResult = {}, context = {}) {
  const signal = rawResult.signal || 'NONE';
  const metadata = rawResult.metadata || {};
  return {
    scope: context.scope || 'live',
    source: 'symbolCustom',
    symbol: symbolCustom.symbol,
    symbolCustomId: symbolCustom._id || null,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName: context.logicName || symbolCustom.logicName || symbolCustom.symbolCustomName,
    signal,
    status: rawResult.status || (signal === 'NONE' ? 'NO_SIGNAL' : 'SIGNAL'),
    reason: rawResult.reason || null,
    reasonCode: rawResult.reasonCode,
    confidence: rawResult.confidence ?? metadata.confidence,
    marketQualityScore: rawResult.marketQualityScore ?? metadata.marketQualityScore,
    marketQualityThreshold: rawResult.marketQualityThreshold ?? metadata.marketQualityThreshold,
    sl: rawResult.sl ?? null,
    tp: rawResult.tp ?? null,
    setupTimeframe: rawResult.setupTimeframe || symbolCustom.timeframes?.setupTimeframe || symbolCustom.parameters?.setupTimeframe || null,
    entryTimeframe: rawResult.entryTimeframe || symbolCustom.timeframes?.entryTimeframe || symbolCustom.parameters?.entryTimeframe || null,
    setupCandleTime: rawResult.setupCandleTime,
    entryCandleTime: rawResult.entryCandleTime,
    metadata,
    parameters: symbolCustom.parameters || {},
    timestamp: context.timestamp || new Date('2026-06-04T00:00:00.000Z'),
  };
}

function evaluateReadiness(symbolCustom = {}) {
  if (symbolCustom.liveEnabled !== true) {
    return { allowed: false, reasonCode: 'SYMBOL_CUSTOM_LIVE_NOT_ENABLED', reason: 'liveEnabled required' };
  }
  if (symbolCustom.allowLive !== true) {
    return { allowed: false, reasonCode: 'SYMBOL_CUSTOM_LIVE_NOT_ALLOWED', reason: 'allowLive required' };
  }
  if (!['validated', 'live_ready'].includes(symbolCustom.status)) {
    return { allowed: false, reasonCode: 'SYMBOL_CUSTOM_LIVE_STATUS_NOT_READY', reason: 'live-ready status required' };
  }
  if (symbolCustom.parameters?.enabled === false) {
    return { allowed: false, reasonCode: 'SYMBOL_CUSTOM_LIVE_PARAMETERS_DISABLED', reason: 'parameters disabled' };
  }
  return { allowed: true, reasonCode: null, reason: null };
}

function loadRuntime({ symbolCustoms = [], analysisResult = null } = {}) {
  jest.resetModules();

  const SymbolCustom = {
    findAll: jest.fn(async () => symbolCustoms.map((record) => ({ ...record }))),
  };
  const Position = {
    findAll: jest.fn(async () => []),
  };
  const tradeExecutor = {
    executeTrade: jest.fn(async (signal) => ({ success: true, message: 'mock live executed', trade: { _id: 'pos-1', signal } })),
  };
  const engine = {
    evaluateSymbolCustomLiveReadiness: jest.fn(evaluateReadiness),
    buildSymbolCustomSignal: jest.fn(buildEngineSignal),
    analyzeSymbolCustom: jest.fn(async (symbolCustom, getCandlesFn, options) => buildEngineSignal(
      symbolCustom,
      analysisResult || {
        signal: 'BUY',
        confidence: 0.84,
        marketQualityScore: 84,
        marketQualityThreshold: 70,
        sl: 2345,
        tp: 2360,
        metadata: {
          setupType: 'ema50_pullback_trend',
          candidatePreset: 'xauusd_m30_ema50_pullback_trend_default',
        },
      },
      { scope: options.scope, logicName: symbolCustom.logicName }
    )),
  };

  jest.doMock('../src/models/SymbolCustom', () => SymbolCustom);
  jest.doMock('../src/models/Position', () => Position);
  jest.doMock('../src/services/tradeExecutor', () => tradeExecutor);
  jest.doMock('../src/services/symbolCustomEngine', () => engine);

  return {
    runtime: require('../src/services/symbolCustomLiveRuntimeService'),
    SymbolCustom,
    Position,
    tradeExecutor,
    engine,
  };
}

describe('symbolCustomLiveRuntimeService', () => {
  let consoleLogSpy;

  beforeEach(() => {
    delete process.env.SYMBOL_CUSTOM_LIVE_ALLOWED_LOGICS;
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    if (consoleLogSpy) consoleLogSpy.mockRestore();
    process.env.SYMBOL_CUSTOM_LIVE_ENABLED = ORIGINAL_SYMBOL_CUSTOM_LIVE_ENABLED;
    process.env.SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED = ORIGINAL_SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED;
    if (ORIGINAL_SYMBOL_CUSTOM_LIVE_ALLOWED_LOGICS === undefined) {
      delete process.env.SYMBOL_CUSTOM_LIVE_ALLOWED_LOGICS;
    } else {
      process.env.SYMBOL_CUSTOM_LIVE_ALLOWED_LOGICS = ORIGINAL_SYMBOL_CUSTOM_LIVE_ALLOWED_LOGICS;
    }
    jest.dontMock('../src/models/SymbolCustom');
    jest.dontMock('../src/models/Position');
    jest.dontMock('../src/services/tradeExecutor');
    jest.dontMock('../src/services/symbolCustomEngine');
  });

  test('runtime is disabled by default and does not query SymbolCustom records', async () => {
    delete process.env.SYMBOL_CUSTOM_LIVE_ENABLED;
    delete process.env.SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED;
    const { runtime, SymbolCustom, tradeExecutor } = loadRuntime({
      symbolCustoms: [{ _id: 'sc-ema50', liveEnabled: true }],
    });

    const result = await runtime.runLiveScan({
      getCandlesFn: jest.fn(async () => ({ entry: [] })),
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      enabled: false,
      reasonCode: runtime.SYMBOL_CUSTOM_LIVE_RUNTIME_DISABLED,
      submitted: 0,
    }));
    expect(SymbolCustom.findAll).not.toHaveBeenCalled();
    expect(tradeExecutor.executeTrade).not.toHaveBeenCalled();
  });

  test('live-ready primary EMA50 signal is analyzed but not executed when execution env is off', async () => {
    process.env.SYMBOL_CUSTOM_LIVE_ENABLED = 'true';
    delete process.env.SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED;
    const getCandlesFn = jest.fn(async () => ({ entry: [{ close: 2350 }] }));
    const { runtime, engine, tradeExecutor } = loadRuntime({
      symbolCustoms: [{
        _id: 'sc-ema50',
        symbol: 'XAUUSD',
        symbolCustomName: EMA50_LOGIC,
        logicName: EMA50_LOGIC,
        status: 'live_ready',
        liveEnabled: true,
        allowLive: true,
        isPrimaryLive: true,
        parameters: { enabled: true },
      }],
    });

    const result = await runtime.runLiveScan({ getCandlesFn });

    expect(engine.analyzeSymbolCustom).toHaveBeenCalledWith(expect.objectContaining({
      _id: 'sc-ema50',
    }), getCandlesFn, expect.objectContaining({
      scope: 'live',
      liveAnalysisAllowed: true,
    }));
    expect(result.submitted).toBe(0);
    expect(result.executionDisabled).toBe(1);
    expect(result.results[0]).toEqual(expect.objectContaining({
      action: 'live_execution_disabled',
      reasonCode: runtime.SYMBOL_CUSTOM_LIVE_EXECUTION_DISABLED,
    }));
    expect(tradeExecutor.executeTrade).not.toHaveBeenCalled();
  });

  test('tradeExecutor is called only when live runtime and live execution env are both enabled', async () => {
    process.env.SYMBOL_CUSTOM_LIVE_ENABLED = 'true';
    process.env.SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED = 'true';
    const { runtime, tradeExecutor } = loadRuntime({
      symbolCustoms: [{
        _id: 'sc-ema50',
        symbol: 'XAUUSD',
        symbolCustomName: EMA50_LOGIC,
        logicName: EMA50_LOGIC,
        status: 'live_ready',
        liveEnabled: true,
        allowLive: true,
        isPrimaryLive: true,
        parameters: { enabled: true, maxDailyTrades: 1 },
      }],
    });

    const result = await runtime.runLiveScan({
      getCandlesFn: jest.fn(async () => ({ entry: [{ close: 2350 }] })),
    });

    expect(result.submitted).toBe(1);
    expect(tradeExecutor.executeTrade).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'live',
      source: 'symbolCustom',
      symbol: 'XAUUSD',
      symbolCustomId: 'sc-ema50',
      symbolCustomName: EMA50_LOGIC,
      logicName: EMA50_LOGIC,
      strategy: EMA50_LOGIC,
      strategyType: 'SymbolCustom',
      setupType: 'ema50_pullback_trend',
      signal: 'BUY',
      confidence: 0.84,
      parameterSnapshot: expect.objectContaining({ maxDailyTrades: 1 }),
    }));
  });

  test('status exposes the latest live scan summary for diagnostics', async () => {
    process.env.SYMBOL_CUSTOM_LIVE_ENABLED = 'true';
    process.env.SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED = 'true';
    const { runtime } = loadRuntime({
      symbolCustoms: [{
        _id: 'sc-ema50',
        symbol: 'XAUUSD',
        symbolCustomName: EMA50_LOGIC,
        logicName: EMA50_LOGIC,
        status: 'live_ready',
        liveEnabled: true,
        allowLive: true,
        isPrimaryLive: true,
        parameters: { enabled: true },
      }],
    });

    const result = await runtime.runLiveScan({
      getCandlesFn: jest.fn(async () => ({ entry: [{ close: 2350 }] })),
    });
    const status = runtime.getStatus();

    expect(result.submitted).toBe(1);
    expect(status.lastScanSummary).toEqual(expect.objectContaining({
      enabled: true,
      executionEnabled: true,
      scanned: 1,
      activeLiveCustoms: 1,
      signalCount: 1,
      submitted: 1,
    }));
    expect(status.lastScanSummary.signals[0]).toEqual(expect.objectContaining({
      symbol: 'XAUUSD',
      logicName: EMA50_LOGIC,
      signal: 'BUY',
      action: 'live_submitted',
    }));
  });

  test('live runtime submits one trade signal per SymbolCustom candle bucket', async () => {
    process.env.SYMBOL_CUSTOM_LIVE_ENABLED = 'true';
    process.env.SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED = 'true';
    const { runtime, tradeExecutor } = loadRuntime({
      symbolCustoms: [{
        _id: 'sc-ema50',
        symbol: 'XAUUSD',
        symbolCustomName: EMA50_LOGIC,
        logicName: EMA50_LOGIC,
        status: 'live_ready',
        liveEnabled: true,
        allowLive: true,
        isPrimaryLive: true,
        parameters: { enabled: true, entryTimeframe: '30m', maxDailyTrades: 1 },
      }],
      analysisResult: {
        signal: 'SELL',
        confidence: 0.84,
        sl: 2360,
        tp: 2320,
        entryTimeframe: '30m',
        metadata: {
          setupType: 'ema50_pullback_trend',
          candidatePreset: 'xauusd_m30_ema50_pullback_trend_default',
        },
      },
    });

    const getCandlesFn = jest.fn(async () => ({ entry: [{ close: 2350 }] }));
    const first = await runtime.runLiveScan({ getCandlesFn });
    const second = await runtime.runLiveScan({ getCandlesFn });

    expect(first.submitted).toBe(1);
    expect(first.duplicateSkipped).toBe(0);
    expect(second.submitted).toBe(0);
    expect(second.duplicateSkipped).toBe(1);
    expect(second.results[0]).toEqual(expect.objectContaining({
      action: 'duplicate_skipped',
      reasonCode: runtime.SYMBOL_CUSTOM_LIVE_DUPLICATE_SIGNAL,
    }));
    expect(tradeExecutor.executeTrade).toHaveBeenCalledTimes(1);
  });

  test('live runtime skips execution when the same SymbolCustom already has an open position', async () => {
    process.env.SYMBOL_CUSTOM_LIVE_ENABLED = 'true';
    process.env.SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED = 'true';
    const { runtime, Position, tradeExecutor } = loadRuntime({
      symbolCustoms: [{
        _id: 'sc-ema50',
        symbol: 'XAUUSD',
        symbolCustomName: EMA50_LOGIC,
        logicName: EMA50_LOGIC,
        status: 'live_ready',
        liveEnabled: true,
        allowLive: true,
        isPrimaryLive: true,
        parameters: { enabled: true, entryTimeframe: '30m', maxDailyTrades: 1 },
      }],
      analysisResult: {
        signal: 'SELL',
        confidence: 0.84,
        sl: 2360,
        tp: 2320,
        entryTimeframe: '30m',
        metadata: {
          setupType: 'ema50_pullback_trend',
          candidatePreset: 'xauusd_m30_ema50_pullback_trend_default',
        },
      },
    });
    Position.findAll.mockResolvedValue([{
      _id: 'pos-open',
      status: 'OPEN',
      symbol: 'XAUUSD',
      strategy: EMA50_LOGIC,
      mt5PositionId: '12345',
    }]);

    const result = await runtime.runLiveScan({
      getCandlesFn: jest.fn(async () => ({ entry: [{ close: 2350 }] })),
    });

    expect(result.submitted).toBe(0);
    expect(result.openPositionSkipped).toBe(1);
    expect(result.results[0]).toEqual(expect.objectContaining({
      action: 'open_position_skipped',
      reasonCode: runtime.SYMBOL_CUSTOM_LIVE_OPEN_POSITION_EXISTS,
      openPositionId: 'pos-open',
      mt5PositionId: '12345',
    }));
    expect(tradeExecutor.executeTrade).not.toHaveBeenCalled();
  });

  test('non-primary live records are ignored before candle fetch and execution', async () => {
    process.env.SYMBOL_CUSTOM_LIVE_ENABLED = 'true';
    process.env.SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED = 'true';
    const getCandlesFn = jest.fn(async () => ({ entry: [{ close: 2350 }] }));
    const { runtime, engine, tradeExecutor } = loadRuntime({
      symbolCustoms: [{
        _id: 'sc-ema50',
        symbol: 'XAUUSD',
        symbolCustomName: EMA50_LOGIC,
        logicName: EMA50_LOGIC,
        status: 'live_ready',
        liveEnabled: true,
        allowLive: true,
        isPrimaryLive: false,
        parameters: { enabled: true },
      }],
    });

    const result = await runtime.runLiveScan({ getCandlesFn });

    expect(result.ignored).toBe(1);
    expect(result.signals[0]).toEqual(expect.objectContaining({
      status: 'IGNORED',
      reasonCode: runtime.SYMBOL_CUSTOM_LIVE_NOT_PRIMARY,
    }));
    expect(engine.analyzeSymbolCustom).not.toHaveBeenCalled();
    expect(getCandlesFn).not.toHaveBeenCalled();
    expect(tradeExecutor.executeTrade).not.toHaveBeenCalled();
  });

  test('live runtime uses an explicit logic allow-list', async () => {
    process.env.SYMBOL_CUSTOM_LIVE_ENABLED = 'true';
    const { runtime, tradeExecutor } = loadRuntime({
      symbolCustoms: [{
        _id: 'sc-other',
        symbol: 'XAUUSD',
        symbolCustomName: VOLUME_PROFILE_LOGIC,
        logicName: VOLUME_PROFILE_LOGIC,
        status: 'live_ready',
        liveEnabled: true,
        allowLive: true,
        isPrimaryLive: true,
        parameters: { enabled: true },
      }],
    });

    const result = await runtime.runLiveScan({
      getCandlesFn: jest.fn(async () => ({ entry: [{ close: 2350 }] })),
    });

    expect(result.ignored).toBe(1);
    expect(result.signals[0]).toEqual(expect.objectContaining({
      reasonCode: runtime.SYMBOL_CUSTOM_LIVE_LOGIC_NOT_ALLOWED,
    }));
    expect(tradeExecutor.executeTrade).not.toHaveBeenCalled();
  });

  test('live runtime allow-list can be extended from env', async () => {
    process.env.SYMBOL_CUSTOM_LIVE_ENABLED = 'true';
    process.env.SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED = 'true';
    process.env.SYMBOL_CUSTOM_LIVE_ALLOWED_LOGICS = VOLUME_PROFILE_LOGIC;
    const { runtime, tradeExecutor } = loadRuntime({
      symbolCustoms: [{
        _id: 'sc-volume-profile',
        symbol: 'XAUUSD',
        symbolCustomName: VOLUME_PROFILE_LOGIC,
        logicName: VOLUME_PROFILE_LOGIC,
        status: 'live_ready',
        liveEnabled: true,
        allowLive: true,
        isPrimaryLive: true,
        parameters: { enabled: true },
      }],
    });

    const result = await runtime.runLiveScan({
      getCandlesFn: jest.fn(async () => ({ entry: [{ close: 2350 }] })),
    });

    expect(runtime.getLiveAllowedLogics()).toEqual([VOLUME_PROFILE_LOGIC]);
    expect(result.submitted).toBe(1);
    expect(tradeExecutor.executeTrade).toHaveBeenCalledWith(expect.objectContaining({
      symbolCustomName: VOLUME_PROFILE_LOGIC,
      logicName: VOLUME_PROFILE_LOGIC,
      strategyType: 'SymbolCustom',
    }));
  });

  test('allowed live records require a candle provider', async () => {
    process.env.SYMBOL_CUSTOM_LIVE_ENABLED = 'true';
    const { runtime } = loadRuntime({
      symbolCustoms: [{
        _id: 'sc-ema50',
        symbol: 'XAUUSD',
        symbolCustomName: EMA50_LOGIC,
        logicName: EMA50_LOGIC,
        status: 'live_ready',
        liveEnabled: true,
        allowLive: true,
        isPrimaryLive: true,
        parameters: { enabled: true },
      }],
    });

    await expect(runtime.runLiveScan({})).rejects.toMatchObject({
      statusCode: 400,
      message: runtime.SYMBOL_CUSTOM_CANDLE_PROVIDER_REQUIRED,
      details: [expect.objectContaining({
        symbolCustomId: 'sc-ema50',
        logicName: EMA50_LOGIC,
      })],
    });
  });
});
