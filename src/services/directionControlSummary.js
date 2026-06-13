const { EVENT_TYPE } = require('./directionControlEvaluator');

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function round(value, digits = 4) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return parseFloat(num.toFixed(digits));
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function average(values) {
  const safe = values.filter(Number.isFinite);
  if (safe.length === 0) return 0;
  return safe.reduce((sum, value) => sum + value, 0) / safe.length;
}

function normalizeDirectionControlExitReason(reason) {
  const value = String(reason || '').toUpperCase();
  if (value.includes('TP') || value.includes('TAKE_PROFIT') || value.includes('TAKEPROFIT')) {
    return 'TP';
  }
  if (
    value.includes('SL')
    || value.includes('STOP')
    || value.includes('BREAKEVEN')
    || value.includes('TRAILING')
    || value.includes('PROTECTIVE')
  ) {
    return 'SL';
  }
  if (
    value.includes('TIME')
    || value.includes('END_OF_DATA')
    || value.includes('END_OF_BACKTEST')
    || value.includes('MAX_HOLD')
    || value.includes('EXPIRED')
  ) {
    return 'TIME_EXIT';
  }
  return 'OTHER';
}

function getDirectionControlEvents(trade = {}) {
  const direct = Array.isArray(trade.directionControlEvents) ? trade.directionControlEvents : [];
  const management = Array.isArray(trade.managementEvents) ? trade.managementEvents : [];
  return [...direct, ...management]
    .filter((event) => event && event.type === EVENT_TYPE && event.triggered !== false);
}

function getFirstTriggerEvent(trade = {}) {
  const events = getDirectionControlEvents(trade);
  if (events.length === 0) return null;
  return events.slice().sort((a, b) => {
    const ai = toNumber(a.firstTriggerBarIndex, toNumber(a.barIndex, toNumber(a.barsHeld, 0)));
    const bi = toNumber(b.firstTriggerBarIndex, toNumber(b.barIndex, toNumber(b.barsHeld, 0)));
    if (ai !== bi) return ai - bi;
    return String(a.candleTime || '').localeCompare(String(b.candleTime || ''));
  })[0];
}

function getFinalR(trade = {}) {
  const candidates = [
    trade.realizedRMultiple,
    trade.rMultiple,
    trade.realizedR,
    trade.finalR,
  ];
  for (const value of candidates) {
    const num = toNumber(value, null);
    if (Number.isFinite(num)) return num;
  }

  const pnl = toNumber(trade.profitLoss, toNumber(trade.pnl, null));
  const risk = toNumber(trade.plannedRiskAmount, null);
  if (Number.isFinite(pnl) && Number.isFinite(risk) && risk > 0) {
    return pnl / risk;
  }
  return null;
}

function getFirstTriggerR(event = {}) {
  return toNumber(event.firstTriggerR, toNumber(event.unrealizedR, null));
}

function inferRecoveredToPositive(finalR) {
  return Number.isFinite(finalR) && finalR > 0;
}

function inferReachedOriginalTp(trade = {}, finalR) {
  const targetR = toNumber(trade.targetRMultiple, null);
  if (Number.isFinite(targetR) && Number.isFinite(finalR)) {
    return finalR >= targetR;
  }
  return normalizeDirectionControlExitReason(trade.exitReason || trade.reason) === 'TP';
}

function inferWorsenedToSl(trade = {}) {
  return normalizeDirectionControlExitReason(trade.exitReason || trade.reason) === 'SL';
}

function getPostTriggerMfe(trade = {}, event = {}) {
  const direct = toNumber(trade.directionControlPostTriggerMfeR, null);
  if (Number.isFinite(direct)) return direct;
  const eventValue = toNumber(event.mfeAfterTriggerR, null);
  if (Number.isFinite(eventValue)) return eventValue;
  return toNumber(event.mfeR, null);
}

function getPostTriggerMae(trade = {}, event = {}) {
  const direct = toNumber(trade.directionControlPostTriggerMaeR, null);
  if (Number.isFinite(direct)) return direct;
  const eventValue = toNumber(event.maeAfterTriggerR, null);
  if (Number.isFinite(eventValue)) return eventValue;
  return toNumber(event.maeR, null);
}

