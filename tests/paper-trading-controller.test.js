jest.mock('../src/services/paperTradingService', () => ({
  getStatus: jest.fn(),
  start: jest.fn(),
  stop: jest.fn(),
  getPositions: jest.fn(),
  closePosition: jest.fn(),
}));

jest.mock('../src/services/dailyReportService', () => ({
  getStatus: jest.fn(),
  start: jest.fn(),
  stop: jest.fn(),
  generateAndSendReport: jest.fn(),
}));

jest.mock('../src/models/TradeLog', () => ({
  findAll: jest.fn(),
  getStats: jest.fn(),
}));

const paperTradingController = require('../src/controllers/paperTradingController');
const paperTradingService = require('../src/services/paperTradingService');
const dailyReportService = require('../src/services/dailyReportService');

function createRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

describe('paperTradingController.getStatus runtime identity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    dailyReportService.getStatus.mockReturnValue({ running: false });
  });

  test('returns paper account identity fields', async () => {
    paperTradingService.getStatus.mockResolvedValue({
      scope: 'paper',
      enabled: true,
      running: true,
      connected: true,
      mt5Path: 'C:\\MT5-Paper\\terminal64.exe',
      account: {
        login: '222222',
        server: 'Broker-Demo',
        tradeModeName: 'DEMO',
        isReal: false,
        isDemo: true,
        balance: 25000,
        equity: 24900,
        currency: 'USD',
      },
      validation: { ok: true, warnings: [], errors: [] },
    });

    const res = createRes();
    await paperTradingController.getStatus({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        scope: 'paper',
        connected: true,
        mt5Path: 'C:\\MT5-Paper\\terminal64.exe',
        account: expect.objectContaining({
          login: '222222',
          server: 'Broker-Demo',
          tradeModeName: 'DEMO',
          isDemo: true,
          balance: 25000,
          equity: 24900,
          currency: 'USD',
        }),
        validation: { ok: true, warnings: [], errors: [] },
        dailyReport: { running: false },
      }),
    }));
  });

  test('returns safe payload when paper runtime is not connected', async () => {
    paperTradingService.getStatus.mockResolvedValue({
      scope: 'paper',
      enabled: false,
      running: false,
      connected: false,
      mt5Path: null,
      account: null,
      validation: { ok: false, warnings: [], errors: [] },
      message: 'Paper runtime not configured or not connected.',
    });

    const res = createRes();
    await paperTradingController.getStatus({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.data).toEqual(expect.objectContaining({
      scope: 'paper',
      connected: false,
      mt5Path: null,
      account: null,
      message: 'Paper runtime not configured or not connected.',
    }));
  });

  test('surfaces validation error when paper status reports REAL account', async () => {
    paperTradingService.getStatus.mockResolvedValue({
      scope: 'paper',
      enabled: true,
      running: false,
      connected: true,
      mt5Path: 'C:\\MT5-Paper\\terminal64.exe',
      account: {
        login: '999999',
        server: 'Broker-Real',
        tradeModeName: 'REAL',
        isReal: true,
        isDemo: false,
        balance: 50000,
        equity: 50000,
        currency: 'USD',
      },
      validation: {
        ok: false,
        warnings: [],
        errors: ['Paper MT5 runtime must not use a REAL account.'],
      },
      message: 'Paper runtime is connected to REAL account. Paper trading is blocked.',
    });

    const res = createRes();
    await paperTradingController.getStatus({}, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload.data).toEqual(expect.objectContaining({
      account: expect.objectContaining({ tradeModeName: 'REAL', isReal: true }),
      validation: expect.objectContaining({
        ok: false,
        errors: ['Paper MT5 runtime must not use a REAL account.'],
      }),
      message: 'Paper runtime is connected to REAL account. Paper trading is blocked.',
    }));
  });
});
