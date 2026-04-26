const fs = require('fs');
const os = require('os');
const path = require('path');

const remoteAccessService = require('../src/services/remoteAccessService');

describe('remote access service', () => {
  const originalEnv = { ...process.env };
  let tempDir;
  let stateFile;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qm-remote-'));
    stateFile = path.join(tempDir, 'remote-access-state.json');
    process.env.REMOTE_ACCESS_STATE_FILE = stateFile;
    process.env.NGROK_API_URL = 'http://127.0.0.1:9/api/tunnels';
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.FRONTEND_URL;
    delete process.env.ALLOW_SELF_REGISTRATION;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('defaults self registration to disabled', () => {
    expect(remoteAccessService.isSelfRegistrationAllowed()).toBe(false);
  });

  test('prefers configured public base URL over cached tunnel state', async () => {
    remoteAccessService.writeRemoteAccessState({
      publicUrl: 'https://old-tunnel.ngrok.app',
      basicAuth: { username: 'user', password: 'password123' },
    });
    process.env.PUBLIC_BASE_URL = 'https://trade.example.com';

    await expect(remoteAccessService.getPublicBaseUrl()).resolves.toBe('https://trade.example.com');
  });

  test('falls back to the local frontend URL when no active tunnel or configured public URL exists', async () => {
    remoteAccessService.writeRemoteAccessState({
      publicUrl: 'https://cached-tunnel.ngrok.app',
    });
    process.env.FRONTEND_URL = 'http://localhost:5000';

    await expect(remoteAccessService.getPublicBaseUrl()).resolves.toBe('http://localhost:5000');
  });

  test('builds reset password URL from the resolved public base URL', async () => {
    process.env.PUBLIC_BASE_URL = 'https://remote.quantmatrix.example';

    await expect(remoteAccessService.buildResetPasswordUrl('abc123')).resolves.toBe(
      'https://remote.quantmatrix.example/reset-password/abc123'
    );
  });

  test('merges stored basic auth state updates', () => {
    remoteAccessService.writeRemoteAccessState({
      publicUrl: 'https://cached-tunnel.ngrok.app',
      basicAuth: {
        username: 'qmremote',
        password: 'password123',
      },
    });

    const nextState = remoteAccessService.updateRemoteAccessState({
      tunnelActive: true,
      basicAuth: {
        username: 'qmremote2',
      },
    });

    expect(nextState.basicAuth).toEqual({
      username: 'qmremote2',
      password: 'password123',
    });
    expect(nextState.tunnelActive).toBe(true);
  });
});
