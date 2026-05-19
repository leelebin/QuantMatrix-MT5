function makeBacktestForPreset(args = {}) {
  const presetName = args.options?.presetName || 'baseline';
  const statsByPreset = {
    baseline: {
      trades: 2500,
      netPnl: 10,
      profitFactor: 1.01,
      winRate: 0.42,
      avgR: 0.01,
      maxDrawdown: 250,
      maxDrawdownPercent: 50,
    },
    buy_only: {
      trades: 600,
      netPnl: 180,
      profitFactor: 1.25,
      winRate: 0.48,
      avgR: 0.12,
      maxDrawdown: 80,
      maxDrawdownPercent: 16,
    },
    sell_only: {
      trades: 700,
      netPnl: -40,
      profitFactor: 0.94,
      winRate: 0.39,
      avgR: -0.03,
      maxDrawdown: 140,
      maxDrawdownPercent: 28,
    },
  };
  const summary = statsByPreset[presetName] || {
    trades: 400,
    netPnl: 30,
    profitFactor: 1.08,
    winRate: 0.43,
    avgR: 0.03,
    maxDrawdown: 120,
    maxDrawdownPercent: 24,
  };

  return {
    _id: `bt-${presetName}`,
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

function loadService({ symbolCustom } = {}) {
  jest.resetModules();

  const SymbolCustom = {
    findById: jest.fn(async () => symbolCustom || {
      _id: 'sc-usdjpy',
      symbol: 'USDJPY',
      symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      logicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      parameters: {},
    }),
  };
  const symbolCustomBacktestService = {
    runSymbolCustomBacktest: jest.fn(async (args) => makeBacktestForPreset(args)),
  };
  const symbolCustomEvaluationService = {
    evaluateSymbolCustomBacktest: jest.fn((backtest) => makeEvaluation(backtest)),
  };
  const tradeExecutor = { executeTrade: jest.fn() };
  const paperTradingService = {
    submitSymbolCustomSignal: jest.fn(),
    submitExternalPaperSignal: jest.fn(),
    _executePaperTrade: jest.fn(),
  };
  const backtestEngine = { runBacktest: jest.fn(), run: jest.fn() };

  jest.doMock('../src/models/SymbolCustom', () => SymbolCustom);
  jest.doMock('../src/services/symbolCustomBacktestService', () => symbolCustomBacktestService);
  jest.doMock('../src/services/symbolCustomEvaluationService', () => symbolCustomEvaluationService);
  jest.doMock('../src/services/tradeExecutor', () => tradeExecutor);
  jest.doMock('../src/services/paperTradingService', () => paperTradingService);
  jest.doMock('../src/services/backtestEngine', () => backtestEngine);

  return {
    service: require('../src/services/symbolCustomPresetComparisonService'),
    SymbolCustom,
    symbolCustomBacktestService,
    symbolCustomEvaluationService,
    tradeExecutor,
    paperTradingService,
    backtestEngine,
  };
}

describe('symbolCustomPresetComparisonService', () => {
  afterEach(() => {
    jest.dontMock('../src/models/SymbolCustom');
    jest.dontMock('../src/services/symbolCustomBacktestService');
    jest.dontMock('../src/services/symbolCustomEvaluationService');
    jest.dontMock('../src/services/tradeExecutor');
    jest.dontMock('../src/services/paperTradingService');
    jest.dontMock('../src/services/backtestEngine');
  });

  test('baseline preset runs', async () => {
    const { service, symbolCustomBacktestService } = loadService();

    const comparison = await service.runSymbolCustomPresetComparison({
      symbolCustomId: 'sc-usdjpy',
      startDate: '2025-03-15',
      endDate: '2026-05-15',
      initialBalance: 500,
      presets: [{ presetName: 'baseline', parameters: {} }],
    });

    expect(symbolCustomBacktestService.runSymbolCustomBacktest).toHaveBeenCalledWith(expect.objectContaining({
      symbolCustomId: 'sc-usdjpy',
      parameters: {},
      options: expect.objectContaining({
        useHistoricalCandles: true,
        presetComparison: true,
        presetName: 'baseline',
      }),
    }));
    expect(comparison.results).toHaveLength(1);
    expect(comparison.results[0]).toEqual(expect.objectContaining({
      presetName: 'baseline',
      evaluation: expect.any(Object),
      score: expect.any(Number),
    }));
  });

  test('buy_only preset overrides enableSell=false', async () => {
    const { service, symbolCustomBacktestService } = loadService();

    await service.runSymbolCustomPresetComparison({
      symbolCustomId: 'sc-usdjpy',
      presets: [{ presetName: 'buy_only', parameters: { enableBuy: true, enableSell: false } }],
    });

    expect(symbolCustomBacktestService.runSymbolCustomBacktest).toHaveBeenCalledWith(expect.objectContaining({
      parameters: { enableBuy: true, enableSell: false },
    }));
  });

  test('sell_only preset overrides enableBuy=false', async () => {
    const { service, symbolCustomBacktestService } = loadService();

    await service.runSymbolCustomPresetComparison({
      symbolCustomId: 'sc-usdjpy',
      presets: [{ presetName: 'sell_only', parameters: { enableBuy: false, enableSell: true } }],
    });

    expect(symbolCustomBacktestService.runSymbolCustomBacktest).toHaveBeenCalledWith(expect.objectContaining({
      parameters: { enableBuy: false, enableSell: true },
    }));
  });

  test('cooldown preset passes parameters', async () => {
    const { service, symbolCustomBacktestService } = loadService();

    await service.runSymbolCustomPresetComparison({
      symbolCustomId: 'sc-usdjpy',
      presets: [{
        presetName: 'cooldown_light',
        parameters: { cooldownBarsAfterAnyExit: 6, cooldownBarsAfterSL: 12 },
      }],
    });

    expect(symbolCustomBacktestService.runSymbolCustomBacktest).toHaveBeenCalledWith(expect.objectContaining({
      parameters: { cooldownBarsAfterAnyExit: 6, cooldownBarsAfterSL: 12 },
    }));
  });

  test('session preset passes allowedUtcHours', async () => {
    const { service, symbolCustomBacktestService } = loadService();

    await service.runSymbolCustomPresetComparison({
      symbolCustomId: 'sc-usdjpy',
      presets: [{
        presetName: 'session_best_probe',
        parameters: { allowedUtcHours: '23,0,1,7,8,9,10' },
      }],
    });

    expect(symbolCustomBacktestService.runSymbolCustomBacktest).toHaveBeenCalledWith(expect.objectContaining({
      parameters: { allowedUtcHours: '23,0,1,7,8,9,10' },
    }));
  });

  test('result includes evaluation, score, and bestPreset selected', async () => {
    const { service } = loadService();

    const comparison = await service.runSymbolCustomPresetComparison({
      symbolCustomId: 'sc-usdjpy',
      presets: [
        { presetName: 'baseline', parameters: {} },
        { presetName: 'buy_only', parameters: { enableBuy: true, enableSell: false } },
        { presetName: 'sell_only', parameters: { enableBuy: false, enableSell: true } },
      ],
    });

    expect(comparison.results[0]).toEqual(expect.objectContaining({
      presetName: 'buy_only',
      evaluation: expect.any(Object),
      score: expect.any(Number),
    }));
    expect(comparison.bestPreset).toEqual(expect.objectContaining({
      presetName: 'buy_only',
      score: comparison.results[0].score,
    }));
  });

  test('placeholder returns invalid comparison reason without running presets', async () => {
    const { service, symbolCustomBacktestService } = loadService({
      symbolCustom: {
        _id: 'sc-placeholder',
        symbol: 'USDJPY',
        symbolCustomName: 'USDJPY_PLACEHOLDER',
        logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
      },
    });

    const comparison = await service.runSymbolCustomPresetComparison({
      symbolCustomId: 'sc-placeholder',
    });

    expect(symbolCustomBacktestService.runSymbolCustomBacktest).not.toHaveBeenCalled();
    expect(comparison.results).toEqual([]);
    expect(comparison.conclusion).toEqual(expect.objectContaining({
      reasonCode: 'PLACEHOLDER_SYMBOL_CUSTOM',
    }));
  });

  test('does not call tradeExecutor, paperTradingService, old backtestEngine, or six strategies', async () => {
    const {
      service,
      tradeExecutor,
      paperTradingService,
      backtestEngine,
    } = loadService();

    await service.runSymbolCustomPresetComparison({
      symbolCustomId: 'sc-usdjpy',
      presets: [{ presetName: 'baseline', parameters: {} }],
    });

    expect(tradeExecutor.executeTrade).not.toHaveBeenCalled();
    expect(paperTradingService.submitSymbolCustomSignal).not.toHaveBeenCalled();
    expect(paperTradingService.submitExternalPaperSignal).not.toHaveBeenCalled();
    expect(paperTradingService._executePaperTrade).not.toHaveBeenCalled();
    expect(backtestEngine.runBacktest).not.toHaveBeenCalled();
    expect(backtestEngine.run).not.toHaveBeenCalled();

    const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'services', 'symbolCustomPresetComparisonService.js'), 'utf8');
    expect(source).not.toMatch(/src\/strategies|\.\.\/strategies|Momentum|Breakout|MeanReversion|MultiTimeframe|TrendFollowing|VolumeFlowHybrid/);
  });
});
