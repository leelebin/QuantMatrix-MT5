jest.mock('../src/services/notificationService', () => ({
  enabled: true,
  init: jest.fn(),
}));

jest.mock('../src/services/notificationHubService', () => ({
  enqueueTelegram: jest.fn(() => Promise.resolve({ queued: 1, skipped: 0 })),
}));

jest.mock('../src/services/remoteAccessService', () => ({
  isRemoteUrlNotifyEnabled: jest.fn(() => true),
  updateRemoteAccessState: jest.fn(),
}));

const notificationHubService = require('../src/services/notificationHubService');
const remoteAccessService = require('../src/services/remoteAccessService');
const {
  buildRemoteAccessDedupeKey,
  maybeNotifyTelegram,
} = require('../scripts/start-remote-access');

describe('remote access notification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('dedupeKey does not include the basic auth password', async () => {
    const publicUrl = 'https://qm-example.ngrok-free.app';
    const basicAuth = {
      username: 'qmremote',
      password: 'super-secret-password',
    };

    const dedupeKey = buildRemoteAccessDedupeKey(publicUrl, basicAuth);
    expect(dedupeKey).toContain(publicUrl);
    expect(dedupeKey).toContain(basicAuth.username);
    expect(dedupeKey).not.toContain(basicAuth.password);

    await maybeNotifyTelegram(publicUrl, basicAuth, {});

    expect(remoteAccessService.updateRemoteAccessState).toHaveBeenCalled();
    expect(notificationHubService.enqueueTelegram).toHaveBeenCalledWith(expect.objectContaining({
      type: 'remote_access',
      dedupeKey: expect.not.stringContaining(basicAuth.password),
      message: expect.stringContaining(basicAuth.password),
    }));
  });
});
