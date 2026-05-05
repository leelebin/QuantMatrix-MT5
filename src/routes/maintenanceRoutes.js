const express = require('express');
const { protect } = require('../middleware/auth');
const {
  getCacheStatus,
  clearCache,
  getResourceStatus,
  getDatabaseStatus,
  compactDatabases,
  cleanupOldRecords,
  exportWeeklyTradeReviews,
} = require('../controllers/maintenanceController');

const router = express.Router();

router.use(protect);

router.get('/cache/status', getCacheStatus);
router.post('/cache/clear', clearCache);
router.get('/resources', getResourceStatus);
router.get('/databases', getDatabaseStatus);
router.post('/databases/compact', compactDatabases);
router.post('/databases/cleanup', cleanupOldRecords);
router.post('/history/export-weekly-trades', exportWeeklyTradeReviews);

module.exports = router;
