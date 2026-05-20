jest.mock('../src/services/notificationService', () => ({
  enabled: true,
  getStatus: jest.fn(() => ({ telegramConfigured: true })),
  sendTelegramRaw: jest.fn(() => Promise.resolve({ ok: true, result: { message_id: 101 } })),
  sendTelegram: jest.fn(() => Promise.resolve({ ok: true, result: { message_id: 101 } })),
}));

const notificationService = require('../src/services/notificationService');
const notificationHubService = require('../src/services/notificationHubService');
const NotificationDelivery = require('../src/models/NotificationDelivery');

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
    jest.useRealTimers();
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

  test('non-429 retry waits for backoff instead of consuming max attempts in same drain', async () => {
    jest.useFakeTimers();
    notificationService.sendTelegramRaw
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValueOnce({ ok: true, result: { message_id: 202 } });

    await notificationHubService.enqueueTelegram({
      type: 'test',
      scope: 'system',
      message: 'retry me',
      immediate: true,
    });

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(1);
    let deliveries = await notificationHubService.listRecentDeliveries({ limit: 1 });
    expect(deliveries[0]).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'temporary outage',
    });
    expect(new Date(deliveries[0].nextAttemptAt).getTime()).toBeGreaterThan(Date.now());

    await jest.advanceTimersByTimeAsync(1000);

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(2);
    deliveries = await notificationHubService.listRecentDeliveries({ limit: 1 });
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

  test('findNextPending only returns due deliveries and exposes the next future pending', async () => {
    const now = new Date();
    const futureAt = new Date(now.getTime() + 60000);
    const dueAt = new Date(now.getTime() - 1000);

    await NotificationDelivery.create({
      type: 'future',
      scope: 'system',
      priority: 99,
      message: 'future pending',
      nextAttemptAt: futureAt,
    });
    await NotificationDelivery.create({
      type: 'due',
      scope: 'system',
      priority: 1,
      message: 'due pending',
      nextAttemptAt: dueAt,
    });

    const due = await NotificationDelivery.findNextPending(now);
    const future = await NotificationDelivery.findNextFuturePending(now);

    expect(due.message).toBe('due pending');
    expect(future.message).toBe('future pending');
  });

  test('start drains an existing pending delivery after startup', async () => {
    jest.useFakeTimers();
    await NotificationDelivery.create({
      type: 'startup',
      scope: 'system',
      message: 'boot pending',
    });

    await notificationHubService.start();
    await jest.advanceTimersByTimeAsync(0);

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledWith('boot pending');
    const deliveries = await notificationHubService.listRecentDeliveries({ type: 'startup', limit: 1 });
    expect(deliveries[0]).toMatchObject({
      status: 'SENT',
      attempts: 1,
    });
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
    let deliveries = await notificationHubService.listRecentDeliveries({ type: 'rate_limit', limit: 1 });
    expect(deliveries[0]).toMatchObject({
      status: 'PENDING',
      attempts: 1,
    });
    expect(new Date(deliveries[0].nextAttemptAt).getTime()).toBeGreaterThan(Date.now());

    await jest.advanceTimersByTimeAsync(2000);

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(2);
    status = await notificationHubService.getStatus();
    expect(status.queueLength).toBe(0);
    jest.useRealTimers();
  });

  test('records FAILED after max attempts', async () => {
    jest.useFakeTimers();
    notificationService.sendTelegramRaw.mockRejectedValue(new Error('permanent failure'));

    await notificationHubService.enqueueTelegram({
      type: 'fail',
      scope: 'system',
      message: 'will fail',
      immediate: true,
    });

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(2000);
    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(3);
    const deliveries = await notificationHubService.listRecentDeliveries({ type: 'fail', limit: 1 });
    expect(deliveries[0]).toMatchObject({
      status: 'FAILED',
      attempts: 3,
      lastError: 'permanent failure',
    });
  });
});
