jest.mock('../src/services/notificationService', () => ({
  enabled: true,
  getStatus: jest.fn(() => ({ telegramConfigured: true })),
  sendTelegramRaw: jest.fn(() => Promise.resolve({ ok: true, result: { message_id: 101 } })),
  sendTelegram: jest.fn(() => Promise.resolve({ ok: true, result: { message_id: 101 } })),
}));

const notificationService = require('../src/services/notificationService');
const notificationHubService = require('../src/services/notificationHubService');

describe('notificationHubService', () => {
  beforeEach(async () => {
    process.env.NOTIFICATION_SEND_INTERVAL_MS = '0';
    notificationService.enabled = true;
    notificationService.getStatus.mockReturnValue({ telegramConfigured: true });
    notificationService.sendTelegramRaw.mockReset();
    notificationService.sendTelegramRaw.mockResolvedValue({ ok: true, result: { message_id: 101 } });
    notificationHubService._resetForTests();
    await notificationHubService._clearDeliveriesForTests();
  });

  afterEach(() => {
    notificationHubService._resetForTests();
    delete process.env.NOTIFICATION_SEND_INTERVAL_MS;
  });

  test('queues messages until flushed', async () => {
    const result = await notificationHubService.enqueueTelegram({
      type: 'test',
      scope: 'system',
      title: 'Queued',
      message: 'hello',
    });

    expect(result.queued).toBe(1);
    expect(notificationService.sendTelegramRaw).not.toHaveBeenCalled();

    await notificationHubService.flushPending();

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledWith('hello');
    const status = await notificationHubService.getStatus();
    expect(status.queueLength).toBe(0);
    expect(status.recentSent).toBe(1);
  });

  test('retries failed Telegram sends and records SENT', async () => {
    notificationService.sendTelegramRaw
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValueOnce({ ok: true, result: { message_id: 202 } });

    await notificationHubService.enqueueTelegram({
      type: 'test',
      scope: 'system',
      message: 'retry me',
      immediate: true,
    });

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(2);
    const deliveries = await notificationHubService.listRecentDeliveries({ limit: 1 });
    expect(deliveries[0]).toMatchObject({
      status: 'SENT',
      attempts: 2,
      telegramMessageId: 202,
    });
  });

  test('chunks messages longer than 3900 chars', async () => {
    const longMessage = 'x'.repeat(8000);

    await notificationHubService.enqueueTelegram({
      type: 'long',
      scope: 'system',
      message: longMessage,
    });

    const deliveries = await notificationHubService.listRecentDeliveries({ type: 'long', limit: 10 });
    expect(deliveries.length).toBeGreaterThan(1);
    expect(deliveries.every((delivery) => delivery.message.length <= 3900)).toBe(true);
  });

  test('handles 429 with backoff before retrying', async () => {
    jest.useFakeTimers();
    const rateLimitError = new Error('Telegram API error: 429');
    rateLimitError.statusCode = 429;
    rateLimitError.retryAfter = 2;
    notificationService.sendTelegramRaw
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({ ok: true, result: { message_id: 303 } });

    const enqueuePromise = notificationHubService.enqueueTelegram({
      type: 'rate_limit',
      scope: 'system',
      message: 'wait please',
      immediate: true,
    });
    await enqueuePromise;

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(1);
    let status = await notificationHubService.getStatus();
    expect(status.backoffUntil).not.toBeNull();

    await jest.advanceTimersByTimeAsync(2000);

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(2);
    status = await notificationHubService.getStatus();
    expect(status.queueLength).toBe(0);
    jest.useRealTimers();
  });

  test('records FAILED after max attempts', async () => {
    notificationService.sendTelegramRaw.mockRejectedValue(new Error('permanent failure'));

    await notificationHubService.enqueueTelegram({
      type: 'fail',
      scope: 'system',
      message: 'will fail',
      immediate: true,
    });

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(3);
    const deliveries = await notificationHubService.listRecentDeliveries({ type: 'fail', limit: 1 });
    expect(deliveries[0]).toMatchObject({
      status: 'FAILED',
      attempts: 3,
      lastError: 'permanent failure',
    });
  });
});
