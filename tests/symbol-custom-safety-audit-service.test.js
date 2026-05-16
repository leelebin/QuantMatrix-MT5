function loadAuditService({ symbolCustoms = [] } = {}) {
  jest.resetModules();

  const SymbolCustom = {
    findAll: jest.fn(async () => symbolCustoms.map((record) => ({ ...record }))),
  };
  const optimizerRunsDb = {
    insert: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    find: jest.fn(),
  };
  const tradeExecutor = {
    executeTrade: jest.fn(),
  };
  const backtestEngine = {
    runBacktest: jest.fn(),
    run: jest.fn(),
  };

  jest.doMock('../src/models/SymbolCustom', () => SymbolCustom);
  jest.doMock('../src/config/db', () => ({ optimizerRunsDb }));
  jest.doMock('../src/services/tradeExecutor', () => tradeExecutor);
  jest.doMock('../src/services/backtestEngine', () => backtestEngine);
  jest.doMock('../src/routes/symbolCustomRoutes', () => jest.fn());
  jest.doMock('../src/services/symbolCustomReportService', () => ({
    buildSymbolCustomReport: jest.fn(),
  }));
  jest.doMock('../src/services/symbolCustomOptimizerService', () => ({
    buildParameterGridPreview: jest.fn(() => ({
      totalCombinations: 2,
      maxCombinations: 2,
      parameterGridPreview: [{ lookbackBars: 10 }, { lookbackBars: 20 }],
    })),
  }));
  jest.doMock('../src/services/symbolCustomBacktestService', () => ({
    runSymbolCustomBacktest: jest.fn(),
  }));

  return {
    service: require('../src/services/symbolCustomSafetyAuditService'),
    SymbolCustom,
    optimizerRunsDb,
    tradeExecutor,
    backtestEngine,
  };
}

function getCheck(audit, name) {
  return audit.checks.find((check) => check.name === name);
}

