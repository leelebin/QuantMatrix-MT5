const { getInstrument } = require('../config/instruments');

function mapDealReasonToExitReason(reasonName, fallbackReason = 'EXTERNAL') {
  const normalizedReason = String(reasonName || '').toUpperCase();

  if (normalizedReason === 'SL') return 'SL_HIT';
  if (normalizedReason === 'TP') return 'TP_HIT';
  if (normalizedReason === 'STOP_OUT' || normalizedReason === 'SO') return 'STOP_OUT';
  if (normalizedReason === 'CLIENT' || normalizedReason === 'MOBILE' || normalizedReason === 'WEB') {
    return fallbackReason === 'MANUAL' ? 'MANUAL' : 'EXTERNAL';
  }
  if (normalizedReason === 'EXPERT') {
    return fallbackReason || 'EXTERNAL';
  }

  return fallbackReason || 'EXTERNAL';
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
  const exitReason = mapDealReasonToExitReason(dealSummary?.exitReason, fallback.reason);

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
  };
}

module.exports = {
  mapDealReasonToExitReason,
  buildClosedTradeSnapshot,
};
