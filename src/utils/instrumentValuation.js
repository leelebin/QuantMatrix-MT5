/**
 * Instrument Valuation
 *
 * Centralizes all pricing / sizing / P&L math used in backtests, optimizer
 * scans, and the parts of paper/live execution that don't have a live broker
 * answer. The goal is one place that knows how to translate between price,
 * pips, lots and money so backtest results stay close to what the broker
 * actually books in live trading.
 *
 * Inputs are an `instrument` (from src/config/instruments.js) plus an
 * optional `snapshot` of broker-side metadata (typically the result of
 * `mt5Service.getResolvedSymbolInfo()` — `volumeMin`, `volumeStep`,
 * `tickSize`, `tickValue`, `digits`, ...). The snapshot, when provided,
 * always wins over the static config so live/paper paths can pass real
 * broker spec into the same helpers.
 *
 * Live trading still prefers `mt5Service.calculateOrderProfit` for the
 * authoritative risk-per-lot estimate (see riskManager._getBrokerSizingContext).
 * This helper is the offline fallback and the canonical math for backtests.
 */

const DEFAULT_MAX_LOT = 5;

function _num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function _positive(value) {
  const n = _num(value);
  return n !== null && n > 0 ? n : null;
}

function _round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

function _normalizeType(type) {
  return String(type || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
}

/**
 * Pip size in price units (e.g. 0.0001 for EURUSD, 0.01 for XAUUSD).
 * Snapshot does not override pipSize because brokers report tickSize, not
 * pipSize — pipSize is a strategy-facing concept and we keep it stable.
 */
function getPipSize(instrument) {
  return _positive(instrument && instrument.pipSize) || 0.0001;
}

/**
 * Tick size in price units. Falls back to pipSize when no snapshot.
 */
function getTickSize(instrument, snapshot = null) {
  return (
    _positive(snapshot && (snapshot.tickSize ?? snapshot.trade_tick_size))
    || _positive(instrument && instrument.tickSize)
    || getPipSize(instrument)
  );
}

/**
 * Money value of one tick for one standard lot.
 * If the broker snapshot provides tickValue we trust it; otherwise we
 * derive it from the static `pipValue` (per-pip per-lot) divided by the
 * pip-to-tick ratio.
 */
function getTickValuePerLot(instrument, snapshot = null) {
  const snapshotTickValue = _positive(snapshot && (snapshot.tickValue ?? snapshot.trade_tick_value));
  if (snapshotTickValue) return snapshotTickValue;

  const pipSize = getPipSize(instrument);
  const tickSize = getTickSize(instrument, snapshot);
  const pipValue = _positive(instrument && instrument.pipValue);
  if (!pipValue || !pipSize || !tickSize) return 0;

  return pipValue * (tickSize / pipSize);
}

/**
 * Money value of one pip for one standard lot.
 * Derived from tickValue if present (so broker spec wins), otherwise
 * falls back to the static `pipValue` from instruments.js.
 */
function getPipValuePerLot(instrument, snapshot = null) {
  const snapshotTickValue = _positive(snapshot && (snapshot.tickValue ?? snapshot.trade_tick_value));
  if (snapshotTickValue) {
    const pipSize = getPipSize(instrument);
    const tickSize = getTickSize(instrument, snapshot);
    if (pipSize > 0 && tickSize > 0) {
      return snapshotTickValue * (pipSize / tickSize);
    }
  }
  return _positive(instrument && instrument.pipValue) || 0;
}

function getContractSize(instrument, snapshot = null) {
  return (
    _positive(snapshot && (snapshot.contractSize ?? snapshot.trade_contract_size))
    || _positive(instrument && instrument.contractSize)
    || 0
  );
}

function getMinLot(instrument, snapshot = null) {
  return (
    _positive(snapshot && (snapshot.volumeMin ?? snapshot.minLot))
    || _positive(instrument && instrument.minLot)
    || 0.01
  );
}

function getLotStep(instrument, snapshot = null) {
  return (
    _positive(snapshot && (snapshot.volumeStep ?? snapshot.lotStep))
    || _positive(instrument && instrument.lotStep)
    || 0.01
  );
}

function getMaxLot(instrument, snapshot = null) {
  return (
    _positive(snapshot && (snapshot.volumeMax ?? snapshot.maxLot))
    || _positive(instrument && instrument.maxLot)
    || DEFAULT_MAX_LOT
  );
}

/** Spread expressed in pips (matches the static `instrument.spread` units). */
function getSpreadPips(instrument, snapshot = null) {
  if (snapshot && Number.isFinite(snapshot.spread) && snapshot.spread > 0) {
    return Number(snapshot.spread);
  }
  const v = _num(instrument && instrument.spread);
  return v !== null ? v : 0;
}

function resolveLotPrecision(minLot, lotStep) {
  const raw = String(lotStep ?? minLot ?? '0.01');
  if (raw.includes('e-')) {
    return parseInt(raw.split('e-')[1], 10);
  }
  const decimalPart = raw.split('.')[1];
  return decimalPart ? decimalPart.length : 2;
}

function resolvePricePrecision(instrument, snapshot = null) {
  if (snapshot && Number.isFinite(snapshot.digits) && snapshot.digits >= 0) {
    return Math.round(snapshot.digits);
  }
  const pipSize = getPipSize(instrument);
  if (pipSize >= 1) return 0;
  return Math.max(0, Math.round(-Math.log10(pipSize))) + 1;
}

/**
 * Snap a raw lot size to the broker's volume grid.
 * Aggressive-min mode (default for backtests) bumps anything below minLot
 * up to minLot — this matches the live `allowAggressiveMinLot` setting and
 * keeps backtest behaviour consistent with the production sizing path.
 */
function normalizeLotSize(rawLotSize, options = {}) {
  const {
    instrument = null,
    snapshot = null,
    minLot = getMinLot(instrument, snapshot),
    lotStep = getLotStep(instrument, snapshot),
    maxLot = getMaxLot(instrument, snapshot),
    aggressiveMinLot = true,
  } = options;

  const value = _num(rawLotSize);
  if (value === null || value <= 0) {
    return aggressiveMinLot ? _round(minLot, resolveLotPrecision(minLot, lotStep)) : 0;
  }

  const step = _positive(lotStep) || 0.01;
  const floor = _positive(minLot) || 0.01;
  const ceiling = _positive(maxLot) || DEFAULT_MAX_LOT;

  // Float-drift safe snap. `value / step` can land at e.g. 19.999... when
  // the math should be exactly 20 (0.20 / 0.01 in IEEE-754), and a naïve
  // floor would silently shave off a step. The epsilon nudges values that
  // are within 1e-9 of a step boundary up to that boundary before flooring.
  let snapped = Math.floor(value / step + 1e-9) * step;
  if (snapped < floor) {
    snapped = aggressiveMinLot ? floor : 0;
  }
  snapped = Math.min(snapped, ceiling);

  const precision = resolveLotPrecision(floor, step);
  return parseFloat(snapped.toFixed(precision));
}

/**
 * Pips between two prices, signed by direction.
 * BUY profits when exit > entry; SELL profits when exit < entry.
 */
function calculateProfitPips({ type, entryPrice, exitPrice, instrument }) {
  const direction = _normalizeType(type);
  const pipSize = getPipSize(instrument);
  if (!pipSize) return 0;
  const priceDiff = direction === 'BUY'
    ? Number(exitPrice) - Number(entryPrice)
    : Number(entryPrice) - Number(exitPrice);
  return priceDiff / pipSize;
}

/**
 * Gross P&L in account currency (excludes commission/swap/fee).
 *
 * Uses tickValue when available (broker snapshot) so CFDs price correctly,
 * otherwise falls back to `priceDiff * lotSize * contractSize`. Both paths
 * give identical numbers for the static config because tickValue is derived
 * from pipValue/tickSize when no snapshot is provided.
 */
function calculateGrossProfitLoss({ type, entryPrice, exitPrice, lotSize, instrument, snapshot = null }) {
  const direction = _normalizeType(type);
  const lots = _num(lotSize);
  if (lots === null) return 0;

  const priceDiff = direction === 'BUY'
    ? Number(exitPrice) - Number(entryPrice)
    : Number(entryPrice) - Number(exitPrice);

  if (!Number.isFinite(priceDiff)) return 0;

  const tickSize = getTickSize(instrument, snapshot);
  const tickValue = getTickValuePerLot(instrument, snapshot);
  if (tickSize > 0 && tickValue > 0) {
    return (priceDiff / tickSize) * tickValue * lots;
  }

  const contractSize = getContractSize(instrument, snapshot);
  if (contractSize > 0) {
    return priceDiff * lots * contractSize;
  }

  return 0;
}

/**
 * Net P&L = gross + (commission + swap + fee) where the cost components
 * are usually negative numbers (broker debits). Defaults to 0 when costs
 * are not modelled — backtest behaviour stays unchanged.
 */
function calculateNetProfitLoss({ grossProfitLoss, commission = 0, swap = 0, fee = 0 }) {
  return Number(grossProfitLoss || 0)
    + Number(commission || 0)
    + Number(swap || 0)
    + Number(fee || 0);
}

/**
 * Money risked when a position closes at its stop loss for the given lot.
 * Mirrors riskManager.calculateLotSizeDetails.plannedRiskAmount semantics.
 */
function calculatePlannedRiskAmount({ entryPrice, slPrice, lotSize, instrument, snapshot = null }) {
  const slDistance = Math.abs(Number(entryPrice) - Number(slPrice));
  if (!(slDistance > 0)) return 0;
  const tickSize = getTickSize(instrument, snapshot);
  const tickValue = getTickValuePerLot(instrument, snapshot);
  if (tickSize > 0 && tickValue > 0) {
    return (slDistance / tickSize) * tickValue * Number(lotSize || 0);
  }
  const contractSize = getContractSize(instrument, snapshot);
  return slDistance * Number(lotSize || 0) * contractSize;
}

/**
 * Risk-per-lot in account currency.
 * Used by the lot sizing helper below; in live this is overridden by the
 * MT5 broker estimate (riskManager._getBrokerSizingContext).
 */
function calculateRiskPerLot({ entryPrice, slPrice, instrument, snapshot = null }) {
  return calculatePlannedRiskAmount({
    entryPrice,
    slPrice,
    lotSize: 1,
    instrument,
    snapshot,
  });
}

/**
 * Lot size that risks `balance * riskPercent` if SL is hit.
 * Returns the snapped, broker-grid-compliant size.
 */
function calculateLotSize({
  entryPrice,
  slPrice,
  balance,
  riskPercent,
  instrument,
  snapshot = null,
  maxLot = null,
  aggressiveMinLot = true,
}) {
  const accountBalance = _positive(balance);
  const risk = _positive(riskPercent);
  if (!accountBalance || !risk) return 0;

  const riskAmount = accountBalance * risk;
  const riskPerLot = calculateRiskPerLot({ entryPrice, slPrice, instrument, snapshot });
  if (!(riskPerLot > 0)) return 0;

  const raw = riskAmount / riskPerLot;
  return normalizeLotSize(raw, {
    instrument,
    snapshot,
    maxLot: maxLot != null ? maxLot : getMaxLot(instrument, snapshot),
    aggressiveMinLot,
  });
}

/**
 * One-shot bundle for callers that prefer a single object.
 * Reads from instrument + snapshot once and caches the resolved values.
 */
function getValuationContext(instrument, snapshot = null) {
  const minLot = getMinLot(instrument, snapshot);
  const lotStep = getLotStep(instrument, snapshot);
  return {
    pipSize: getPipSize(instrument),
    pipValue: getPipValuePerLot(instrument, snapshot),
    tickSize: getTickSize(instrument, snapshot),
    tickValue: getTickValuePerLot(instrument, snapshot),
    contractSize: getContractSize(instrument, snapshot),
    minLot,
    lotStep,
    maxLot: getMaxLot(instrument, snapshot),
    spreadPips: getSpreadPips(instrument, snapshot),
    lotPrecision: resolveLotPrecision(minLot, lotStep),
    pricePrecision: resolvePricePrecision(instrument, snapshot),
  };
}

module.exports = {
  getPipSize,
  getPipValuePerLot,
  getContractSize,
  getTickSize,
  getTickValuePerLot,
  getMinLot,
  getLotStep,
  getMaxLot,
  getSpreadPips,
  resolveLotPrecision,
  resolvePricePrecision,
  normalizeLotSize,
  calculateProfitPips,
  calculateGrossProfitLoss,
  calculateNetProfitLoss,
  calculatePlannedRiskAmount,
  calculateRiskPerLot,
  calculateLotSize,
  getValuationContext,
};
