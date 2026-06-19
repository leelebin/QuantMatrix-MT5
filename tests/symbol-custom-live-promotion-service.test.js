const EMA50_LOGIC = 'XAUUSD_EMA50_PULLBACK_TREND_V1';

function buildRecord(overrides = {}) {
  return {
    _id: 'sc-ema50',
    symbol: 'XAUUSD',
    symbolCustomName: EMA50_LOGIC,
    logicName: EMA50_LOGIC,
    status: 'paper_testing',
    paperEnabled: true,
    liveEnabled: true,
    allowLive: false,
    isPrimaryLive: false,
    parameters: {
      enabled: true,
      maxDailyTrades: 1,
      maxRollingConsecutiveLosses: 4,
      rollingLossCooldownBars: 144,
    },
    ...overrides,
  };
}

function buildValidationReport(overrides = {}) {
  return {
    symbolCustomId: 'sc-ema50',
    symbolCustomName: EMA50_LOGIC,
    logicName: EMA50_LOGIC,
    symbol: 'XAUUSD',
    results: [
      {
        label: 'full_window',
        summary: {
          trades: 230,
          netPnl: 187.75,
          profitFactor: 1.56,
          maxDrawdown: 16.76,
          maxConsecutiveLosses: 4,
          equityCurveHasBalance: true,
          equityCurveHasEquity: true,
        },
      },
      {
        label: 'recent_window',
        summary: {
          trades: 49,
          netPnl: 40.62,
          profitFactor: 1.64,
          maxDrawdown: 13.24,
          maxConsecutiveLosses: 4,
          equityCurveHasBalance: true,
          equityCurveHasEquity: true,
        },
      },
    ],
    ...overrides,
  };
}

function loadService({ record = buildRecord(), allRecords = null } = {}) {
  jest.resetModules();

  let stored = record ? JSON.parse(JSON.stringify(record)) : null;
  const SymbolCustom = {
    findById: jest.fn(async (id) => (stored && stored._id === id ? { ...stored } : null)),
    findAll: jest.fn(async () => (allRecords || (stored ? [stored] : [])).map((item) => ({ ...item }))),
    update: jest.fn(async (id, patch) => {
      if (!stored || stored._id !== id) return null;
      stored = {
        ...stored,
        ...patch,
        updatedAt: new Date('2026-06-04T04:00:00.000Z'),
      };
      return { ...stored };
    }),
  };

  jest.doMock('../src/models/SymbolCustom', () => SymbolCustom);

  return {
    service: require('../src/services/symbolCustomLivePromotionService'),
    SymbolCustom,
  };
}

describe('symbolCustomLivePromotionService', () => {
  afterEach(() => {
    jest.dontMock('../src/models/SymbolCustom');
  });

  test('dry-run passes EMA50 with strict full and recent evidence without updating DB', async () => {
    const { service, SymbolCustom } = loadService();

    const result = await service.evaluateSymbolCustomLivePromotion({
      symbolCustomId: 'sc-ema50',
      validationReport: buildValidationReport(),
      now: new Date('2026-06-04T04:00:00.000Z'),
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      mode: 'dry_run',
      eligible: true,
      decision: 'PASS',
      plannedPatch: {
        status: 'live_ready',
        allowLive: true,
        isPrimaryLive: true,
      },
      flagsBefore: expect.objectContaining({
        paperEnabled: true,
        liveEnabled: true,
        allowLive: false,
        isPrimaryLive: false,
        status: 'paper_testing',
      }),
    }));
    expect(result.summary.fail).toBe(0);
    expect(SymbolCustom.update).not.toHaveBeenCalled();
  });

  test('apply promotes only status allowLive and isPrimaryLive while preserving paper/live flags', async () => {
    const { service, SymbolCustom } = loadService();

    const result = await service.promoteSymbolCustomToLiveReady({
      symbolCustomId: 'sc-ema50',
      validationReport: buildValidationReport(),
      now: new Date('2026-06-04T04:00:00.000Z'),
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      mode: 'apply',
      applied: true,
      appliedPatch: {
        status: 'live_ready',
        allowLive: true,
        isPrimaryLive: true,
      },
      flagsAfter: expect.objectContaining({
        paperEnabled: true,
        liveEnabled: true,
        allowLive: true,
        isPrimaryLive: true,
        status: 'live_ready',
      }),
    }));
    expect(result.policy).toEqual(expect.objectContaining({
      paperEnabledPreserved: true,
      liveEnabledPreserved: true,
    }));
    expect(SymbolCustom.update).toHaveBeenCalledWith('sc-ema50', {
      status: 'live_ready',
      allowLive: true,
      isPrimaryLive: true,
    });
  });

  test('paper-disabled records are not eligible and are not updated', async () => {
    const { service, SymbolCustom } = loadService({
      record: buildRecord({ paperEnabled: false }),
    });

    const result = await service.promoteSymbolCustomToLiveReady({
      symbolCustomId: 'sc-ema50',
      validationReport: buildValidationReport(),
    });

    expect(result.eligible).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'paperEnabled remains enabled',
        status: 'FAIL',
      }),
    ]));
    expect(SymbolCustom.update).not.toHaveBeenCalled();
  });

  test('below-threshold validation evidence blocks promotion', async () => {
    const { service, SymbolCustom } = loadService();

    const result = await service.promoteSymbolCustomToLiveReady({
      symbolCustomId: 'sc-ema50',
      validationReport: buildValidationReport({
        results: [
          {
            label: 'full_window',
            summary: {
              trades: 230,
              netPnl: 187.75,
              profitFactor: 1.2,
              maxDrawdown: 16.76,
              maxConsecutiveLosses: 4,
              equityCurveHasBalance: true,
              equityCurveHasEquity: true,
            },
          },
          {
            label: 'recent_window',
            summary: {
              trades: 49,
              netPnl: 40.62,
              profitFactor: 1.64,
              maxDrawdown: 13.24,
              maxConsecutiveLosses: 4,
              equityCurveHasBalance: true,
              equityCurveHasEquity: true,
            },
          },
        ],
      }),
    });

    expect(result.eligible).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'full_window profitFactor >= 1.5',
        status: 'FAIL',
      }),
    ]));
    expect(SymbolCustom.update).not.toHaveBeenCalled();
  });

  test('existing primary live record on same symbol blocks promotion', async () => {
    const record = buildRecord();
    const { service, SymbolCustom } = loadService({
      record,
      allRecords: [
        record,
        buildRecord({
          _id: 'sc-existing-primary',
          symbolCustomName: 'XAUUSD_OTHER_LIVE',
          logicName: 'XAUUSD_OTHER_LIVE',
          isPrimaryLive: true,
        }),
      ],
    });

    const result = await service.promoteSymbolCustomToLiveReady({
      symbolCustomId: 'sc-ema50',
      validationReport: buildValidationReport(),
    });

    expect(result.eligible).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'no existing primary live conflict',
        status: 'FAIL',
      }),
    ]));
    expect(SymbolCustom.update).not.toHaveBeenCalled();
  });

  test('non-allowlisted logic is not eligible for live promotion', async () => {
    const { service, SymbolCustom } = loadService({
      record: buildRecord({
        symbolCustomName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
        logicName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
      }),
    });

    const result = await service.promoteSymbolCustomToLiveReady({
      symbolCustomId: 'sc-ema50',
      validationReport: buildValidationReport({
        logicName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
        symbolCustomName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
      }),
    });

    expect(result.eligible).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'logic is live promotion allowed',
        status: 'FAIL',
      }),
    ]));
    expect(SymbolCustom.update).not.toHaveBeenCalled();
  });
});
