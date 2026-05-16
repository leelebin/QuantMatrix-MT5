function makeBacktestForWindow(args = {}) {
  const statsByLabel = {
    '2M': {
      trades: 80,
      netPnl: 120,
      profitFactor: 1.28,
      winRate: 0.48,
      avgR: 0.12,
      maxDrawdown: 45,
      maxDrawdownPercent: 9,
    },
    '4M': {
      trades: 150,
      netPnl: 180,
      profitFactor: 1.24,
      winRate: 0.46,
      avgR: 0.11,
      maxDrawdown: 70,
      maxDrawdownPercent: 14,
    },
    '8M': {
      trades: 260,
      netPnl: 260,
      profitFactor: 1.21,
      winRate: 0.45,
      avgR: 0.10,
      maxDrawdown: 100,
      maxDrawdownPercent: 20,
    },
    '12M': {
      trades: 396,
      netPnl: 337.28,
      profitFactor: 1.294,
      winRate: 0.465,
      avgR: 0.1377,
      maxDrawdown: 63.9,
      maxDrawdownPercent: 12.78,
    },
    bad_cost: {
      trades: 200,
      netPnl: 20,
      profitFactor: 1.08,
      winRate: 0.40,
      avgR: 0.03,
      maxDrawdown: 80,
      maxDrawdownPercent: 16,
    },
    bad_dd: {
      trades: 200,
      netPnl: 50,
      profitFactor: 1.15,
      winRate: 0.42,
      avgR: 0.05,
      maxDrawdown: 220,
      maxDrawdownPercent: 44,
    },
  };
  const label = args.options?.validationWindow || '2M';
  const summary = statsByLabel[label] || statsByLabel['2M'];

  return {
    _id: `bt-${label}`,
    symbol: 'USDJPY',
    symbolCustomId: args.symbolCustomId,
    symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
    logicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
    status: 'completed',
    startDate: args.startDate,
    endDate: args.endDate,
    initialBalance: args.initialBalance || 500,
    parameters: args.parameters,
    costModelUsed: args.costModel || {},
    summary,
    trades: [],
  };
}

function makeEvaluation(backtest = {}) {
  const netPnl = Number(backtest.summary?.netPnl || 0);
  const trades = Number(backtest.summary?.trades || 0);
  return {
    symbol: backtest.symbol,
    symbolCustomName: backtest.symbolCustomName,
    summary: backtest.summary,
    directionBreakdown: {
      BUY: { trades, netPnl, profitFactor: backtest.summary?.profitFactor },
      SELL: { trades: 0, netPnl: 0, profitFactor: null },
    },
    exitReasonBreakdown: {
      TP: { trades: Math.floor(trades / 2), netPnl },
      SL: { trades: Math.ceil(trades / 2), netPnl: 0 },
    },
    monthlyBreakdown: {
      '2026-05': { trades, netPnl, profitFactor: backtest.summary?.profitFactor },
    },
    costSensitivity: {
      mediumCost: {
        netPnlAfterCost: netPnl - trades * 0.5,
        profitFactorAfterCost: backtest.summary?.profitFactor || null,
        profitableAfterCost: netPnl - trades * 0.5 > 0,
      },
    },
    recommendation: { primary: 'BACKTEST_ONLY_REVIEW', codes: [] },
    warnings: [],
  };
}

function loadService({ symbolCustom, backtestImpl } = {}) {
  jest.resetModules();

  const SymbolCustom = {
    findById: jest.fn(async () => symbolCustom || {
      _id: 'sc-usdjpy',
      symbol: 'USDJPY',
      symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      logicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      parameters: { enableBuy: true, enableSell: true },
    }),
  };
  const symbolCustomBacktestService = {
    runSymbolCustomBacktest: jest.fn(backtestImpl || (async (args) => makeBacktestForWindow(args))),
  };
  const symbolCustomEvaluationService = {
    evaluateSymbolCustomBacktest: jest.fn((backtest) => makeEvaluation(backtest)),
  };
  const tradeExecutor = { executeTrade: jest.fn() };
  const riskManager = { calculateLotSize: jest.fn(), calculatePositionSize: jest.fn() };
  const paperTradingService = { submitSymbolCustomSignal: jest.fn(), _executePaperTrade: jest.fn() };
  const backtestEngine = { runBacktest: jest.fn(), run: jest.fn() };

  jest.doMock('../src/models/SymbolCustom', () => SymbolCustom);
  jest.doMock('../src/services/symbolCustomBacktestService', () => symbolCustomBacktestService);
  jest.doMock('../src/services/symbolCustomEvaluationService', () => symbolCustomEvaluationService);
  jest.doMock('../src/services/tradeExecutor', () => tradeExecutor);
  jest.doMock('../src/services/riskManager', () => riskManager);
  jest.doMock('../src/services/paperTradingService', () => paperTradingService);
  jest.doMock('../src/services/backtestEngine', () => backtestEngine);

  return {
    service: require('../src/services/symbolCustomCandidateValidationService'),
    SymbolCustom,
    symbolCustomBacktestService,
    symbolCustomEvaluationService,
    tradeExecutor,
    riskManager,
    paperTradingService,
    backtestEngine,
  };
}

