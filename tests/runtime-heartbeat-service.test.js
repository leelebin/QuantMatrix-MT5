jest.mock('../src/services/notificationHubService', () => ({
  enqueueTelegram: jest.fn(() => Promise.resolve({ queued: 1, skipped: 0 })),
  _internals: {
    escapeHtml: jest.fn((value) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')),
  },
}));

jest.mock('../src/services/mt5Service', () => {
  const live = {
    isConnected: jest.fn(() => true),
    getPublicConnectionConfig: jest.fn(() => ({ login: '111', server: 'Broker-Live', pathConfigured: true })),
    buildRuntimeIdentityStatus: jest.fn(() => ({ scope: 'live', connected: true })),
  };
  const paper = {
    isConnected: jest.fn(() => true),
    getPublicConnectionConfig: jest.fn(() => ({ login: '222', server: 'Broker-Demo', pathConfigured: true })),
    buildRuntimeIdentityStatus: jest.fn(() => ({ scope: 'paper', connected: true })),
  };
  return {
    ...live,
    getScopedService: jest.fn((scope) => (scope === 'paper' ? paper : live)),
    __mockLive: live,
    __mockPaper: paper,
  };
});

jest.mock('../src/services/paperTradingService', () => ({
  getStatus: jest.fn(),
}));

jest.mock('../src/services/dataSyncSchedulerService', () => ({
  getStatus: jest.fn(),
}));

jest.mock('../src/models/DecisionAudit', () => ({
  count: jest.fn(),
}));

const notificationHubService = require('../src/services/notificationHubService');
const mt5Service = require('../src/services/mt5Service');
const paperTradingService = require('../src/services/paperTradingService');
const dataSyncSchedulerService = require('../src/services/dataSyncSchedulerService');
const DecisionAudit = require('../src/models/DecisionAudit');
const runtimeHeartbeatService = require('../src/services/runtimeHeartbeatService');

const MB = 1024 * 1024;

describe('runtimeHeartbeatService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TELEGRAM_HEARTBEAT_ENABLED = 'true';
    process.env.TELEGRAM_HEARTBEAT_INTERVAL_MINUTES = '5';
    process.env.TELEGRAM_HEARTBEAT_SUMMARY_INTERVAL_MINUTES = '360';
    process.env.TELEGRAM_ALERT_MEMORY_MB = '800';
    process.env.TELEGRAM_ALERT_NO_SCAN_MINUTES = '30';
    process.env.TRADING_ENABLED = 'false';
    process.env.PAPER_TRADING_ENABLED = 'false';
    process.env.SYMBOL_CUSTOM_PAPER_ENABLED = 'false';
    delete process.env.TELEGRAM_ALERT_NO_SCAN_ALWAYS;
    runtimeHeartbeatService._resetForTests();
    runtimeHeartbeatService._setNowForTests('2026-05-19T00:00:00.000Z');
    runtimeHeartbeatService._setMemoryUsageForTests({ rss: 120 * MB, heapUsed: 40 * MB });
    mt5Service.__mockLive.isConnected.mockReturnValue(true);
    mt5Service.__mockPaper.isConnected.mockReturnValue(true);
    paperTradingService.getStatus.mockResolvedValue({
      enabled: false,
      running: false,
      connected: true,
      positionMonitor: { lastScanAt: '2026-05-19T00:00:00.000Z' },
    });
    dataSyncSchedulerService.getStatus.mockReturnValue({
      running: false,
      lastRun: { success: true, finishedAt: '2026-05-19T00:00:00.000Z' },
    });
    DecisionAudit.count.mockResolvedValue(4);
  });

  afterEach(() => {
    runtimeHeartbeatService._resetForTests();
    delete process.env.TELEGRAM_HEARTBEAT_ENABLED;
    delete process.env.TELEGRAM_HEARTBEAT_INTERVAL_MINUTES;
    delete process.env.TELEGRAM_HEARTBEAT_SUMMARY_INTERVAL_MINUTES;
    delete process.env.TELEGRAM_ALERT_MEMORY_MB;
    delete process.env.TELEGRAM_ALERT_NO_SCAN_MINUTES;
    delete process.env.TRADING_ENABLED;
    delete process.env.PAPER_TRADING_ENABLED;
    delete process.env.SYMBOL_CUSTOM_PAPER_ENABLED;
    delete process.env.TELEGRAM_ALERT_NO_SCAN_ALWAYS;
  });

  test('normal heartbeat sends no spam', async () => {
    const result = await runtimeHeartbeatService.checkNow();

    expect(result.sentAlerts).toHaveLength(0);
    expect(result.resolvedAlerts).toHaveLength(0);
    expect(result.summarySent).toBe(false);
    expect(notificationHubService.enqueueTelegram).not.toHaveBeenCalled();
  });

  test('state change sends alert', async () => {
    mt5Service.__mockLive.isConnected.mockReturnValue(false);

    await runtimeHeartbeatService.checkNow();

    expect(notificationHubService.enqueueTelegram).toHaveBeenCalledTimes(1);
    expect(notificationHubService.enqueueTelegram).toHaveBeenCalledWith(expect.objectContaining({
      type: 'heartbeat_alert',
      title: 'MT5 live disconnected',
      message: expect.stringContaining('MT5_LIVE_DISCONNECTED'),
    }));
  });

  test('repeated same alert is deduped', async () => {
    mt5Service.__mockLive.isConnected.mockReturnValue(false);

    await runtimeHeartbeatService.checkNow();
    await runtimeHeartbeatService.checkNow();

    expect(notificationHubService.enqueueTelegram).toHaveBeenCalledTimes(1);
  });

  test('recovery sends resolved message', async () => {
    mt5Service.__mockLive.isConnected.mockReturnValue(false);
    await runtimeHeartbeatService.checkNow();

    mt5Service.__mockLive.isConnected.mockReturnValue(true);
    await runtimeHeartbeatService.checkNow();

    expect(notificationHubService.enqueueTelegram).toHaveBeenCalledTimes(2);
    expect(notificationHubService.enqueueTelegram).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'heartbeat_resolved',
      message: expect.stringContaining('RESOLVED'),
    }));
  });

  test('memory high alert', async () => {
    process.env.TELEGRAM_ALERT_MEMORY_MB = '100';
    runtimeHeartbeatService._setMemoryUsageForTests({ rss: 140 * MB, heapUsed: 50 * MB });

    await runtimeHeartbeatService.checkNow();

    expect(notificationHubService.enqueueTelegram).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Memory high',
      message: expect.stringContaining('MEMORY_HIGH'),
    }));
  });

  test('data sync failed alert', async () => {
    dataSyncSchedulerService.getStatus.mockReturnValue({
      running: false,
      lastRun: {
        success: false,
        errorCode: 'RCLONE_NOT_FOUND',
        finishedAt: '2026-05-19T00:00:00.000Z',
      },
    });

    await runtimeHeartbeatService.checkNow();

    expect(notificationHubService.enqueueTelegram).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Data sync failed',
      message: expect.stringContaining('DATA_SYNC_FAILED'),
    }));
  });

  test('no decision audit activity does not alert when all runtimes are disabled', async () => {
    DecisionAudit.count.mockResolvedValue(0);

    await runtimeHeartbeatService.checkNow();

    expect(notificationHubService.enqueueTelegram).not.toHaveBeenCalled();
    expect(DecisionAudit.count).not.toHaveBeenCalled();
  });

  test('no decision audit activity alerts when paper trading is enabled', async () => {
    process.env.PAPER_TRADING_ENABLED = 'true';
    paperTradingService.getStatus.mockResolvedValue({
      enabled: true,
      running: true,
      connected: true,
      positionMonitor: { lastScanAt: '2026-05-19T00:00:00.000Z' },
    });
    DecisionAudit.count.mockResolvedValue(0);

    await runtimeHeartbeatService.checkNow();

    expect(notificationHubService.enqueueTelegram).toHaveBeenCalledWith(expect.objectContaining({
      title: 'No signal scan activity',
      message: expect.stringContaining('NO_SIGNAL_SCAN_ACTIVITY'),
    }));
  });
});
