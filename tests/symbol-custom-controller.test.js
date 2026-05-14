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

const controller = require('../src/controllers/symbolCustomController');
const symbolCustomService = require('../src/services/symbolCustomService');
const symbolCustomSeedService = require('../src/services/symbolCustomSeedService');
const symbolCustomBacktestService = require('../src/services/symbolCustomBacktestService');
const symbolCustomEngine = require('../src/services/symbolCustomEngine');
const symbolCustomReportService = require('../src/services/symbolCustomReportService');
const symbolCustomOptimizerService = require('../src/services/symbolCustomOptimizerService');
const symbolCustomSafetyAuditService = require('../src/services/symbolCustomSafetyAuditService');
const symbolCustomPaperRuntimeService = require('../src/services/symbolCustomPaperRuntimeService');

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

describe('symbolCustomController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('list returns count and symbolCustoms', async () => {
    symbolCustomService.listSymbolCustoms.mockResolvedValue([
      { _id: 'sc-1', symbol: 'USDJPY' },
      { _id: 'sc-2', symbol: 'GBPJPY' },
    ]);

    const res = createRes();
    await controller.list({ query: { symbol: 'USDJPY' } }, res);

    expect(symbolCustomService.listSymbolCustoms).toHaveBeenCalledWith({ symbol: 'USDJPY' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({
      success: true,
      count: 2,
      symbolCustoms: [
        { _id: 'sc-1', symbol: 'USDJPY' },
        { _id: 'sc-2', symbol: 'GBPJPY' },
      ],
    });
  });

  test('getById returns data and 404 for missing records', async () => {
    symbolCustomService.getSymbolCustom.mockResolvedValueOnce({ _id: 'sc-1' });
    const foundRes = createRes();
    await controller.getById({ params: { id: 'sc-1' } }, foundRes);

    symbolCustomService.getSymbolCustom.mockResolvedValueOnce(null);
    const missingRes = createRes();
    await controller.getById({ params: { id: 'missing' } }, missingRes);

    expect(foundRes.payload).toEqual({ success: true, data: { _id: 'sc-1' } });
    expect(missingRes.statusCode).toBe(404);
    expect(missingRes.payload).toEqual({ success: false, message: 'SymbolCustom not found' });
  });

  test('getBySymbol returns matching rows', async () => {
    symbolCustomService.getSymbolCustomsBySymbol.mockResolvedValue([
      { _id: 'sc-1', symbol: 'AUDUSD' },
    ]);

    const res = createRes();
    await controller.getBySymbol({ params: { symbol: 'AUDUSD' } }, res);

    expect(symbolCustomService.getSymbolCustomsBySymbol).toHaveBeenCalledWith('AUDUSD');
    expect(res.payload).toEqual({
      success: true,
      count: 1,
      symbolCustoms: [{ _id: 'sc-1', symbol: 'AUDUSD' }],
    });
  });

  test('create, update, duplicate, and remove use service response shape', async () => {
    symbolCustomService.createSymbolCustom.mockResolvedValue({
      symbolCustom: { _id: 'sc-1', liveEnabled: true },
      warnings: ['SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1'],
    });
    symbolCustomService.updateSymbolCustom.mockResolvedValue({
      symbolCustom: { _id: 'sc-1', status: 'validated' },
      warnings: [],
    });
    symbolCustomService.duplicateSymbolCustom.mockResolvedValue({
      symbolCustom: { _id: 'sc-2' },
      warnings: [],
    });
    symbolCustomService.deleteSymbolCustom.mockResolvedValue({ _id: 'sc-1' });

    const createResponse = createRes();
    await controller.create({ body: { liveEnabled: true } }, createResponse);

    const updateRes = createRes();
    await controller.update({ params: { id: 'sc-1' }, body: { status: 'validated' } }, updateRes);

    const duplicateRes = createRes();
    await controller.duplicate({ params: { id: 'sc-1' }, body: { symbolCustomName: 'Copy' } }, duplicateRes);

    const removeRes = createRes();
    await controller.remove({ params: { id: 'sc-1' } }, removeRes);

    expect(createResponse.payload).toEqual({
      success: true,
      data: { _id: 'sc-1', liveEnabled: true },
      warning: 'SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1',
      warnings: ['SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_1'],
    });
    expect(updateRes.payload).toEqual({
      success: true,
      data: { _id: 'sc-1', status: 'validated' },
    });
    expect(duplicateRes.payload).toEqual({
      success: true,
      data: { _id: 'sc-2' },
    });
    expect(removeRes.payload).toEqual({
      success: true,
      data: { _id: 'sc-1' },
    });
  });

  test('ensureDefaults returns backend default draft seed result', async () => {
    symbolCustomSeedService.ensureDefaultSymbolCustomDrafts.mockResolvedValue({
      createdCount: 2,
      existingCount: 1,
      totalCount: 3,
      created: [{ _id: 'sc-new' }],
      existing: [{ _id: 'sc-existing' }],
      symbolCustoms: [{ _id: 'sc-existing' }, { _id: 'sc-new' }],
    });

    const res = createRes();
    await controller.ensureDefaults({}, res);

    expect(symbolCustomSeedService.ensureDefaultSymbolCustomDrafts).toHaveBeenCalledTimes(1);
    expect(res.payload).toEqual({
      success: true,
      createdCount: 2,
      existingCount: 1,
      totalCount: 3,
      created: [{ _id: 'sc-new' }],
      existing: [{ _id: 'sc-existing' }],
      symbolCustoms: [{ _id: 'sc-existing' }, { _id: 'sc-new' }],
    });
  });

  test('report returns SymbolCustom report service response shape', async () => {
    symbolCustomReportService.buildSymbolCustomReport.mockResolvedValue({
      success: true,
      count: 1,
      symbolCustoms: [{ symbol: 'USDJPY', recommendation: 'PLACEHOLDER_ONLY' }],
    });

    const res = createRes();
    await controller.report({ query: { symbol: 'USDJPY', status: 'draft' } }, res);

    expect(symbolCustomReportService.buildSymbolCustomReport).toHaveBeenCalledWith({
      symbol: 'USDJPY',
      status: 'draft',
    });
    expect(res.payload).toEqual({
      success: true,
      count: 1,
      symbolCustoms: [{ symbol: 'USDJPY', recommendation: 'PLACEHOLDER_ONLY' }],
    });
  });

  test('safetyAudit returns SymbolCustom safety audit response shape', async () => {
    symbolCustomSafetyAuditService.runSymbolCustomPhase1SafetyAudit.mockResolvedValue({
      success: true,
      checks: [{ name: 'placeholder does not trade', status: 'PASS', message: 'ok' }],
      summary: { pass: 1, warn: 0, fail: 0 },
    });

    const res = createRes();
    await controller.safetyAudit({}, res);

    expect(symbolCustomSafetyAuditService.runSymbolCustomPhase1SafetyAudit).toHaveBeenCalledTimes(1);
    expect(res.payload).toEqual({
      success: true,
      checks: [{ name: 'placeholder does not trade', status: 'PASS', message: 'ok' }],
      summary: { pass: 1, warn: 0, fail: 0 },
    });
  });

  test('paperRuntimeStatus returns SymbolCustom paper runtime status shape', async () => {
    symbolCustomPaperRuntimeService.getStatus.mockReturnValue({
      enabled: false,
      running: false,
      lastScanAt: null,
      lastError: null,
      activePaperCustoms: 0,
      lastSignals: [],
    });

    const res = createRes();
    await controller.paperRuntimeStatus({}, res);

    expect(symbolCustomPaperRuntimeService.getStatus).toHaveBeenCalledTimes(1);
    expect(res.payload).toEqual({
      success: true,
      enabled: false,
      running: false,
      lastScanAt: null,
      lastError: null,
      activePaperCustoms: 0,
      lastSignals: [],
    });
  });

  test('scanPaperRuntimeOnce runs one paper scan without starting scheduler', async () => {
    symbolCustomPaperRuntimeService.runPaperScan.mockResolvedValue({
      success: true,
      scanned: 1,
      submitted: 0,
      ignored: 1,
      signals: [{ source: 'symbolCustom', scope: 'paper', signal: 'NONE' }],
      results: [],
    });

    const res = createRes();
    await controller.scanPaperRuntimeOnce({}, res);

    expect(symbolCustomPaperRuntimeService.runPaperScan).toHaveBeenCalledWith({});
    expect(res.payload).toEqual({
      success: true,
      scanned: 1,
      submitted: 0,
      ignored: 1,
      signals: [{ source: 'symbolCustom', scope: 'paper', signal: 'NONE' }],
      results: [],
    });
  });

  test('backtest handlers use SymbolCustom backtest service response shape', async () => {
    symbolCustomBacktestService.runSymbolCustomBacktest.mockResolvedValue({
      _id: 'bt-1',
      status: 'stub',
    });
    symbolCustomBacktestService.listSymbolCustomBacktests.mockResolvedValue([
      { _id: 'bt-1' },
      { _id: 'bt-2' },
    ]);
    symbolCustomBacktestService.getSymbolCustomBacktest.mockResolvedValueOnce({ _id: 'bt-1' });
    symbolCustomBacktestService.deleteSymbolCustomBacktest.mockResolvedValueOnce({ _id: 'bt-1' });

    const runRes = createRes();
    await controller.runBacktest({
      params: { id: 'sc-1' },
      body: { startDate: '2026-01-01', endDate: '2026-05-01', initialBalance: 500 },
    }, runRes);

    const listRes = createRes();
    await controller.listBacktests({ query: { symbol: 'USDJPY' } }, listRes);

    const getRes = createRes();
    await controller.getBacktestById({ params: { backtestId: 'bt-1' } }, getRes);

    const deleteRes = createRes();
    await controller.removeBacktest({ params: { backtestId: 'bt-1' } }, deleteRes);

    expect(symbolCustomBacktestService.runSymbolCustomBacktest).toHaveBeenCalledWith({
      symbolCustomId: 'sc-1',
      startDate: '2026-01-01',
      endDate: '2026-05-01',
      initialBalance: 500,
    });
    expect(runRes.payload).toEqual({ success: true, backtest: { _id: 'bt-1', status: 'stub' } });
    expect(listRes.payload).toEqual({
      success: true,
      count: 2,
      backtests: [{ _id: 'bt-1' }, { _id: 'bt-2' }],
    });
    expect(getRes.payload).toEqual({ success: true, backtest: { _id: 'bt-1' } });
    expect(deleteRes.payload).toEqual({ success: true, backtest: { _id: 'bt-1' } });
  });

  test('backtest get and delete return 404 for missing records', async () => {
    symbolCustomBacktestService.getSymbolCustomBacktest.mockResolvedValueOnce(null);
    symbolCustomBacktestService.deleteSymbolCustomBacktest.mockResolvedValueOnce(null);

    const getRes = createRes();
    await controller.getBacktestById({ params: { backtestId: 'missing' } }, getRes);

    const deleteRes = createRes();
    await controller.removeBacktest({ params: { backtestId: 'missing' } }, deleteRes);

    expect(getRes.statusCode).toBe(404);
    expect(getRes.payload).toEqual({ success: false, message: 'SymbolCustom backtest not found' });
    expect(deleteRes.statusCode).toBe(404);
    expect(deleteRes.payload).toEqual({ success: false, message: 'SymbolCustom backtest not found' });
  });

  test('analyzePaperOnce returns a paper signal without mutating SymbolCustom', async () => {
    const symbolCustom = {
      _id: 'sc-1',
      symbol: 'USDJPY',
      symbolCustomName: 'USDJPY_PAPER',
      logicName: 'PLACEHOLDER_SYMBOL_CUSTOM',
    };
    const signal = {
      scope: 'paper',
      source: 'symbolCustom',
      signal: 'NONE',
      symbolCustomId: 'sc-1',
    };
    symbolCustomService.getSymbolCustom.mockResolvedValueOnce(symbolCustom);
    symbolCustomEngine.analyzeSymbolCustom.mockResolvedValueOnce(signal);

    const res = createRes();
    await controller.analyzePaperOnce({
      params: { id: 'sc-1' },
      body: { candles: { entry: [] }, context: { test: true }, timestamp: '2026-05-14T00:00:00.000Z' },
    }, res);

    expect(symbolCustomService.getSymbolCustom).toHaveBeenCalledWith('sc-1');
    expect(symbolCustomEngine.analyzeSymbolCustom).toHaveBeenCalledWith(symbolCustom, null, {
      scope: 'paper',
      candles: { entry: [] },
      context: { test: true },
      timestamp: '2026-05-14T00:00:00.000Z',
    });
    expect(res.payload).toEqual({ success: true, signal });
    expect(symbolCustomService.updateSymbolCustom).not.toHaveBeenCalled();
  });

  test('analyzePaperOnce returns 404 for missing SymbolCustom', async () => {
    symbolCustomService.getSymbolCustom.mockResolvedValueOnce(null);

    const res = createRes();
    await controller.analyzePaperOnce({ params: { id: 'missing' }, body: {} }, res);

    expect(res.statusCode).toBe(404);
    expect(res.payload).toEqual({ success: false, message: 'SymbolCustom not found' });
    expect(symbolCustomEngine.analyzeSymbolCustom).not.toHaveBeenCalled();
  });

  test('optimizer run handlers use SymbolCustom optimizer service response shape', async () => {
    symbolCustomOptimizerService.createOptimizerRun.mockResolvedValue({
      _id: 'opt-1',
      status: 'stub',
    });
    symbolCustomOptimizerService.listOptimizerRuns.mockResolvedValue([
      { _id: 'opt-1' },
      { _id: 'opt-2' },
    ]);
    symbolCustomOptimizerService.getOptimizerRun.mockResolvedValueOnce({ _id: 'opt-1' });
    symbolCustomOptimizerService.deleteOptimizerRun.mockResolvedValueOnce({ _id: 'opt-1' });

    const runRes = createRes();
    await controller.createOptimizerRun({
      params: { id: 'sc-1' },
      body: { maxCombinations: 25, parameterOverrides: { lookbackBars: { max: 60 } } },
    }, runRes);

    const listRes = createRes();
    await controller.listOptimizerRuns({ query: { symbol: 'USDJPY' } }, listRes);

    const getRes = createRes();
    await controller.getOptimizerRunById({ params: { runId: 'opt-1' } }, getRes);

    const deleteRes = createRes();
    await controller.removeOptimizerRun({ params: { runId: 'opt-1' } }, deleteRes);

    expect(symbolCustomOptimizerService.createOptimizerRun).toHaveBeenCalledWith({
      symbolCustomId: 'sc-1',
      maxCombinations: 25,
      parameterOverrides: { lookbackBars: { max: 60 } },
    });
    expect(runRes.payload).toEqual({ success: true, optimizerRun: { _id: 'opt-1', status: 'stub' } });
    expect(listRes.payload).toEqual({
      success: true,
      count: 2,
      optimizerRuns: [{ _id: 'opt-1' }, { _id: 'opt-2' }],
    });
    expect(getRes.payload).toEqual({ success: true, optimizerRun: { _id: 'opt-1' } });
    expect(deleteRes.payload).toEqual({ success: true, optimizerRun: { _id: 'opt-1' } });
  });

  test('optimizer get and delete return 404 for missing runs', async () => {
    symbolCustomOptimizerService.getOptimizerRun.mockResolvedValueOnce(null);
    symbolCustomOptimizerService.deleteOptimizerRun.mockResolvedValueOnce(null);

    const getRes = createRes();
    await controller.getOptimizerRunById({ params: { runId: 'missing' } }, getRes);

    const deleteRes = createRes();
    await controller.removeOptimizerRun({ params: { runId: 'missing' } }, deleteRes);

    expect(getRes.statusCode).toBe(404);
    expect(getRes.payload).toEqual({ success: false, message: 'SymbolCustom optimizer run not found' });
    expect(deleteRes.statusCode).toBe(404);
    expect(deleteRes.payload).toEqual({ success: false, message: 'SymbolCustom optimizer run not found' });
  });
});
