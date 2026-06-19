const { analyzeEquityCurveQuality } = require('../src/utils/equityCurveQuality');

function curve(values) {
  return values.map((equity, index) => ({
    time: new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
    equity,
  }));
}

describe('equity curve quality', () => {
  test('stable linear uptrend passes', () => {
    const result = analyzeEquityCurveQuality(curve([
      500, 510, 520, 530, 540, 550, 560, 570, 580,
    ]), 500);

    expect(result.isLinearUptrend).toBe(true);
    expect(result.slope).toBeGreaterThan(0);
    expect(result.rSquared).toBeGreaterThanOrEqual(0.7);
    expect(result.positiveSegmentRatio).toBeGreaterThanOrEqual(0.75);
  });

  test('stable downtrend fails', () => {
    const result = analyzeEquityCurveQuality(curve([
      580, 570, 560, 550, 540, 530, 520, 510, 500,
    ]), 500);

    expect(result.isLinearUptrend).toBe(false);
    expect(result.slope).toBeLessThan(0);
    expect(result.warnings).toContain('slope is not positive');
  });

  test('long stagnation with one final profit burst fails', () => {
    const result = analyzeEquityCurveQuality(curve([
      500, 500, 500, 500, 500, 500, 500, 500, 700,
    ]), 500);

    expect(result.isLinearUptrend).toBe(false);
    expect(result.positiveSegmentRatio).toBeLessThan(0.75);
  });

  test('violent profitable curve usually fails quality checks', () => {
    const result = analyzeEquityCurveQuality(curve([
      500, 700, 430, 760, 420, 820, 450, 900, 650,
    ]), 500);

    expect(result.endEquity).toBeGreaterThan(result.startEquity);
    expect(result.isLinearUptrend).toBe(false);
  });

  test('three rising segments and one small losing segment can pass', () => {
    const result = analyzeEquityCurveQuality(curve([
      500, 510, 520, 530, 540, 535, 550, 565, 580,
    ]), 500);

    expect(result.segmentReturns.filter((value) => value > 0)).toHaveLength(3);
    expect(result.worstSegmentReturnPercent).toBeGreaterThanOrEqual(-5);
    expect(result.isLinearUptrend).toBe(true);
  });

  test('two rising and two losing segments fail', () => {
    const result = analyzeEquityCurveQuality(curve([
      500, 510, 520, 515, 500, 510, 525, 510, 500,
    ]), 500);

    expect(result.positiveSegmentRatio).toBeLessThan(0.75);
    expect(result.isLinearUptrend).toBe(false);
  });

  test('insufficient points do not throw', () => {
    const result = analyzeEquityCurveQuality(curve([500]), 500);

    expect(result.isLinearUptrend).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
