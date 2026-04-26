const { getInstrument } = require('../config/instruments');
const { calculateExitMetrics } = require('./positionExitState');

function normalizeActionType(value) {
  return String(value || '').trim().toUpperCase();
}

function mapDealReasonToExitReason(reasonName, fallbackReason = 'EXTERNAL', context = {}) {
  const normalizedReason = String(reasonName || '').toUpperCase();
  const normalizedFallback = normalizeActionType(fallbackReason || 'EXTERNAL') || 'EXTERNAL';
  const pendingActionType = normalizeActionType(
    context?.pendingExitAction?.type
      || context?.pendingExitAction?.reason
      || context?.pendingExitAction?.action
  );
  const protectivePhase = normalizeActionType(
    context?.protectiveStopState?.phase
      || context?.protectiveStopState?.type
  );

  const resolveProtectiveStopReason = () => {
    if (protectivePhase === 'BREAKEVEN') return 'BREAKEVEN';
    if (protectivePhase === 'TRAILING' || protectivePhase === 'TRAILING_STOP') return 'TRAILING_STOP';
    return 'SL_HIT';
  };

  if (normalizedReason === 'SL') return resolveProtectiveStopReason();
  if (normalizedReason === 'TP') return 'TP_HIT';
  if (normalizedReason === 'STOP_OUT' || normalizedReason === 'SO') return 'STOP_OUT';
  if (normalizedReason === 'CLIENT' || normalizedReason === 'MOBILE' || normalizedReason === 'WEB') {
    if (pendingActionType) {
      return pendingActionType;
    }
    return normalizedFallback === 'MANUAL' ? 'MANUAL' : 'BROKER_EXTERNAL';
  }
  if (normalizedReason === 'EXPERT') {
    if (pendingActionType) {
      return pendingActionType;
    }
    return normalizedFallback === 'EXTERNAL' ? 'BROKER_EXTERNAL' : normalizedFallback;
  }

  if (pendingActionType) {
    return pendingActionType;
  }

  if (normalizedReason) {
    return normalizedFallback === 'EXTERNAL' ? 'BROKER_EXTERNAL' : normalizedFallback;
  }

  return normalizedFallback || 'EXTERNAL';
}

function buildClosedTradeSnapshot(position, dealSummary = null, fallback = {}) {
  const instrument = getInstrument(position.symbol);
  const entryPrice = dealSummary?.entryPrice ?? position.entryPrice;
  const exitPrice = dealSummary?.exitPrice ?? fallback.exitPrice ?? position.currentPrice ?? position.entryPrice;
  const priceDiff = position.type === 'BUY'
    ? exitPrice - entryPrice
    : entryPrice - exitPrice;
  const profitPips = instrument ? priceDiff / instrument.pipSize : 0;
  const priceBasedProfit = instrument
    ? (
      typeof instrument.pipValue === 'number'
        ? profitPips * instrument.pipValue * position.lotSize
        : priceDiff * position.lotSize * instrument.contractSize
    )
    : 0;
  const hasRealizedBrokerProfit = dealSummary && dealSummary.exitDeals && dealSummary.exitDeals.length > 0;
  const profitLoss = hasRealizedBrokerProfit
    ? dealSummary.realizedProfit
    : priceBasedProfit;
  const closedAt = dealSummary?.exitTime
    ? new Date(dealSummary.exitTime)
    : (fallback.closedAt || new Date());
  const exitReason = mapDealReasonToExitReason(dealSummary?.exitReason, fallback.reason, {
    pendingExitAction: fallback.pendingExitAction || position?.pendingExitAction || null,
    protectiveStopState: position?.protectiveStopState || null,
  });
  const metrics = calculateExitMetrics(position, { profitLoss });

  return {
    entryPrice,
    exitPrice,
    exitReason,
    profitLoss,
    profitPips,
    closedAt,
    commission: dealSummary?.commission || 0,
    swap: dealSummary?.swap || 0,
    fee: dealSummary?.fee || 0,
    dealSummary,
    exitPlanSnapshot: position?.exitPlanSnapshot || position?.exitPlan || null,
    managementEvents: Array.isArray(position?.managementEvents) ? position.managementEvents : [],
    realizedRMultiple: metrics.realizedRMultiple,
    targetRMultipleCaptured: metrics.targetRMultipleCaptured,
  };
}

module.exports = {
  mapDealReasonToExitReason,
  buildClosedTradeSnapshot,
};
