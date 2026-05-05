const mt5Service = require('../src/services/mt5Service');

const RUNTIME_ENV_KEYS = [
  'MT5_LOGIN',
  'MT5_PASSWORD',
  'MT5_SERVER',
  'MT5_PATH',
  'MT5_LIVE_LOGIN',
  'MT5_LIVE_PASSWORD',
  'MT5_LIVE_SERVER',
  'MT5_LIVE_PATH',
  'MT5_PAPER_LOGIN',
  'MT5_PAPER_PASSWORD',
  'MT5_PAPER_SERVER',
  'MT5_PAPER_PATH',
  'MT5_STRICT_RUNTIME_ISOLATION',
];

function resetRuntimeFlags() {
  const live = mt5Service.getScopedService('live');
  const paper = mt5Service.getScopedService('paper');
  [live, paper].forEach((service) => {
    service.connected = false;
    service.ready = false;
    service.connecting = false;
  });
}

function withCleanRuntimeEnv(overrides, callback) {
  const live = mt5Service.getScopedService('live');
  const paper = mt5Service.getScopedService('paper');
  const previousEnv = Object.fromEntries(
    RUNTIME_ENV_KEYS.map((key) => [key, process.env[key]])
  );
  const previousReadEnvFileValues = new Map([
    [live, live._readEnvFileValues],
    [paper, paper._readEnvFileValues],
  ]);
  const cleanReader = () => ({});

  try {
    RUNTIME_ENV_KEYS.forEach((key) => {
      delete process.env[key];
    });
    Object.entries(overrides || {}).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    live._readEnvFileValues = cleanReader;
    paper._readEnvFileValues = cleanReader;
    resetRuntimeFlags();
    return callback({ live, paper });
  } finally {
    RUNTIME_ENV_KEYS.forEach((key) => {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    });
    previousReadEnvFileValues.forEach((reader, service) => {
      service._readEnvFileValues = reader;
    });
    resetRuntimeFlags();
  }
}

