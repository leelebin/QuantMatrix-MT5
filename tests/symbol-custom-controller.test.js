jest.mock('../src/services/symbolCustomService', () => ({
  listSymbolCustoms: jest.fn(),
  getSymbolCustom: jest.fn(),
  getSymbolCustomsBySymbol: jest.fn(),
  createSymbolCustom: jest.fn(),
  updateSymbolCustom: jest.fn(),
  deleteSymbolCustom: jest.fn(),
  duplicateSymbolCustom: jest.fn(),
}));

const controller = require('../src/controllers/symbolCustomController');
const symbolCustomService = require('../src/services/symbolCustomService');

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
});
