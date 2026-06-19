const OilBreakoutRetestBase = require('./OilBreakoutRetestBase');

const XBRUSD_OIL_LONG_RETEST_SESSION_V2 = 'XBRUSD_OIL_LONG_RETEST_SESSION_V2';
const XBRUSD_OIL_LONG_RETEST_SESSION_V2_VERSION = 1;
const CANDIDATE_PRESET = 'xbrusd_oil_long_retest_session_v2';

class XbrusdOilLongRetestSessionV2 extends OilBreakoutRetestBase {
  constructor() {
    super({
      name: XBRUSD_OIL_LONG_RETEST_SESSION_V2,
      symbol: 'XBRUSD',
      description: 'XBRUSD long-only oil breakout retest session candidate. It keeps the failed V1 retest engine but removes weak short-side and weak-hour exposure found in diagnostics.',
      candidatePreset: CANDIDATE_PRESET,
      setupType: 'xbrusd_oil_long_retest_session',
      runtimeScopes: ['backtest', 'paper'],
    });
  }

  getDefaultParameters() {
    return {
      ...super.getDefaultParameters(),
      enableBuy: true,
      enableSell: false,
      allowedUtcHours: '8,9,16,17',
      requireHigherTrendAlignment: false,
      maxDailyLosses: 1,
      minConfidence: 0.55,
    };
  }

  getDefaultParameterSchema() {
    const defaults = this.getDefaultParameters();
    return super.getDefaultParameterSchema().map((field) => (
      Object.prototype.hasOwnProperty.call(defaults, field.key)
        ? { ...field, defaultValue: defaults[field.key] }
        : field
    ));
  }
}

XbrusdOilLongRetestSessionV2.XBRUSD_OIL_LONG_RETEST_SESSION_V2 = XBRUSD_OIL_LONG_RETEST_SESSION_V2;
XbrusdOilLongRetestSessionV2.XBRUSD_OIL_LONG_RETEST_SESSION_V2_VERSION = XBRUSD_OIL_LONG_RETEST_SESSION_V2_VERSION;
XbrusdOilLongRetestSessionV2.CANDIDATE_PRESET = CANDIDATE_PRESET;

module.exports = XbrusdOilLongRetestSessionV2;
module.exports.XBRUSD_OIL_LONG_RETEST_SESSION_V2 = XBRUSD_OIL_LONG_RETEST_SESSION_V2;
module.exports.XBRUSD_OIL_LONG_RETEST_SESSION_V2_VERSION = XBRUSD_OIL_LONG_RETEST_SESSION_V2_VERSION;
