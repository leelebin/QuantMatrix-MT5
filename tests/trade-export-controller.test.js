jest.mock('../src/models/Position', () => ({}));
jest.mock('../src/models/ExecutionAudit', () => ({}));
jest.mock('../src/services/tradeExecutor', () => ({}));
jest.mock('../src/services/tradeHistoryService', () => ({}));
jest.mock('../src/services/mt5Service', () => ({}));
jest.mock('../src/services/positionMonitor', () => ({}));
jest.mock('../src/config/db', () => ({
  paperPositionsDb: { find: jest.fn() },
}));
jest.mock('../src/models/Trade', () => ({
  findForExport: jest.fn(),
}));
jest.mock('../src/services/tradeLedgerService', () => ({
  normalizeLedgerSource: jest.fn((source) => source || 'canonical'),
  getRows: jest.fn(),
}));
jest.mock('../src/utils/tradeExport', () => ({
  LIVE_TRADE_COLUMNS: [{ key: 'symbol', header: 'symbol' }],
  buildCsv: jest.fn(() => 'csv-body'),
  buildExportFilename: jest.fn(() => 'trades.csv'),
}));

const positionController = require('../src/controllers/positionController');
const Trade = require('../src/models/Trade');
const tradeLedgerService = require('../src/services/tradeLedgerService');
const { buildCsv, buildExportFilename } = require('../src/utils/tradeExport');

function createRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(key, value) {
      this.headers[key] = value;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
}

describe('trade export controller source selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tradeLedgerService.normalizeLedgerSource.mockImplementation((source) => source || 'canonical');
  });

  test('exports canonical ledger by default', async () => {
    tradeLedgerService.getRows.mockResolvedValue([{ symbol: 'EURUSD', ledgerSource: 'matched' }]);

    const req = { query: { startDate: '2026-04-27', endDate: '2026-05-01' } };
    const res = createRes();

    await positionController.exportTradesCsv(req, res);

    expect(tradeLedgerService.getRows).toHaveBeenCalledWith({
      source: 'canonical',
      filters: {
        symbol: undefined,
        strategy: undefined,
        status: undefined,
        startDate: '2026-04-27',
        endDate: '2026-05-01',
      },
    });
    expect(Trade.findForExport).not.toHaveBeenCalled();
    expect(buildCsv).toHaveBeenCalledWith([{ key: 'symbol', header: 'symbol' }], [{ symbol: 'EURUSD', ledgerSource: 'matched' }]);
    expect(buildExportFilename).toHaveBeenCalledWith(expect.objectContaining({ source: 'canonical' }));
    expect(res.body).toBe('csv-body');
  });

  test('keeps broker source on the legacy MT5 export path', async () => {
    tradeLedgerService.normalizeLedgerSource.mockReturnValue('broker');
    Trade.findForExport.mockResolvedValue([{ symbol: 'XAUUSD', brokerSyncSource: 'history_sync' }]);

    const req = { query: { source: 'broker', symbol: 'XAUUSD' } };
    const res = createRes();

    await positionController.exportTradesCsv(req, res);

    expect(Trade.findForExport).toHaveBeenCalledWith({
      symbol: 'XAUUSD',
      strategy: undefined,
      status: undefined,
      startDate: undefined,
      endDate: undefined,
    });
    expect(tradeLedgerService.getRows).not.toHaveBeenCalled();
    expect(buildExportFilename).toHaveBeenCalledWith(expect.objectContaining({ source: 'broker' }));
    expect(res.body).toBe('csv-body');
  });
});
