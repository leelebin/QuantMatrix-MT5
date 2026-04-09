const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  runOptimizer,
  getProgress,
  getResult,
  getFullResult,
  getDefaultRanges,
} = require('../controllers/optimizerController');

router.use(protect);

router.post('/run', runOptimizer);
router.get('/progress', getProgress);
router.get('/result', getResult);
router.get('/result/full', getFullResult);
router.get('/ranges/:strategyType', getDefaultRanges);

module.exports = router;
