const OilBreakoutRetestBase = require('./OilBreakoutRetestBase');

const XBRUSD_OIL_BREAKOUT_RETEST_V1 = 'XBRUSD_OIL_BREAKOUT_RETEST_V1';
const XBRUSD_OIL_BREAKOUT_RETEST_V1_VERSION = 1;
const CANDIDATE_PRESET = 'xbrusd_oil_breakout_retest_research_v1';

class XbrusdOilBreakoutRetestV1 extends OilBreakoutRetestBase {
  constructor() {
    super({
      name: XBRUSD_OIL_BREAKOUT_RETEST_V1,
      symbol: 'XBRUSD',
      description: 'XBRUSD backtest-only oil breakout retest prototype for avoiding immediate headline-breakout chases.',
      candidatePreset: CANDIDATE_PRESET,
      setupType: 'xbrusd_oil_breakout_retest',
    });
  }
}

XbrusdOilBreakoutRetestV1.XBRUSD_OIL_BREAKOUT_RETEST_V1 = XBRUSD_OIL_BREAKOUT_RETEST_V1;
XbrusdOilBreakoutRetestV1.XBRUSD_OIL_BREAKOUT_RETEST_V1_VERSION = XBRUSD_OIL_BREAKOUT_RETEST_V1_VERSION;
XbrusdOilBreakoutRetestV1.CANDIDATE_PRESET = CANDIDATE_PRESET;

module.exports = XbrusdOilBreakoutRetestV1;
