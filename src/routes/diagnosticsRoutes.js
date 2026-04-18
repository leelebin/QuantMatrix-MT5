const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { getAudits, getStats, getConstants } = require('../controllers/diagnosticsController');

router.use(protect);

router.get('/audits', getAudits);
router.get('/stats', getStats);
router.get('/constants', getConstants);

module.exports = router;