describe('symbolCustomCandidateValidationService', () => {
  afterEach(() => {
    jest.dontMock('../src/models/SymbolCustom');
    jest.dontMock('../src/services/symbolCustomBacktestService');
    jest.dontMock('../src/services/symbolCustomEvaluationService');
    jest.dontMock('../src/services/tradeExecutor');
    jest.dontMock('../src/services/riskManager');
    jest.dontMock('../src/services/paperTradingService');
    jest.dontMock('../src/services/backtestEngine');
  });

  test('candidate validation runs multiple windows', async () => {
    const { service, symbolCustomBacktestService } = loadService();

    const validation = await service.runSymbolCustomCandidateValidation({
      symbolCustomId: 'sc-usdjpy',
      candidateName: 'buy_session_conservative',
      candidateParameters: { enableBuy: true, enableSell: false },
      windows: [
        { label: '2M', startDate: '2026-03-15', endDate: '2026-05-15' },
        { label: '4M', startDate: '2026-01-15', endDate: '2026-05-15' },
        { label: '8M', startDate: '2025-09-15', endDate: '2026-05-15' },
        { label: '12M', startDate: '2025-05-15', endDate: '2026-05-15' },
      ],
      initialBalance: 500,
    });

    expect(symbolCustomBacktestService.runSymbolCustomBacktest).toHaveBeenCalledTimes(4);
    expect(validation.windows).toHaveLength(4);
    expect(validation.passCount).toBe(4);
    expect(validation.failCount).toBe(0);
    expect(validation.overallRecommendation).toBe('VALIDATION_PASSED');
  });

  test('candidate parameters override stored baseline without saving them', async () => {
    const { service, symbolCustomBacktestService, SymbolCustom } = loadService({
      symbolCustom: {
        _id: 'sc-usdjpy',
        symbol: 'USDJPY',
        symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
        logicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
        parameters: { enableBuy: true, enableSell: true, allowedUtcHours: '' },
      },
    });

    await service.runSymbolCustomCandidateValidation({
      symbolCustomId: 'sc-usdjpy',
      candidateParameters: {
        enableBuy: true,
        enableSell: false,
        allowedUtcHours: '23,0,1,7,8,9,10',
      },
      windows: [{ label: '2M', startDate: '2026-03-15', endDate: '2026-05-15' }],
    });

    expect(symbolCustomBacktestService.runSymbolCustomBacktest).toHaveBeenCalledWith(expect.objectContaining({
      parameters: {
        enableBuy: true,
        enableSell: false,
        allowedUtcHours: '23,0,1,7,8,9,10',
      },
    }));
    expect(SymbolCustom.findById).toHaveBeenCalledWith('sc-usdjpy');
    expect(SymbolCustom.update).toBeUndefined();
  });

  test('window output includes evaluation breakdowns and medium cost net pnl', async () => {
    const { service } = loadService();

    const validation = await service.runSymbolCustomCandidateValidation({
      symbolCustomId: 'sc-usdjpy',
      windows: [{ label: '2M', startDate: '2026-03-15', endDate: '2026-05-15' }],
    });

    expect(validation.windows[0]).toEqual(expect.objectContaining({
      label: '2M',
      trades: 80,
      netPnl: 120,
      profitFactor: 1.28,
      avgR: 0.12,
      maxDrawdownPercent: 9,
      mediumCostNetPnl: 80,
      validationStatus: 'PASS',
      monthlyBreakdown: expect.any(Object),
      directionBreakdown: expect.any(Object),
      exitReasonBreakdown: expect.any(Object),
    }));
  });

  test('cost fragile window returns REJECT_COST_FRAGILE', async () => {
    const { service } = loadService();

    const validation = await service.runSymbolCustomCandidateValidation({
      symbolCustomId: 'sc-usdjpy',
      windows: [{ label: 'bad_cost', startDate: '2026-04-01', endDate: '2026-05-15' }],
    });

    expect(validation.windows[0].validationStatus).toBe('FAIL');
    expect(validation.windows[0].reasons).toContain('MEDIUM_COST_NOT_PROFITABLE');
    expect(validation.overallRecommendation).toBe('REJECT_COST_FRAGILE');
  });

  test('high drawdown window returns REJECT_DRAWDOWN_TOO_HIGH', async () => {
    const { service } = loadService();

    const validation = await service.runSymbolCustomCandidateValidation({
      symbolCustomId: 'sc-usdjpy',
      windows: [{ label: 'bad_dd', startDate: '2026-04-01', endDate: '2026-05-15' }],
    });

    expect(validation.windows[0].validationStatus).toBe('FAIL');
    expect(validation.windows[0].reasons).toContain('DRAWDOWN_ABOVE_35');
    expect(validation.overallRecommendation).toBe('REJECT_DRAWDOWN_TOO_HIGH');
  });

  test('placeholder returns validation rejection without running backtests', async () => {
    const { service, symbolCustomBacktestService } = loadService({
      symbolCustom: {
        _id: 'sc-placeholder',
        symbol: 'USDJPY',
        symbolCustomName: 'USDJPY_PLACEHOLDER',
        logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
      },
    });

    const validation = await service.runSymbolCustomCandidateValidation({
      symbolCustomId: 'sc-placeholder',
    });

    expect(symbolCustomBacktestService.runSymbolCustomBacktest).not.toHaveBeenCalled();
    expect(validation.windows).toEqual([]);
    expect(validation.conclusion).toEqual(expect.objectContaining({
      reasonCode: 'PLACEHOLDER_SYMBOL_CUSTOM',
    }));
  });

  test('paper/live remains NONE for USDJPY logic', () => {
    const UsdjpyJpyMacroReversalV1 = require('../src/symbolCustom/logics/UsdjpyJpyMacroReversalV1');
    const logic = new UsdjpyJpyMacroReversalV1();
    const parameters = {
      enableBuy: true,
      enableSell: false,
      allowedUtcHours: '23,0,1,7,8,9,10',
      cooldownBarsAfterAnyExit: 6,
      cooldownBarsAfterSL: 18,
      maxDailyLosses: 3,
      maxDailyTrades: 6,
    };

    expect(logic.analyze({ scope: 'paper', parameters }).signal).toBe('NONE');
    expect(logic.analyze({ scope: 'live', parameters }).signal).toBe('NONE');
  });

  test('does not call tradeExecutor, riskManager, paperTradingService, old backtestEngine, or six strategies', async () => {
    const {
      service,
      tradeExecutor,
      riskManager,
      paperTradingService,
      backtestEngine,
    } = loadService();

    await service.runSymbolCustomCandidateValidation({
      symbolCustomId: 'sc-usdjpy',
      windows: [{ label: '2M', startDate: '2026-03-15', endDate: '2026-05-15' }],
    });

    expect(tradeExecutor.executeTrade).not.toHaveBeenCalled();
    expect(riskManager.calculateLotSize).not.toHaveBeenCalled();
    expect(riskManager.calculatePositionSize).not.toHaveBeenCalled();
    expect(paperTradingService.submitSymbolCustomSignal).not.toHaveBeenCalled();
    expect(paperTradingService._executePaperTrade).not.toHaveBeenCalled();
    expect(backtestEngine.runBacktest).not.toHaveBeenCalled();
    expect(backtestEngine.run).not.toHaveBeenCalled();

    const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'services', 'symbolCustomCandidateValidationService.js'), 'utf8');
    expect(source).not.toMatch(/tradeExecutor|riskManager|paperTradingService|backtestEngine|src\/strategies|\.\.\/strategies|Momentum|Breakout|MeanReversion|MultiTimeframe|TrendFollowing|VolumeFlowHybrid/);
  });
});
