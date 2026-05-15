const { PLACEHOLDER_SYMBOL_CUSTOM } = require('../symbolCustom/logics/PlaceholderSymbolCustom');
const UsdjpyJpyMacroReversalV1 = require('../symbolCustom/logics/UsdjpyJpyMacroReversalV1');

const {
  USDJPY_JPY_MACRO_REVERSAL_V1,
  USDJPY_JPY_MACRO_REVERSAL_V1_VERSION,
} = UsdjpyJpyMacroReversalV1;
const usdjpyMacroReversal = new UsdjpyJpyMacroReversalV1();

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
