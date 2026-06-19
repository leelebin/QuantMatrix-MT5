const { PLACEHOLDER_SYMBOL_CUSTOM } = require('../symbolCustom/logics/PlaceholderSymbolCustom');
const UsdjpyJpyMacroReversalV1 = require('../symbolCustom/logics/UsdjpyJpyMacroReversalV1');
const XauusdVolumeFlowBreakoutNyV1 = require('../symbolCustom/logics/XauusdVolumeFlowBreakoutNyV1');
const XauusdMicrostructureScalpV1 = require('../symbolCustom/logics/XauusdMicrostructureScalpV1');
const XauusdEma50PullbackTrendV1 = require('../symbolCustom/logics/XauusdEma50PullbackTrendV1');
const XauusdVolumeProfileStrategyV1 = require('../symbolCustom/logics/XauusdVolumeProfileStrategyV1');
const XtiusdOilBreakoutRetestV1 = require('../symbolCustom/logics/XtiusdOilBreakoutRetestV1');
const XbrusdOilLongRetestSessionV2 = require('../symbolCustom/logics/XbrusdOilLongRetestSessionV2');
const XagusdVolTargetTrendV1 = require('../symbolCustom/logics/XagusdVolTargetTrendV1');
const Us30IndexOpeningRangeMomentumV1 = require('../symbolCustom/logics/Us30IndexOpeningRangeMomentumV1');
const Nas100IndexOpeningRangeMomentumV1 = require('../symbolCustom/logics/Nas100IndexOpeningRangeMomentumV1');
const Us30OpeningRangeFailedBreakoutFadeV1 = require('../symbolCustom/logics/Us30OpeningRangeFailedBreakoutFadeV1');

const {
  USDJPY_JPY_MACRO_REVERSAL_V1,
  USDJPY_JPY_MACRO_REVERSAL_V1_VERSION,
} = UsdjpyJpyMacroReversalV1;
const {
  XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1,
  XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1_VERSION,
} = XauusdVolumeFlowBreakoutNyV1;
const {
  XAUUSD_MICROSTRUCTURE_SCALP_V1,
  XAUUSD_MICROSTRUCTURE_SCALP_V1_VERSION,
} = XauusdMicrostructureScalpV1;
const {
  XAUUSD_EMA50_PULLBACK_TREND_V1,
  XAUUSD_EMA50_PULLBACK_TREND_V1_VERSION,
} = XauusdEma50PullbackTrendV1;
const {
  XAUUSD_VOLUME_PROFILE_STRATEGY_V1,
  XAUUSD_VOLUME_PROFILE_STRATEGY_V1_VERSION,
} = XauusdVolumeProfileStrategyV1;
const {
  XTIUSD_OIL_BREAKOUT_RETEST_V1,
  XTIUSD_OIL_BREAKOUT_RETEST_V1_VERSION,
} = XtiusdOilBreakoutRetestV1;
const {
  XBRUSD_OIL_LONG_RETEST_SESSION_V2,
  XBRUSD_OIL_LONG_RETEST_SESSION_V2_VERSION,
} = XbrusdOilLongRetestSessionV2;
const {
  XAGUSD_VOL_TARGET_TREND_V1,
  XAGUSD_VOL_TARGET_TREND_V1_VERSION,
} = XagusdVolTargetTrendV1;
const {
  US30_INDEX_OPENING_RANGE_MOMENTUM_V1,
  US30_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION,
} = Us30IndexOpeningRangeMomentumV1;
const {
  NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1,
  NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION,
} = Nas100IndexOpeningRangeMomentumV1;
const {
  US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1,
  US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1_VERSION,
} = Us30OpeningRangeFailedBreakoutFadeV1;
const usdjpyMacroReversal = new UsdjpyJpyMacroReversalV1();
const xauusdBreakoutNy = new XauusdVolumeFlowBreakoutNyV1();
const xauusdMicrostructureScalp = new XauusdMicrostructureScalpV1();
const xauusdEma50PullbackTrend = new XauusdEma50PullbackTrendV1();
const xauusdVolumeProfileStrategy = new XauusdVolumeProfileStrategyV1();
const xtiusdOilRetest = new XtiusdOilBreakoutRetestV1();
const xbrusdOilLongRetestSession = new XbrusdOilLongRetestSessionV2();
const xagusdVolTargetTrend = new XagusdVolTargetTrendV1();
const us30IndexOpeningRangeMomentum = new Us30IndexOpeningRangeMomentumV1();
const nas100IndexOpeningRangeMomentum = new Nas100IndexOpeningRangeMomentumV1();
const us30OpeningRangeFailedBreakoutFade = new Us30OpeningRangeFailedBreakoutFadeV1();

