const { getInstrument } = require('../config/instruments');
const { calculateExitMetrics } = require('./positionExitState');

function normalizeActionType(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeExitReasonCode(value, fallback = 'BROKER_EXTERNAL') {
  const normalized = normalizeActionType(value);
  switch (normalized) {
    case 'SL':
    case 'SL_HIT':
      return 'SL_HIT';
    case 'INITIAL_SL':
    case 'INITIAL_SL_HIT':
      return 'INITIAL_SL_HIT';
    case 'BREAKEVEN':
    case 'BREAKEVEN_HIT':
    case 'BREAKEVEN_SL':
    case 'BREAKEVEN_SL_HIT':
      return 'BREAKEVEN_SL_HIT';
    case 'TRAILING':
    case 'TRAILING_STOP':
    case 'TRAILING_SL':
    case 'TRAILING_SL_HIT':
      return 'TRAILING_SL_HIT';
    case 'PROTECTIVE':
    case 'PROTECTIVE_SL':
    case 'PROTECTIVE_SL_HIT':
      return 'PROTECTIVE_SL_HIT';
    case 'TP':
    case 'TP_HIT':
      return 'TP_HIT';
    case 'MANUAL':
    case 'MANUAL_CLOSE':
      return 'MANUAL_CLOSE';
    case 'EXTERNAL':
    case 'BROKER_EXTERNAL':
      return 'BROKER_EXTERNAL';
    default:
      return normalized || fallback;
  }
}

function mapDealReasonToExitReason(reasonName, fallbackReason = 'EXTERNAL', context = {}) {
  const normalizedReason = String(reasonName || '').toUpperCase();
  const normalizedFallback = normalizeExitReasonCode(fallbackReason || 'BROKER_EXTERNAL');
  const pendingActionType = normalizeActionType(
    context?.pendingExitAction?.type
      || context?.pendingExitAction?.reason
      || context?.pendingExitAction?.action
  );
  const protectivePhase = normalizeActionType(
    context?.protectiveStopState?.phase
      || context?.protectiveStopState?.type
  );
  const hasProtectiveState = Boolean(context?.protectiveStopState);

  const resolveProtectiveStopReason = () => {
    if (protectivePhase === 'BREAKEVEN') return 'BREAKEVEN_SL_HIT';
    if (protectivePhase === 'TRAILING' || protectivePhase === 'TRAILING_STOP') return 'TRAILING_SL_HIT';
    if (hasProtectiveState) return 'PROTECTIVE_SL_HIT';
    return 'SL_HIT';
  };

  if (normalizedReason === 'SL') return resolveProtectiveStopReason();
  if (normalizedReason === 'TP') return 'TP_HIT';
  if (normalizedReason === 'STOP_OUT' || normalizedReason === 'SO') return 'STOP_OUT';
  if (normalizedReason === 'CLIENT' || normalizedReason === 'MOBILE' || normalizedReason === 'WEB') {
    if (pendingActionType) {
      return normalizeExitReasonCode(pendingActionType);
    }
    return normalizedFallback === 'MANUAL_CLOSE' ? 'MANUAL_CLOSE' : 'BROKER_EXTERNAL';
  }
  if (normalizedReason === 'EXPERT') {
    if (pendingActionType) {
      return normalizeExitReasonCode(pendingActionType);
    }
    return normalizedFallback === 'EXTERNAL' ? 'BROKER_EXTERNAL' : normalizedFallback;
  }

  if (pendingActionType) {
    return normalizeExitReasonCode(pendingActionType);
  }

  if (normalizedReason) {
    return normalizedFallback === 'EXTERNAL' ? 'BROKER_EXTERNAL' : normalizedFallback;
  }

  return normalizedFallback || 'BROKER_EXTERNAL';
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
  const commission = dealSummary?.commission || 0;
  const swap = dealSummary?.swap || 0;
  const fee = dealSummary?.fee || 0;
  const grossProfitLoss = hasRealizedBrokerProfit
    ? profitLoss - commission - swap - fee
    : priceBasedProfit;

  return {
    entryPrice,
    exitPrice,
    exitReason,
    profitLoss,
    grossProfitLoss,
    profitPips,
    closedAt,
    commission,
    swap,
    fee,
    dealSummary,
    exitPlanSnapshot: position?.exitPlanSnapshot || position?.exitPlan || null,
    managementEvents: Array.isArray(position?.managementEvents) ? position.managementEvents : [],
    realizedRMultiple: metrics.realizedRMultiple,
    targetRMultipleCaptured: metrics.targetRMultipleCaptured,
  };
}

module.exports = {
  mapDealReasonToExitReason,
  normalizeExitReasonCode,
  buildClosedTradeSnapshot,
};
