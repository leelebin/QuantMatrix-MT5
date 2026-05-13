const {
  PHASE_1_LIVE_WARNING,
  PLACEHOLDER_SYMBOL_CUSTOM,
  parseJsonField,
  serializeEditorPayload,
  shouldShowLiveWarning,
  buildSymbolCustomSymbolSummaries,
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
});
