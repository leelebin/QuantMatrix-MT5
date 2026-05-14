const symbolCustomService = require('../services/symbolCustomService');
const symbolCustomSeedService = require('../services/symbolCustomSeedService');
const symbolCustomBacktestService = require('../services/symbolCustomBacktestService');
const symbolCustomEngine = require('../services/symbolCustomEngine');
const symbolCustomReportService = require('../services/symbolCustomReportService');
const symbolCustomOptimizerService = require('../services/symbolCustomOptimizerService');
const symbolCustomSafetyAuditService = require('../services/symbolCustomSafetyAuditService');
const symbolCustomPaperRuntimeService = require('../services/symbolCustomPaperRuntimeService');

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

exports.report = async (req, res) => {
  try {
    const report = await symbolCustomReportService.buildSymbolCustomReport(req.query || {});
    return res.json(report);
  } catch (error) {
    return handleError(res, error, 'Failed to build SymbolCustom report');
  }
};

exports.safetyAudit = async (req, res) => {
  try {
    const audit = await symbolCustomSafetyAuditService.runSymbolCustomPhase1SafetyAudit();
    return res.json(audit);
  } catch (error) {
    return handleError(res, error, 'Failed to run SymbolCustom safety audit');
  }
};

exports.paperRuntimeStatus = async (req, res) => {
  try {
    return res.json({
      success: true,
      ...symbolCustomPaperRuntimeService.getStatus(),
    });
  } catch (error) {
    return handleError(res, error, 'Failed to load SymbolCustom paper runtime status');
  }
};

exports.scanPaperRuntimeOnce = async (req, res) => {
  try {
    const result = await symbolCustomPaperRuntimeService.runPaperScan({});
    return res.json({
      success: true,
      ...result,
    });
  } catch (error) {
    return handleError(res, error, 'Failed to scan SymbolCustom paper runtime');
  }
};

exports.runBacktest = async (req, res) => {
  try {
    const backtest = await symbolCustomBacktestService.runSymbolCustomBacktest({
      ...(req.body || {}),
      symbolCustomId: req.params.id,
    });
    return res.json({ success: true, backtest });
  } catch (error) {
    return handleError(res, error, 'Failed to run SymbolCustom backtest');
  }
};

exports.analyzePaperOnce = async (req, res) => {
  try {
    const symbolCustom = await symbolCustomService.getSymbolCustom(req.params.id);
    if (!symbolCustom) {
      return res.status(404).json({ success: false, message: 'SymbolCustom not found' });
    }

    const body = req.body || {};
    const signal = await symbolCustomEngine.analyzeSymbolCustom(symbolCustom, null, {
      scope: 'paper',
      candles: body.candles,
      context: body.context,
      timestamp: body.timestamp,
    });

    return res.json({ success: true, signal });
  } catch (error) {
    return handleError(res, error, 'Failed to analyze SymbolCustom paper signal');
  }
};

exports.createOptimizerRun = async (req, res) => {
  try {
    const optimizerRun = await symbolCustomOptimizerService.createOptimizerRun({
      ...(req.body || {}),
      symbolCustomId: req.params.id,
    });
    return res.json({ success: true, optimizerRun });
  } catch (error) {
    return handleError(res, error, 'Failed to create SymbolCustom optimizer run');
  }
};

exports.listOptimizerRuns = async (req, res) => {
  try {
    const optimizerRuns = await symbolCustomOptimizerService.listOptimizerRuns(req.query || {});
    return res.json({
      success: true,
      count: optimizerRuns.length,
      optimizerRuns,
    });
  } catch (error) {
    return handleError(res, error, 'Failed to list SymbolCustom optimizer runs');
  }
};

exports.getOptimizerRunById = async (req, res) => {
  try {
    const optimizerRun = await symbolCustomOptimizerService.getOptimizerRun(req.params.runId);
    if (!optimizerRun) {
      return res.status(404).json({ success: false, message: 'SymbolCustom optimizer run not found' });
    }
    return res.json({ success: true, optimizerRun });
  } catch (error) {
    return handleError(res, error, 'Failed to load SymbolCustom optimizer run');
  }
};

exports.removeOptimizerRun = async (req, res) => {
  try {
    const optimizerRun = await symbolCustomOptimizerService.deleteOptimizerRun(req.params.runId);
    if (!optimizerRun) {
      return res.status(404).json({ success: false, message: 'SymbolCustom optimizer run not found' });
    }
    return res.json({ success: true, optimizerRun });
  } catch (error) {
    return handleError(res, error, 'Failed to delete SymbolCustom optimizer run');
  }
};

exports.listBacktests = async (req, res) => {
  try {
    const backtests = await symbolCustomBacktestService.listSymbolCustomBacktests(req.query || {});
    return res.json({
      success: true,
      count: backtests.length,
      backtests,
    });
  } catch (error) {
    return handleError(res, error, 'Failed to list SymbolCustom backtests');
  }
};

exports.getBacktestById = async (req, res) => {
  try {
    const backtest = await symbolCustomBacktestService.getSymbolCustomBacktest(req.params.backtestId);
    if (!backtest) {
      return res.status(404).json({ success: false, message: 'SymbolCustom backtest not found' });
    }
    return res.json({ success: true, backtest });
  } catch (error) {
    return handleError(res, error, 'Failed to load SymbolCustom backtest');
  }
};

exports.removeBacktest = async (req, res) => {
  try {
    const backtest = await symbolCustomBacktestService.deleteSymbolCustomBacktest(req.params.backtestId);
    if (!backtest) {
      return res.status(404).json({ success: false, message: 'SymbolCustom backtest not found' });
    }
    return res.json({ success: true, backtest });
  } catch (error) {
    return handleError(res, error, 'Failed to delete SymbolCustom backtest');
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