function buildZeroDirectionControlSummary(totalTrades = 0) {
  return {
    totalTrades,
    triggeredTrades: 0,
    triggerRate: 0,
    avgRAtFirstTrigger: 0,
    medianRAtFirstTrigger: 0,
    avgFinalRWhenTriggered: 0,
    avgFinalRWhenNotTriggered: 0,
    triggeredThenHitSL: 0,
    triggeredThenHitTP: 0,
    triggeredThenTimeExit: 0,
    triggeredThenRecoveredToPositive: 0,
    triggeredThenReachedOriginalTP: 0,
    triggeredThenWorsenedToSL: 0,
    avgMfeAfterTrigger: 0,
    avgMaeAfterTrigger: 0,
    hypotheticalExitAtFirstTriggerImpactR: 0,
    hypotheticalSavedLossR: 0,
    hypotheticalMissedProfitR: 0,
    netHypotheticalImpactR: 0,
  };
}

function buildDirectionControlSummary(trades = []) {
  const safeTrades = Array.isArray(trades) ? trades : [];
  if (safeTrades.length === 0) return buildZeroDirectionControlSummary(0);

  const triggered = [];
  const notTriggeredFinalR = [];

  for (const trade of safeTrades) {
    const firstEvent = getFirstTriggerEvent(trade);
    const finalR = getFinalR(trade);
    if (!firstEvent) {
      if (Number.isFinite(finalR)) notTriggeredFinalR.push(finalR);
      continue;
    }

    const firstTriggerR = getFirstTriggerR(firstEvent);
    triggered.push({
      trade,
      event: firstEvent,
      finalR,
      firstTriggerR,
      exitReason: normalizeDirectionControlExitReason(trade.exitReason || trade.reason),
      mfeAfter: getPostTriggerMfe(trade, firstEvent),
      maeAfter: getPostTriggerMae(trade, firstEvent),
    });
  }

  if (triggered.length === 0) {
    return buildZeroDirectionControlSummary(safeTrades.length);
  }

  const firstTriggerRs = triggered.map((item) => item.firstTriggerR).filter(Number.isFinite);
  const finalTriggeredRs = triggered.map((item) => item.finalR).filter(Number.isFinite);
  const impactValues = triggered
    .filter((item) => Number.isFinite(item.firstTriggerR) && Number.isFinite(item.finalR))
    .map((item) => item.firstTriggerR - item.finalR);
  const savedLoss = impactValues.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const missedProfit = impactValues.filter((value) => value < 0).reduce((sum, value) => sum + Math.abs(value), 0);

  return {
    totalTrades: safeTrades.length,
    triggeredTrades: triggered.length,
    triggerRate: round(triggered.length / safeTrades.length),
    avgRAtFirstTrigger: round(average(firstTriggerRs)),
    medianRAtFirstTrigger: round(median(firstTriggerRs)),
    avgFinalRWhenTriggered: round(average(finalTriggeredRs)),
    avgFinalRWhenNotTriggered: round(average(notTriggeredFinalR)),
    triggeredThenHitSL: triggered.filter((item) => item.exitReason === 'SL').length,
    triggeredThenHitTP: triggered.filter((item) => item.exitReason === 'TP').length,
    triggeredThenTimeExit: triggered.filter((item) => item.exitReason === 'TIME_EXIT').length,
    triggeredThenRecoveredToPositive: triggered.filter((item) => inferRecoveredToPositive(item.finalR)).length,
    triggeredThenReachedOriginalTP: triggered.filter((item) => inferReachedOriginalTp(item.trade, item.finalR)).length,
    triggeredThenWorsenedToSL: triggered.filter((item) => inferWorsenedToSl(item.trade)).length,
    avgMfeAfterTrigger: round(average(triggered.map((item) => item.mfeAfter))),
    avgMaeAfterTrigger: round(average(triggered.map((item) => item.maeAfter))),
    hypotheticalExitAtFirstTriggerImpactR: round(average(impactValues)),
    hypotheticalSavedLossR: round(savedLoss),
    hypotheticalMissedProfitR: round(missedProfit),
    netHypotheticalImpactR: round(savedLoss - missedProfit),
  };
}

module.exports = {
  normalizeDirectionControlExitReason,
  buildDirectionControlSummary,
  buildZeroDirectionControlSummary,
};
