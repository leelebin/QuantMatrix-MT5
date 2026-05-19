jest.mock('../src/services/notificationService', () => ({
  enabled: true,
  getStatus: jest.fn(() => ({ telegramConfigured: true })),
  sendTelegramRaw: jest.fn(() => Promise.resolve({ ok: true, result: { message_id: 1 } })),
  sendTelegram: jest.fn(() => Promise.resolve({ ok: true, result: { message_id: 1 } })),
}));

const notificationService = require('../src/services/notificationService');
const notificationHubService = require('../src/services/notificationHubService');
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
  beforeEach(async () => {
    jest.useFakeTimers();
    process.env.TELEGRAM_TRADE_OPEN_MERGE_WINDOW_MS = '10000';
    process.env.NOTIFICATION_SEND_INTERVAL_MS = '0';
    notificationService.enabled = true;
    notificationService.getStatus.mockReturnValue({ telegramConfigured: true });
    notificationService.sendTelegramRaw.mockClear();
    notificationService.sendTelegram.mockClear();
    notificationHubService._resetForTests();
    await notificationHubService._clearDeliveriesForTests();
    tradeNotificationService._resetForTests();
  });

  afterEach(() => {
    tradeNotificationService._resetForTests();
    notificationHubService._resetForTests();
    jest.useRealTimers();
    delete process.env.TELEGRAM_TRADE_OPEN_MERGE_WINDOW_MS;
    delete process.env.NOTIFICATION_SEND_INTERVAL_MS;
    delete process.env.TELEGRAM_TRADE_OPEN_IMMEDIATE;
  });

  test('paper open only sends PAPER OPEN after merge window', async () => {
    await tradeNotificationService.notifyTradeOpened(openEvent());

    expect(notificationService.sendTelegramRaw).not.toHaveBeenCalled();
    await advanceMergeWindow();

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(1);
    const message = notificationService.sendTelegramRaw.mock.calls[0][0];
    expect(message).toContain('[PAPER OPEN]');
    expect(message).toContain('EURUSD BUY | Momentum | 1h');
    expect(message).toContain('Entry 1.0842 | SL 1.0818 | TP 1.0914 | Vol 0.03');
    expect(message).toContain('Risk 0.25% | Q 3/3');
    expect(message).toContain('Reason: momentum confirmed');
  });

  test('immediate paper open sends PAPER OPEN without waiting for merge window', async () => {
    await expect(
      tradeNotificationService.notifyTradeOpened(openEvent(), { immediate: true })
    ).resolves.toEqual(expect.objectContaining({
      queued: true,
      sent: true,
      immediate: true,
      message: expect.stringContaining('[PAPER OPEN]'),
    }));

    expect(notificationService.sendTelegram).not.toHaveBeenCalled();
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

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(1);
    const message = notificationService.sendTelegramRaw.mock.calls[0][0];
    expect(message).toContain('[LIVE/PAPER OPEN]');
    expect(message).toContain('Entry 1.08421');
    expect(message).toContain('Vol 0.04');
  });

  test('same symbol strategy and side with different timeframe does not merge', async () => {
    await tradeNotificationService.notifyTradeOpened(openEvent({ timeframe: '15m' }));
    await tradeNotificationService.notifyTradeOpened(openEvent({
      scope: 'live',
      timeframe: '1h',
      timestamp: '2026-05-06T10:00:05.000Z',
    }));

    await advanceMergeWindow();

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(2);
    const messages = notificationService.sendTelegramRaw.mock.calls.map((call) => call[0]).join('\n---\n');
    expect(messages).toContain('EURUSD BUY | Momentum | 15m');
    expect(messages).toContain('EURUSD BUY | Momentum | 1h');
  });

  test('live open only sends LIVE OPEN', async () => {
    await tradeNotificationService.notifyTradeOpened(openEvent({ scope: 'live' }));

    await advanceMergeWindow();

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(1);
    expect(notificationService.sendTelegramRaw.mock.calls[0][0]).toContain('[LIVE OPEN]');
  });

  test('different symbols do not merge', async () => {
    await tradeNotificationService.notifyTradeOpened(openEvent({ symbol: 'EURUSD' }));
    await tradeNotificationService.notifyTradeOpened(openEvent({ scope: 'live', symbol: 'XAUUSD' }));

    await advanceMergeWindow();

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(2);
    const messages = notificationService.sendTelegramRaw.mock.calls.map((call) => call[0]).join('\n---\n');
    expect(messages).toContain('EURUSD BUY');
    expect(messages).toContain('XAUUSD BUY');
  });

  test('different sides do not merge', async () => {
    await tradeNotificationService.notifyTradeOpened(openEvent({ side: 'BUY' }));
    await tradeNotificationService.notifyTradeOpened(openEvent({ scope: 'live', side: 'SELL' }));

    await advanceMergeWindow();

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(2);
    const messages = notificationService.sendTelegramRaw.mock.calls.map((call) => call[0]).join('\n---\n');
    expect(messages).toContain('EURUSD BUY');
    expect(messages).toContain('EURUSD SELL');
  });

  test('immediate=false respects TELEGRAM_TRADE_OPEN_MERGE_WINDOW_MS', async () => {
    process.env.TELEGRAM_TRADE_OPEN_IMMEDIATE = 'false';

    await tradeNotificationService.notifyTradeOpened(openEvent({ immediate: true }));

    expect(notificationService.sendTelegramRaw).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(9999);
    expect(notificationService.sendTelegramRaw).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(1);
  });

  test('symbolCustom paper open includes custom metadata', async () => {
    await tradeNotificationService.notifyTradeOpened(openEvent({
      source: 'symbolCustom',
      symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      logicName: 'JPY_MACRO_REVERSAL',
      candidatePreset: 'trial-ready',
    }));

    await advanceMergeWindow();

    const message = notificationService.sendTelegramRaw.mock.calls[0][0];
    expect(message).toContain('[SYMBOLCUSTOM PAPER OPEN]');
    expect(message).toContain('SymbolCustom USDJPY_JPY_MACRO_REVERSAL_V1');
    expect(message).toContain('Preset trial-ready');
  });

  test('close notification includes P/L and exitReason', async () => {
    await tradeNotificationService.notifyTradeClosed({
      scope: 'paper',
      symbol: 'EURUSD',
      type: 'BUY',
      entryPrice: 1.08,
      exitPrice: 1.09,
      profitLoss: 12.34,
      profitPips: 100,
      realizedRMultiple: 1.5,
      exitReason: 'TP_HIT',
      holdingTime: '2h 10m',
      strategy: 'Momentum',
    });

    const message = notificationService.sendTelegramRaw.mock.calls[0][0];
    expect(message).toContain('[PAPER CLOSE]');
    expect(message).toContain('P/L +12.34');
    expect(message).toContain('Pips +100');
    expect(message).toContain('R +1.5');
    expect(message).toContain('Reason TP_HIT');
  });

  test('data sync success sends compact DATA SYNC notification', async () => {
    await tradeNotificationService.notifyDataSyncResult({
      success: true,
      fileCount: 128,
      totalBytes: 25800000,
      remotePath: 'quantmatrix-drive:QuantMatrix/backups/2026-05-06/',
    });

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(1);
    const message = notificationService.sendTelegramRaw.mock.calls[0][0];
    expect(message).toContain('[DATA SYNC');
    expect(message).toContain('Files 128 | Size 24.6 MB');
    expect(message).toContain('Remote: QuantMatrix/backups/2026-05-06');
  });

  test('data sync failure sends compact DATA SYNC failed notification', async () => {
    await tradeNotificationService.notifyDataSyncResult({
      success: false,
      error: { code: 'RCLONE_VERSION_FAILED' },
    });

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(1);
    const message = notificationService.sendTelegramRaw.mock.calls[0][0];
    expect(message).toContain('[DATA SYNC');
    expect(message).toContain('Error: UPLOAD_FAILED');
  });

  test('data sync disabled sends warning notification instead of failure', async () => {
    await tradeNotificationService.notifyDataSyncResult({
      success: true,
      uploadSkipped: true,
      skipReason: 'DATA_SYNC_DISABLED',
      fileCount: 49,
      totalBytes: 503633083,
    });

    expect(notificationService.sendTelegramRaw).toHaveBeenCalledTimes(1);
    const message = notificationService.sendTelegramRaw.mock.calls[0][0];
    expect(message).toContain('[DATA SYNC');
    expect(message).toContain('Local snapshot created');
    expect(message).toContain('Cloud upload: disabled');
    expect(message).toContain('Files 49 | Size');
    expect(message).not.toContain('Error: DATA_SYNC_DISABLED');
  });

  test('Telegram disabled does not throw', async () => {
    notificationService.enabled = false;
    notificationService.getStatus.mockReturnValue({ telegramConfigured: false });

    await expect(tradeNotificationService.notifyTradeOpened(openEvent())).resolves.toEqual(expect.objectContaining({
      queued: true,
    }));
    await expect(advanceMergeWindow()).resolves.toBeUndefined();
    await expect(tradeNotificationService.notifyDataSyncResult({ success: true })).resolves.toEqual(expect.objectContaining({
      sent: false,
    }));

    expect(notificationService.sendTelegramRaw).not.toHaveBeenCalled();
  });
});
