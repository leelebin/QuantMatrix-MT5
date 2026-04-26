const cacheMaintenanceService = require('../services/cacheMaintenanceService');

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
