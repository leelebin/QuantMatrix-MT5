const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  list,
  getById,
  getBySymbol,
  create,
  ensureDefaults,
  report,
  safetyAudit,
  paperRuntimeStatus,
  scanPaperRuntimeOnce,
  runBacktest,
  analyzePaperOnce,
  createOptimizerRun,
  listOptimizerRuns,
  getOptimizerRunById,
  removeOptimizerRun,
  listBacktests,
  getBacktestById,
  evaluateBacktest,
  removeBacktest,
  update,
  remove,
  duplicate,
} = require('../controllers/symbolCustomController');

router.use(protect);

router.get('/', list);
router.get('/by-symbol/:symbol', getBySymbol);
router.get('/report', report);
router.get('/safety-audit', safetyAudit);
router.get('/paper-runtime/status', paperRuntimeStatus);
router.get('/optimizer/runs', listOptimizerRuns);
router.get('/optimizer/runs/:runId', getOptimizerRunById);
router.get('/backtests', listBacktests);
router.get('/backtests/:backtestId/evaluation', evaluateBacktest);
router.get('/backtests/:backtestId', getBacktestById);
router.post('/', create);
router.post('/defaults/ensure', ensureDefaults);
router.post('/paper-runtime/scan-once', scanPaperRuntimeOnce);
router.post('/backtests/:backtestId/evaluate', evaluateBacktest);
router.post('/:id/analyze-paper-once', analyzePaperOnce);
router.post('/:id/backtest', runBacktest);
router.post('/:id/optimizer/run', createOptimizerRun);
router.delete('/optimizer/runs/:runId', removeOptimizerRun);
router.delete('/backtests/:backtestId', removeBacktest);
router.get('/:id', getById);
router.put('/:id', update);
router.delete('/:id', remove);
router.post('/:id/duplicate', duplicate);

module.exports = router;
