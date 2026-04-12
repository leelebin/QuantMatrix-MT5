const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { getTrades, getTradeStats, reconcileTrades, getExecutionAudits } = require('../controllers/positionController');

router.use(protect);

router.get('/', getTrades);
router.get('/stats', getTradeStats);
router.post('/reconcile', reconcileTrades);
router.get('/execution-audits', getExecutionAudits);

module.exports = router;
