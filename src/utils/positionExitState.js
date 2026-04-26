function normalizeHigherTfTrendSnapshot(raw) {
  if (!raw) return null;

  if (typeof raw === 'string') {
    const trend = raw.trim();
    return trend ? { trend } : null;
  }

  if (typeof raw !== 'object') {
    return null;
  }

  const trendValue = raw.trend ?? raw.direction ?? raw.value;
  if (!trendValue) {
    return null;
  }

  const snapshot = {
    trend: String(trendValue),
  };

  const ema200 = Number(raw.ema200);
  if (Number.isFinite(ema200)) {
    snapshot.ema200 = ema200;
  }

  const price = Number(raw.price);
  if (Number.isFinite(price)) {
    snapshot.price = price;
  }

  if (raw.timeframe) {
    snapshot.timeframe = String(raw.timeframe);
  }

  return snapshot;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function createManagerAction(type, details = {}) {
  const normalizedType = String(type || 'MANAGER_ACTION').toUpperCase();
  return {
    id: `${normalizedType}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    type: normalizedType,
    createdAt: new Date().toISOString(),
    ...cloneValue(details),
  };
}

function appendManagementEvent(position, action, extra = {}) {
  const existingEvents = Array.isArray(position?.managementEvents)
    ? [...position.managementEvents]
    : [];

  existingEvents.push({
    ...cloneValue(action),
    ...cloneValue(extra),
  });

  return existingEvents;
}

function resolveTargetRMultiple(entryPrice, takeProfit, stopLoss) {
  const rewardDistance = Math.abs(Number(takeProfit) - Number(entryPrice));
  const riskDistance = Math.abs(Number(entryPrice) - Number(stopLoss));

  if (!(rewardDistance > 0) || !(riskDistance > 0)) {
    return null;
  }

  return parseFloat((rewardDistance / riskDistance).toFixed(4));
}

function calculateExitMetrics(position, closedSnapshot = {}) {
  const plannedRiskAmount = Math.abs(Number(position?.plannedRiskAmount) || 0);
  const realizedProfit = Number(closedSnapshot?.profitLoss);
  const targetRMultiple = Number(position?.targetRMultiple);

  const realizedRMultiple = plannedRiskAmount > 0 && Number.isFinite(realizedProfit)
    ? parseFloat((realizedProfit / plannedRiskAmount).toFixed(4))
    : null;
  const targetRMultipleCaptured = Number.isFinite(realizedRMultiple)
    && Number.isFinite(targetRMultiple)
    && targetRMultiple > 0
    ? parseFloat((realizedRMultiple / targetRMultiple).toFixed(4))
    : null;

  return {
    realizedRMultiple,
    targetRMultipleCaptured,
  };
}

function resolveStructureAnchor(signal) {
  const candidate = signal?.structureAnchor
    ?? signal?.indicatorsSnapshot?.structureAnchor
    ?? signal?.indicatorsSnapshot?.structureLevel;
  const numericCandidate = Number(candidate);
  return Number.isFinite(numericCandidate) && numericCandidate > 0 ? numericCandidate : null;
}

function buildManagedPositionState({
  signal,
  lotSize,
  entryPrice,
  breakevenConfig = null,
  exitPlan = null,
  plannedRiskAmount = null,
} = {}) {
  const initialSl = Number(signal?.sl);
  const targetRMultiple = resolveTargetRMultiple(entryPrice, signal?.tp, initialSl);

  return {
    originalLotSize: lotSize,
    breakevenConfig,
    exitPlan,
    exitPlanSnapshot: cloneValue(exitPlan),
    partialsExecutedIndices: [],
    maxFavourablePrice: entryPrice,
    structureAnchor: resolveStructureAnchor(signal),
    higherTfTrend: normalizeHigherTfTrendSnapshot(
      signal?.higherTfTrend
      ?? signal?.indicatorsSnapshot?.higherTfTrend
      ?? signal?.indicatorsSnapshot?.higherTfTrendSnapshot
    ),
    initialSl: Number.isFinite(initialSl) ? initialSl : null,
    plannedRiskAmount: Number.isFinite(Number(plannedRiskAmount))
      ? parseFloat(Number(plannedRiskAmount).toFixed(4))
      : null,
    targetRMultiple,
    managementEvents: [],
    pendingExitAction: null,
    managerActionId: null,
    protectiveStopState: null,
    executionScore: Number.isFinite(Number(signal?.executionScore))
      ? parseFloat(Number(signal.executionScore).toFixed(4))
      : null,
    executionScoreDetails: signal?.executionScoreDetails || null,
    executionPolicy: signal?.executionPolicy || null,
    setupTimeframe: signal?.setupTimeframe || null,
    entryTimeframe: signal?.entryTimeframe || null,
    setupCandleTime: signal?.setupCandleTime || null,
    entryCandleTime: signal?.entryCandleTime || null,
  };
}

module.exports = {
  appendManagementEvent,
  calculateExitMetrics,
  createManagerAction,
  normalizeHigherTfTrendSnapshot,
  resolveTargetRMultiple,
  resolveStructureAnchor,
  buildManagedPositionState,
};
