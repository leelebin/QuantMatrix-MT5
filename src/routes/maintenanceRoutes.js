const express = require('express');
const { protect } = require('../middleware/auth');
const { getCacheStatus, clearCache } = require('../controllers/maintenanceController');

const router = express.Router();

router.use(protect);

router.get('/cache/status', getCacheStatus);
router.post('/cache/clear', clearCache);

module.exports = router;
