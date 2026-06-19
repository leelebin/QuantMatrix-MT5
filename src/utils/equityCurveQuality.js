function toFiniteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, digits = 4) {
  const numeric = toFiniteNumber(value, 0);
  return parseFloat(numeric.toFixed(digits));
}

function percentReturn(start, end) {
  const startValue = toFiniteNumber(start, 0);
  const endValue = toFiniteNumber(end, startValue);
  if (startValue === 0) {
    return endValue === 0 ? 0 : (endValue > 0 ? 100 : -100);
  }
  return ((endValue - startValue) / Math.abs(startValue)) * 100;
}

function buildEmptyResult(initialBalance, warnings) {
  const startEquity = toFiniteNumber(initialBalance, 0);
  return {
    startEquity: round(startEquity, 2),
    endEquity: round(startEquity, 2),
    netProfit: 0,
    returnPercent: 0,
    points: 0,
    slope: 0,
    rSquared: 0,
    maxStagnationBars: 0,
    maxStagnationPercentOfSeries: 0,
    underwaterPercent: 0,
    positiveSegmentRatio: 0,
    worstSegmentReturnPercent: 0,
    bestSegmentReturnPercent: 0,
    segmentReturns: [],
    isLinearUptrend: false,
    warnings,
  };
}

function linearRegression(values) {
  const n = values.length;
  if (n < 2) {
    return { slope: 0, rSquared: 0 };
  }

  const xMean = (n - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;

  for (let index = 0; index < n; index += 1) {
    const xDelta = index - xMean;
    numerator += xDelta * (values[index] - yMean);
    denominator += xDelta * xDelta;
  }

  const slope = denominator > 0 ? numerator / denominator : 0;
  let ssResidual = 0;
  let ssTotal = 0;

  for (let index = 0; index < n; index += 1) {
    const predicted = yMean + slope * (index - xMean);
    ssResidual += (values[index] - predicted) ** 2;
    ssTotal += (values[index] - yMean) ** 2;
  }

  const rSquared = ssTotal > 0 ? Math.max(0, Math.min(1, 1 - (ssResidual / ssTotal))) : 0;
  return { slope, rSquared };
}

function segmentReturns(values, segmentCount = 4) {
  const returns = [];
  if (values.length < 2) {
    return returns;
  }

  for (let segment = 0; segment < segmentCount; segment += 1) {
    const startIndex = Math.floor((segment * values.length) / segmentCount);
    const endIndex = Math.floor(((segment + 1) * values.length) / segmentCount) - 1;
    const boundedEnd = Math.max(startIndex, Math.min(values.length - 1, endIndex));
    returns.push(round(percentReturn(values[startIndex], values[boundedEnd]), 2));
  }

  return returns;
}

function drawdownShape(values) {
  let high = values[0];
  let underwater = 0;
  let stagnation = 0;
  let maxStagnation = 0;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (index === 0 || value > high) {
      high = value;
      stagnation = 0;
      continue;
    }

    if (value < high) {
      underwater += 1;
    }
    stagnation += 1;
    maxStagnation = Math.max(maxStagnation, stagnation);
  }

  return {
    underwaterPercent: values.length > 0 ? underwater / values.length : 0,
    maxStagnationBars: maxStagnation,
    maxStagnationPercentOfSeries: values.length > 0 ? maxStagnation / values.length : 0,
  };
}

function analyzeEquityCurveQuality(equityCurve, initialBalance) {
  const warnings = [];
  const fallbackEquity = toFiniteNumber(initialBalance, 0);

  if (!Array.isArray(equityCurve)) {
    warnings.push('equityCurve is not an array');
    return buildEmptyResult(fallbackEquity, warnings);
  }

  const values = equityCurve
    .map((point) => toFiniteNumber(point && point.equity, null))
    .filter((value) => value !== null);

  if (values.length === 0) {
    warnings.push('equityCurve has no finite equity points');
    return buildEmptyResult(fallbackEquity, warnings);
  }

  if (values.length < 2) {
    warnings.push('equityCurve has fewer than 2 points; regression is unavailable');
  }
  if (values.length < 5) {
    warnings.push('equityCurve has too few points for four-segment quality checks');
  }

  const startEquity = values[0];
  const endEquity = values[values.length - 1];
  const { slope, rSquared } = linearRegression(values);
  const segments = segmentReturns(values, 4);
  const positiveSegments = segments.filter((value) => value > 0).length;
  const positiveSegmentRatio = segments.length > 0 ? positiveSegments / 4 : 0;
  const worstSegmentReturnPercent = segments.length > 0 ? Math.min(...segments) : 0;
  const bestSegmentReturnPercent = segments.length > 0 ? Math.max(...segments) : 0;
  const drawdown = drawdownShape(values);

  const isLinearUptrend = slope > 0
    && rSquared >= 0.70
    && endEquity > startEquity
    && positiveSegmentRatio >= 0.75
    && worstSegmentReturnPercent >= -5
    && drawdown.underwaterPercent <= 0.65;

  if (slope <= 0) warnings.push('slope is not positive');
  if (rSquared < 0.70) warnings.push('rSquared is below 0.70');
  if (endEquity <= startEquity) warnings.push('endEquity is not above startEquity');
  if (positiveSegmentRatio < 0.75) warnings.push('fewer than 3 of 4 segments are positive');
  if (worstSegmentReturnPercent < -5) warnings.push('worst segment return is below -5%');
  if (drawdown.underwaterPercent > 0.65) warnings.push('underwaterPercent is above 0.65');

  return {
    startEquity: round(startEquity, 2),
    endEquity: round(endEquity, 2),
    netProfit: round(endEquity - startEquity, 2),
    returnPercent: round(percentReturn(startEquity, endEquity), 2),
    points: values.length,
    slope: round(slope, 6),
    rSquared: round(rSquared, 4),
    maxStagnationBars: drawdown.maxStagnationBars,
    maxStagnationPercentOfSeries: round(drawdown.maxStagnationPercentOfSeries, 4),
    underwaterPercent: round(drawdown.underwaterPercent, 4),
    positiveSegmentRatio: round(positiveSegmentRatio, 4),
    worstSegmentReturnPercent: round(worstSegmentReturnPercent, 2),
    bestSegmentReturnPercent: round(bestSegmentReturnPercent, 2),
    segmentReturns: segments,
    isLinearUptrend,
    warnings,
  };
}

module.exports = {
  analyzeEquityCurveQuality,
};
