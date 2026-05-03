const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  getStrategies,
  getAssignments,
  getStrategy,
  updateStrategy,
  updateAssignments,
  resetAssignments,
  toggleStrategy,
  getPaperAssignments,
  updatePaperAssignments,
  resetPaperAssignments,
  togglePaperStrategy,
  getSignals,
} = require('../controllers/strategyController');

router.use(protect);

// ─── Live trading ─────────────────────────────────────────────────────────────
router.get('/', getStrategies);
router.get('/assignments', getAssignments);
router.put('/assignments', updateAssignments);
router.post('/assignments/reset', resetAssignments);

// ─── Paper trading ────────────────────────────────────────────────────────────
// These endpoints read/write paperEnabled and paperSymbols only.
// Live `enabled` and `symbols` fields are never touched by these routes.
router.get('/paper-assignments', getPaperAssignments);
router.put('/paper-assignments', updatePaperAssignments);
router.post('/paper-assignments/reset', resetPaperAssignments);

// ─── Individual strategy ──────────────────────────────────────────────────────
router.get('/:id', getStrategy);
router.put('/:id', updateStrategy);
router.put('/:id/toggle', toggleStrategy);
router.put('/:id/paper-toggle', togglePaperStrategy);
router.get('/:id/signals', getSignals);

module.exports = router;
