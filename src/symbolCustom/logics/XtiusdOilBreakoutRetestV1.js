const OilBreakoutRetestBase = require('./OilBreakoutRetestBase');

const XTIUSD_OIL_BREAKOUT_RETEST_V1 = 'XTIUSD_OIL_BREAKOUT_RETEST_V1';
const XTIUSD_OIL_BREAKOUT_RETEST_V1_VERSION = 1;
const CANDIDATE_PRESET = 'xtiusd_oil_breakout_retest_research_v1';

class XtiusdOilBreakoutRetestV1 extends OilBreakoutRetestBase {
  constructor() {
    super({
      name: XTIUSD_OIL_BREAKOUT_RETEST_V1,
      symbol: 'XTIUSD',
      description: 'XTIUSD paper-validation oil breakout retest prototype for avoiding immediate headline-breakout chases.',
      candidatePreset: CANDIDATE_PRESET,
      setupType: 'xtiusd_oil_breakout_retest',
      runtimeScopes: ['backtest', 'paper'],
    });
  }
}

XtiusdOilBreakoutRetestV1.XTIUSD_OIL_BREAKOUT_RETEST_V1 = XTIUSD_OIL_BREAKOUT_RETEST_V1;
XtiusdOilBreakoutRetestV1.XTIUSD_OIL_BREAKOUT_RETEST_V1_VERSION = XTIUSD_OIL_BREAKOUT_RETEST_V1_VERSION;
XtiusdOilBreakoutRetestV1.CANDIDATE_PRESET = CANDIDATE_PRESET;

module.exports = XtiusdOilBreakoutRetestV1;
