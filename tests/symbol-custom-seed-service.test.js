function matchesQuery(doc, query = {}) {
  return Object.entries(query).every(([key, value]) => doc[key] === value);
}

function sortRecords(records, sortSpec = {}) {
  const fields = Object.entries(sortSpec);
  return [...records].sort((left, right) => {
    for (const [field, direction] of fields) {
      if (left[field] === right[field]) continue;
      if (left[field] > right[field]) return direction;
      return -direction;
    }
    return 0;
  });
}

function createSymbolCustomsDb(records) {
  let nextId = records.length + 1;
  return {
    findOne: jest.fn(async (query) => records.find((record) => matchesQuery(record, query)) || null),
    find: jest.fn((query = {}) => ({
      sort: jest.fn(async (sortSpec) => sortRecords(
        records.filter((record) => matchesQuery(record, query)),
        sortSpec
      )),
    })),
    insert: jest.fn(async (doc) => {
      const stored = {
        _id: doc._id || `symbol-custom-${nextId++}`,
        ...doc,
      };
      records.push(stored);
      return stored;
    }),
    update: jest.fn(async (query, update) => {
      const matchedRecords = records.filter((record) => matchesQuery(record, query));
      matchedRecords.forEach((record) => {
        if (update && update.$set) {
          Object.assign(record, update.$set);
        }
      });
      return matchedRecords.length;
    }),
    remove: jest.fn(async (query) => {
      const removed = records.filter((record) => matchesQuery(record, query));
      const remaining = records.filter((record) => !matchesQuery(record, query));
      records.splice(0, records.length, ...remaining);
      return removed.length;
    }),
  };
}

function loadSeedService({ records = [] } = {}) {
  jest.resetModules();

  const symbolCustomRecords = records.map((record) => ({ ...record }));
  const symbolCustomsDb = createSymbolCustomsDb(symbolCustomRecords);

  jest.doMock('../src/config/db', () => ({
    symbolCustomsDb,
  }));

  const seedService = require('../src/services/symbolCustomSeedService');
  const { PLACEHOLDER_SYMBOL_CUSTOM } = require('../src/symbolCustom/logics/PlaceholderSymbolCustom');
  const {
    USDJPY_JPY_MACRO_REVERSAL_V1,
    USDJPY_JPY_MACRO_REVERSAL_V1_VERSION,
  } = require('../src/symbolCustom/logics/UsdjpyJpyMacroReversalV1');
  const {
    XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1,
    XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1_VERSION,
  } = require('../src/symbolCustom/logics/XauusdVolumeFlowBreakoutNyV1');
  const {
    XAUUSD_MICROSTRUCTURE_SCALP_V1,
    XAUUSD_MICROSTRUCTURE_SCALP_V1_VERSION,
  } = require('../src/symbolCustom/logics/XauusdMicrostructureScalpV1');
  const {
    XAUUSD_EMA50_PULLBACK_TREND_V1,
    XAUUSD_EMA50_PULLBACK_TREND_V1_VERSION,
  } = require('../src/symbolCustom/logics/XauusdEma50PullbackTrendV1');
  const {
    XAUUSD_VOLUME_PROFILE_STRATEGY_V1,
    XAUUSD_VOLUME_PROFILE_STRATEGY_V1_VERSION,
  } = require('../src/symbolCustom/logics/XauusdVolumeProfileStrategyV1');
  const {
    XTIUSD_OIL_BREAKOUT_RETEST_V1,
    XTIUSD_OIL_BREAKOUT_RETEST_V1_VERSION,
  } = require('../src/symbolCustom/logics/XtiusdOilBreakoutRetestV1');
  const {
    XBRUSD_OIL_LONG_RETEST_SESSION_V2,
    XBRUSD_OIL_LONG_RETEST_SESSION_V2_VERSION,
  } = require('../src/symbolCustom/logics/XbrusdOilLongRetestSessionV2');
  const {
    XAGUSD_VOL_TARGET_TREND_V1,
    XAGUSD_VOL_TARGET_TREND_V1_VERSION,
  } = require('../src/symbolCustom/logics/XagusdVolTargetTrendV1');
  const {
    US30_INDEX_OPENING_RANGE_MOMENTUM_V1,
    US30_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION,
  } = require('../src/symbolCustom/logics/Us30IndexOpeningRangeMomentumV1');
  const {
    NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1,
    NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION,
  } = require('../src/symbolCustom/logics/Nas100IndexOpeningRangeMomentumV1');
  const {
    US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1,
    US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1_VERSION,
  } = require('../src/symbolCustom/logics/Us30OpeningRangeFailedBreakoutFadeV1');

  return {
    seedService,
    records: symbolCustomRecords,
    symbolCustomsDb,
    PLACEHOLDER_SYMBOL_CUSTOM,
    USDJPY_JPY_MACRO_REVERSAL_V1,
    USDJPY_JPY_MACRO_REVERSAL_V1_VERSION,
    XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1,
    XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1_VERSION,
    XAUUSD_MICROSTRUCTURE_SCALP_V1,
    XAUUSD_MICROSTRUCTURE_SCALP_V1_VERSION,
    XAUUSD_EMA50_PULLBACK_TREND_V1,
    XAUUSD_EMA50_PULLBACK_TREND_V1_VERSION,
    XAUUSD_VOLUME_PROFILE_STRATEGY_V1,
    XAUUSD_VOLUME_PROFILE_STRATEGY_V1_VERSION,
    XTIUSD_OIL_BREAKOUT_RETEST_V1,
    XTIUSD_OIL_BREAKOUT_RETEST_V1_VERSION,
    XBRUSD_OIL_LONG_RETEST_SESSION_V2,
    XBRUSD_OIL_LONG_RETEST_SESSION_V2_VERSION,
    XAGUSD_VOL_TARGET_TREND_V1,
    XAGUSD_VOL_TARGET_TREND_V1_VERSION,
    US30_INDEX_OPENING_RANGE_MOMENTUM_V1,
    US30_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION,
    NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1,
    NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION,
    US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1,
    US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1_VERSION,
  };
}

