const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  testNotification,
  sendNotification,
  getStatus,
} = require('../controllers/notificationController');

router.use(protect);

router.post('/test', testNotification);
router.post('/send', sendNotification);
router.get('/status', getStatus);

module.exports = router;
