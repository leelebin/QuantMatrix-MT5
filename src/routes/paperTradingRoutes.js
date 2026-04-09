const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  startPaperTrading,
  stopPaperTrading,
  getStatus,
  getPositions,
  closePosition,
  getTradeLog,
  getStats,
  generateReport,
} = require('../controllers/paperTradingController');

router.use(protect);

router.post('/start', startPaperTrading);
router.post('/stop', stopPaperTrading);
router.get('/status', getStatus);
router.get('/positions', getPositions);
router.post('/positions/:id/close', closePosition);
router.get('/trade-log', getTradeLog);
router.get('/stats', getStats);
router.post('/report', generateReport);

module.exports = router;
