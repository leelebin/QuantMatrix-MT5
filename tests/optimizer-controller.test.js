jest.mock('../src/services/optimizerService', () => ({
  running: true,
  getDefaultRanges: jest.fn(),
  run: jest.fn(),
}));

jest.mock('../src/models/Strategy', () => ({
  findByName: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/models/RiskProfile', () => ({
  getActive: jest.fn().mockResolvedValue(null),
}));

jest.mock('../src/services/mt5Service', () => ({
  isConnected: jest.fn(),
  connect: jest.fn(),
  getCandles: jest.fn(),
}));

jest.mock('../src/services/websocketService', () => ({
  broadcast: jest.fn(),
}));

jest.mock('../src/services/notificationService', () => ({
  notifyOptimizerComplete: jest.fn(),
}));

const optimizerController = require('../src/controllers/optimizerController');

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

describe('optimizer controller', () => {
  test('runOptimizer returns 409 when the optimizer is already running', async () => {
    const req = {
      body: {
        symbol: 'EURUSD',
        strategyType: 'TrendFollowing',
      },
    };
    const res = createRes();

    await optimizerController.runOptimizer(req, res);

    expect(res.statusCode).toBe(409);
    expect(res.payload).toEqual(expect.objectContaining({
      success: false,
      message: 'Optimizer is already running',
    }));
  });
});
