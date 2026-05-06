const express = require('express');
const { protect } = require('../middleware/auth');
const {
  getStatus,
  runDataSync,
} = require('../controllers/dataSyncController');

const router = express.Router();

router.use(protect);

router.get('/status', getStatus);
router.post('/run', runDataSync);

module.exports = router;
