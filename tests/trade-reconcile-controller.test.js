jest.mock('../src/models/Position', () => ({}));
jest.mock('../src/models/Trade', () => ({}));
jest.mock('../src/models/ExecutionAudit', () => ({}));
jest.mock('../src/services/tradeExecutor', () => ({}));
jest.mock('../src/services/tradeHistoryService', () => ({
  syncTradesFromBroker: jest.fn(),
}));
jest.mock('../src/utils/tradeExport', () => ({
  LIVE_TRADE_COLUMNS: [],
  buildCsv: jest.fn(),
  buildExportFilename: jest.fn(),
}));

const positionController = require('../src/controllers/positionController');
const tradeHistoryService = require('../src/services/tradeHistoryService');

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

describe('trade reconcile controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('passes filters through to trade history reconcile and returns import counts', async () => {
    tradeHistoryService.syncTradesFromBroker.mockResolvedValue({
      mode: 'full',
      checked: 12,
      updated: 2,
      imported: 3,
      skipped: 7,
      results: [],
    });

    const req = {
      body: {
        mode: 'full',
        limit: 500,
        symbol: 'GBPJPY',
        startDate: '2026-04-01',
        endDate: '2026-04-30',
      },
      query: {},
    };
    const res = createRes();

    await positionController.reconcileTrades(req, res);

    expect(tradeHistoryService.syncTradesFromBroker).toHaveBeenCalledWith({
      mode: 'full',
      limit: 500,
      symbol: 'GBPJPY',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      message: 'MT5 sync complete: 3 imported, 2 updated, 7 skipped across 12 broker trades',
      data: {
        mode: 'full',
        checked: 12,
        updated: 2,
        imported: 3,
        skipped: 7,
        results: [],
      },
    });
  });
});
