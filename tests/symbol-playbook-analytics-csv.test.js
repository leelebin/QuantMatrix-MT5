const {
  BE_FIELDS,
  RECOMMENDATION_FIELDS,
  SETUP_FIELDS,
  escapeCsvValue,
  flattenBeRows,
  flattenRecommendationRows,
  flattenSetupRows,
  rowsToCsv,
} = require('../public/js/symbolPlaybookAnalyticsCsv');

describe('symbol playbook analytics CSV helpers', () => {
  test('escapes commas newlines and quotes in CSV values', () => {
    expect(escapeCsvValue('plain')).toBe('plain');
    expect(escapeCsvValue('a,b')).toBe('"a,b"');
    expect(escapeCsvValue('line\nbreak')).toBe('"line\nbreak"');
    expect(escapeCsvValue('say "yes"')).toBe('"say ""yes"""');

    const csv = rowsToCsv([
      { symbol: 'XAUUSD', reason: 'wait, then "confirm"\nagain' },
    ], ['symbol', 'reason']);

    expect(csv).toBe('symbol,reason\nXAUUSD,"wait, then ""confirm""\nagain"');
  });

  test('flattens setup performance rows with source breakdown', () => {
    const rows = flattenSetupRows({
      report: {
        scope: 'paper',
        since: '2026-04-27T00:00:00.000Z',
        symbols: [
          {
            symbol: 'XAUUSD',
            setups: [
              {
                setupType: 'event_breakout',
                trades: 3,
                netPnl: 120,
                profitFactor: 4,
                profitFactorLabel: null,
                winRate: 0.6667,
                avgR: 0.4,
                maxSingleLoss: -40,
                setupTypeSourceBreakdown: {
                  recorded: 1,
                  legacy_inferred: 2,
                  unknown_legacy: 0,
                },
              },
            ],
          },
        ],
      },
    });

    expect(rows).toEqual([
      {
        scope: 'paper',
        since: '2026-04-27',
        symbol: 'XAUUSD',
        setupType: 'event_breakout',
        trades: 3,
        netPnl: 120,
        profitFactor: 4,
        profitFactorLabel: null,
        winRate: 0.6667,
        avgR: 0.4,
        maxSingleLoss: -40,
        recordedCount: 1,
        legacyInferredCount: 2,
        unknownLegacyCount: 0,
      },
    ]);

    expect(rowsToCsv(rows, SETUP_FIELDS)).toContain('paper,2026-04-27,XAUUSD,event_breakout,3,120');
  });

  test('flattens BE report rows', () => {
    const rows = flattenBeRows({
      beReport: {
        scope: 'live',
        since: '2026-04-27T00:00:00.000Z',
        groups: [
          {
            symbol: 'EURUSD',
            strategy: 'Momentum',
            setupType: 'm15_intraday_pullback',
            beStyle: 'tight',
            totalTrades: 5,
            beExitCount: 3,
            beExitRate: 0.6,
            protectedLossEstimate: 150,
            missedProfitAfterBEEstimate: null,
            avgRealizedR: 0.1,
            recommendation: 'NEUTRAL',
          },
        ],
      },
    });

    expect(rows[0]).toEqual({
      scope: 'live',
      since: '2026-04-27',
      symbol: 'EURUSD',
      strategy: 'Momentum',
      setupType: 'm15_intraday_pullback',
      beStyle: 'tight',
      totalTrades: 5,
      beExitCount: 3,
      beExitRate: 0.6,
      protectedLossEstimate: 150,
      missedProfitAfterBEEstimate: null,
      avgRealizedR: 0.1,
      recommendation: 'NEUTRAL',
    });
    expect(rowsToCsv(rows, BE_FIELDS)).toContain('live,2026-04-27,EURUSD,Momentum');
  });

  test('flattens recommendation rows with BE recommendation and reason', () => {
    const rows = flattenRecommendationRows({
      recommendationsReport: {
        scope: 'paper',
        since: '2026-04-27T00:00:00.000Z',
        recommendations: [
          {
            symbol: 'NAS100',
            currentRole: 'index_momentum',
            currentLiveBias: 'paper_first',
            dataSummary: {
              trades: 8,
              netPnl: 420,
              profitFactor: 1.8,
              winRate: 0.625,
              avgR: 0.3,
              bestSetupType: 'us_session_momentum',
              worstSetupType: 'post_news_continuation',
              be: { recommendation: 'CONSIDER_LOOSEN_BE' },
            },
            suggestedAction: 'CONSIDER_BE_LOOSENING',
            suggestedRiskWeight: 0.5,
            suggestedBeStyle: 'medium_loose',
            suggestedEntryStyle: 'pullback_after_impulse',
            reason: 'BE missed profit is larger, keep review.',
          },
        ],
      },
    });

    expect(rows[0]).toEqual(expect.objectContaining({
      scope: 'paper',
      since: '2026-04-27',
      symbol: 'NAS100',
      beRecommendation: 'CONSIDER_LOOSEN_BE',
      suggestedAction: 'CONSIDER_BE_LOOSENING',
      reason: 'BE missed profit is larger, keep review.',
    }));
    expect(rowsToCsv(rows, RECOMMENDATION_FIELDS)).toContain(
      'paper,2026-04-27,NAS100,index_momentum,paper_first'
    );
  });
});
