const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  getStrategies,
  getAssignments,
  getStrategy,
  updateStrategy,
  updateAssignments,
  toggleStrategy,
  getSignals,
} = require('../controllers/strategyController');

router.use(protect);

router.get('/', getStrategies);
router.get('/assignments', getAssignments);
router.put('/assignments', updateAssignments);
router.get('/:id', getStrategy);
router.put('/:id', updateStrategy);
router.put('/:id/toggle', toggleStrategy);
router.get('/:id/signals', getSignals);

module.exports = router;