describe('MT5 scoped runtime services', () => {
  test('live and paper services use independent symbol resolver caches', () => {
    const live = mt5Service.getScopedService('live');
    const paper = mt5Service.getScopedService('paper');

    live.symbolResolver.clear();
    paper.symbolResolver.clear();
    live.symbolResolver.setManualResolution('BTCUSD', 'BTCUSD.live');
    paper.symbolResolver.setManualResolution('BTCUSD', 'BTCUSD.paper');

    expect(live).toBe(mt5Service);
    expect(paper).not.toBe(live);
    expect(live._resolveSymbol('BTCUSD')).toBe('BTCUSD.live');
    expect(paper._resolveSymbol('BTCUSD')).toBe('BTCUSD.paper');
  });

  test('scoped connection config prefers live and paper env values over legacy MT5 values', () => {
    const previous = {
      MT5_LOGIN: process.env.MT5_LOGIN,
      MT5_PASSWORD: process.env.MT5_PASSWORD,
      MT5_SERVER: process.env.MT5_SERVER,
      MT5_LIVE_LOGIN: process.env.MT5_LIVE_LOGIN,
      MT5_LIVE_PASSWORD: process.env.MT5_LIVE_PASSWORD,
      MT5_LIVE_SERVER: process.env.MT5_LIVE_SERVER,
      MT5_PAPER_LOGIN: process.env.MT5_PAPER_LOGIN,
      MT5_PAPER_PASSWORD: process.env.MT5_PAPER_PASSWORD,
      MT5_PAPER_SERVER: process.env.MT5_PAPER_SERVER,
    };

    try {
      process.env.MT5_LOGIN = 'legacy-login';
      process.env.MT5_PASSWORD = 'legacy-password';
      process.env.MT5_SERVER = 'legacy-server';
      process.env.MT5_LIVE_LOGIN = 'live-login';
      process.env.MT5_LIVE_PASSWORD = 'live-password';
      process.env.MT5_LIVE_SERVER = 'live-server';
      process.env.MT5_PAPER_LOGIN = 'paper-login';
      process.env.MT5_PAPER_PASSWORD = 'paper-password';
      process.env.MT5_PAPER_SERVER = 'paper-server';

      expect(mt5Service.getScopedService('live').getConnectionConfig()).toEqual(expect.objectContaining({
        login: 'live-login',
        password: 'live-password',
        server: 'live-server',
      }));
      expect(mt5Service.getScopedService('paper').getConnectionConfig()).toEqual(expect.objectContaining({
        login: 'paper-login',
        password: 'paper-password',
        server: 'paper-server',
      }));
    } finally {
      Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });

  test('detects when the connected account does not match the scoped config', () => {
    const previous = {
      MT5_LIVE_LOGIN: process.env.MT5_LIVE_LOGIN,
      MT5_LIVE_SERVER: process.env.MT5_LIVE_SERVER,
    };

    try {
      process.env.MT5_LIVE_LOGIN = '44938841';
      process.env.MT5_LIVE_SERVER = 'Elev8-Real2';

      const live = mt5Service.getScopedService('live');
      expect(live.getAccountConfigMatch({
        login: '230044684',
        server: 'Elev8-Demo2',
      })).toEqual(expect.objectContaining({
        matches: false,
        loginMatches: false,
        serverMatches: false,
      }));
      expect(live.getAccountConfigMatch({
        login: '44938841',
        server: 'Elev8-Real2',
      })).toEqual(expect.objectContaining({
        matches: true,
        loginMatches: true,
        serverMatches: true,
      }));
    } finally {
      Object.entries(previous).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });

  test('builds live connection diagnostics without exposing the password', () => {
    withCleanRuntimeEnv({
      MT5_LIVE_LOGIN: '44938841',
      MT5_LIVE_PASSWORD: 'secret-password',
      MT5_LIVE_SERVER: 'Elev8-Real2',
    }, ({ live }) => {
      const diagnostics = live.getConnectionDiagnostics();

      expect(diagnostics).toEqual(expect.objectContaining({
        scope: 'live',
        expectedAccount: {
          login: '44938841',
          server: 'Elev8-Real2',
        },
        config: expect.objectContaining({
          login: '44938841',
          server: 'Elev8-Real2',
          pathConfigured: false,
        }),
        likelyReasons: expect.arrayContaining([
          expect.stringContaining('MT5_LIVE_PATH is not configured'),
        ]),
      }));
      expect(JSON.stringify(diagnostics)).not.toContain('secret-password');
    });
  });

  test('hard-fails when live and paper are active and live path is missing', () => {
    withCleanRuntimeEnv({
      MT5_PAPER_PATH: 'C:\\MT5-Paper\\terminal64.exe',
    }, ({ live, paper }) => {
      paper.connected = true;
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      try {
        expect(() => live._checkTerminalIsolation(live.getConnectionConfig()))
          .toThrow(/MT5_LIVE_PATH is required/);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('MT5_LIVE_PATH is required'));
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  test('hard-fails when live and paper are active and paper path is missing', () => {
    withCleanRuntimeEnv({
      MT5_LIVE_PATH: 'C:\\MT5-Live\\terminal64.exe',
    }, ({ live, paper }) => {
      live.connected = true;
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      try {
        expect(() => paper._checkTerminalIsolation(paper.getConnectionConfig()))
          .toThrow(/MT5_PAPER_PATH is required/);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('MT5_PAPER_PATH is required'));
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  test('hard-fails when live and paper paths normalize to the same terminal', () => {
    withCleanRuntimeEnv({
      MT5_LIVE_PATH: 'C:\\MT5\\terminal64.exe',
      MT5_PAPER_PATH: '  c:/mt5/terminal64.exe/  ',
    }, ({ live, paper }) => {
      live.connected = true;
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      try {
        expect(() => paper._checkTerminalIsolation(paper.getConnectionConfig()))
          .toThrow(/resolve to the same terminal path/);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('resolve to the same terminal path'));
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  test('strict=false warns but does not hard-fail on path isolation risk', () => {
    withCleanRuntimeEnv({
      MT5_STRICT_RUNTIME_ISOLATION: 'false',
      MT5_LIVE_PATH: 'C:\\MT5\\terminal64.exe',
      MT5_PAPER_PATH: 'c:/mt5/terminal64.exe',
    }, ({ live, paper }) => {
      live.connected = true;
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        expect(() => paper._checkTerminalIsolation(paper.getConnectionConfig())).not.toThrow();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MT5_STRICT_RUNTIME_ISOLATION=false'));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('account-mixing risk'));
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  test('only live active does not require MT5_PAPER_PATH', () => {
    withCleanRuntimeEnv({
      MT5_LIVE_PATH: 'C:\\MT5-Live\\terminal64.exe',
    }, ({ live }) => {
      expect(() => live._checkTerminalIsolation(live.getConnectionConfig())).not.toThrow();
    });
  });

  test('only paper active does not require MT5_LIVE_PATH', () => {
    withCleanRuntimeEnv({
      MT5_PAPER_PATH: 'C:\\MT5-Paper\\terminal64.exe',
    }, ({ paper }) => {
      expect(() => paper._checkTerminalIsolation(paper.getConnectionConfig())).not.toThrow();
    });
  });

  test('paper runtime hard-fails when account mode is REAL', () => {
    withCleanRuntimeEnv({
      MT5_PAPER_LOGIN: '230044684',
      MT5_PAPER_SERVER: 'Elev8-Demo2',
    }, ({ paper }) => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      try {
        expect(() => paper.validateRuntimeAccountIdentity({
          login: '230044684',
          server: 'Elev8-Demo2',
          tradeModeName: 'REAL',
        })).toThrow(/Paper MT5 runtime must not use a REAL account/);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Account identity validation failed'));
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  test('paper login mismatch hard-fails when strict isolation is enabled', () => {
    withCleanRuntimeEnv({
      MT5_PAPER_LOGIN: '230044684',
      MT5_PAPER_SERVER: 'Elev8-Demo2',
    }, ({ paper }) => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      try {
        expect(() => paper.validateRuntimeAccountIdentity({
          login: '111111',
          server: 'Elev8-Demo2',
          tradeModeName: 'DEMO',
        })).toThrow(/connected account mismatch/);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('connected account mismatch'));
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  test('paper login mismatch warns when strict isolation is disabled', () => {
    withCleanRuntimeEnv({
      MT5_STRICT_RUNTIME_ISOLATION: 'false',
      MT5_PAPER_LOGIN: '230044684',
      MT5_PAPER_SERVER: 'Elev8-Demo2',
    }, ({ paper }) => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const validation = paper.validateRuntimeAccountIdentity({
          login: '111111',
          server: 'Elev8-Demo2',
          tradeModeName: 'DEMO',
        });
        expect(validation.ok).toBe(true);
        expect(validation.warnings).toEqual(expect.arrayContaining([
          expect.stringContaining('MT5_STRICT_RUNTIME_ISOLATION=false'),
        ]));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('identity mismatch risk'));
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  test('live DEMO account hard-fails when strict isolation is enabled', () => {
    withCleanRuntimeEnv({
      MT5_LIVE_LOGIN: '44938841',
      MT5_LIVE_SERVER: 'Elev8-Real2',
    }, ({ live }) => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      try {
        expect(() => live.validateRuntimeAccountIdentity({
          login: '44938841',
          server: 'Elev8-Real2',
          tradeModeName: 'DEMO',
        })).toThrow(/Live MT5 runtime expects a REAL account/);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Live MT5 runtime expects a REAL account'));
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  test('live DEMO account warns when strict isolation is disabled', () => {
    withCleanRuntimeEnv({
      MT5_STRICT_RUNTIME_ISOLATION: 'false',
      MT5_LIVE_LOGIN: '44938841',
      MT5_LIVE_SERVER: 'Elev8-Real2',
    }, ({ live }) => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const validation = live.validateRuntimeAccountIdentity({
          login: '44938841',
          server: 'Elev8-Real2',
          tradeModeName: 'DEMO',
        });
        expect(validation.ok).toBe(true);
        expect(validation.warnings).toEqual(expect.arrayContaining([
          expect.stringContaining('MT5_STRICT_RUNTIME_ISOLATION=false'),
        ]));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Live MT5 runtime expects a REAL account'));
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  test('normalizes account trade modes from bridge variants', () => {
    const live = mt5Service.getScopedService('live');

    expect(live.normalizeAccountMode({ tradeMode: 2 })).toEqual(expect.objectContaining({
      tradeModeName: 'REAL',
      isReal: true,
      isDemo: false,
    }));
    expect(live.normalizeAccountMode({ accountInfo: { trade_mode: 0 } })).toEqual(expect.objectContaining({
      tradeModeName: 'DEMO',
      isReal: false,
      isDemo: true,
    }));
    expect(live.normalizeAccountMode({ trade_mode: 'ACCOUNT_TRADE_MODE_CONTEST' })).toEqual(expect.objectContaining({
      tradeModeName: 'CONTEST',
      isReal: false,
      isDemo: false,
      isContest: true,
    }));
    expect(live.normalizeAccountMode({ tradeModeName: 'FULL' })).toEqual(expect.objectContaining({
      tradeModeName: 'UNKNOWN',
      isReal: false,
      isDemo: false,
    }));
  });

  test('builds runtime identity status with path and validated account mode', () => {
    withCleanRuntimeEnv({
      MT5_PAPER_LOGIN: '230044684',
      MT5_PAPER_SERVER: 'Elev8-Demo2',
      MT5_PAPER_PATH: 'C:\\MT5-Paper\\terminal64.exe',
    }, ({ paper }) => {
      paper.connected = true;
      const status = paper.buildRuntimeIdentityStatus({
        login: '230044684',
        server: 'Elev8-Demo2',
        tradeModeName: 'DEMO',
        balance: 10000,
        equity: 10050,
        currency: 'USD',
      });

      expect(status).toEqual(expect.objectContaining({
        scope: 'paper',
        connected: true,
        mt5Path: 'C:\\MT5-Paper\\terminal64.exe',
        account: expect.objectContaining({
          login: '230044684',
          server: 'Elev8-Demo2',
          tradeModeName: 'DEMO',
          isReal: false,
          isDemo: true,
          balance: 10000,
          equity: 10050,
          currency: 'USD',
        }),
        validation: expect.objectContaining({
          ok: true,
          errors: [],
        }),
      }));
    });
  });
});
