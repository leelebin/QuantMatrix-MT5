jest.mock('../src/models/Position', () => ({
  findAll: jest.fn(),
  findById: jest.fn(),
}));

jest.mock('../src/models/Trade', () => ({}));
jest.mock('../src/models/ExecutionAudit', () => ({}));
jest.mock('../src/services/tradeExecutor', () => ({
  closePosition: jest.fn(),
}));
jest.mock('../src/services/tradeHistoryService', () => ({
  syncTradesFromBroker: jest.fn(),
}));
jest.mock('../src/services/mt5Service', () => ({
  isConnected: jest.fn(),
  getPositions: jest.fn(),
}));
jest.mock('../src/services/positionMonitor', () => ({
  syncPositions: jest.fn(),
}));
jest.mock('../src/config/db', () => ({
  paperPositionsDb: {
    find: jest.fn(),
  },
}));
jest.mock('../src/utils/tradeExport', () => ({
  LIVE_TRADE_COLUMNS: [],
  buildCsv: jest.fn(),
  buildExportFilename: jest.fn(),
}));

const positionController = require('../src/controllers/positionController');
const Position = require('../src/models/Position');
const mt5Service = require('../src/services/mt5Service');
const positionMonitor = require('../src/services/positionMonitor');
const { paperPositionsDb } = require('../src/config/db');

function createRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    },
  };
}

describe('position controller live merge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('resolves MT5 paper positions against paperPositionsDb instead of marking them external', async () => {
    Position.findAll.mockResolvedValue([]);
    positionMonitor.syncPositions.mockResolvedValue([]);
    paperPositionsDb.find.mockResolvedValue([
      {
        _id: 'paper-pos-1',
        symbol: 'XAUUSD',
        type: 'SELL',
        entryPrice: 4668.21,
        currentSl: 4692.47,
        currentTp: 4570.69,
        lotSize: 0.01,
        mt5PositionId: '42868597',
        mt5EntryDealId: '41925890',
        mt5Comment: 'PT|Momentum|SELL|0.60',
        strategy: 'Momentum',
        comment: 'Strategy=Momentum | Signal=SELL',
        openedAt: new Date('2026-04-24T04:00:31.134Z'),
        unrealizedPl: -1.25,
        status: 'OPEN',
      },
    ]);
    mt5Service.isConnected.mockReturnValue(true);
    mt5Service.getPositions.mockResolvedValue([
      {
        id: '42868597',
        symbol: 'XAUUSD',
        type: 'SELL',
        volume: 0.01,
        openPrice: 4668.21,
        stopLoss: 4692.47,
        takeProfit: 4570.69,
        currentPrice: 4674.34,
        profit: 2.32,
        comment: 'PT|Momentum|SELL|0.60',
        time: 1777003231,
      },
    ]);

    const req = {};
    const res = createRes();

    await positionController.getPositions(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.success).toBe(true);
    expect(res.payload.data).toHaveLength(1);
    expect(res.payload.data[0]).toMatchObject({
      _id: null,
      paperPositionId: 'paper-pos-1',
      symbol: 'XAUUSD',
      type: 'SELL',
      strategy: 'Momentum',
      source: 'paper_mt5',
      isPaper: true,
      isExternal: false,
      mt5PositionId: '42868597',
      mt5EntryDealId: '41925890',
      currentPrice: 4674.34,
      unrealizedPl: 2.32,
    });
  });

  test('falls back to broker comment strategy when no local live or paper record exists', async () => {
    Position.findAll.mockResolvedValue([]);
    positionMonitor.syncPositions.mockResolvedValue([]);
    paperPositionsDb.find.mockResolvedValue([]);
    mt5Service.isConnected.mockReturnValue(true);
    mt5Service.getPositions.mockResolvedValue([
      {
        id: '42868592',
        symbol: 'USDCHF',
        type: 'BUY',
        volume: 0.01,
        openPrice: 0.78732,
        stopLoss: 0.78648,
        takeProfit: 0.79,
        currentPrice: 0.78679,
        profit: -0.56,
        comment: 'PT|Momentum|BUY|0.70',
        time: 1777003230,
      },
    ]);

    const req = {};
    const res = createRes();

    await positionController.getPositions(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.success).toBe(true);
    expect(res.payload.data).toHaveLength(1);
    expect(res.payload.data[0]).toMatchObject({
      _id: null,
      symbol: 'USDCHF',
      type: 'BUY',
      strategy: 'Momentum',
      source: 'paper_mt5_unlinked',
      isPaper: true,
      isExternal: true,
      mt5PositionId: '42868592',
    });
  });
});
