const {
  mapDealReasonToExitReason,
  normalizeExitReasonCode,
} = require('../src/utils/mt5Reconciliation');

describe('MT5 exit reason normalization', () => {
  test('keeps raw stop-loss reason while preserving protective stop categories', () => {
    expect(mapDealReasonToExitReason('SL')).toBe('SL_HIT');
    expect(mapDealReasonToExitReason('SL', 'EXTERNAL', {
      protectiveStopState: { phase: 'breakeven' },
    })).toBe('BREAKEVEN_SL_HIT');
    expect(mapDealReasonToExitReason('SL', 'EXTERNAL', {
      protectiveStopState: { phase: 'trailing' },
    })).toBe('TRAILING_SL_HIT');
    expect(mapDealReasonToExitReason('SL', 'EXTERNAL', {
      protectiveStopState: { phase: 'custom_protection' },
    })).toBe('PROTECTIVE_SL_HIT');
  });

  test('normalizes external and manual close aliases', () => {
    expect(normalizeExitReasonCode('SL_HIT')).toBe('SL_HIT');
    expect(normalizeExitReasonCode('TRAILING_STOP')).toBe('TRAILING_SL_HIT');
    expect(normalizeExitReasonCode('MANUAL')).toBe('MANUAL_CLOSE');
    expect(normalizeExitReasonCode('EXTERNAL')).toBe('BROKER_EXTERNAL');
    expect(mapDealReasonToExitReason('CLIENT', 'MANUAL')).toBe('MANUAL_CLOSE');
    expect(mapDealReasonToExitReason('EXPERT', 'EXTERNAL')).toBe('BROKER_EXTERNAL');
  });
});
