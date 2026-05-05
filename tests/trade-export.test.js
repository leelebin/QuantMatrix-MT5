const {
  LIVE_TRADE_COLUMNS,
  buildCsv,
  buildExportFilename,
  prepareTradeExportRow,
} = require('../src/utils/tradeExport');

describe('trade export utilities', () => {
  test('builds a UTF-8 CSV with strategy/comment fields', () => {
    const csv = buildCsv(LIVE_TRADE_COLUMNS, [{
      openedAt: new Date('2026-04-10T11:03:38.000Z'),
      closedAt: new Date('2026-04-10T12:00:08.000Z'),
      symbol: 'GBPJPY',
      type: 'SELL',
      strategy: 'MeanReversion',
      confidence: 0.5,
      comment: 'Strategy=MeanReversion | Signal=SELL | Confidence=50%',
      mt5Comment: 'QM|MeanReversion',
      reason: 'Price bounced from upper BB',
      entryPrice: 213.705,
      exitPrice: 213.847,
      sl: 213.84,
      tp: 213.611,
      lotSize: 0.09,
      profitLoss: -8.02,
      profitPips: -14.2,
      commission: 0,
      swap: 0,
      fee: 0,
      exitReason: 'SL_HIT',
      status: 'CLOSED',
      mt5PositionId: '38313633',
      mt5OrderId: '38313633',
      mt5EntryDealId: '37500941',
      mt5CloseDealId: '37522737',
      brokerSyncSource: 'position',
      brokerSyncedAt: new Date('2026-04-13T00:10:00.000Z'),
      indicatorsSnapshot: { rsi: 66.33 },
    }]);

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('strategy');
    expect(csv).toContain('mt5_comment');
    expect(csv).toContain('exit_reason_detail');
    expect(csv).toContain('planned_risk_amount');
    expect(csv).toContain('Strategy=MeanReversion | Signal=SELL | Confidence=50%');
    expect(csv).toContain('QM|MeanReversion');
  });

  test('prepares review fields from trade, linked position snapshot, and comments', () => {
    const row = prepareTradeExportRow({
      openedAt: new Date('2026-04-10T10:00:00.000Z'),
      closedAt: new Date('2026-04-10T11:30:00.000Z'),
      symbol: 'EURUSD',
      type: 'BUY',
      entryPrice: 100,
      exitPrice: 101,
      sl: 99,
      tp: 103,
      profitLoss: 90,
      commission: -2,
      swap: 0,
      fee: -1,
      exitReason: 'SL_HIT',
      comment: 'Strategy=TrendFollowing | Signal=BUY | Confidence=62% | Reason=Breakout retest',
      indicatorsSnapshot: {
        atr: 1.2,
        rsi: 55,
        emaFast: 100.4,
        fullSeries: [1, 2, 3],
      },
      managementEvents: [
        { type: 'TRAILING_STOP', status: 'APPLIED', newSl: 101 },
        { type: 'PARTIAL_TP', status: 'EXECUTED', volume: 0.01 },
      ],
      maxFavourablePrice: 102.5,
      positionSnapshot: {
        plannedRiskAmount: 50,
        targetRMultiple: 3,
        setupTimeframe: '1h',
        entryTimeframe: '15m',
      },
    });

    expect(row.confidence).toBe(0.62);
    expect(row.signalReason).toBe('Breakout retest');
    expect(row.entryReason).toBe('Breakout retest');
    expect(row.initialSl).toBe(99);
    expect(row.initialTp).toBe(103);
    expect(row.finalSl).toBe(99);
    expect(row.plannedRiskAmount).toBe(50);
    expect(row.targetRMultiple).toBe(3);
    expect(row.exitReasonDetail).toBe('TRAILING_SL_HIT');
    expect(row.trailingTriggered).toBe(true);
    expect(row.partialCloseCount).toBe(1);
    expect(row.maxFavourableR).toBe(2.5);
    expect(row.grossProfitLoss).toBe(93);
    expect(row.holdingMinutes).toBe(90);
    expect(row.indicatorsSnapshot).toEqual(expect.objectContaining({
      atr: 1.2,
      rsi: 55,
      ema_fast: 100.4,
      setup_timeframe: '1h',
      entry_timeframe: '15m',
    }));
    expect(row.indicatorsSnapshot.fullSeries).toBe(3);
  });

  test('derives breakeven detail for stop-loss exits after SL moves to entry', () => {
    const row = prepareTradeExportRow({
      openedAt: '2026-04-10T10:00:00.000Z',
      symbol: 'GBPJPY',
      type: 'SELL',
      entryPrice: 213.7,
      sl: 214.1,
      finalSl: 213.7,
      exitReason: 'SL_HIT',
    });

    expect(row.exitReason).toBe('SL_HIT');
    expect(row.exitReasonDetail).toBe('BREAKEVEN_SL_HIT');
  });

  test('builds a readable CSV filename from filters', () => {
    const filename = buildExportFilename({
      symbol: 'GBPJPY',
      strategy: 'MeanReversion',
      status: 'CLOSED',
    });

    expect(filename).toMatch(/^quantmatrix-trades-GBPJPY-MeanReversion-CLOSED-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