const GENERIC_SYMBOL_CUSTOM_PARAMETER_SCHEMA = Object.freeze([
  {
    key: 'lookbackBars',
    label: 'Lookback Bars',
    type: 'number',
    defaultValue: 50,
    min: 1,
    step: 1,
  },
  {
    key: 'slAtrMultiplier',
    label: 'SL ATR Multiplier',
    type: 'number',
    defaultValue: 1.5,
    min: 0.1,
    step: 0.1,
  },
  {
    key: 'tpAtrMultiplier',
    label: 'TP ATR Multiplier',
    type: 'number',
    defaultValue: 2,
    min: 0.1,
    step: 0.1,
  },
  {
    key: 'beTriggerR',
    label: 'BE Trigger R',
    type: 'number',
    defaultValue: 1,
    min: 0,
    step: 0.1,
  },
  {
    key: 'maxConsecutiveLosses',
    label: 'Max Consecutive Losses',
    type: 'number',
    defaultValue: 3,
    min: 1,
    step: 1,
  },
]);

const DEFAULT_TIMEFRAMES = Object.freeze({
  setupTimeframe: '15m',
  entryTimeframe: '5m',
  higherTimeframe: '1h',
});

const XAUUSD_VOLUME_FLOW_TIMEFRAMES = Object.freeze({
  setupTimeframe: '5m',
  entryTimeframe: '5m',
  higherTimeframe: '15m',
});

const XAUUSD_MICROSTRUCTURE_SCALP_TIMEFRAMES = Object.freeze({
  setupTimeframe: '5m',
  entryTimeframe: '1m',
  higherTimeframe: '15m',
});

const XAUUSD_EMA50_PULLBACK_TREND_TIMEFRAMES = Object.freeze({
  setupTimeframe: '30m',
  entryTimeframe: '30m',
  higherTimeframe: '30m',
});

const XAUUSD_VOLUME_PROFILE_STRATEGY_TIMEFRAMES = Object.freeze({
  setupTimeframe: '5m',
  entryTimeframe: '1m',
  higherTimeframe: '15m',
});

const OIL_BREAKOUT_RETEST_TIMEFRAMES = Object.freeze({
  setupTimeframe: '1h',
  entryTimeframe: '5m',
  higherTimeframe: '4h',
});

const XAGUSD_VOL_TARGET_TREND_TIMEFRAMES = Object.freeze({
  setupTimeframe: '1h',
  entryTimeframe: '1h',
  higherTimeframe: '4h',
});

const INDEX_OPENING_RANGE_MOMENTUM_TIMEFRAMES = Object.freeze({
  setupTimeframe: '15m',
  entryTimeframe: '5m',
  higherTimeframe: '1h',
});

