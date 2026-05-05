const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  getTrades,
  getTradeStats,
  exportTradesCsv,
  reconcileTrades,
  getTradeLedger,
  getExecutionAudits,
} = require('../controllers/positionController');

router.use(protect);

router.get('/', getTrades);
router.get('/stats', getTradeStats);
router.get('/export.csv', exportTradesCsv);
router.post('/reconcile', reconcileTrades);
router.get('/ledger', getTradeLedger);
router.get('/execution-audits', getExecutionAudits);

module.exports = router;
