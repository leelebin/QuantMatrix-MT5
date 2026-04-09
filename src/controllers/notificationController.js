const notificationService = require('../services/notificationService');

// @desc    Test Telegram notification
// @route   POST /api/notifications/test
exports.testNotification = async (req, res) => {
  try {
    if (!notificationService.enabled) {
      return res.status(400).json({
        success: false,
        message: 'Telegram not configured. Set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID in .env',
      });
    }
    await notificationService.sendTest();
    res.json({ success: true, message: 'Test notification sent' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Send custom notification
// @route   POST /api/notifications/send
exports.sendNotification = async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ success: false, message: 'Message is required' });
    }
    await notificationService.sendTelegram(message);
    res.json({ success: true, message: 'Notification sent' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get notification status
// @route   GET /api/notifications/status
exports.getStatus = (req, res) => {
  res.json({ success: true, data: notificationService.getStatus() });
};
