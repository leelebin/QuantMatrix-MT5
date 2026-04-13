jest.mock('../src/config/db', () => ({
  backtestsDb: {
    insert: jest.fn(),
    find: jest.fn(() => ({
      sort: jest.fn(() => ({
        limit: jest.fn().mockResolvedValue([]),
      })),
    })),
    findOne: jest.fn(),
    remove: jest.fn(),
  },
}));

const backtestEngine = require('../src/services/backtestEngine');
const optimizerService = require('../src/services/optimizerService');

function makeCandles(count, start = 100) {
  return Array.from({ length: count }, (_, index) => {
    const close = start + (index * 0.01);
    return {
      time: new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
      open: close - 0.2,
      high: close + 0.3,
      low: close - 0.3,
      close,
    };
  });
}

describe('optimizer/backtest consistency', () => {
  test('optimizer single-combination results match the formal backtest engine output', async () => {
    const candles = makeCandles(270, 95);
    const params = {
      lookback_period: 20,
      body_multiplier: 1.2,
      slMultiplier: 2,
      tpMultiplier: 5,
    };

    const simulation = await backtestEngine.simulate({
      symbol: 'XTIUSD',
      strategyType: 'Breakout',
      timeframe: '1h',
      candles,
      tradeStartTime: candles[250].time,
      tradeEndTime: candles[candles.length - 1].time,
      strategyParams: params,
    });

    const optimization = await optimizerService.run({
      symbol: 'XTIUSD',
      strategyType: 'Breakout',
      timeframe: '1h',
      candles,
      tradeStartTime: candles[250].time,
      tradeEndTime: candles[candles.length - 1].time,
      paramRanges: {
        lookback_period: { min: 20, max: 20, step: 1 },
        body_multiplier: { min: 1.2, max: 1.2, step: 0.1 },
        slMultiplier: { min: 2, max: 2, step: 0.1 },
        tpMultiplier: { min: 5, max: 5, step: 0.1 },
      },
      minimumTrades: 0,
    });

    expect(optimization.bestResult.parameters).toEqual(simulation.parameters);
    expect(optimization.bestResult.summary).toEqual(simulation.summary);
  });
});
