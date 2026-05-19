const notificationService = require('../services/notificationService');
const notificationHubService = require('../services/notificationHubService');
const tradeNotificationService = require('../services/tradeNotificationService');
const runtimeHeartbeatService = require('../services/runtimeHeartbeatService');

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
    await notificationHubService.enqueueTelegram({
      type: 'test',
      scope: 'system',
      priority: 10,
      title: 'QuantMatrix test',
      message: `\u2705 <b>QuantMatrix Test</b>\n\nTelegram notifications are working!\n<b>Time:</b> ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
      immediate: true,
    });
    res.json({ success: true, message: 'Test notification queued' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Send custom notification
// @route   POST /api/notifications/send
exports.sendNotification = async (req, res) => {
  try {
    if (!notificationHubService.isTelegramConfigured()) {
      return res.status(400).json({
        success: false,
        message: 'Telegram not configured. Set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID in .env',
      });
    }

    const rawMessage = notificationHubService._internals.validateCustomMessage(req.body?.message);
    const message = notificationHubService._internals.sanitizeHtml(rawMessage);
    const delivery = await notificationHubService.enqueueTelegram({
      type: 'custom',
      scope: 'manual',
      priority: 5,
      title: 'Custom notification',
      message,
      immediate: true,
    });

    res.json({
      success: true,
      message: 'Notification queued',
      data: {
        queued: delivery.queued,
        skipped: delivery.skipped,
      },
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

// @desc    Get notification status
// @route   GET /api/notifications/status
exports.getStatus = async (req, res) => {
  try {
    const hubStatus = await notificationHubService.getStatus();
    res.json({
      success: true,
      data: {
        telegramConfigured: hubStatus.telegramConfigured,
        queueLength: hubStatus.queueLength,
        sending: hubStatus.sending,
        recentSent: hubStatus.recentSent,
        recentFailed: hubStatus.recentFailed,
        mergeWindowMs: tradeNotificationService.getMergeWindowMs(),
        heartbeat: runtimeHeartbeatService.getStatus(),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    List recent notification delivery records
// @route   GET /api/notifications/deliveries
exports.listDeliveries = async (req, res) => {
  try {
    const deliveries = await notificationHubService.listRecentDeliveries({
      status: req.query.status,
      type: req.query.type,
      scope: req.query.scope,
      limit: req.query.limit,
    });
    res.json({ success: true, data: deliveries });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Retry failed notification delivery records
// @route   POST /api/notifications/retry-failed
exports.retryFailed = async (req, res) => {
  try {
    const result = await notificationHubService.retryFailed(req.body?.limit);
    res.json({ success: true, message: 'Failed notifications requeued', data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get runtime heartbeat status
// @route   GET /api/notifications/heartbeat/status
exports.getHeartbeatStatus = async (req, res) => {
  try {
    res.json({ success: true, data: runtimeHeartbeatService.getStatus() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Send a test runtime heartbeat notification
// @route   POST /api/notifications/heartbeat/test
exports.sendTestHeartbeat = async (req, res) => {
  try {
    if (!notificationHubService.isTelegramConfigured()) {
      return res.status(400).json({
        success: false,
        message: 'Telegram not configured. Set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID in .env',
      });
    }

    const result = await runtimeHeartbeatService.sendTestHeartbeat();
    res.json({ success: true, message: 'Test heartbeat queued', data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
