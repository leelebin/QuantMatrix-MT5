const {
  BACKTEST_MODE_SYMBOL_CUSTOM,
  HISTORY_MODE_SYMBOL_CUSTOM,
  PLACEHOLDER_SYMBOL_CUSTOM,
  buildStandardBacktestPayload,
  buildSymbolCustomBacktestRequest,
  buildSymbolCustomPresetComparisonRequest,
  buildSymbolCustomCandidateValidationRequest,
  getSymbolCustomSelectionState,
  normalizeBacktestError,
  normalizeBacktestHistoryRow,
  normalizeBacktestResult,
  buildBacktestAiExportPayload,
  buildBacktestAiMarkdown,
  buildBacktestTradeEventsCsv,
  buildBacktestTradeEventsExport,
} = require('../public/js/backtestPageUtils');

describe('backtestPageUtils', () => {
  test('buildStandardBacktestPayload preserves standard strategy payload shape', () => {
    expect(buildStandardBacktestPayload({
      symbol: 'EURUSD',
      strategyType: 'TrendFollowing',
      timeframe: '1h',
      startDate: '2026-04-01',
      endDate: '2026-05-01',
      initialBalance: '10000',
      parameterPreset: 'optimized',
      strategyParams: { atrPeriod: 14 },
    })).toEqual({
      symbol: 'EURUSD',
      strategyType: 'TrendFollowing',
      timeframe: '1h',
      startDate: '2026-04-01',
      endDate: '2026-05-01',
      initialBalance: 10000,
      parameterPreset: 'optimized',
      strategyParams: { atrPeriod: 14 },
    });
  });

  test('buildSymbolCustomBacktestRequest targets SymbolCustom API with historical candles enabled', () => {
    const request = buildSymbolCustomBacktestRequest({
      _id: 'sc-1',
      parameters: { lookbackBars: 36 },
    }, {
      startDate: '2026-04-01',
      endDate: '2026-05-01',
      initialBalance: '500',
    });

    expect(request.endpoint).toBe('/api/symbol-customs/sc-1/backtest');
    expect(request.payload).toEqual({
      startDate: '2026-04-01',
      endDate: '2026-05-01',
      initialBalance: 500,
      parameters: { lookbackBars: 36 },
      costModel: {
        spread: 0,
        commissionPerTrade: 0,
        slippage: 0,
      },
      options: {
        useHistoricalCandles: true,
      },
    });
  });

  test('buildSymbolCustomPresetComparisonRequest targets SymbolCustom preset API with page values', () => {
    const request = buildSymbolCustomPresetComparisonRequest({
      _id: 'sc-guardrail',
    }, {
      startDate: '2025-03-15',
      endDate: '2026-05-15',
      initialBalance: '500',
      costModel: { spread: 0.1, commissionPerTrade: 0.25, slippage: 0.05 },
    });

    expect(request.endpoint).toBe('/api/symbol-customs/sc-guardrail/preset-comparison');
    expect(request.payload).toEqual({
      startDate: '2025-03-15',
      endDate: '2026-05-15',
      initialBalance: 500,
      costModel: { spread: 0.1, commissionPerTrade: 0.25, slippage: 0.05 },
    });
  });

  test('buildSymbolCustomCandidateValidationRequest targets validation API with candidate parameters and windows', () => {
    const request = buildSymbolCustomCandidateValidationRequest({
      _id: 'sc-guardrail',
    }, {
      candidateName: 'buy_session_conservative',
      candidateParameters: {
        enableBuy: true,
        enableSell: false,
        allowedUtcHours: '23,0,1,7,8,9,10',
      },
      windows: [{ label: '2M', startDate: '2026-03-15', endDate: '2026-05-15' }],
      startDate: '2025-03-15',
      endDate: '2026-05-15',
      initialBalance: '500',
      costModel: { spread: 0, commissionPerTrade: 0, slippage: 0 },
    });

    expect(request.endpoint).toBe('/api/symbol-customs/sc-guardrail/candidate-validation');
    expect(request.payload).toEqual({
      candidateName: 'buy_session_conservative',
      candidateParameters: {
        enableBuy: true,
        enableSell: false,
        allowedUtcHours: '23,0,1,7,8,9,10',
      },
      windows: [{ label: '2M', startDate: '2026-03-15', endDate: '2026-05-15' }],
      initialBalance: 500,
      costModel: { spread: 0, commissionPerTrade: 0, slippage: 0 },
    });
  });

  test('getSymbolCustomSelectionState disables run when no SymbolCustom exists', () => {
    expect(getSymbolCustomSelectionState([], null)).toEqual({
      rows: [],
      selectedRecord: null,
      runEnabled: false,
      warning: 'No SymbolCustom found for this symbol.',
    });
  });

  test('getSymbolCustomSelectionState warns and disables placeholder-only records', () => {
    const state = getSymbolCustomSelectionState([
      { _id: 'sc-placeholder', logicName: PLACEHOLDER_SYMBOL_CUSTOM },
    ], 'sc-placeholder');

    expect(state.runEnabled).toBe(false);
    expect(state.warning).toBe('Placeholder only. No active backtest logic.');
  });

  test('getSymbolCustomSelectionState enables real SymbolCustom logic', () => {
    const state = getSymbolCustomSelectionState([
      { _id: 'sc-placeholder', logicName: PLACEHOLDER_SYMBOL_CUSTOM },
      { _id: 'sc-real', logicName: 'USDJPY_JPY_MACRO_REVERSAL_V1' },
    ], null);

    expect(state.selectedRecord).toEqual(expect.objectContaining({ _id: 'sc-real' }));
    expect(state.runEnabled).toBe(true);
    expect(state.warning).toBe('');
  });

  test('normalizeBacktestResult adapts SymbolCustom summary and trades for Backtest page', () => {
    const normalized = normalizeBacktestResult({
      _id: 'bt-1',
      symbol: 'USDJPY',
      symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      logicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      initialBalance: 500,
      summary: {
        trades: 1,
        wins: 1,
        netPnl: 25,
        profitFactor: 2,
        winRate: 1,
        maxDrawdown: 5,
      },
      trades: [
        { side: 'BUY', entryPrice: 150, exitPrice: 150.2, pnl: 25 },
      ],
      chartData: {
        symbol: 'USDJPY',
        candles: [{ time: '2026-04-01T00:00:00.000Z', open: 150, high: 151, low: 149, close: 150.2 }],
        panels: [],
      },
    }, BACKTEST_MODE_SYMBOL_CUSTOM);

    expect(normalized.mode).toBe(HISTORY_MODE_SYMBOL_CUSTOM);
    expect(normalized.source).toBe('symbolCustom');
    expect(normalized.strategy).toBe('USDJPY_JPY_MACRO_REVERSAL_V1');
    expect(normalized.summary.totalTrades).toBe(1);
    expect(normalized.summary.netProfitMoney).toBe(25);
    expect(normalized.summary.returnPercent).toBe(5);
    expect(normalized.trades[0]).toEqual(expect.objectContaining({
      direction: 'BUY',
      profitLoss: 25,
      module: 'USDJPY_JPY_MACRO_REVERSAL_V1',
    }));
    expect(normalized.chartData.panels).toEqual([
      { kind: 'price', title: 'Price', series: [], referenceLines: [] },
    ]);
  });

  test('normalizeBacktestHistoryRow marks SymbolCustom source and custom label', () => {
    const row = normalizeBacktestHistoryRow({
      _id: 'bt-sc-1',
      symbol: 'USDJPY',
      symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      logicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      summary: { trades: 2, netPnl: 10 },
    }, BACKTEST_MODE_SYMBOL_CUSTOM);

    expect(row).toEqual(expect.objectContaining({
      id: 'bt-sc-1',
      mode: HISTORY_MODE_SYMBOL_CUSTOM,
      source: 'symbolCustom',
      label: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      logicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
    }));
  });

  test('normalizeBacktestError maps SymbolCustom error codes to friendly text', () => {
    expect(normalizeBacktestError({
      success: false,
      message: 'SYMBOL_CUSTOM_BACKTEST_CANDLES_REQUIRED',
    })).toEqual({
      message: 'No candles provided. Enable historical candle provider or provide candle data.',
      reasonCode: 'SYMBOL_CUSTOM_BACKTEST_CANDLES_REQUIRED',
      hint: null,
    });

    expect(normalizeBacktestError({
      success: false,
      message: 'MT5 not connected. Call connect() first.',
    })).toEqual({
      message: 'MT5 is not connected. Please connect MT5 first before running historical SymbolCustom backtest.',
      reasonCode: 'SYMBOL_CUSTOM_MT5_NOT_CONNECTED',
      hint: 'Go to Dashboard/Diagnostics and connect MT5, then retry.',
    });
  });

  test('buildBacktestAiExportPayload includes context, summary, parameters, and trades', () => {
    const payload = buildBacktestAiExportPayload({
      generatedAt: '2026-05-15T00:00:00.000Z',
      mode: BACKTEST_MODE_SYMBOL_CUSTOM,
      selectedTradeId: '2',
      result: {
        symbol: 'USDJPY',
        symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
        logicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
        startDate: '2026-04-01',
        endDate: '2026-05-01',
        initialBalance: 500,
        summary: { trades: 2, netPnl: 12.5, winRate: 0.5 },
        parameters: { lookbackBars: 36 },
      },
      tradeEvents: [
        { tradeId: 1, direction: 'SELL', entryReason: 'overbought rejection', exitReason: 'SL', profitLoss: -3.65 },
        { tradeId: 2, direction: 'SELL', entryReason: 'overbought rejection', exitReason: 'TP', profitLoss: 5.42 },
      ],
    });

    expect(payload.exportType).toBe('quantmatrix_backtest_trade_events_ai_review');
    expect(payload.mode).toBe(HISTORY_MODE_SYMBOL_CUSTOM);
    expect(payload.source).toBe('symbolCustom');
    expect(payload.symbol).toBe('USDJPY');
    expect(payload.parameters).toEqual({ lookbackBars: 36 });
    expect(payload.tradeCount).toBe(2);
    expect(payload.trades[1]).toEqual(expect.objectContaining({
      side: 'SELL',
      exitReason: 'TP',
      selected: true,
    }));
    expect(payload.aiInstructions).toMatch(/Analyze this QuantMatrix backtest/);
  });

  test('buildBacktestAiMarkdown creates AI-readable markdown with trade reasons', () => {
    const markdown = buildBacktestAiMarkdown({
      generatedAt: '2026-05-15T00:00:00.000Z',
      mode: HISTORY_MODE_SYMBOL_CUSTOM,
      source: 'symbolCustom',
      symbol: 'USDJPY',
      symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      logicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      timeframe: '5m',
      period: { startDate: '2026-04-01', endDate: '2026-05-01' },
      summary: { trades: 1, netPnl: 5.42 },
      parameters: { lookbackBars: 36 },
      tradeCount: 1,
      trades: [
        { side: 'SELL', entryTime: '2026-04-01T01:00:00Z', exitTime: '2026-04-01T01:30:00Z', entryReason: 'overbought | rejection', exitReason: 'TP', pnl: 5.42 },
      ],
      aiInstructions: 'Analyze this export.',
    });

    expect(markdown).toContain('# QuantMatrix Backtest Trade Events AI Review');
    expect(markdown).toContain('overbought \\| rejection');
    expect(markdown).toContain('## Suggested Review Checklist');
  });

  test('buildBacktestTradeEventsCsv escapes CSV values', () => {
    const csv = buildBacktestTradeEventsCsv({
      trades: [
        { tradeId: 1, side: 'BUY', entryReason: 'comma, reason', exitReason: 'quote " reason', pnl: 1.25 },
      ],
    });

    expect(csv.split('\n')[0]).toContain('tradeId,side,entryTime');
    expect(csv).toContain('"comma, reason"');
    expect(csv).toContain('"quote "" reason"');
  });

  test('buildBacktestTradeEventsExport returns markdown, json, and csv artifacts', () => {
    const base = {
      generatedAt: '2026-05-15T00:00:00.000Z',
      result: {
        symbol: 'EURUSD',
        strategy: 'TrendFollowing',
        summary: { totalTrades: 1 },
      },
      tradeEvents: [
        { tradeId: 1, direction: 'BUY', entryReason: 'trend continuation', exitReason: 'TP', profitLoss: 9 },
      ],
    };

    const markdown = buildBacktestTradeEventsExport({ ...base, format: 'md' });
    const json = buildBacktestTradeEventsExport({ ...base, format: 'json' });
    const csv = buildBacktestTradeEventsExport({ ...base, format: 'csv' });

    expect(markdown.filename).toBe('quantmatrix-backtest-STANDARD-EURUSD-TrendFollowing-2026-05-15.md');
    expect(markdown.content).toContain('trend continuation');
    expect(JSON.parse(json.content).trades[0].pnl).toBe(9);
    expect(csv.content).toContain('tradeId,side,entryTime');
  });
});
