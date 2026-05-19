jest.mock('../src/services/notificationService', () => ({
  enabled: false,
}));

jest.mock('../src/services/notificationHubService', () => ({
  isTelegramConfigured: jest.fn(),
  enqueueTelegram: jest.fn(),
  getStatus: jest.fn(),
  listRecentDeliveries: jest.fn(),
  retryFailed: jest.fn(),
  _internals: {
    sanitizeHtml: jest.fn((value) => String(value).replace(/</g, '&lt;').replace(/>/g, '&gt;')),
    validateCustomMessage: jest.fn((value) => {
      if (!value) {
        const error = new Error('Message is required');
        error.statusCode = 400;
        throw error;
      }
      return String(value);
    }),
  },
}));

jest.mock('../src/services/tradeNotificationService', () => ({
  getMergeWindowMs: jest.fn(() => 10000),
}));

jest.mock('../src/services/runtimeHeartbeatService', () => ({
  getStatus: jest.fn(() => ({
    enabled: true,
    running: true,
    lastHeartbeatAt: '2026-05-19T00:00:00.000Z',
    activeAlerts: [],
  })),
  sendTestHeartbeat: jest.fn(),
}));

const notificationHubService = require('../src/services/notificationHubService');
const notificationController = require('../src/controllers/notificationController');

function createRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    },
  };
}

describe('notificationController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('custom send returns error when Telegram is not configured', async () => {
    notificationHubService.isTelegramConfigured.mockReturnValue(false);

    const res = createRes();
    await notificationController.sendNotification({
      body: { message: 'hello' },
    }, res);

    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual(expect.objectContaining({
      success: false,
      message: expect.stringContaining('Telegram not configured'),
    }));
    expect(notificationHubService.enqueueTelegram).not.toHaveBeenCalled();
  });

  test('custom send sanitizes and enqueues configured Telegram messages', async () => {
    notificationHubService.isTelegramConfigured.mockReturnValue(true);
    notificationHubService.enqueueTelegram.mockResolvedValue({ queued: 1, skipped: 0 });

    const res = createRes();
    await notificationController.sendNotification({
      body: { message: '<b>hello</b>' },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(notificationHubService.enqueueTelegram).toHaveBeenCalledWith(expect.objectContaining({
      type: 'custom',
      scope: 'manual',
      message: '&lt;b&gt;hello&lt;/b&gt;',
      immediate: true,
    }));
  });
});