const DEFAULT_SYMBOL_CUSTOM_DRAFTS = Object.freeze([
  {
    symbol: 'USDJPY',
    symbolCustomName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
    displayName: 'USDJPY JPY Macro Reversal V1',
    status: 'draft',
    paperEnabled: false,
    liveEnabled: false,
    isPrimaryLive: false,
    allowLive: false,
    version: USDJPY_JPY_MACRO_REVERSAL_V1_VERSION,
    logicName: USDJPY_JPY_MACRO_REVERSAL_V1,
    registryLogicName: USDJPY_JPY_MACRO_REVERSAL_V1,
    timeframes: DEFAULT_TIMEFRAMES,
    parameterSchema: usdjpyMacroReversal.getDefaultParameterSchema(),
    parameters: usdjpyMacroReversal.getDefaultParameters(),
    hypothesis: 'USDJPY may react strongly to JPY macro repricing, USD rate expectations, Tokyo/London session transitions.',
  },
  {
    symbol: 'XAUUSD',
    symbolCustomName: 'XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1',
    displayName: 'XAUUSD Volume Flow Breakout NY V1',
    status: 'draft',
    paperEnabled: false,
    liveEnabled: false,
    isPrimaryLive: false,
    allowLive: false,
    version: XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1_VERSION,
    logicName: XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1,
    registryLogicName: XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1,
    timeframes: XAUUSD_VOLUME_FLOW_TIMEFRAMES,
    parameterSchema: xauusdBreakoutNy.getDefaultParameterSchema(),
    parameters: xauusdBreakoutNy.getDefaultParameters(),
    hypothesis: 'XAUUSD showed candidate edge in UTC 15-17 New York high-RVOL breakout continuation tests with RVOL 2.8, 2 ATR SL and 5 ATR TP; this draft remains backtest-only until further out-of-sample validation.',
  },
  {
    symbol: 'XAUUSD',
    symbolCustomName: 'XAUUSD_EMA50_PULLBACK_TREND_V1',
    displayName: 'XAUUSD EMA50 Pullback Trend V1',
    status: 'draft',
    paperEnabled: false,
    liveEnabled: false,
    isPrimaryLive: false,
    allowLive: false,
    version: XAUUSD_EMA50_PULLBACK_TREND_V1_VERSION,
    logicName: XAUUSD_EMA50_PULLBACK_TREND_V1,
    registryLogicName: XAUUSD_EMA50_PULLBACK_TREND_V1,
    timeframes: XAUUSD_EMA50_PULLBACK_TREND_TIMEFRAMES,
    parameterSchema: xauusdEma50PullbackTrend.getDefaultParameterSchema(),
    parameters: xauusdEma50PullbackTrend.getDefaultParameters(),
    hypothesis: 'XAUUSD M30 showed a trend-dominant structure over the last year; this draft tests the EMA200/EMA50 trend filter, EMA50 pullback, EMA20 reclaim, RSI50 momentum confirmation, 2 ATR stop, 1.5R target, and 96-bar timeout as a backtest/paper candidate.',
  },
  {
    symbol: 'XAUUSD',
    symbolCustomName: 'XAUUSD_VOLUME_PROFILE_STRATEGY_V1',
    displayName: 'XAUUSD Volume Profile Strategy V1',
    status: 'draft',
    paperEnabled: false,
    liveEnabled: false,
    isPrimaryLive: false,
    allowLive: false,
    version: XAUUSD_VOLUME_PROFILE_STRATEGY_V1_VERSION,
    logicName: XAUUSD_VOLUME_PROFILE_STRATEGY_V1,
    registryLogicName: XAUUSD_VOLUME_PROFILE_STRATEGY_V1,
    timeframes: XAUUSD_VOLUME_PROFILE_STRATEGY_TIMEFRAMES,
    parameterSchema: xauusdVolumeProfileStrategy.getDefaultParameterSchema(),
    parameters: xauusdVolumeProfileStrategy.getDefaultParameters(),
    hypothesis: 'XAUUSD M1/M5 short-term XAUUSD Volume Profile SymbolCustom logic: M5 EMA20/EMA50 trend, M1 high-RVOL 8-bar structure breakout, VWAP continuation filter, UTC 01-05 and 15-18 entry sessions, fixed SL/TP at 1:1.5, 30-minute timeout, spread/cooldown/daily trade and consecutive-loss guards. Reversal module is implemented but disabled by default.',
  },
  {
    symbol: 'XAUUSD',
    symbolCustomName: 'XAUUSD_MICROSTRUCTURE_SCALP_V1',
    displayName: 'XAUUSD Microstructure Scalp V1',
    status: 'draft',
    paperEnabled: false,
    liveEnabled: false,
    isPrimaryLive: false,
    allowLive: false,
    version: XAUUSD_MICROSTRUCTURE_SCALP_V1_VERSION,
    logicName: XAUUSD_MICROSTRUCTURE_SCALP_V1,
    registryLogicName: XAUUSD_MICROSTRUCTURE_SCALP_V1,
    timeframes: XAUUSD_MICROSTRUCTURE_SCALP_TIMEFRAMES,
    parameterSchema: xauusdMicrostructureScalp.getDefaultParameterSchema(),
    parameters: xauusdMicrostructureScalp.getDefaultParameters(),
    hypothesis: 'XAUUSD microstructure-inspired scalping draft using M5/M15 direction filters with M1/tick-proxy order-flow evidence, spread/ATR filters, fixed SL/TP, timeout, cooldown, and local loss guards. Default parameters keep logic disabled until explicitly enabled for backtest/paper validation.',
  },
  {
    symbol: 'XTIUSD',
    symbolCustomName: 'XTIUSD_OIL_BREAKOUT_RETEST_V1',
    displayName: 'XTIUSD Oil Breakout Retest V1',
    status: 'paper_testing',
    paperEnabled: true,
    liveEnabled: false,
    isPrimaryLive: false,
    allowLive: false,
    version: XTIUSD_OIL_BREAKOUT_RETEST_V1_VERSION,
    logicName: XTIUSD_OIL_BREAKOUT_RETEST_V1,
    registryLogicName: XTIUSD_OIL_BREAKOUT_RETEST_V1,
    timeframes: OIL_BREAKOUT_RETEST_TIMEFRAMES,
    riskConfig: {
      maxRiskPerTradePct: 0.25,
    },
    parameterSchema: xtiusdOilRetest.getDefaultParameterSchema(),
    parameters: {
      ...xtiusdOilRetest.getDefaultParameters(),
      allowedUtcHours: '7,8,9,13,15,17',
      maxDailyLosses: 1,
      minConfidence: 0.68,
    },
    hypothesis: 'XTIUSD old Breakout follow-up losses showed oil continuation needs retest confirmation, session filtering, and daily guardrails. This paper-testing candidate keeps only UTC 7,8,9,13,15,17, with maxDailyLosses=1 and minConfidence=0.68. Live remains disabled until forward paper evidence confirms the filtered edge.',
    designNotes: '2026-06-15 closed-candle validation found a positive but not live-ready XTIUSD oil breakout-retest edge. Initial conservative candidate used maxDailyLosses=1 and minConfidence=0.68. 2026-06-16 half-year diagnostics showed the broad-hour version still had a losing 2025_H1 segment: 56 trades, net -2.0568, PF 0.9515, avgR -0.0276, maxCL 6, with persistent weakness in UTC 10/18 and recent weakness in 14/16. Filtered paper candidate keeps UTC 7,8,9,13,15,17. Filtered replay at 0.25% risk: full 2025-01-01..2026-06-05 113 trades, net +40.5019, PF 1.5739, avgR +0.2778, maxDD 11.4601, maxCL 4; recent six months 40 trades, net +29.4753, PF 2.5141, avgR +0.5751, maxCL 3; 2025_H1 39 trades, net +6.8674, PF 1.2613; 2025_H2 42 trades, net +14.6571, PF 1.5752; 2026_H1 30 trades, net +20.5943, PF 2.3398. Promote/keep only as paper_testing; liveEnabled/allowLive/isPrimaryLive remain false pending forward paper sample.',
  },
  {
    symbol: 'XBRUSD',
    symbolCustomName: 'XBRUSD_OIL_LONG_RETEST_SESSION_V2',
    displayName: 'XBRUSD Oil Long Retest Session V2',
    status: 'paper_testing',
    paperEnabled: true,
    liveEnabled: false,
    isPrimaryLive: false,
    allowLive: false,
    version: XBRUSD_OIL_LONG_RETEST_SESSION_V2_VERSION,
    logicName: XBRUSD_OIL_LONG_RETEST_SESSION_V2,
    registryLogicName: XBRUSD_OIL_LONG_RETEST_SESSION_V2,
    timeframes: OIL_BREAKOUT_RETEST_TIMEFRAMES,
    riskConfig: {
      maxRiskPerTradePct: 0.25,
    },
    parameterSchema: xbrusdOilLongRetestSession.getDefaultParameterSchema(),
    parameters: xbrusdOilLongRetestSession.getDefaultParameters(),
    hypothesis: 'XBRUSD V1 oil breakout-retest failed because short-side and late/early weak-hour exposure overwhelmed the edge. This V2 keeps only the observed Brent long retest session pocket: BUY-only after confirmed oil breakout retest in UTC 8,9,16,17, with one daily loss. It is paper-testing only; live remains disabled until forward sample size and walk-forward stability improve.',
    designNotes: '2026-06-16 diagnostics of archived XBRUSD_OIL_BREAKOUT_RETEST_V1 candidate 1: full 2025-01-01..2026-06-05 was negative overall (157 trades, net -45.8656 at 1% default risk, PF 0.8942). Losses concentrated in SELL (-47.0574 net) and UTC hours 18/13/10. A BUY-only filtered session test using UTC 8,9,16,17 improved to 47 trades, PF 1.4068, avgR +0.2172, max consecutive losses 4. V2 default 0.25% risk replay: full net +12.8056, PF 1.4208, maxDD 6.4215; recent six months 22 trades, net +10.2507, PF 1.8030, maxCL 3. Half-year split: 2025_H1 12 trades, net +0.4141, PF 1.0473, avgR +0.0295, maxCL 3; 2025_H2 15 trades, net +5.5922, PF 1.6324, avgR +0.2985, maxCL 4; 2026_H1 20 trades, net +6.7139, PF 1.5296, avgR +0.2689, maxCL 3. Because 2025_H1 is barely positive and total sample is small, promote only to paper_testing for forward observation; liveEnabled/allowLive/isPrimaryLive remain false.',
  },
  {
    symbol: 'XAGUSD',
    symbolCustomName: 'XAGUSD_VOL_TARGET_TREND_V1',
    displayName: 'XAGUSD Vol Target Trend V1',
    status: 'draft',
    paperEnabled: false,
    liveEnabled: false,
    isPrimaryLive: false,
    allowLive: false,
    version: XAGUSD_VOL_TARGET_TREND_V1_VERSION,
    logicName: XAGUSD_VOL_TARGET_TREND_V1,
    registryLogicName: XAGUSD_VOL_TARGET_TREND_V1,
    timeframes: XAGUSD_VOL_TARGET_TREND_TIMEFRAMES,
    riskConfig: {
      maxRiskPerTradePct: 0.5,
    },
    parameterSchema: xagusdVolTargetTrend.getDefaultParameterSchema(),
    parameters: xagusdVolTargetTrend.getDefaultParameters(),
    hypothesis: 'Strict validation found XAGUSD trend candidates had the strongest fixed-parameter edge but still suffered clustered drawdowns. This draft translates time-series momentum and volatility-managed portfolio research into a slower 1h/4h XAGUSD trend-following logic with ATR regime bounds, ATR spike avoidance, breakout confirmation, conservative 0.5% risk, cooldown, and time exits. It stays paper-disabled until dedicated SymbolCustom validation passes.',
  },
  {
    symbol: 'US30',
    symbolCustomName: 'US30_INDEX_OPENING_RANGE_MOMENTUM_V1',
    displayName: 'US30 Index Opening Range Momentum V1',
    status: 'draft',
    paperEnabled: false,
    liveEnabled: false,
    isPrimaryLive: false,
    allowLive: false,
    version: US30_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION,
    logicName: US30_INDEX_OPENING_RANGE_MOMENTUM_V1,
    registryLogicName: US30_INDEX_OPENING_RANGE_MOMENTUM_V1,
    timeframes: INDEX_OPENING_RANGE_MOMENTUM_TIMEFRAMES,
    riskConfig: {
      maxRiskPerTradePct: 0.35,
    },
    parameterSchema: us30IndexOpeningRangeMomentum.getDefaultParameterSchema(),
    parameters: us30IndexOpeningRangeMomentum.getDefaultParameters(),
    hypothesis: 'US30 generic breakout results were too direction-error prone around headline moves. This draft tests a more selective 15m/5m index opening-range momentum continuation: higher-timeframe EMA alignment, prior-range breakout, minimum body and momentum in ATR units, relative-volume confirmation, spread/ATR cost filter, daily loss guard, cooldown after SL, and time exit. It stays draft/paper-disabled until broad out-of-sample validation proves an edge.',
    designNotes: '2026-06-15 closed-candle validation: strict default screen produced too few losing trades. Relaxed opening-range momentum candidate 7 (all UTC hours, no volume filter, 14-bar breakout) still failed full 2025-2026 validation: 676 trades, net -13.7774, PF 0.9774, maxDD 53.1942, max consecutive losses 11. Treat this US30 logic family as not live-ready; next iteration should use a different US30 thesis rather than more minor parameter tuning.',
  },
  {
    symbol: 'NAS100',
    symbolCustomName: 'NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1',
    displayName: 'NAS100 Index Opening Range Momentum V1',
    status: 'draft',
    paperEnabled: false,
    liveEnabled: false,
    isPrimaryLive: false,
    allowLive: false,
    version: NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION,
    logicName: NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1,
    registryLogicName: NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1,
    timeframes: INDEX_OPENING_RANGE_MOMENTUM_TIMEFRAMES,
    riskConfig: {
      maxRiskPerTradePct: 0.25,
    },
    parameterSchema: nas100IndexOpeningRangeMomentum.getDefaultParameterSchema(),
    parameters: {
      ...nas100IndexOpeningRangeMomentum.getDefaultParameters(),
      allowedUtcHours: [],
      minSignalScore: 55,
      breakoutLookbackBars: 14,
      minRelativeVolume: 0,
      useVolumeFilter: false,
      breakoutBufferAtr: 0.03,
      maxPreBreakoutRangeAtr: 8,
      maxExtensionAtr: 8,
      maxAtrRatio: 4,
      maxAtrSpikeRatio: 5,
      spreadAtrMaxRatio: 0.2,
    },
    hypothesis: 'NAS100 generic breakout behavior needs stronger trend and volatility gating before live consideration. This draft uses the same index opening-range continuation structure as US30 with a stricter score threshold, lower spread tolerance, relative-volume confirmation, ATR-regime bounds, daily loss guard, cooldown after SL, and time exit. It stays draft/paper-disabled until validation proves stable OOS behavior.',
    designNotes: '2026-06-15 closed-candle validation removed an intra-15m lookahead risk. Current best research candidate is broad-hours, no-volume-filter, 14-bar breakout momentum. Full 2025-2026: 868 trades, net +131.8296, PF 1.1576, maxDD 35.2981, max consecutive losses 10. Recent six months: 296 trades, net +42.3126, PF 1.1601. This is only a weak research edge, not live-ready; require OOS/walk-forward, drawdown guard, and paper observation before promotion.',
  },
  {
    symbol: 'US30',
    symbolCustomName: 'US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1',
    displayName: 'US30 Opening Range Failed Breakout Fade V1',
    status: 'draft',
    paperEnabled: false,
    liveEnabled: false,
    isPrimaryLive: false,
    allowLive: false,
    version: US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1_VERSION,
    logicName: US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1,
    registryLogicName: US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1,
    timeframes: INDEX_OPENING_RANGE_MOMENTUM_TIMEFRAMES,
    riskConfig: {
      maxRiskPerTradePct: 0.25,
    },
    parameterSchema: us30OpeningRangeFailedBreakoutFade.getDefaultParameterSchema(),
    parameters: {
      ...us30OpeningRangeFailedBreakoutFade.getDefaultParameters(),
      targetMode: 'opposite_boundary',
      minTargetR: 0.3,
      minSignalScore: 55,
      blockStrongHigherTrend: false,
    },
    hypothesis: 'US30 V1 opening-range continuation repeatedly failed because broad breakout chasing had direction errors and clustered losses. This V2 tests the opposite thesis: wait for the US cash-session opening range to break, require price to reclaim back inside the range on a closed bar, then fade the failed breakout toward range mid/opposite boundary with strict daily-loss and cooldown guardrails.',
    designNotes: 'Created after archiving US30_INDEX_OPENING_RANGE_MOMENTUM_V1. Default remains disabled. 2026-06-16 focused candidate 21 reproduced the best V2 thesis on 2026-01-01..2026-06-05: 131 trades, net +14.1073, PF 1.2026, avgR +0.0863, maxDD 20.1808, max consecutive losses 6, using opposite_boundary target, minSignalScore=55, minTargetR=0.3, failedBreakoutLookbackBars=12, blockStrongHigherTrend=false. This is a weak research edge only; maxDD and clustered loss risk are still too high for paper/live. Continue grid/OOS filtering before enabling.',
  },
  {
    symbol: 'GBPJPY',
    symbolCustomName: 'GBPJPY_VOLATILITY_BREAKOUT_V1',
    displayName: 'GBPJPY Volatility Breakout V1',
    status: 'draft',
    paperEnabled: false,
    liveEnabled: false,
    isPrimaryLive: false,
    allowLive: false,
    logicName: PLACEHOLDER_SYMBOL_CUSTOM,
    timeframes: DEFAULT_TIMEFRAMES,
    parameterSchema: GENERIC_SYMBOL_CUSTOM_PARAMETER_SCHEMA,
    parameters: {},
    hypothesis: 'GBPJPY is high volatility JPY cross; potential edge may come from London session volatility expansion and risk-on/risk-off flows.',
  },
  {
    symbol: 'AUDUSD',
    symbolCustomName: 'AUDUSD_SESSION_PULLBACK_V1',
    displayName: 'AUDUSD Session Pullback V1',
    status: 'draft',
    paperEnabled: false,
    liveEnabled: false,
    isPrimaryLive: false,
    allowLive: false,
    logicName: PLACEHOLDER_SYMBOL_CUSTOM,
    timeframes: DEFAULT_TIMEFRAMES,
    parameterSchema: GENERIC_SYMBOL_CUSTOM_PARAMETER_SCHEMA,
    parameters: {},
    hypothesis: 'AUDUSD may require commodity currency / Asia session / risk sentiment specific pullback logic instead of generic momentum.',
  },
]);

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function getDefaultSymbolCustomDrafts() {
  return cloneValue(DEFAULT_SYMBOL_CUSTOM_DRAFTS);
}

module.exports = {
  GENERIC_SYMBOL_CUSTOM_PARAMETER_SCHEMA,
  DEFAULT_SYMBOL_CUSTOM_DRAFTS,
  getDefaultSymbolCustomDrafts,
};