describe('symbolCustomSeedService', () => {
  afterEach(() => {
    jest.dontMock('../src/config/db');
  });

  test('ensureDefaultSymbolCustomDrafts creates 13 default records', async () => {
    const { seedService, records } = loadSeedService();

    const result = await seedService.ensureDefaultSymbolCustomDrafts();

    expect(result.createdCount).toBe(13);
    expect(result.existingCount).toBe(0);
    expect(records).toHaveLength(13);
    expect(records.map((record) => record.symbolCustomName).sort()).toEqual([
      'AUDUSD_SESSION_PULLBACK_V1',
      'GBPJPY_VOLATILITY_BREAKOUT_V1',
      'NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1',
      'US30_INDEX_OPENING_RANGE_MOMENTUM_V1',
      'US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1',
      'USDJPY_JPY_MACRO_REVERSAL_V1',
      'XAGUSD_VOL_TARGET_TREND_V1',
      'XAUUSD_EMA50_PULLBACK_TREND_V1',
      'XAUUSD_MICROSTRUCTURE_SCALP_V1',
      'XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1',
      'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
      'XBRUSD_OIL_LONG_RETEST_SESSION_V2',
      'XTIUSD_OIL_BREAKOUT_RETEST_V1',
    ]);
  });

  test('repeated call does not duplicate drafts', async () => {
    const { seedService, records } = loadSeedService();

    await seedService.ensureDefaultSymbolCustomDrafts();
    const secondRun = await seedService.ensureDefaultSymbolCustomDrafts();

    expect(secondRun.createdCount).toBe(0);
    expect(secondRun.existingCount).toBe(13);
    expect(records).toHaveLength(13);
  });

  test('default records have expected enablement and logic bindings', async () => {
    const {
      seedService,
      records,
      PLACEHOLDER_SYMBOL_CUSTOM,
      USDJPY_JPY_MACRO_REVERSAL_V1,
      USDJPY_JPY_MACRO_REVERSAL_V1_VERSION,
      XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1,
      XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1_VERSION,
      XAUUSD_MICROSTRUCTURE_SCALP_V1,
      XAUUSD_MICROSTRUCTURE_SCALP_V1_VERSION,
      XAUUSD_EMA50_PULLBACK_TREND_V1,
      XAUUSD_EMA50_PULLBACK_TREND_V1_VERSION,
      XAUUSD_VOLUME_PROFILE_STRATEGY_V1,
      XAUUSD_VOLUME_PROFILE_STRATEGY_V1_VERSION,
      XTIUSD_OIL_BREAKOUT_RETEST_V1,
      XTIUSD_OIL_BREAKOUT_RETEST_V1_VERSION,
      XBRUSD_OIL_LONG_RETEST_SESSION_V2,
      XBRUSD_OIL_LONG_RETEST_SESSION_V2_VERSION,
      XAGUSD_VOL_TARGET_TREND_V1,
      XAGUSD_VOL_TARGET_TREND_V1_VERSION,
      US30_INDEX_OPENING_RANGE_MOMENTUM_V1,
      US30_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION,
      NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1,
      NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION,
      US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1,
      US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1_VERSION,
    } = loadSeedService();

    await seedService.ensureDefaultSymbolCustomDrafts();

    expect(records).toHaveLength(13);
    records.forEach((record) => {
      const isPaperCandidate = [
        'XTIUSD_OIL_BREAKOUT_RETEST_V1',
        'XBRUSD_OIL_LONG_RETEST_SESSION_V2',
      ].includes(record.symbolCustomName);
      expect(record.status).toBe(isPaperCandidate ? 'paper_testing' : 'draft');
      expect(record.paperEnabled).toBe(isPaperCandidate);
      expect(record.liveEnabled).toBe(false);
      expect(record.isPrimaryLive).toBe(false);
      expect(record.allowLive).toBe(false);
    });

    const usdjpy = records.find((record) => record.symbolCustomName === 'USDJPY_JPY_MACRO_REVERSAL_V1');
    expect(usdjpy.logicName).toBe(USDJPY_JPY_MACRO_REVERSAL_V1);
    expect(usdjpy.registryLogicName).toBe(USDJPY_JPY_MACRO_REVERSAL_V1);
    expect(usdjpy.version).toBe(USDJPY_JPY_MACRO_REVERSAL_V1_VERSION);
    expect(usdjpy.parameterSchema.map((field) => field.key)).toEqual([
      'lookbackBars',
      'impulseAtrMultiplier',
      'reversalConfirmBars',
      'rsiPeriod',
      'rsiOverbought',
      'rsiOversold',
      'atrPeriod',
      'slAtrMultiplier',
      'tpAtrMultiplier',
      'maxBarsInTrade',
      'minAtr',
      'cooldownBars',
      'enableBuy',
      'enableSell',
      'allowedUtcHours',
      'blockedUtcHours',
      'cooldownBarsAfterAnyExit',
      'cooldownBarsAfterSL',
      'maxDailyLosses',
      'maxDailyTrades',
      'maxRollingConsecutiveLosses',
      'rollingLossCooldownBars',
      'useHigherTrendFilter',
      'higherTrendSmaPeriod',
      'higherTrendAtrPeriod',
      'minHigherTrendDistanceAtr',
      'useHigherDriftFilter',
      'higherDriftLookbackBars',
      'minHigherDriftAtr',
    ]);

    const xauusd = records.find((record) => record.symbolCustomName === 'XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1');
    expect(xauusd.logicName).toBe(XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1);
    expect(xauusd.registryLogicName).toBe(XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1);
    expect(xauusd.version).toBe(XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1_VERSION);
    expect(xauusd.timeframes).toEqual({
      setupTimeframe: '5m',
      entryTimeframe: '5m',
      higherTimeframe: '15m',
    });
    expect(xauusd.paperEnabled).toBe(false);
    expect(xauusd.liveEnabled).toBe(false);
    expect(xauusd.parameterSchema.map((field) => field.key)).toEqual(expect.arrayContaining([
      'enableBreakout',
      'rvolContinuation',
      'allowedUtcHours',
      'allowUnknownSession',
      'slAtrMultiplier',
      'tpAtrMultiplier',
      'maxTradesPerDay',
      'maxRollingConsecutiveLosses',
      'rollingLossCooldownBars',
    ]));

    const xauusdMicrostructure = records.find((record) => record.symbolCustomName === 'XAUUSD_MICROSTRUCTURE_SCALP_V1');
    expect(xauusdMicrostructure.logicName).toBe(XAUUSD_MICROSTRUCTURE_SCALP_V1);
    expect(xauusdMicrostructure.registryLogicName).toBe(XAUUSD_MICROSTRUCTURE_SCALP_V1);
    expect(xauusdMicrostructure.version).toBe(XAUUSD_MICROSTRUCTURE_SCALP_V1_VERSION);
    expect(xauusdMicrostructure.timeframes).toEqual({
      setupTimeframe: '5m',
      entryTimeframe: '1m',
      higherTimeframe: '15m',
    });
    expect(xauusdMicrostructure.paperEnabled).toBe(false);
    expect(xauusdMicrostructure.liveEnabled).toBe(false);
    expect(xauusdMicrostructure.parameters.enabled).toBe(false);
    expect(xauusdMicrostructure.parameterSchema.map((field) => field.key)).toEqual(expect.arrayContaining([
      'riskReward',
      'tickProxyLookbackBars',
      'minDirectionalCloseRatio',
      'vwapReclaimToleranceAtr',
      'cooldownBarsAfterSL',
      'maxConsecutiveLosses',
      'minSignalScore',
    ]));

    const xauusdEma50Pullback = records.find((record) => record.symbolCustomName === 'XAUUSD_EMA50_PULLBACK_TREND_V1');
    expect(xauusdEma50Pullback.logicName).toBe(XAUUSD_EMA50_PULLBACK_TREND_V1);
    expect(xauusdEma50Pullback.registryLogicName).toBe(XAUUSD_EMA50_PULLBACK_TREND_V1);
    expect(xauusdEma50Pullback.version).toBe(XAUUSD_EMA50_PULLBACK_TREND_V1_VERSION);
    expect(xauusdEma50Pullback.timeframes).toEqual({
      setupTimeframe: '30m',
      entryTimeframe: '30m',
      higherTimeframe: '30m',
    });
    expect(xauusdEma50Pullback.paperEnabled).toBe(false);
    expect(xauusdEma50Pullback.liveEnabled).toBe(false);
    expect(xauusdEma50Pullback.parameters.enabled).toBe(false);
    expect(xauusdEma50Pullback.parameterSchema.map((field) => field.key)).toEqual(expect.arrayContaining([
      'trendEmaFast',
      'pullbackEma',
      'trendEmaSlow',
      'pullbackLookbackBars',
      'rsiMidline',
      'slAtrMultiplier',
      'riskReward',
      'maxBarsInTrade',
      'spreadAtrMaxRatio',
    ]));

    const xauusdVolumeProfile = records.find((record) => record.symbolCustomName === 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1');
    expect(xauusdVolumeProfile.logicName).toBe(XAUUSD_VOLUME_PROFILE_STRATEGY_V1);
    expect(xauusdVolumeProfile.registryLogicName).toBe(XAUUSD_VOLUME_PROFILE_STRATEGY_V1);
    expect(xauusdVolumeProfile.version).toBe(XAUUSD_VOLUME_PROFILE_STRATEGY_V1_VERSION);
    expect(xauusdVolumeProfile.timeframes).toEqual({
      setupTimeframe: '5m',
      entryTimeframe: '1m',
      higherTimeframe: '15m',
    });
    expect(xauusdVolumeProfile.paperEnabled).toBe(false);
    expect(xauusdVolumeProfile.liveEnabled).toBe(false);
    expect(xauusdVolumeProfile.parameters).toEqual(expect.objectContaining({
      enabled: true,
      strategyName: 'XAUUSD Volume Profile',
      enableBreakoutContinuation: true,
      enableExhaustionReversal: false,
      riskReward: 1.5,
      maxHoldingMinutes: 30,
      maxSpreadPoints: 35,
      maxTradesPerDay: 5,
      maxConsecutiveLossesPerDay: 2,
    }));
    expect(xauusdVolumeProfile.parameterSchema.map((field) => field.key)).toEqual(expect.arrayContaining([
      'strategyName',
      'symbols',
      'rvolContinuation',
      'rvolReversal',
      'vwapToleranceAtr',
      'maxHoldingMinutes',
      'cooldownMinutes',
      'maxTradesPerDay',
      'maxConsecutiveLossesPerDay',
    ]));

    const xtiusd = records.find((record) => record.symbolCustomName === 'XTIUSD_OIL_BREAKOUT_RETEST_V1');
    expect(xtiusd.logicName).toBe(XTIUSD_OIL_BREAKOUT_RETEST_V1);
    expect(xtiusd.registryLogicName).toBe(XTIUSD_OIL_BREAKOUT_RETEST_V1);
    expect(xtiusd.version).toBe(XTIUSD_OIL_BREAKOUT_RETEST_V1_VERSION);
    expect(xtiusd.riskConfig).toEqual(expect.objectContaining({ maxRiskPerTradePct: 0.25 }));
    expect(xtiusd.status).toBe('paper_testing');
    expect(xtiusd.paperEnabled).toBe(true);
    expect(xtiusd.liveEnabled).toBe(false);
    expect(xtiusd.allowLive).toBe(false);
    expect(xtiusd.isPrimaryLive).toBe(false);
    expect(xtiusd.parameters.allowedUtcHours).toBe('7,8,9,13,15,17');
    expect(xtiusd.parameters.maxDailyLosses).toBe(1);
    expect(xtiusd.parameters.minConfidence).toBe(0.68);

    const xbrusdLongRetest = records.find((record) => record.symbolCustomName === 'XBRUSD_OIL_LONG_RETEST_SESSION_V2');
    expect(xbrusdLongRetest.logicName).toBe(XBRUSD_OIL_LONG_RETEST_SESSION_V2);
    expect(xbrusdLongRetest.registryLogicName).toBe(XBRUSD_OIL_LONG_RETEST_SESSION_V2);
    expect(xbrusdLongRetest.version).toBe(XBRUSD_OIL_LONG_RETEST_SESSION_V2_VERSION);
    expect(xbrusdLongRetest.riskConfig).toEqual(expect.objectContaining({ maxRiskPerTradePct: 0.25 }));
    expect(xbrusdLongRetest.status).toBe('paper_testing');
    expect(xbrusdLongRetest.paperEnabled).toBe(true);
    expect(xbrusdLongRetest.liveEnabled).toBe(false);
    expect(xbrusdLongRetest.allowLive).toBe(false);
    expect(xbrusdLongRetest.isPrimaryLive).toBe(false);
    expect(xbrusdLongRetest.parameters.enableBuy).toBe(true);
    expect(xbrusdLongRetest.parameters.enableSell).toBe(false);
    expect(xbrusdLongRetest.parameters.allowedUtcHours).toBe('8,9,16,17');
    expect(xbrusdLongRetest.parameters.maxDailyLosses).toBe(1);

    const xagusd = records.find((record) => record.symbolCustomName === 'XAGUSD_VOL_TARGET_TREND_V1');
    expect(xagusd.logicName).toBe(XAGUSD_VOL_TARGET_TREND_V1);
    expect(xagusd.registryLogicName).toBe(XAGUSD_VOL_TARGET_TREND_V1);
    expect(xagusd.version).toBe(XAGUSD_VOL_TARGET_TREND_V1_VERSION);
    expect(xagusd.timeframes).toEqual({
      setupTimeframe: '1h',
      entryTimeframe: '1h',
      higherTimeframe: '4h',
    });
    expect(xagusd.riskConfig).toEqual(expect.objectContaining({ maxRiskPerTradePct: 0.5 }));
    expect(xagusd.paperEnabled).toBe(false);
    expect(xagusd.liveEnabled).toBe(false);
    expect(xagusd.parameters.enabled).toBe(false);
    expect(xagusd.parameterSchema.map((field) => field.key)).toEqual(expect.arrayContaining([
      'momentumLookbackBars',
      'higherMomentumLookbackBars',
      'breakoutLookbackBars',
      'minAtrRatio',
      'maxAtrRatio',
      'targetAtrRatio',
      'riskReward',
      'cooldownBarsAfterSL',
      'minSignalScore',
    ]));

    const us30 = records.find((record) => record.symbolCustomName === 'US30_INDEX_OPENING_RANGE_MOMENTUM_V1');
    expect(us30.logicName).toBe(US30_INDEX_OPENING_RANGE_MOMENTUM_V1);
    expect(us30.registryLogicName).toBe(US30_INDEX_OPENING_RANGE_MOMENTUM_V1);
    expect(us30.version).toBe(US30_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION);
    expect(us30.timeframes).toEqual({
      setupTimeframe: '15m',
      entryTimeframe: '5m',
      higherTimeframe: '1h',
    });
    expect(us30.riskConfig).toEqual(expect.objectContaining({ maxRiskPerTradePct: 0.35 }));
    expect(us30.paperEnabled).toBe(false);
    expect(us30.liveEnabled).toBe(false);
    expect(us30.parameters.enabled).toBe(false);
    expect(us30.parameterSchema.map((field) => field.key)).toEqual(expect.arrayContaining([
      'breakoutLookbackBars',
      'minBreakoutBodyAtr',
      'minRelativeVolume',
      'maxAtrSpikeRatio',
      'spreadAtrMaxRatio',
      'cooldownBarsAfterSL',
      'maxDailyLosses',
      'minSignalScore',
    ]));

    const nas100 = records.find((record) => record.symbolCustomName === 'NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1');
    expect(nas100.logicName).toBe(NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1);
    expect(nas100.registryLogicName).toBe(NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1);
    expect(nas100.version).toBe(NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION);
    expect(nas100.timeframes).toEqual({
      setupTimeframe: '15m',
      entryTimeframe: '5m',
      higherTimeframe: '1h',
    });
    expect(nas100.riskConfig).toEqual(expect.objectContaining({ maxRiskPerTradePct: 0.25 }));
    expect(nas100.paperEnabled).toBe(false);
    expect(nas100.liveEnabled).toBe(false);
    expect(nas100.parameters.enabled).toBe(false);
    expect(nas100.parameters.minSignalScore).toBe(55);
    expect(nas100.parameters.breakoutLookbackBars).toBe(14);
    expect(nas100.parameters.useVolumeFilter).toBe(false);
    expect(nas100.parameters.minRelativeVolume).toBe(0);
    expect(nas100.parameterSchema.map((field) => field.key)).toEqual(expect.arrayContaining([
      'breakoutLookbackBars',
      'minBreakoutBodyAtr',
      'minRelativeVolume',
      'maxAtrSpikeRatio',
      'spreadAtrMaxRatio',
      'cooldownBarsAfterSL',
      'maxDailyLosses',
      'minSignalScore',
    ]));

    const us30FailedBreakoutFade = records.find((record) => record.symbolCustomName === 'US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1');
    expect(us30FailedBreakoutFade.logicName).toBe(US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1);
    expect(us30FailedBreakoutFade.registryLogicName).toBe(US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1);
    expect(us30FailedBreakoutFade.version).toBe(US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1_VERSION);
    expect(us30FailedBreakoutFade.timeframes).toEqual({
      setupTimeframe: '15m',
      entryTimeframe: '5m',
      higherTimeframe: '1h',
    });
    expect(us30FailedBreakoutFade.riskConfig).toEqual(expect.objectContaining({ maxRiskPerTradePct: 0.25 }));
    expect(us30FailedBreakoutFade.paperEnabled).toBe(false);
    expect(us30FailedBreakoutFade.liveEnabled).toBe(false);
    expect(us30FailedBreakoutFade.parameters.enabled).toBe(false);
    expect(us30FailedBreakoutFade.parameters.targetMode).toBe('opposite_boundary');
    expect(us30FailedBreakoutFade.parameters.minTargetR).toBe(0.3);
    expect(us30FailedBreakoutFade.parameters.minSignalScore).toBe(55);
    expect(us30FailedBreakoutFade.parameters.blockStrongHigherTrend).toBe(false);
    expect(us30FailedBreakoutFade.parameters.maxDailyLosses).toBe(1);
    expect(us30FailedBreakoutFade.parameterSchema.map((field) => field.key)).toEqual(expect.arrayContaining([
      'rangeStartUtcHour',
      'openingRangeBars',
      'failedBreakoutLookbackBars',
      'requireRejectionCandle',
      'blockStrongHigherTrend',
      'targetMode',
      'minTargetR',
      'maxDailyLosses',
      'minSignalScore',
    ]));

    records
      .filter((record) => ![
        'USDJPY_JPY_MACRO_REVERSAL_V1',
        'XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1',
        'XAUUSD_MICROSTRUCTURE_SCALP_V1',
        'XAUUSD_EMA50_PULLBACK_TREND_V1',
        'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
        'XTIUSD_OIL_BREAKOUT_RETEST_V1',
        'XBRUSD_OIL_LONG_RETEST_SESSION_V2',
        'XAGUSD_VOL_TARGET_TREND_V1',
        'US30_INDEX_OPENING_RANGE_MOMENTUM_V1',
        'NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1',
        'US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1',
      ].includes(record.symbolCustomName))
      .forEach((record) => {
        expect(record.logicName).toBe(PLACEHOLDER_SYMBOL_CUSTOM);
        expect(record.parameterSchema.map((field) => field.key)).toEqual([
          'lookbackBars',
          'slAtrMultiplier',
          'tpAtrMultiplier',
          'beTriggerR',
          'maxConsecutiveLosses',
        ]);
      });
  });

  test('existing defaults are not overwritten', async () => {
    const { seedService, records } = loadSeedService({
      records: [
        {
          _id: 'existing-usdjpy',
          symbol: 'USDJPY',
          symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
          displayName: 'User Edited Name',
          status: 'validated',
          paperEnabled: true,
          liveEnabled: false,
          isPrimaryLive: false,
          allowLive: false,
          logicName: 'USER_SELECTED_PLACEHOLDER',
        },
      ],
    });

    const result = await seedService.ensureDefaultSymbolCustomDrafts();

    expect(result.createdCount).toBe(12);
    expect(result.existingCount).toBe(1);
    expect(records).toHaveLength(13);
    expect(records.find((record) => record._id === 'existing-usdjpy')).toEqual(expect.objectContaining({
      displayName: 'User Edited Name',
      status: 'validated',
      paperEnabled: true,
      logicName: 'USER_SELECTED_PLACEHOLDER',
    }));
  });
});
