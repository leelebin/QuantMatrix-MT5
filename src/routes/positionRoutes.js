const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  getPositions,
  getPosition,
  closePosition,
  getTrades,
  getTradeStats,
} = require('../controllers/positionController');

router.use(protect);

router.get('/', getPositions);
router.get('/:id', getPosition);
router.post('/:id/close', closePosition);

module.exports = router;
