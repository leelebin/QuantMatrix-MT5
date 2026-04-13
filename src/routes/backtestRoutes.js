const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  runBacktest,
  runBatchBacktest,
  getBatchJobs,
  getBatchJob,
  getBatchJobResults,
  getBatchJobReport,
  getBatchJobChildResult,
  getResults,
  getResult,
  deleteResult,
} = require('../controllers/backtestController');

router.use(protect);

router.post('/run', runBacktest);
router.post('/batch/run', runBatchBacktest);
router.get('/batch/jobs', getBatchJobs);
router.get('/batch/jobs/:id', getBatchJob);
router.get('/batch/jobs/:id/results', getBatchJobResults);
router.get('/batch/jobs/:id/report', getBatchJobReport);
router.get('/batch/jobs/:id/child/:backtestId', getBatchJobChildResult);
router.get('/results', getResults);
router.get('/results/:id', getResult);
router.delete('/results/:id', deleteResult);

module.exports = router;