describe('symbolCustomSafetyAuditService', () => {
  afterEach(() => {
    jest.dontMock('../src/models/SymbolCustom');
    jest.dontMock('../src/config/db');
    jest.dontMock('../src/services/tradeExecutor');
    jest.dontMock('../src/services/backtestEngine');
    jest.dontMock('../src/routes/symbolCustomRoutes');
    jest.dontMock('../src/services/symbolCustomReportService');
  jest.dontMock('../src/services/symbolCustomOptimizerService');
  jest.dontMock('../src/services/symbolCustomBacktestService');
  jest.dontMock('../src/services/symbolCustomCandidateValidationService');
  });

  test('audit response structure is correct and placeholder returns PASS', async () => {
    const { service } = loadAuditService({
      symbolCustoms: [
        {
          _id: 'sc-1',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_PLACEHOLDER',
          logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
          liveEnabled: false,
          isPrimaryLive: false,
        },
      ],
    });

    const audit = await service.runSymbolCustomPhase1SafetyAudit();

    expect(audit).toEqual({
      success: true,
      checks: expect.any(Array),
      summary: expect.objectContaining({
        pass: expect.any(Number),
        warn: expect.any(Number),
        fail: expect.any(Number),
      }),
    });
    expect(getCheck(audit, 'placeholder does not trade')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'symbolCustom paper runtime default disabled')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'symbolCustom live runtime not connected')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'paper runtime scheduler env gated')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'scan-once respects env gate unless forced')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'runtime does not call private paper execution')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'public paper signal wrapper exists')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'missing candle provider detected')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'backtest scope allowed live blocked')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'symbolCustom backtest does not call old backtestEngine')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'symbolCustom backtest does not call six strategies')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'placeholder backtest returns stub')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'non-placeholder backtest requires candles')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'symbolCustom candle provider does not call tradeExecutor')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'symbolCustom candle provider does not call old backtestEngine')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'symbolCustom candle provider does not call six strategies')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'symbolCustom historical backtest requires date range')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'placeholder still does not require candles')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'USDJPY_JPY_MACRO_REVERSAL_V1 is registered')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'USDJPY_JPY_MACRO_REVERSAL_V1 is backtest-only')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'USDJPY_JPY_MACRO_REVERSAL_V1 does not reference six strategies')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'USDJPY_JPY_MACRO_REVERSAL_V1 does not reference tradeExecutor')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'USDJPY_JPY_MACRO_REVERSAL_V1 does not reference riskManager')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'USDJPY_JPY_MACRO_REVERSAL_V1 does not reference old backtestEngine')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'USDJPY guardrails are backtest-only')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'USDJPY paper/live still return NONE after guardrail changes')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'evaluation service does not call tradeExecutor')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'evaluation service does not call riskManager')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'evaluation service does not call old backtestEngine')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'evaluation service does not call six strategies')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'preset comparison does not call tradeExecutor')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'preset comparison does not call paperTradingService')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'preset comparison does not call old backtestEngine')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'preset comparison does not call six strategies')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'USDJPY paper/live remains NONE for preset comparison')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'candidate validation does not call tradeExecutor')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'candidate validation does not call riskManager')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'candidate validation does not call paperTradingService')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'candidate validation does not call old backtestEngine')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'candidate validation does not call six strategies')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'schema sync does not change paper/live/liveEnabled')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
    expect(getCheck(audit, 'schema sync does not touch trading systems')).toEqual(expect.objectContaining({
      status: 'PASS',
    }));
  });

  test('liveEnabled true produces WARN not FAIL', async () => {
    const { service } = loadAuditService({
      symbolCustoms: [
        {
          _id: 'sc-live',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_LIVE_FLAG',
          liveEnabled: true,
          isPrimaryLive: false,
        },
      ],
    });

    const audit = await service.runSymbolCustomPhase1SafetyAudit();
    const check = getCheck(audit, 'default live disabled');

    expect(check.status).toBe('WARN');
    expect(check.message).toContain('Phase 1 does not support live execution');
  });

  test('multiple primary live records produce WARN without automatic fix', async () => {
    const { service, SymbolCustom } = loadAuditService({
      symbolCustoms: [
        { _id: 'sc-1', symbol: 'USDJPY', symbolCustomName: 'A', isPrimaryLive: true },
        { _id: 'sc-2', symbol: 'USDJPY', symbolCustomName: 'B', isPrimaryLive: true },
      ],
    });

    const audit = await service.runSymbolCustomPhase1SafetyAudit();
    const check = getCheck(audit, 'primary live uniqueness');

    expect(check.status).toBe('WARN');
    expect(check.message).toContain('No automatic fix applied');
    expect(SymbolCustom.findAll).toHaveBeenCalledWith({});
    expect(SymbolCustom.update).toBeUndefined();
  });

  test('old optimizer db is not touched', async () => {
    const { service, optimizerRunsDb } = loadAuditService();

    await service.runSymbolCustomPhase1SafetyAudit();

    expect(optimizerRunsDb.insert).not.toHaveBeenCalled();
    expect(optimizerRunsDb.update).not.toHaveBeenCalled();
    expect(optimizerRunsDb.remove).not.toHaveBeenCalled();
    expect(optimizerRunsDb.find).not.toHaveBeenCalled();
    expect(getCheck(await service.runSymbolCustomPhase1SafetyAudit(), 'old optimizer untouched').status).toBe('PASS');
  });

  test('old backtestEngine is not called', async () => {
    const { service, backtestEngine } = loadAuditService();

    const audit = await service.runSymbolCustomPhase1SafetyAudit();

    expect(backtestEngine.runBacktest).not.toHaveBeenCalled();
    expect(backtestEngine.run).not.toHaveBeenCalled();
    expect(getCheck(audit, 'old backtest untouched').status).toBe('PASS');
  });

  test('tradeExecutor is not called', async () => {
    const { service, tradeExecutor } = loadAuditService();

    const audit = await service.runSymbolCustomPhase1SafetyAudit();

    expect(tradeExecutor.executeTrade).not.toHaveBeenCalled();
    expect(getCheck(audit, 'live execution not connected').status).toBe('PASS');
    expect(getCheck(audit, 'paper runtime never calls tradeExecutor').status).toBe('PASS');
  });

  test('paper runtime marks SymbolCustom source metadata', async () => {
    const { service } = loadAuditService();

    const audit = await service.runSymbolCustomPhase1SafetyAudit();

    expect(getCheck(audit, 'paper runtime marks source symbolCustom').status).toBe('PASS');
  });
});
