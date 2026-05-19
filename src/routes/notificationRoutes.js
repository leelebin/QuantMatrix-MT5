const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  testNotification,
  sendNotification,
  getStatus,
  listDeliveries,
  retryFailed,
  getHeartbeatStatus,
  sendTestHeartbeat,
} = require('../controllers/notificationController');

router.use(protect);

router.post('/test', testNotification);
router.post('/send', sendNotification);
router.get('/status', getStatus);
router.get('/deliveries', listDeliveries);
router.post('/retry-failed', retryFailed);
router.get('/heartbeat/status', getHeartbeatStatus);
router.post('/heartbeat/test', sendTestHeartbeat);

module.exports = router;
