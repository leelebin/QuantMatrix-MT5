const ANALYSIS_MODE = 'shadow_only';

function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function latestFinite(values) {
  if (Array.isArray(values)) {
    for (let index = values.length - 1; index >= 0; index -= 1) {
      const number = toFiniteNumber(values[index]);
      if (number != null) return number;
    }
    return null;
  }

  return toFiniteNumber(values);
}

function roundPrice(value) {
  const number = toFiniteNumber(value);
  return number == null ? null : parseFloat(number.toFixed(10));
}

function getLatestCandle(candles) {
  return Array.isArray(candles) && candles.length > 0
    ? candles[candles.length - 1]
    : null;
}

function getTriggerCandleMidpoint(candles) {
  const candle = getLatestCandle(candles);
  const high = toFiniteNumber(candle?.high);
  const low = toFiniteNumber(candle?.low);
  if (high == null || low == null) return null;
  return roundPrice((high + low) / 2);
}

function normalizeDirection(signal = {}) {
  const direction = String(signal.direction || signal.signal || '').trim().toUpperCase();
  return direction === 'BUY' || direction === 'SELL' ? direction : null;
}

function analyzeEntryRefinement({
  signal = {},
  candles = [],
  atr,
  entryPrice,
} = {}) {
  const direction = normalizeDirection(signal);
  const actualEntry = roundPrice(entryPrice);
  const atrAtSignal = roundPrice(latestFinite(atr));
  let suggestedPullback025Atr = null;
  let suggestedPullback040Atr = null;

  if (direction && actualEntry != null && atrAtSignal != null && atrAtSignal > 0) {
    const sign = direction === 'BUY' ? -1 : 1;
    suggestedPullback025Atr = roundPrice(actualEntry + sign * 0.25 * atrAtSignal);
    suggestedPullback040Atr = roundPrice(actualEntry + sign * 0.40 * atrAtSignal);
  }

  return {
    symbol: signal.symbol || null,
    strategy: signal.strategy || null,
    setupType: signal.setupType || null,
    actualEntry,
    direction,
    atrAtSignal,
    suggestedPullback025Atr,
    suggestedPullback040Atr,
    triggerCandleMidpoint: getTriggerCandleMidpoint(candles),
    preferredEntryStyle: signal.playbook?.preferredEntryStyle || signal.preferredEntryStyle || null,
    analysisMode: ANALYSIS_MODE,
  };
}

module.exports = {
  ANALYSIS_MODE,
  analyzeEntryRefinement,
};
