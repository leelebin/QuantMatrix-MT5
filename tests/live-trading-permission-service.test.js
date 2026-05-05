const fs = require('fs');
const os = require('os');
const path = require('path');

const liveTradingPermissionService = require('../src/services/liveTradingPermissionService');

const originalAllowLiveTrading = process.env.ALLOW_LIVE_TRADING;

async function createTempEnv(content = '') {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'qm-live-permission-'));
  const envPath = path.join(dir, '.env');
  if (content !== null) {
    await fs.promises.writeFile(envPath, content, 'utf8');
  }
  return { dir, envPath };
}

describe('liveTradingPermissionService', () => {
  afterEach(() => {
    if (originalAllowLiveTrading === undefined) {
      delete process.env.ALLOW_LIVE_TRADING;
    } else {
      process.env.ALLOW_LIVE_TRADING = originalAllowLiveTrading;
    }
  });

  test('replaces an existing ALLOW_LIVE_TRADING value and updates process env', async () => {
    const { envPath } = await createTempEnv('FOO=bar\nALLOW_LIVE_TRADING=false\nBAR=baz\n');

    const result = await liveTradingPermissionService.setAllowLiveTrading(true, { envPath });
    const content = await fs.promises.readFile(envPath, 'utf8');

    expect(result).toEqual(expect.objectContaining({
      enabled: true,
      persisted: true,
      created: false,
      path: envPath,
    }));
    expect(process.env.ALLOW_LIVE_TRADING).toBe('true');
    expect(content).toBe('FOO=bar\nALLOW_LIVE_TRADING=true\nBAR=baz\n');
  });

  test('appends ALLOW_LIVE_TRADING when the env file does not contain it', async () => {
    const { envPath } = await createTempEnv('FOO=bar\n');

    await liveTradingPermissionService.setAllowLiveTrading(true, { envPath });
    const content = await fs.promises.readFile(envPath, 'utf8');

    expect(content).toBe('FOO=bar\nALLOW_LIVE_TRADING=true\n');
  });

  test('can enable live trading for the running process without persisting', async () => {
    const { envPath } = await createTempEnv('ALLOW_LIVE_TRADING=false\n');

    const result = await liveTradingPermissionService.setAllowLiveTrading(true, {
      envPath,
      persist: false,
    });
    const content = await fs.promises.readFile(envPath, 'utf8');

    expect(result).toEqual({
      enabled: true,
      persisted: false,
      path: null,
    });
    expect(process.env.ALLOW_LIVE_TRADING).toBe('true');
    expect(content).toBe('ALLOW_LIVE_TRADING=false\n');
  });

  test('does not update process env when persistence fails', async () => {
    const { dir } = await createTempEnv(null);
    process.env.ALLOW_LIVE_TRADING = 'false';

    await expect(liveTradingPermissionService.setAllowLiveTrading(true, { envPath: dir }))
      .rejects.toThrow();

    expect(process.env.ALLOW_LIVE_TRADING).toBe('false');
  });
});
