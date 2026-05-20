jest.mock('../src/config/db', () => ({
  tradeLogDb: {
    insert: jest.fn(async (row) => ({ ...row, _id: 'trade-log-1' })),
  },
}));

const { tradeLogDb } = require('../src/config/db');
const TradeLog = require('../src/models/TradeLog');

describe('TradeLog metadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('logOpen preserves SymbolCustom metadata fields', async () => {
    await TradeLog.logOpen({
      symbol: 'USDJPY',
      type: 'BUY',
      lotSize: 0.1,
      entryPrice: 156.12,
      stopLoss: 155.8,
      takeProfit: 156.8,
      strategy: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      source: 'symbolCustom',
      symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      logicName: 'JPY macro reversal',
      candidatePreset: 'trial-ready',
      parameterSnapshot: { risk: 0.5 },
      setupType: 'macro_reversal',
      scope: 'paper',
      positionDbId: 'paper-position-1',
    });

    expect(tradeLogDb.insert).toHaveBeenCalledWith(expect.objectContaining({
      source: 'symbolCustom',
      symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      logicName: 'JPY macro reversal',
      candidatePreset: 'trial-ready',
      parameterSnapshot: { risk: 0.5 },
      setupType: 'macro_reversal',
      scope: 'paper',
    }));
  });
});
