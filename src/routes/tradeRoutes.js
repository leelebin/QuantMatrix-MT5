const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { getTrades, getTradeStats } = require('../controllers/positionController');

router.use(protect);

router.get('/', getTrades);
router.get('/stats', getTradeStats);

module.exports = router;
