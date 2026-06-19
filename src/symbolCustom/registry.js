const PlaceholderSymbolCustom = require('./logics/PlaceholderSymbolCustom');
const UsdjpyJpyMacroReversalV1 = require('./logics/UsdjpyJpyMacroReversalV1');
const XauusdVolumeFlowBreakoutNyV1 = require('./logics/XauusdVolumeFlowBreakoutNyV1');
const XauusdMicrostructureScalpV1 = require('./logics/XauusdMicrostructureScalpV1');
const XauusdEma50PullbackTrendV1 = require('./logics/XauusdEma50PullbackTrendV1');
const XauusdVolumeProfileStrategyV1 = require('./logics/XauusdVolumeProfileStrategyV1');
const XtiusdOilBreakoutRetestV1 = require('./logics/XtiusdOilBreakoutRetestV1');
const XbrusdOilLongRetestSessionV2 = require('./logics/XbrusdOilLongRetestSessionV2');
const XagusdVolTargetTrendV1 = require('./logics/XagusdVolTargetTrendV1');
const Us30IndexOpeningRangeMomentumV1 = require('./logics/Us30IndexOpeningRangeMomentumV1');
const Nas100IndexOpeningRangeMomentumV1 = require('./logics/Nas100IndexOpeningRangeMomentumV1');
const Us30OpeningRangeFailedBreakoutFadeV1 = require('./logics/Us30OpeningRangeFailedBreakoutFadeV1');

const { PLACEHOLDER_SYMBOL_CUSTOM } = PlaceholderSymbolCustom;
const { USDJPY_JPY_MACRO_REVERSAL_V1 } = UsdjpyJpyMacroReversalV1;
const { XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1 } = XauusdVolumeFlowBreakoutNyV1;
const { XAUUSD_MICROSTRUCTURE_SCALP_V1 } = XauusdMicrostructureScalpV1;
const { XAUUSD_EMA50_PULLBACK_TREND_V1 } = XauusdEma50PullbackTrendV1;
const { XAUUSD_VOLUME_PROFILE_STRATEGY_V1 } = XauusdVolumeProfileStrategyV1;
const { XTIUSD_OIL_BREAKOUT_RETEST_V1 } = XtiusdOilBreakoutRetestV1;
const { XBRUSD_OIL_LONG_RETEST_SESSION_V2 } = XbrusdOilLongRetestSessionV2;
const { XAGUSD_VOL_TARGET_TREND_V1 } = XagusdVolTargetTrendV1;
const { US30_INDEX_OPENING_RANGE_MOMENTUM_V1 } = Us30IndexOpeningRangeMomentumV1;
const { NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1 } = Nas100IndexOpeningRangeMomentumV1;
const { US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1 } = Us30OpeningRangeFailedBreakoutFadeV1;

const SYMBOL_CUSTOM_REGISTRY = Object.freeze({
  [PLACEHOLDER_SYMBOL_CUSTOM]: PlaceholderSymbolCustom,
  [USDJPY_JPY_MACRO_REVERSAL_V1]: UsdjpyJpyMacroReversalV1,
  [XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1]: XauusdVolumeFlowBreakoutNyV1,
  [XAUUSD_MICROSTRUCTURE_SCALP_V1]: XauusdMicrostructureScalpV1,
  [XAUUSD_EMA50_PULLBACK_TREND_V1]: XauusdEma50PullbackTrendV1,
  [XAUUSD_VOLUME_PROFILE_STRATEGY_V1]: XauusdVolumeProfileStrategyV1,
  [XTIUSD_OIL_BREAKOUT_RETEST_V1]: XtiusdOilBreakoutRetestV1,
  [XBRUSD_OIL_LONG_RETEST_SESSION_V2]: XbrusdOilLongRetestSessionV2,
  [XAGUSD_VOL_TARGET_TREND_V1]: XagusdVolTargetTrendV1,
  [US30_INDEX_OPENING_RANGE_MOMENTUM_V1]: Us30IndexOpeningRangeMomentumV1,
  [NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1]: Nas100IndexOpeningRangeMomentumV1,
  [US30_OPENING_RANGE_FAILED_BREAKOUT_FADE_V1]: Us30OpeningRangeFailedBreakoutFadeV1,
});

function normalizeSymbolCustomName(symbolCustomName) {
  return String(symbolCustomName || '').trim();
}

function getSymbolCustomLogic(symbolCustomName) {
  const normalizedName = normalizeSymbolCustomName(symbolCustomName);
  const SymbolCustomClass = SYMBOL_CUSTOM_REGISTRY[normalizedName];
  return SymbolCustomClass ? new SymbolCustomClass() : null;
}

function listRegisteredSymbolCustomLogics() {
  return Object.keys(SYMBOL_CUSTOM_REGISTRY).map((name) => ({
    name,
  }));
}

function isSymbolCustomRegistered(symbolCustomName) {
  const normalizedName = normalizeSymbolCustomName(symbolCustomName);
  return Boolean(SYMBOL_CUSTOM_REGISTRY[normalizedName]);
}

module.exports = {
  SYMBOL_CUSTOM_REGISTRY,
  getSymbolCustomLogic,
  listRegisteredSymbolCustomLogics,
  isSymbolCustomRegistered,
};
