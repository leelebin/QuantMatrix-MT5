const IndexOpeningRangeMomentumBase = require('./IndexOpeningRangeMomentumBase');

const US30_INDEX_OPENING_RANGE_MOMENTUM_V1 = 'US30_INDEX_OPENING_RANGE_MOMENTUM_V1';
const US30_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION = 1;
const CANDIDATE_PRESET = 'us30_m15_m5_index_opening_range_momentum_v1';

class Us30IndexOpeningRangeMomentumV1 extends IndexOpeningRangeMomentumBase {
  constructor() {
    super({
      name: US30_INDEX_OPENING_RANGE_MOMENTUM_V1,
      symbol: 'US30',
      description: 'US30 index opening-range momentum continuation draft with session, volatility, relative-volume, spread, cooldown, and daily loss guardrails.',
      candidatePreset: CANDIDATE_PRESET,
      setupType: 'us30_index_opening_range_momentum',
      spreadPointSize: 0.1,
      spreadMaxPoints: 80,
      minSignalScore: 74,
      allowedUtcHours: [13, 14, 15, 16, 17, 18],
    });
  }
}

Us30IndexOpeningRangeMomentumV1.US30_INDEX_OPENING_RANGE_MOMENTUM_V1 = US30_INDEX_OPENING_RANGE_MOMENTUM_V1;
Us30IndexOpeningRangeMomentumV1.US30_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION = US30_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION;
Us30IndexOpeningRangeMomentumV1.CANDIDATE_PRESET = CANDIDATE_PRESET;

module.exports = Us30IndexOpeningRangeMomentumV1;
module.exports.US30_INDEX_OPENING_RANGE_MOMENTUM_V1 = US30_INDEX_OPENING_RANGE_MOMENTUM_V1;
module.exports.US30_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION = US30_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION;
