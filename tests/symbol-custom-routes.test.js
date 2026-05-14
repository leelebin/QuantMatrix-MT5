const express = require('express');
const request = require('supertest');

jest.mock('../src/middleware/auth', () => ({
  protect: (_req, _res, next) => next(),
}));

jest.mock('../src/services/symbolCustomService', () => ({
  listSymbolCustoms: jest.fn(),
  getSymbolCustom: jest.fn(),
  getSymbolCustomsBySymbol: jest.fn(),
  createSymbolCustom: jest.fn(),
  updateSymbolCustom: jest.fn(),
  deleteSymbolCustom: jest.fn(),
  duplicateSymbolCustom: jest.fn(),
}));

jest.mock('../src/services/symbolCustomSeedService', () => ({
  ensureDefaultSymbolCustomDrafts: jest.fn(),
}));

const symbolCustomSeedService = require('../src/services/symbolCustomSeedService');
const symbolCustomRoutes = require('../src/routes/symbolCustomRoutes');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/symbol-customs', symbolCustomRoutes);
  return app;
}

describe('symbolCustomRoutes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('POST /api/symbol-customs/defaults/ensure ensures backend default drafts', async () => {
    symbolCustomSeedService.ensureDefaultSymbolCustomDrafts.mockResolvedValue({
      createdCount: 3,
      existingCount: 0,
      totalCount: 3,
      created: [
        { symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1' },
        { symbolCustomName: 'GBPJPY_VOLATILITY_BREAKOUT_V1' },
        { symbolCustomName: 'AUDUSD_SESSION_PULLBACK_V1' },
      ],
      existing: [],
      symbolCustoms: [],
    });

    const response = await request(createApp())
      .post('/api/symbol-customs/defaults/ensure')
      .send({});

    expect(response.status).toBe(200);
    expect(symbolCustomSeedService.ensureDefaultSymbolCustomDrafts).toHaveBeenCalledTimes(1);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      createdCount: 3,
      existingCount: 0,
      totalCount: 3,
    }));
  });
});
