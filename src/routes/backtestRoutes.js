const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  runBacktest,
  getResults,
  getResult,
  deleteResult,
} = require('../controllers/backtestController');

router.use(protect);

router.post('/run', runBacktest);
router.get('/results', getResults);
router.get('/results/:id', getResult);
router.delete('/results/:id', deleteResult);

module.exports = router;
