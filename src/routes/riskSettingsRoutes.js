const express = require('express');
const { protect } = require('../middleware/auth');
const {
  getRiskSettings,
  createRiskProfile,
  updateRiskProfile,
  deleteRiskProfile,
  activateRiskProfile,
} = require('../controllers/riskSettingsController');

const router = express.Router();

router.use(protect);

router.get('/', getRiskSettings);
router.post('/profiles', createRiskProfile);
router.put('/profiles/:id', updateRiskProfile);
router.delete('/profiles/:id', deleteRiskProfile);
router.post('/profiles/:id/activate', activateRiskProfile);

module.exports = router;
