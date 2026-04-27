/**
 * Backtest Cost Model
 *
 * Resolves and applies broker-style trading costs (commission, swap, fixed
 * fee) to backtest trades. Spread and slippage stay where they are — they
 * are baked into the entry/exit prices in the engine. This module is
 * additive: when no cost model is supplied, every cost field resolves to
 * 0 and backtest output matches the pre-cost-model behaviour.
 *
 * Resolution priority (first hit wins per field):
 *   1. request.costModel             — `costModel` field on backtest body
 *   2. strategyParams.costModel      — preset/strategy-instance overrides
 *   3. instrument.costModel          — per-symbol defaults from instruments.js
 *   4. zero defaults                 — everything 0
 *
 * Sign convention: commission/swap/fee are applied directly into net P&L.
 * Costs are usually negative (broker debits) — pass them as negative numbers.
 * The engine does NOT flip the sign; whatever you pass in is what gets added
 * to grossProfitLoss.
 */

const ZERO_COST_MODEL = Object.freeze({
  spreadPips: null,                 // null = use instrument.spread
  slippagePips: null,               // null = use engine default (0.5)
  commissionPerLot: 0,              // money per lot (whole trade if perSide=false)
  commissionPerSide: false,         // when true, commissionPerLot applies to entry AND exit
  swapLongPerLotPerDay: 0,          // money per lot per overnight day, BUY side
  swapShortPerLotPerDay: 0,         // money per lot per overnight day, SELL side
  fixedFeePerTrade: 0,              // flat per-trade fee (e.g. exchange fee)
});

const COST_MODEL_FIELDS = Object.keys(ZERO_COST_MODEL);
const NUMERIC_FIELDS = COST_MODEL_FIELDS.filter((k) => k !== 'commissionPerSide');

function _num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function _pickNumber(...candidates) {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const n = Number(candidate);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function _pickBool(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'boolean') return candidate;
  }
  return null;
}

/**
 * Merge cost-model sources by priority. Later sources are overrides.
 *
 * @param {object[]} sources - ordered list, lowest priority first
 *   (so call as `[instrument.costModel, strategyParams.costModel, requestCostModel]`)
 * @returns {{costModel: object, sources: string[]}} normalized model +
 *   names of sources that contributed at least one field, for echo-back
 *   in the trade record (`costModelUsed`).
 */
function resolveCostModel({ instrumentCostModel = null, strategyCostModel = null, requestCostModel = null } = {}) {
  const layers = [
    { name: 'instrument', value: instrumentCostModel },
    { name: 'strategy', value: strategyCostModel },
    { name: 'request', value: requestCostModel },
  ];

  const merged = { ...ZERO_COST_MODEL };
  const contributingSources = [];

  for (const layer of layers) {
    if (!layer.value || typeof layer.value !== 'object') continue;
    let contributed = false;

    for (const field of NUMERIC_FIELDS) {
      const picked = _pickNumber(layer.value[field]);
      if (picked !== null) {
        merged[field] = picked;
        contributed = true;
      }
    }

    const perSide = _pickBool(layer.value.commissionPerSide);
    if (perSide !== null) {
      merged.commissionPerSide = perSide;
      contributed = true;
    }

    if (contributed) contributingSources.push(layer.name);
  }

  return {
    costModel: merged,
    sources: contributingSources.length > 0 ? contributingSources : ['default'],
  };
}

function _hoursBetween(entryTime, exitTime) {
  const start = new Date(entryTime).getTime();
  const end = new Date(exitTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return (end - start) / (1000 * 60 * 60);
}

/**
 * Overnight days held. Counts each calendar-rollover (UTC midnight) the
 * position spans. A trade that opens 23:00 and closes 02:00 next day = 1
 * overnight even though < 24h. Trades closed inside the same UTC day = 0.
 *
 * This is a simple proxy for broker swap accrual; brokers vary (some skip
 * weekends, triple-charge Wednesday, etc.) but for backtesting this gives
 * a consistent and reproducible figure.
 */
function calculateOvernightDays(entryTime, exitTime) {
  const start = new Date(entryTime);
  const end = new Date(exitTime);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return 0;

  // Normalise to UTC midnight boundaries
  const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  if (endDay <= startDay) return 0;
  return Math.round((endDay - startDay) / (1000 * 60 * 60 * 24));
}

/**
 * Money cost numbers for a single closed trade.
 * Returns negative numbers for typical broker debits — the engine adds
 * these directly to grossProfitLoss to produce net profitLoss.
 */
function calculateTradeCosts({ costModel, lotSize, type, entryTime, exitTime }) {
  const model = costModel || ZERO_COST_MODEL;
  const lots = _num(lotSize, 0);
  const sides = model.commissionPerSide ? 2 : 1;

  const commission = -1 * Math.abs(_num(model.commissionPerLot)) * lots * sides;
  const fee = -1 * Math.abs(_num(model.fixedFeePerTrade));

  const overnightDays = calculateOvernightDays(entryTime, exitTime);
  const direction = String(type || '').toUpperCase();
  const swapPerDay = direction === 'SELL'
    ? _num(model.swapShortPerLotPerDay)
    : _num(model.swapLongPerLotPerDay);
  const swap = swapPerDay * lots * overnightDays;

  return {
    commission,
    swap,
    fee,
    overnightDays,
    holdingHours: _hoursBetween(entryTime, exitTime),
  };
}

/**
 * Sum cost components across an array of closed trades.
 * Used by backtestEngine._generateSummary so callers can see how much real
 * money is being eaten by costs vs raw price action.
 */
function summarizeCosts(trades = []) {
  let totalCommission = 0;
  let totalSwap = 0;
  let totalFees = 0;

  for (const trade of trades) {
    totalCommission += _num(trade.commission, 0);
    totalSwap += _num(trade.swap, 0);
    totalFees += _num(trade.fee, 0);
  }

  return {
    totalCommission,
    totalSwap,
    totalFees,
    totalTradingCosts: totalCommission + totalSwap + totalFees,
  };
}

module.exports = {
  ZERO_COST_MODEL,
  COST_MODEL_FIELDS,
  resolveCostModel,
  calculateTradeCosts,
  calculateOvernightDays,
  summarizeCosts,
};
