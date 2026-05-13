const symbolCustomService = require('../services/symbolCustomService');
const symbolCustomSeedService = require('../services/symbolCustomSeedService');

function sendMutationResponse(res, result) {
  const payload = {
    success: true,
    data: result.symbolCustom,
  };

  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    payload.warning = result.warnings[0];
    payload.warnings = result.warnings;
  }

  return res.json(payload);
}

function handleError(res, error, fallbackMessage) {
  const statusCode = error.statusCode || 500;
  return res.status(statusCode).json({
    success: false,
    message: error.message || fallbackMessage,
    errors: error.details || undefined,
  });
}

exports.list = async (req, res) => {
  try {
    const symbolCustoms = await symbolCustomService.listSymbolCustoms(req.query || {});
    res.json({
      success: true,
      count: symbolCustoms.length,
      symbolCustoms,
    });
  } catch (error) {
    handleError(res, error, 'Failed to list SymbolCustom records');
  }
};

exports.getById = async (req, res) => {
  try {
    const symbolCustom = await symbolCustomService.getSymbolCustom(req.params.id);
    if (!symbolCustom) {
      return res.status(404).json({ success: false, message: 'SymbolCustom not found' });
    }
    return res.json({ success: true, data: symbolCustom });
  } catch (error) {
    return handleError(res, error, 'Failed to load SymbolCustom');
  }
};

exports.getBySymbol = async (req, res) => {
  try {
    const symbolCustoms = await symbolCustomService.getSymbolCustomsBySymbol(req.params.symbol);
    res.json({
      success: true,
      count: symbolCustoms.length,
      symbolCustoms,
    });
  } catch (error) {
    handleError(res, error, 'Failed to load SymbolCustom records for symbol');
  }
};

exports.create = async (req, res) => {
  try {
    const result = await symbolCustomService.createSymbolCustom(req.body || {});
    return sendMutationResponse(res, result);
  } catch (error) {
    return handleError(res, error, 'Failed to create SymbolCustom');
  }
};

exports.ensureDefaults = async (req, res) => {
  try {
    const result = await symbolCustomSeedService.ensureDefaultSymbolCustomDrafts();
    return res.json({
      success: true,
      createdCount: result.createdCount,
      existingCount: result.existingCount,
      totalCount: result.totalCount,
      created: result.created,
      existing: result.existing,
      symbolCustoms: result.symbolCustoms,
    });
  } catch (error) {
    return handleError(res, error, 'Failed to ensure default SymbolCustom drafts');
  }
};

exports.update = async (req, res) => {
  try {
    const result = await symbolCustomService.updateSymbolCustom(req.params.id, req.body || {});
    if (!result) {
      return res.status(404).json({ success: false, message: 'SymbolCustom not found' });
    }
    return sendMutationResponse(res, result);
  } catch (error) {
    return handleError(res, error, 'Failed to update SymbolCustom');
  }
};

exports.remove = async (req, res) => {
  try {
    const removed = await symbolCustomService.deleteSymbolCustom(req.params.id);
    if (!removed) {
      return res.status(404).json({ success: false, message: 'SymbolCustom not found' });
    }
    return res.json({ success: true, data: removed });
  } catch (error) {
    return handleError(res, error, 'Failed to delete SymbolCustom');
  }
};

exports.duplicate = async (req, res) => {
  try {
    const result = await symbolCustomService.duplicateSymbolCustom(req.params.id, req.body || {});
    if (!result) {
      return res.status(404).json({ success: false, message: 'SymbolCustom not found' });
    }
    return sendMutationResponse(res, result);
  } catch (error) {
    return handleError(res, error, 'Failed to duplicate SymbolCustom');
  }
};
