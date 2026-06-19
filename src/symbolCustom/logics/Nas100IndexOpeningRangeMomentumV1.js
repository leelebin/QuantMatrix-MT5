const IndexOpeningRangeMomentumBase = require('./IndexOpeningRangeMomentumBase');

const NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1 = 'NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1';
const NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION = 1;
const CANDIDATE_PRESET = 'nas100_m15_m5_index_opening_range_momentum_v1';

class Nas100IndexOpeningRangeMomentumV1 extends IndexOpeningRangeMomentumBase {
  constructor() {
    super({
      name: NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1,
      symbol: 'NAS100',
      description: 'NAS100 index opening-range momentum continuation draft with stronger trend, volatility, relative-volume, spread, cooldown, and daily loss guardrails.',
      candidatePreset: CANDIDATE_PRESET,
      setupType: 'nas100_index_opening_range_momentum',
      spreadPointSize: 0.1,
      spreadMaxPoints: 45,
      minSignalScore: 76,
      allowedUtcHours: [13, 14, 15, 16, 17, 18],
    });
  }
}

Nas100IndexOpeningRangeMomentumV1.NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1 = NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1;
Nas100IndexOpeningRangeMomentumV1.NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION = NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION;
Nas100IndexOpeningRangeMomentumV1.CANDIDATE_PRESET = CANDIDATE_PRESET;

module.exports = Nas100IndexOpeningRangeMomentumV1;
module.exports.NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1 = NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1;
module.exports.NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION = NAS100_INDEX_OPENING_RANGE_MOMENTUM_V1_VERSION;
