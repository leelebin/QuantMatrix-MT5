const dataSyncSchedulerService = require('../services/dataSyncSchedulerService');

const VALID_REASONS = new Set(['daily_settlement', 'manual']);

function normalizeReason(value) {
  const reason = value || 'manual';
  if (!VALID_REASONS.has(reason)) {
    const error = new Error('reason must be daily_settlement or manual');
    error.statusCode = 400;
    throw error;
  }
  return reason;
}

exports.runDataSync = async (req, res) => {
  try {
    const result = await dataSyncSchedulerService.runNow({
      reason: normalizeReason(req.body?.reason),
      force: req.body?.force === true,
      notify: req.body?.notify !== false,
      trigger: 'api',
    });

    const statusCode = result.error && result.error.code === 'RUN_IN_PROGRESS' ? 409 : 200;
    res.status(statusCode).json({
      success: result.success,
      message: result.success ? 'Data sync completed' : 'Data sync failed',
      data: result,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error('[DataSync] API run error:', error.message);
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to run data sync',
    });
  }
};

exports.getStatus = (req, res) => {
  res.json({
    success: true,
    data: dataSyncSchedulerService.getStatus(),
  });
};
