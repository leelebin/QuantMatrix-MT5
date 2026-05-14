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

jest.mock('../src/services/symbolCustomBacktestService', () => ({
  runSymbolCustomBacktest: jest.fn(),
  listSymbolCustomBacktests: jest.fn(),
  getSymbolCustomBacktest: jest.fn(),
  deleteSymbolCustomBacktest: jest.fn(),
}));

jest.mock('../src/services/symbolCustomEngine', () => ({
  analyzeSymbolCustom: jest.fn(),
}));

jest.mock('../src/services/symbolCustomReportService', () => ({
  buildSymbolCustomReport: jest.fn(),
}));

jest.mock('../src/services/symbolCustomOptimizerService', () => ({
  createOptimizerRun: jest.fn(),
  listOptimizerRuns: jest.fn(),
  getOptimizerRun: jest.fn(),
  deleteOptimizerRun: jest.fn(),
}));

jest.mock('../src/services/symbolCustomSafetyAuditService', () => ({
  runSymbolCustomPhase1SafetyAudit: jest.fn(),
}));

jest.mock('../src/services/symbolCustomPaperRuntimeService', () => ({
  getStatus: jest.fn(),
  runPaperScan: jest.fn(),
}));

const symbolCustomService = require('../src/services/symbolCustomService');
const symbolCustomSeedService = require('../src/services/symbolCustomSeedService');
const symbolCustomBacktestService = require('../src/services/symbolCustomBacktestService');
const symbolCustomEngine = require('../src/services/symbolCustomEngine');
const symbolCustomReportService = require('../src/services/symbolCustomReportService');
const symbolCustomOptimizerService = require('../src/services/symbolCustomOptimizerService');
const symbolCustomSafetyAuditService = require('../src/services/symbolCustomSafetyAuditService');
const symbolCustomPaperRuntimeService = require('../src/services/symbolCustomPaperRuntimeService');
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

  test('GET /api/symbol-customs/report is mounted before generic id route', async () => {
    symbolCustomReportService.buildSymbolCustomReport.mockResolvedValue({
      success: true,
      count: 1,
      symbolCustoms: [{ symbol: 'USDJPY', recommendation: 'PLACEHOLDER_ONLY' }],
    });

    const response = await request(createApp())
      .get('/api/symbol-customs/report?symbol=USDJPY&status=draft');

    expect(response.status).toBe(200);
    expect(symbolCustomReportService.buildSymbolCustomReport).toHaveBeenCalledWith({
      symbol: 'USDJPY',
      status: 'draft',
    });
    expect(response.body).toEqual({
      success: true,
      count: 1,
      symbolCustoms: [{ symbol: 'USDJPY', recommendation: 'PLACEHOLDER_ONLY' }],
    });
  });

  test('GET /api/symbol-customs/safety-audit is mounted before generic id route', async () => {
    symbolCustomSafetyAuditService.runSymbolCustomPhase1SafetyAudit.mockResolvedValue({
      success: true,
      checks: [{ name: 'live execution not connected', status: 'PASS', message: 'ok' }],
      summary: { pass: 1, warn: 0, fail: 0 },
    });

    const response = await request(createApp()).get('/api/symbol-customs/safety-audit');

    expect(response.status).toBe(200);
    expect(symbolCustomSafetyAuditService.runSymbolCustomPhase1SafetyAudit).toHaveBeenCalledTimes(1);
    expect(response.body).toEqual({
      success: true,
      checks: [{ name: 'live execution not connected', status: 'PASS', message: 'ok' }],
      summary: { pass: 1, warn: 0, fail: 0 },
    });
  });

  test('SymbolCustom paper runtime routes are mounted before generic id route', async () => {
    symbolCustomPaperRuntimeService.getStatus.mockReturnValue({
      enabled: false,
      running: false,
      lastScanAt: null,
      lastError: null,
      activePaperCustoms: 0,
      lastSignals: [],
    });
    symbolCustomPaperRuntimeService.runPaperScan.mockResolvedValue({
      success: true,
      scanned: 1,
      submitted: 0,
      ignored: 1,
      signals: [{ source: 'symbolCustom', scope: 'paper', signal: 'NONE' }],
      results: [],
    });

    const app = createApp();
    const statusResponse = await request(app).get('/api/symbol-customs/paper-runtime/status');
    const scanResponse = await request(app).post('/api/symbol-customs/paper-runtime/scan-once').send({});

    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body).toEqual({
      success: true,
      enabled: false,
      running: false,
      lastScanAt: null,
      lastError: null,
      activePaperCustoms: 0,
      lastSignals: [],
    });
    expect(scanResponse.status).toBe(200);
    expect(scanResponse.body).toEqual({
      success: true,
      scanned: 1,
      submitted: 0,
      ignored: 1,
      signals: [{ source: 'symbolCustom', scope: 'paper', signal: 'NONE' }],
      results: [],
    });
  });

  test('SymbolCustom backtest routes are mounted before generic id route', async () => {
    symbolCustomBacktestService.listSymbolCustomBacktests.mockResolvedValue([
      { _id: 'bt-1', status: 'stub' },
    ]);
    symbolCustomBacktestService.getSymbolCustomBacktest.mockResolvedValue({
      _id: 'bt-1',
      status: 'stub',
    });
    symbolCustomBacktestService.runSymbolCustomBacktest.mockResolvedValue({
      _id: 'bt-2',
      status: 'stub',
    });
    symbolCustomBacktestService.deleteSymbolCustomBacktest.mockResolvedValue({
      _id: 'bt-1',
      status: 'stub',
    });

    const app = createApp();
    const listResponse = await request(app).get('/api/symbol-customs/backtests');
    const getResponse = await request(app).get('/api/symbol-customs/backtests/bt-1');
    const runResponse = await request(app)
      .post('/api/symbol-customs/sc-1/backtest')
      .send({ startDate: '2026-01-01', endDate: '2026-05-01', initialBalance: 500 });
    const deleteResponse = await request(app).delete('/api/symbol-customs/backtests/bt-1');

    expect(listResponse.status).toBe(200);
    expect(listResponse.body).toEqual({
      success: true,
      count: 1,
      backtests: [{ _id: 'bt-1', status: 'stub' }],
    });
    expect(getResponse.body).toEqual({ success: true, backtest: { _id: 'bt-1', status: 'stub' } });
    expect(runResponse.body).toEqual({ success: true, backtest: { _id: 'bt-2', status: 'stub' } });
    expect(deleteResponse.body).toEqual({ success: true, backtest: { _id: 'bt-1', status: 'stub' } });
    expect(symbolCustomBacktestService.runSymbolCustomBacktest).toHaveBeenCalledWith({
      symbolCustomId: 'sc-1',
      startDate: '2026-01-01',
      endDate: '2026-05-01',
      initialBalance: 500,
    });
  });

  test('POST /api/symbol-customs/:id/analyze-paper-once returns a read-only paper signal', async () => {
    symbolCustomService.getSymbolCustom.mockResolvedValue({
      _id: 'sc-1',
      symbol: 'USDJPY',
      symbolCustomName: 'USDJPY_PAPER',
    });
    symbolCustomEngine.analyzeSymbolCustom.mockResolvedValue({
      scope: 'paper',
      source: 'symbolCustom',
      symbolCustomId: 'sc-1',
      signal: 'NONE',
    });

    const response = await request(createApp())
      .post('/api/symbol-customs/sc-1/analyze-paper-once')
      .send({ candles: { entry: [] } });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      signal: {
        scope: 'paper',
        source: 'symbolCustom',
        symbolCustomId: 'sc-1',
        signal: 'NONE',
      },
    });
    expect(symbolCustomEngine.analyzeSymbolCustom).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'sc-1' }),
      null,
      expect.objectContaining({ scope: 'paper', candles: { entry: [] } })
    );
    expect(symbolCustomService.updateSymbolCustom).not.toHaveBeenCalled();
  });

  test('SymbolCustom optimizer stub routes are mounted before generic id route', async () => {
    symbolCustomOptimizerService.listOptimizerRuns.mockResolvedValue([
      { _id: 'opt-1', status: 'stub' },
    ]);
    symbolCustomOptimizerService.getOptimizerRun.mockResolvedValue({
      _id: 'opt-1',
      status: 'stub',
    });
    symbolCustomOptimizerService.createOptimizerRun.mockResolvedValue({
      _id: 'opt-2',
      status: 'stub',
    });
    symbolCustomOptimizerService.deleteOptimizerRun.mockResolvedValue({
      _id: 'opt-1',
      status: 'stub',
    });

    const app = createApp();
    const listResponse = await request(app).get('/api/symbol-customs/optimizer/runs');
    const getResponse = await request(app).get('/api/symbol-customs/optimizer/runs/opt-1');
    const runResponse = await request(app)
      .post('/api/symbol-customs/sc-1/optimizer/run')
      .send({ maxCombinations: 10, parameterOverrides: { lookbackBars: { max: 60 } } });
    const deleteResponse = await request(app).delete('/api/symbol-customs/optimizer/runs/opt-1');

    expect(listResponse.status).toBe(200);
    expect(listResponse.body).toEqual({
      success: true,
      count: 1,
      optimizerRuns: [{ _id: 'opt-1', status: 'stub' }],
    });
    expect(getResponse.body).toEqual({ success: true, optimizerRun: { _id: 'opt-1', status: 'stub' } });
    expect(runResponse.body).toEqual({ success: true, optimizerRun: { _id: 'opt-2', status: 'stub' } });
    expect(deleteResponse.body).toEqual({ success: true, optimizerRun: { _id: 'opt-1', status: 'stub' } });
    expect(symbolCustomOptimizerService.createOptimizerRun).toHaveBeenCalledWith({
      symbolCustomId: 'sc-1',
      maxCombinations: 10,
      parameterOverrides: { lookbackBars: { max: 60 } },
    });
  });
});
