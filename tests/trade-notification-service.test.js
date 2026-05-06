jest.mock('../src/services/notificationService', () => ({
  enabled: true,
  sendTelegram: jest.fn(() => Promise.resolve({ ok: true })),
}));

const notificationService = require('../src/services/notificationService');
const tradeNotificationService = require('../src/services/tradeNotificationService');

const baseOpenedAt = '2026-05-06T10:00:00.000Z';

function openEvent(overrides = {}) {
  return {
    scope: 'paper',
    symbol: 'EURUSD',
    side: 'BUY',
    strategy: 'Momentum',
    timeframe: '1h',
    entryPrice: 1.0842,
    stopLoss: 1.0818,
    takeProfit: 1.0914,
    volume: 0.03,
    riskPercent: 0.25,
    quality: '3/3',
    reason: 'momentum confirmed with extra debug fields ignored',
    timestamp: baseOpenedAt,
    ...overrides,
  };
}

async function advanceMergeWindow() {
  await jest.advanceTimersByTimeAsync(10000);
}

describe('tradeNotificationService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    process.env.TELEGRAM_TRADE_OPEN_MERGE_WINDOW_MS = '10000';
    notificationService.enabled = true;
    notificationService.sendTelegram.mockClear();
    tradeNotificationService._resetForTests();
  });

  afterEach(() => {
    tradeNotificationService._resetForTests();
    jest.useRealTimers();
    delete process.env.TELEGRAM_TRADE_OPEN_MERGE_WINDOW_MS;
  });

  test('paper open only sends PAPER OPEN after merge window', async () => {
    await tradeNotificationService.notifyTradeOpened(openEvent());

    expect(notificationService.sendTelegram).not.toHaveBeenCalled();
    await advanceMergeWindow();

    expect(notificationService.sendTelegram).toHaveBeenCalledTimes(1);
    const message = notificationService.sendTelegram.mock.calls[0][0];
    expect(message).toContain('[PAPER OPEN]');
    expect(message).toContain('EURUSD BUY | Momentum | 1h');
    expect(message).toContain('Entry 1.0842 | SL 1.0818 | TP 1.0914');
    expect(message).toContain('Vol 0.03 | Risk 0.25% | Q 3/3');
    expect(message).toContain('Reason: momentum confirmed');
  });

  test('paper and live open with same key merge into one LIVE/PAPER OPEN', async () => {
    await tradeNotificationService.notifyTradeOpened(openEvent({ scope: 'paper' }));
    await tradeNotificationService.notifyTradeOpened(openEvent({
      scope: 'live',
      entryPrice: 1.08421,
      volume: 0.04,
      timestamp: '2026-05-06T10:00:05.000Z',
    }));

    await advanceMergeWindow();

    expect(notificationService.sendTelegram).toHaveBeenCalledTimes(1);
    const message = notificationService.sendTelegram.mock.calls[0][0];
    expect(message).toContain('[LIVE/PAPER OPEN]');
    expect(message).toContain('Entry 1.08421');
    expect(message).toContain('Vol 0.04');
  });

  test('live open only sends LIVE OPEN', async () => {
    await tradeNotificationService.notifyTradeOpened(openEvent({ scope: 'live' }));

    await advanceMergeWindow();

    expect(notificationService.sendTelegram).toHaveBeenCalledTimes(1);
    expect(notificationService.sendTelegram.mock.calls[0][0]).toContain('[LIVE OPEN]');
  });

  test('different symbols do not merge', async () => {
    await tradeNotificationService.notifyTradeOpened(openEvent({ symbol: 'EURUSD' }));
    await tradeNotificationService.notifyTradeOpened(openEvent({ scope: 'live', symbol: 'XAUUSD' }));

    await advanceMergeWindow();

    expect(notificationService.sendTelegram).toHaveBeenCalledTimes(2);
    const messages = notificationService.sendTelegram.mock.calls.map((call) => call[0]).join('\n---\n');
    expect(messages).toContain('EURUSD BUY');
    expect(messages).toContain('XAUUSD BUY');
  });

  test('different sides do not merge', async () => {
    await tradeNotificationService.notifyTradeOpened(openEvent({ side: 'BUY' }));
    await tradeNotificationService.notifyTradeOpened(openEvent({ scope: 'live', side: 'SELL' }));

    await advanceMergeWindow();

    expect(notificationService.sendTelegram).toHaveBeenCalledTimes(2);
    const messages = notificationService.sendTelegram.mock.calls.map((call) => call[0]).join('\n---\n');
    expect(messages).toContain('EURUSD BUY');
    expect(messages).toContain('EURUSD SELL');
  });

  test('data sync success sends compact DATA SYNC notification', async () => {
    await tradeNotificationService.notifyDataSyncResult({
      success: true,
      fileCount: 128,
      totalBytes: 25800000,
      remotePath: 'quantmatrix-drive:QuantMatrix/backups/2026-05-06/',
    });

    expect(notificationService.sendTelegram).toHaveBeenCalledTimes(1);
    const message = notificationService.sendTelegram.mock.calls[0][0];
    expect(message).toContain('[DATA SYNC');
    expect(message).toContain('Files 128 | Size 24.6 MB');
    expect(message).toContain('Remote: QuantMatrix/backups/2026-05-06');
  });

  test('data sync failure sends compact DATA SYNC failed notification', async () => {
    await tradeNotificationService.notifyDataSyncResult({
      success: false,
      error: { code: 'RCLONE_VERSION_FAILED' },
    });

    expect(notificationService.sendTelegram).toHaveBeenCalledTimes(1);
    const message = notificationService.sendTelegram.mock.calls[0][0];
    expect(message).toContain('[DATA SYNC');
    expect(message).toContain('Error: UPLOAD_FAILED');
  });

  test('Telegram disabled does not throw', async () => {
    notificationService.enabled = false;

    await expect(tradeNotificationService.notifyTradeOpened(openEvent())).resolves.toEqual(expect.objectContaining({
      queued: true,
    }));
    await expect(advanceMergeWindow()).resolves.toBeUndefined();
    await expect(tradeNotificationService.notifyDataSyncResult({ success: true })).resolves.toEqual(expect.objectContaining({
      sent: false,
    }));

    expect(notificationService.sendTelegram).not.toHaveBeenCalled();
  });
});
