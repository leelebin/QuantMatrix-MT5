const {
  buildCanonicalLedgerRows,
} = require('../src/services/tradeLedgerService');
const {
  LIVE_TRADE_COLUMNS,
  buildCsv,
} = require('../src/utils/tradeExport');

function buildBrokerTrade(index) {
  const openedAt = new Date(Date.UTC(2026, 3, 27, 3, index));
  return {
    _id: `broker-${index}`,
    symbol: index % 2 === 0 ? 'EURUSD' : 'XAUUSD',
    type: index % 2 === 0 ? 'BUY' : 'SELL',
    strategy: 'Unknown',
    mt5PositionId: String(44000000 + index),
    mt5OrderId: String(44000000 + index),
    mt5EntryDealId: String(43000000 + index),
    openedAt,
    closedAt: new Date(openedAt.getTime() + 30 * 60000),
    entryPrice: 100 + index,
    exitPrice: 101 + index,
    profitLoss: 10 + index,
    commission: -1,
    swap: 0,
    fee: -0.25,
    status: 'CLOSED',
    brokerSyncSource: 'history_sync',
  };
}

function buildPaperTrade(index) {
  const openedAt = new Date(Date.UTC(2026, 3, 27, 0, index));
  return {
    _id: `paper-${index}`,
    symbol: index % 2 === 0 ? 'EURUSD' : 'XAUUSD',
    type: index % 2 === 0 ? 'BUY' : 'SELL',
    strategy: index % 2 === 0 ? 'Momentum' : 'Breakout',
    mt5PositionId: String(44000000 + index),
    mt5DealId: String(43000000 + index),
    openedAt,
    closedAt: new Date(openedAt.getTime() + 30 * 60000),
    entryPrice: 99 + index,
    exitPrice: 100 + index,
    profitLoss: 5 + index,
    commission: 0,
    confidence: 0.72,
    signalReason: `paper signal ${index}`,
    entryReason: `entry reason ${index}`,
    indicatorsSnapshot: { rsi: 55 + index, atr: 1.2 },
    executionScore: 0.7,
    plannedRiskAmount: 25,
    managementEvents: [{ type: 'BREAKEVEN', status: 'APPLIED' }],
    status: 'CLOSED',
  };
}

describe('tradeLedgerService canonical ledger', () => {
  test('merges broker and paper trades by ticket while preserving source-only rows', () => {
    const brokerTrades = [
      ...Array.from({ length: 27 }, (_, index) => buildBrokerTrade(index)),
      ...Array.from({ length: 32 }, (_, index) => ({
        ...buildBrokerTrade(100 + index),
        _id: `broker-only-${index}`,
        symbol: `BRK${index}`,
        mt5PositionId: String(45000000 + index),
      })),
    ];
    const paperTrades = [
      ...Array.from({ length: 27 }, (_, index) => buildPaperTrade(index)),
      ...Array.from({ length: 4 }, (_, index) => ({
        ...buildPaperTrade(200 + index),
        _id: `paper-only-${index}`,
        symbol: `PPR${index}`,
        mt5PositionId: String(46000000 + index),
      })),
    ];

    const rows = buildCanonicalLedgerRows({ brokerTrades, paperTrades });
    const counts = rows.reduce((acc, row) => {
      acc[row.ledgerSource] = (acc[row.ledgerSource] || 0) + 1;
      return acc;
    }, {});

    expect(counts).toEqual({
      matched: 27,
      broker_only: 32,
      paper_only: 4,
    });

    const matched = rows.find((row) => row.ledgerSource === 'matched' && row.mt5PositionId === '44000000');
    expect(matched).toMatchObject({
      matchMethod: 'mt5PositionId',
      confidence: 0.72,
      reason: 'paper signal 0',
      signalReason: 'paper signal 0',
      entryReason: 'entry reason 0',
      strategy: 'Momentum',
      profitLoss: 10,
      commission: -1,
      fee: -0.25,
      timeOffsetMinutes: 180,
      matchedBrokerTradeId: 'broker-0',
      matchedPaperTradeId: 'paper-0',
    });
    expect(matched.indicatorsSnapshot).toEqual({ rsi: 55, atr: 1.2 });
    expect(matched.dataQualityFlags).toContain('matched');
    expect(matched.dataQualityFlags).toContain('time_offset_180m');
  });

  test('exports canonical ledger diagnostics without dropping old CSV columns', () => {
    const rows = buildCanonicalLedgerRows({
      brokerTrades: [buildBrokerTrade(1)],
      paperTrades: [buildPaperTrade(1)],
    });

    const csv = buildCsv(LIVE_TRADE_COLUMNS, rows);

    expect(csv).toContain('mt5_open_time');
    expect(csv).toContain('profit_loss_usd');
    expect(csv).toContain('confidence');
    expect(csv).toContain('ledger_source');
    expect(csv).toContain('canonical_trade_id');
    expect(csv).toContain('time_offset_minutes');
    expect(csv).toContain('data_quality_flags');
    expect(csv).toContain('matched');
    expect(csv).toContain('time_offset_180m');
  });

  test('filters canonical rows after broker/paper merge', () => {
    const rows = buildCanonicalLedgerRows({
      brokerTrades: [buildBrokerTrade(2)],
      paperTrades: [buildPaperTrade(2)],
      filters: {
        strategy: 'Momentum',
        status: 'CLOSED',
        startDate: '2026-04-27',
        endDate: '2026-04-27',
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].strategy).toBe('Momentum');
  });
});
