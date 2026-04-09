const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  startTrading,
  stopTrading,
  getStatus,
  getAccount,
  testOrder,
} = require('../controllers/tradingController');

router.use(protect);

router.post('/start', startTrading);
router.post('/stop', stopTrading);
router.get('/status', getStatus);
router.get('/account', getAccount);
router.post('/test-order', testOrder);

module.exports = router;
