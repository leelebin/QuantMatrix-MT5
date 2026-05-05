const cacheMaintenanceService = require('../services/cacheMaintenanceService');
const databaseMaintenanceService = require('../services/databaseMaintenanceService');
const resourceMonitorService = require('../services/resourceMonitorService');
const weeklyReviewExportService = require('../services/weeklyReviewExportService');

function getScope(source) {
  return source && source.scope ? source.scope : 'safe';
}

exports.getCacheStatus = async (req, res) => {
  try {
    const scope = getScope(req.query);
    const data = await cacheMaintenanceService.getCacheStatus(scope);
    res.json({
      success: true,
      message: `Loaded ${data.scope} cache status`,
      data,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error('[Maintenance] getCacheStatus error:', error.message);
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to load cache status',
    });
  }
};

exports.clearCache = async (req, res) => {
  try {
    const scope = getScope(req.body);
    const data = await cacheMaintenanceService.clearCache(scope);
    res.json({
      success: true,
      message: data.message,
      data,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error('[Maintenance] clearCache error:', error.message);
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to clear cache',
    });
  }
};

exports.getResourceStatus = async (req, res) => {
  try {
    const data = resourceMonitorService.getResourceStatus({
      topFilesLimit: req.query?.topFilesLimit,
    });
    res.json({
      success: true,
      message: 'Loaded resource status',
      data,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error('[Maintenance] getResourceStatus error:', error.message);
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to load resource status',
    });
  }
};

exports.getDatabaseStatus = async (req, res) => {
  try {
    const data = await databaseMaintenanceService.getDatabaseStatus();
    res.json({
      success: true,
      message: 'Loaded database status',
      data,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error('[Maintenance] getDatabaseStatus error:', error.message);
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to load database status',
    });
  }
};

exports.compactDatabases = async (req, res) => {
  try {
    const data = await databaseMaintenanceService.compactDatabases({
      targets: req.body?.targets,
      databases: req.body?.databases,
      timeoutMs: req.body?.timeoutMs,
    });
    res.json({
      success: true,
      message: 'Compacted databases',
      data,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error('[Maintenance] compactDatabases error:', error.message);
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to compact databases',
    });
  }
};

exports.cleanupOldRecords = async (req, res) => {
  try {
    const data = await databaseMaintenanceService.cleanupOldRecords({
      targets: req.body?.targets,
      dryRun: req.body?.dryRun,
      retentionDays: req.body?.retentionDays,
      retentionDaysByTarget: req.body?.retentionDaysByTarget,
    });
    res.json({
      success: true,
      message: data.dryRun ? 'Previewed old record cleanup' : 'Cleaned old records',
      data,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error('[Maintenance] cleanupOldRecords error:', error.message);
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to clean old records',
    });
  }
};

exports.exportWeeklyTradeReviews = async (req, res) => {
  try {
    const data = await weeklyReviewExportService.exportWeeklyTradeReviews({
      scope: req.body?.scope,
      rebuild: req.body?.rebuild,
    });
    res.json({
      success: true,
      message: 'Exported weekly trade review files',
      data,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error('[Maintenance] exportWeeklyTradeReviews error:', error.message);
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to export weekly trade review files',
    });
  }
};
