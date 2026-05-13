const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  getBreakevenAnalysisReport,
  getPlaybookRecommendations,
  getSymbolPlaybookReport,
  getSymbolPlaybooks,
} = require('../controllers/symbolPlaybookController');

router.use(protect);

router.get('/be-report', getBreakevenAnalysisReport);
router.get('/recommendations', getPlaybookRecommendations);
router.get('/report', getSymbolPlaybookReport);
router.get('/', getSymbolPlaybooks);

module.exports = router;
