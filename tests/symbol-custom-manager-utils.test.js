const {
  PHASE_1_LIVE_WARNING,
  PLACEHOLDER_SYMBOL_CUSTOM,
  SYMBOL_CUSTOM_MT5_NOT_CONNECTED,
  SYMBOL_CUSTOM_MT5_NOT_CONNECTED_MESSAGE,
  SYMBOL_CUSTOM_MT5_NOT_CONNECTED_HINT,
  normalizeBacktestError,
  parseJsonField,
  serializeBacktestPayload,
  serializeEditorPayload,
  shouldShowLiveWarning,
  buildSymbolCustomSymbolSummaries,
  flattenSymbolCustomReportRow,
  buildSymbolCustomReportCsv,
} = require('../public/js/symbolCustomManager');

describe('symbolCustomManager utils', () => {
  test('parseJsonField parses valid JSON', () => {
    const result = parseJsonField('{"lookbackBars":50}', 'parameters', {});

    expect(result).toEqual({
      valid: true,
      value: { lookbackBars: 50 },
      error: null,
    });
  });

  test('parseJsonField rejects invalid JSON', () => {
    const result = parseJsonField('{"lookbackBars":', 'parameters', {});

    expect(result.valid).toBe(false);
    expect(result.error).toContain('parameters must be valid JSON');
  });

  test('serializeEditorPayload serializes editor values', () => {
    const result = serializeEditorPayload({
      symbol: 'usdjpy',
      symbolCustomName: 'USDJPY_TEST',
      displayName: 'USDJPY Test',
      description: 'Draft only',
      hypothesis: 'Test hypothesis',
      status: 'draft',
      paperEnabled: true,
      liveEnabled: false,
      isPrimaryLive: false,
      setupTimeframe: '15m',
      entryTimeframe: '5m',
      higherTimeframe: '1h',
      logicName: PLACEHOLDER_SYMBOL_CUSTOM,
      parameterSchemaJson: '[{"key":"lookbackBars","type":"number"}]',
      parametersJson: '{"lookbackBars":50}',
      riskConfigJson: '{"maxConsecutiveLosses":3}',
      sessionFilterJson: '{"enabled":false}',
      newsFilterJson: '{"enabled":false}',
      beConfigJson: '{"enabled":false}',
      entryConfigJson: '{}',
      exitConfigJson: '{}',
      designNotes: 'Editable notes',
      aiResearchSummary: 'Editable summary',
    });

    expect(result.valid).toBe(true);
    expect(result.payload).toEqual(expect.objectContaining({
      symbol: 'USDJPY',
      symbolCustomName: 'USDJPY_TEST',
      paperEnabled: true,
      liveEnabled: false,
      logicName: PLACEHOLDER_SYMBOL_CUSTOM,
      timeframes: {
        setupTimeframe: '15m',
        entryTimeframe: '5m',
        higherTimeframe: '1h',
      },
      parameters: { lookbackBars: 50 },
      riskConfig: { maxConsecutiveLosses: 3 },
    }));
  });

  test('shouldShowLiveWarning detects liveEnabled true', () => {
    expect(shouldShowLiveWarning({ liveEnabled: true })).toBe(true);
    expect(shouldShowLiveWarning({ liveEnabled: false })).toBe(false);
    expect(PHASE_1_LIVE_WARNING).toContain('not supported in Phase 1');
  });

  test('serializeBacktestPayload sends historical date range payload', () => {
    const result = serializeBacktestPayload({
      record: { parameters: { lookbackBars: 50 } },
      startDate: '2026-04-01',
      endDate: '2026-05-01',
      initialBalance: '500',
      useHistoricalCandles: true,
    });

    expect(result).toEqual({
      valid: true,
      errors: [],
      payload: {
        startDate: '2026-04-01',
        endDate: '2026-05-01',
        initialBalance: 500,
        parameters: { lookbackBars: 50 },
        costModel: { spread: 0, commissionPerTrade: 0, slippage: 0 },
        options: { useHistoricalCandles: true },
      },
    });
  });

  test('serializeBacktestPayload requires date range and positive balance', () => {
    const result = serializeBacktestPayload({
      startDate: '',
      endDate: '',
      initialBalance: '0',
      useHistoricalCandles: true,
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'startDate is required',
      'endDate is required',
      'initialBalance must be a positive number',
    ]));
    expect(result.payload).toBeNull();
  });

  test('normalizeBacktestError maps MT5 not connected API response to friendly message and hint', () => {
    expect(normalizeBacktestError({
      success: false,
      message: 'MT5 not connected. Call connect() first.',
      reasonCode: SYMBOL_CUSTOM_MT5_NOT_CONNECTED,
    })).toEqual({
      message: SYMBOL_CUSTOM_MT5_NOT_CONNECTED_MESSAGE,
      hint: SYMBOL_CUSTOM_MT5_NOT_CONNECTED_HINT,
      reasonCode: SYMBOL_CUSTOM_MT5_NOT_CONNECTED,
    });
  });

  test('normalizeBacktestError reads nested MT5 not connected hint from errors', () => {
    expect(normalizeBacktestError({
      success: false,
      message: 'Historical provider failed',
      errors: [
        {
          reasonCode: SYMBOL_CUSTOM_MT5_NOT_CONNECTED,
          hint: 'Go to Dashboard/Diagnostics and connect MT5, then retry.',
        },
      ],
    })).toEqual({
      message: SYMBOL_CUSTOM_MT5_NOT_CONNECTED_MESSAGE,
      hint: SYMBOL_CUSTOM_MT5_NOT_CONNECTED_HINT,
      reasonCode: SYMBOL_CUSTOM_MT5_NOT_CONNECTED,
    });
  });

  test('normalizeBacktestError keeps historical candles not found friendly text', () => {
    expect(normalizeBacktestError({
      success: false,
      message: 'SYMBOL_CUSTOM_BACKTEST_CANDLES_NOT_FOUND',
    })).toEqual({
      message: 'No historical candles found for selected symbol/timeframes/date range.',
      hint: null,
      reasonCode: 'SYMBOL_CUSTOM_BACKTEST_CANDLES_NOT_FOUND',
    });
  });

  test('buildSymbolCustomSymbolSummaries builds symbol-level counts', () => {
    const summaries = buildSymbolCustomSymbolSummaries([
      { symbol: 'USDJPY', symbolCustomName: 'A', status: 'draft', paperEnabled: true },
      { symbol: 'USDJPY', symbolCustomName: 'B', status: 'validated', liveEnabled: true, isPrimaryLive: true },
      { symbol: 'AUDUSD', symbolCustomName: 'C', status: 'draft' },
    ]);

    expect(summaries).toEqual([
      expect.objectContaining({
        symbol: 'AUDUSD',
        customCount: 1,
        paperEnabledCount: 0,
        liveEnabledCount: 0,
        statusSummary: { draft: 1 },
      }),
      expect.objectContaining({
        symbol: 'USDJPY',
        customCount: 2,
        paperEnabledCount: 1,
        liveEnabledCount: 1,
        primaryLiveName: 'B',
        statusSummary: { draft: 1, validated: 1 },
      }),
    ]);
  });

  test('flattenSymbolCustomReportRow flattens latest backtest and warnings for CSV', () => {
    expect(flattenSymbolCustomReportRow({
      symbol: 'USDJPY',
      symbolCustomName: 'USDJPY_DRAFT',
      displayName: 'USDJPY Draft',
      status: 'draft',
      paperEnabled: true,
      liveEnabled: false,
      isPrimaryLive: false,
      allowLive: false,
      logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
      latestBacktest: {
        status: 'stub',
        trades: 0,
        netPnl: 0,
        profitFactor: null,
      },
      recommendation: 'PLACEHOLDER_ONLY',
      warnings: ['SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1'],
    })).toEqual({
      symbol: 'USDJPY',
      symbolCustomName: 'USDJPY_DRAFT',
      displayName: 'USDJPY Draft',
      status: 'draft',
      paperEnabled: true,
      liveEnabled: false,
      isPrimaryLive: false,
      allowLive: false,
      logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
      latestBacktestStatus: 'stub',
      latestBacktestTrades: 0,
      latestBacktestNetPnl: 0,
      latestBacktestProfitFactor: '',
      recommendation: 'PLACEHOLDER_ONLY',
      warnings: 'SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1',
    });
  });

  test('buildSymbolCustomReportCsv escapes commas and warning arrays', () => {
    const csv = buildSymbolCustomReportCsv([
      {
        symbol: 'USDJPY',
        symbolCustomName: 'USDJPY_DRAFT',
        displayName: 'USDJPY, Draft',
        status: 'draft',
        paperEnabled: false,
        liveEnabled: false,
        isPrimaryLive: false,
        allowLive: false,
        logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
        latestBacktest: { status: 'stub', trades: 0, netPnl: 0, profitFactor: null },
        recommendation: 'PLACEHOLDER_ONLY',
        warnings: ['A', 'B'],
      },
    ]);

    expect(csv).toContain('symbol,symbolCustomName,displayName,status,paperEnabled');
    expect(csv).toContain('"USDJPY, Draft"');
    expect(csv).toContain('PLACEHOLDER_ONLY,A|B');
  });
});
