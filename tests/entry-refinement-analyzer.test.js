const {
  ANALYSIS_MODE,
  analyzeEntryRefinement,
} = require('../src/services/entryRefinementAnalyzer');

describe('entryRefinementAnalyzer', () => {
  test('calculates BUY pullback shadow levels without changing entry', () => {
    const shadow = analyzeEntryRefinement({
      signal: {
        symbol: 'XAUUSD',
        strategy: 'Breakout',
        setupType: 'event_breakout',
        signal: 'BUY',
        playbook: {
          preferredEntryStyle: 'pullback_after_breakout',
        },
      },
      candles: [
        { high: 2298, low: 2288 },
        { high: 2302, low: 2292 },
      ],
      atr: 8,
      entryPrice: 2300,
    });

    expect(shadow).toEqual({
      symbol: 'XAUUSD',
      strategy: 'Breakout',
      setupType: 'event_breakout',
      actualEntry: 2300,
      direction: 'BUY',
      atrAtSignal: 8,
      suggestedPullback025Atr: 2298,
      suggestedPullback040Atr: 2296.8,
      triggerCandleMidpoint: 2297,
      preferredEntryStyle: 'pullback_after_breakout',
      analysisMode: ANALYSIS_MODE,
    });
  });

  test('calculates SELL pullback shadow levels from latest ATR array value', () => {
    const shadow = analyzeEntryRefinement({
      signal: {
        symbol: 'EURUSD',
        strategy: 'MeanReversion',
        setupType: 'session_range_reversal',
        signal: 'SELL',
        preferredEntryStyle: 'session_pullback',
      },
      candles: [
        { high: 1.102, low: 1.098 },
      ],
      atr: [0.001, 0.002],
      entryPrice: 1.1,
    });

    expect(shadow).toEqual(expect.objectContaining({
      actualEntry: 1.1,
      direction: 'SELL',
      atrAtSignal: 0.002,
      suggestedPullback025Atr: 1.1005,
      suggestedPullback040Atr: 1.1008,
      triggerCandleMidpoint: 1.1,
      preferredEntryStyle: 'session_pullback',
      analysisMode: 'shadow_only',
    }));
  });

  test('returns null shadow levels when entry inputs are incomplete', () => {
    const shadow = analyzeEntryRefinement({
      signal: {
        symbol: 'US30',
        strategy: 'Momentum',
        setupType: 'generic_signal',
        signal: 'NONE',
      },
      candles: [{ high: null, low: 100 }],
      atr: null,
      entryPrice: null,
    });

    expect(shadow).toEqual(expect.objectContaining({
      symbol: 'US30',
      direction: null,
      actualEntry: null,
      atrAtSignal: null,
      suggestedPullback025Atr: null,
      suggestedPullback040Atr: null,
      triggerCandleMidpoint: null,
      analysisMode: 'shadow_only',
    }));
  });
});
