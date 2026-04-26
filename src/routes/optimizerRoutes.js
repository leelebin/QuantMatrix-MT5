const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  runOptimizer,
  stopOptimizer,
  getProgress,
  getResult,
  getFullResult,
  getDefaultRanges,
  getLatestBestResult,
  getHistory,
  getHistoryDetail,
} = require('../controllers/optimizerController');

router.use(protect);

router.post('/run', runOptimizer);
router.post('/stop', stopOptimizer);
router.get('/progress', getProgress);
router.get('/result', getResult);
router.get('/result/full', getFullResult);
router.get('/latest', getLatestBestResult);
router.get('/history', getHistory);
router.get('/history/:id', getHistoryDetail);
router.get('/ranges/:strategyType', getDefaultRanges);

module.exports = router;
