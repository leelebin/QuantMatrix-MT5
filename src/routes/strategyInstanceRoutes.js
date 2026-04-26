const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  getStrategyInstances,
  getParametersLibrary,
  getStrategyInstancesByStrategyName,
  getStrategyInstanceByKey,
  upsertStrategyInstance,
} = require('../controllers/strategyInstanceController');

router.use(protect);

router.get('/', getStrategyInstances);
router.get('/library/parameters', getParametersLibrary);
router.get('/:strategyName', getStrategyInstancesByStrategyName);
router.get('/:strategyName/:symbol', getStrategyInstanceByKey);
router.put('/:strategyName/:symbol', upsertStrategyInstance);

module.exports = router;
