jest.mock('../src/config/db', () => ({
  backtestsDb: {
    insert: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
  },
}));

const backtestEngine = require('../src/services/backtestEngine');

function makeCandles(count, start = 1.1) {
  return Array.from({ length: count }, (_, index) => {
    const base = start + (index * 0.0001);
    return {
      time: new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
      open: Number(base.toFixed(5)),
      high: Number((base + 0.0003).toFixed(5)),
      low: Number((base - 0.0003).toFixed(5)),
      close: Number((base + 0.00005).toFixed(5)),
      volume: 100,
      tickVolume: 100,
    };
  });
}

describe('backtest equity curve integrity', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('forced END_OF_DATA close appends the realized final equity point', async () => {
    const candles = makeCandles(270, 1.1);
    candles[260] = {
      ...candles[260],
      open: 1.11,
      high: 1.1103,
      low: 1.0997,
      close: 1.1,
    };
    candles[candles.length - 1] = {
      ...candles[candles.length - 1],
      open: 1.139,
      high: 1.1404,
      low: 1.1388,
      close: 1.14,
    };

    jest.spyOn(backtestEngine, '_createStrategy').mockReturnValue({
      analyze: jest.fn(() => ({
        signal: 'BUY',
        confidence: 1,
        sl: 0,
        tp: 10,
        reason: 'Test setup',
      })),
    });
    jest.spyOn(backtestEngine, '_buildIndicators').mockReturnValue({});

    const result = await backtestEngine.simulate({
      symbol: 'EURUSD',
      strategyType: 'Momentum',
      timeframe: '1h',
      candles,
      initialBalance: 10000,
      tradeStartTime: candles[250].time,
      tradeEndTime: candles[candles.length - 1].time,
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe('END_OF_DATA');
    expect(result.finalEquity).toBe(result.finalBalance);
    expect(result.equityCurve[result.equityCurve.length - 1]).toEqual({
      time: candles[candles.length - 1].time,
      equity: result.finalBalance,
    });
  });

  test('tradeEndTime bounds simulation and closes open positions at the cutoff', async () => {
    const candles = makeCandles(280, 1.1);
    const cutoff = candles[260].time;
    candles[260] = {
      ...candles[260],
      open: 1.126,
      high: 1.1263,
      low: 1.1257,
      close: 1.126,
    };
    candles[candles.length - 1] = {
      ...candles[candles.length - 1],
      open: 1.18,
      high: 1.181,
      low: 1.179,
      close: 1.18,
    };

    jest.spyOn(backtestEngine, '_createStrategy').mockReturnValue({
      analyze: jest.fn(() => ({
        signal: 'BUY',
        confidence: 1,
        sl: 0,
        tp: 10,
        reason: 'Test setup',
      })),
    });
    jest.spyOn(backtestEngine, '_buildIndicators').mockReturnValue({});

    const result = await backtestEngine.simulate({
      symbol: 'EURUSD',
      strategyType: 'Momentum',
      timeframe: '1h',
      candles,
      initialBalance: 10000,
      tradeStartTime: candles[250].time,
      tradeEndTime: cutoff,
    });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe('END_OF_DATA');
    expect(result.trades[0].exitTime).toBe(cutoff);
    expect(result.equityCurve[result.equityCurve.length - 1].time).toBe(cutoff);
  });

  test('summary max drawdown follows mark-to-market equity curve points', () => {
    const summary = backtestEngine._generateSummary(
      [{
        profitPips: 25,
        profitLoss: 100,
        entryTime: '2026-01-01T00:00:00.000Z',
        exitTime: '2026-01-01T06:00:00.000Z',
      }],
      10000,
      10100,
      [
        { time: '2026-01-01T00:00:00.000Z', equity: 10000 },
        { time: '2026-01-01T03:00:00.000Z', equity: 9500 },
        { time: '2026-01-01T06:00:00.000Z', equity: 10100 },
      ]
    );

    expect(summary.maxDrawdownPercent).toBe(5);
  });

  test('summary exposes net metrics after trading costs', () => {
    const summary = backtestEngine._generateSummary(
      [
        {
          profitPips: 10,
          grossProfitLoss: 100,
          profitLoss: 93,
          commission: -7,
          swap: 0,
          fee: 0,
          entryTime: '2026-01-01T00:00:00.000Z',
          exitTime: '2026-01-01T06:00:00.000Z',
        },
        {
          profitPips: 1,
          grossProfitLoss: 2,
          profitLoss: -5,
          commission: -7,
          swap: 0,
          fee: 0,
          entryTime: '2026-01-02T00:00:00.000Z',
          exitTime: '2026-01-02T06:00:00.000Z',
        },
      ],
      10000,
      10088,
      [
        { time: '2026-01-01T00:00:00.000Z', equity: 10000 },
        { time: '2026-01-02T06:00:00.000Z', equity: 10088 },
      ]
    );

    expect(summary.profitFactor).toBe(999);
    expect(summary.netProfitFactor).toBe(18.6);
    expect(summary.netWinningTrades).toBe(1);
    expect(summary.netLosingTrades).toBe(1);
    expect(summary.totalCommission).toBe(-14);
    expect(summary.totalTradingCosts).toBe(-14);
    expect(summary.averageNetTradeMoney).toBe(44);
  });

  test('classifies stop exits by breakeven lifecycle state', () => {
    expect(backtestEngine._classifyStopExitReason({})).toBe('INITIAL_SL_HIT');
    expect(backtestEngine._classifyStopExitReason({ breakevenActivated: true })).toBe('BREAKEVEN_SL_HIT');
    expect(backtestEngine._classifyStopExitReason({
      breakevenActivated: true,
      trailingActivated: true,
    })).toBe('TRAILING_SL_HIT');
    expect(backtestEngine._classifyStopExitReason({
      type: 'BUY',
      sl: 1.1,
      currentSl: 1.101,
    })).toBe('PROTECTIVE_SL_HIT');
    expect(backtestEngine._classifyStopExitReason({
      type: 'SELL',
      sl: 1.1,
      currentSl: 1.099,
    })).toBe('PROTECTIVE_SL_HIT');

    const position = {};
    backtestEngine._markBreakevenState(position, 'breakeven');
    expect(position).toMatchObject({
      breakevenActivated: true,
      breakevenPhase: 'breakeven',
    });
    expect(position.trailingActivated).toBeUndefined();

    backtestEngine._markBreakevenState(position, 'trailing');
    expect(position).toMatchObject({
      breakevenActivated: true,
      trailingActivated: true,
      breakevenPhase: 'trailing',
    });

    expect(backtestEngine._classifyTradeOutcome({
      exitReason: 'BREAKEVEN_SL_HIT',
      realizedRMultiple: 0.02,
      profitPips: 0.3,
      profitLoss: -1,
    })).toBe('neutral');
    expect(backtestEngine._classifyTradeOutcome({
      exitReason: 'BREAKEVEN_SL_HIT',
      realizedRMultiple: 0.3,
      profitPips: 15,
      profitLoss: 150,
    })).toBe('win');
    expect(backtestEngine._classifyTradeOutcome({
      exitReason: 'TRAILING_SL_HIT',
      realizedRMultiple: -0.2,
      profitPips: -8,
      profitLoss: -80,
    })).toBe('loss');
  });

  test('summary exposes breakeven exit, trigger, and required win-rate metrics', () => {
    const summary = backtestEngine._generateSummary(
      [
        {
          profitPips: 10,
          grossProfitLoss: 100,
          profitLoss: 100,
          exitReason: 'TP_HIT',
          entryTime: '2026-01-01T00:00:00.000Z',
          exitTime: '2026-01-01T01:00:00.000Z',
        },
        {
          profitPips: 0.2,
          grossProfitLoss: -1,
          profitLoss: -1,
          exitReason: 'BREAKEVEN_SL_HIT',
          realizedRMultiple: 0.02,
          breakevenActivated: true,
          entryTime: '2026-01-02T00:00:00.000Z',
          exitTime: '2026-01-02T01:00:00.000Z',
        },
        {
          profitPips: 15,
          grossProfitLoss: 150,
          profitLoss: 150,
          exitReason: 'BREAKEVEN_SL_HIT',
          realizedRMultiple: 0.45,
          breakevenActivated: true,
          entryTime: '2026-01-03T00:00:00.000Z',
          exitTime: '2026-01-03T01:00:00.000Z',
        },
        {
          profitPips: -5,
          grossProfitLoss: -50,
          profitLoss: -50,
          exitReason: 'SL_HIT',
          entryTime: '2026-01-04T00:00:00.000Z',
          exitTime: '2026-01-04T01:00:00.000Z',
        },
      ],
      10000,
      10199,
      [
        { time: '2026-01-01T00:00:00.000Z', equity: 10000 },
        { time: '2026-01-04T01:00:00.000Z', equity: 10199 },
      ]
    );

    expect(summary.winningTrades).toBe(2);
    expect(summary.losingTrades).toBe(1);
    expect(summary.neutralTrades).toBe(1);
    expect(summary.winRate).toBe(0.6667);
    expect(summary.neutralRate).toBe(0.25);
    expect(summary.breakevenExitTrades).toBe(2);
    expect(summary.breakevenExitRate).toBe(0.5);
    expect(summary.breakevenTriggeredTrades).toBe(2);
    expect(summary.breakevenTriggerRate).toBe(0.5);
    expect(summary.requiredBreakevenWinRate).toBe(0.2857);
  });
});
