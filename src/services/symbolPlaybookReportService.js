const { tradeLogDb, tradesDb } = require('../config/db');
const { STRATEGY_TYPES } = require('../config/instruments');
const { normalizeDateStart, normalizeDateValue } = require('../utils/tradeTime');

const DEFAULT_REPORT_SINCE = '2026-04-27';
const DEFAULT_SCOPE = 'paper';
const SETUP_TYPE_LEGACY_FALLBACK = 'unknown_legacy';
const SETUP_TYPE_SOURCES = ['recorded', 'legacy_inferred', 'unknown_legacy'];
const VALID_SCOPES = new Set(['paper', 'live']);

function createBadRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeScope(scope = DEFAULT_SCOPE) {
  const normalized = String(scope || DEFAULT_SCOPE).trim().toLowerCase();
  if (!VALID_SCOPES.has(normalized)) {
    throw createBadRequest(`Unsupported symbol playbook report scope: ${scope}`);
  }
  return normalized;
}

function normalizeSince(since = DEFAULT_REPORT_SINCE) {
  const normalized = normalizeDateStart(since || DEFAULT_REPORT_SINCE);
  if (!normalized) {
    throw createBadRequest(`Invalid symbol playbook report since date: ${since}`);
  }
  return normalized;
}

function getDbForScope(scope) {
  return scope === 'live' ? tradesDb : tradeLogDb;
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundNumber(value, digits = 4) {
  const number = toFiniteNumber(value);
  return number == null ? null : parseFloat(number.toFixed(digits));
}

function getProfitLoss(trade = {}) {
  return toFiniteNumber(trade.profitLoss) ?? 0;
}

function getRMultiple(trade = {}) {
  const realized = toFiniteNumber(trade.realizedRMultiple);
  if (realized != null) return realized;

  const tradeR = toFiniteNumber(trade.tradeR);
  if (tradeR != null) return tradeR;

  const profitLoss = toFiniteNumber(trade.profitLoss);
  const plannedRiskAmount = toFiniteNumber(trade.plannedRiskAmount);
  if (profitLoss != null && plannedRiskAmount != null && plannedRiskAmount > 0) {
    return profitLoss / plannedRiskAmount;
  }

  return null;
}

function inferLegacySetupType({ symbol, strategy } = {}) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const normalizedStrategy = String(strategy || '').trim();

  if (normalizedSymbol === 'XAUUSD' && normalizedStrategy === STRATEGY_TYPES.BREAKOUT) {
    return 'event_breakout';
  }
  if (normalizedSymbol === 'XAUUSD' && normalizedStrategy === STRATEGY_TYPES.MOMENTUM) {
    return 'momentum_continuation';
  }
  if (normalizedSymbol === 'XAGUSD' && normalizedStrategy === STRATEGY_TYPES.MOMENTUM) {
    return 'momentum_continuation';
  }
  if (normalizedSymbol === 'XAGUSD' && normalizedStrategy === STRATEGY_TYPES.VOLUME_FLOW_HYBRID) {
    return 'volatility_expansion';
  }
  if (
    ['XTIUSD', 'XBRUSD'].includes(normalizedSymbol)
    && [STRATEGY_TYPES.BREAKOUT, STRATEGY_TYPES.MOMENTUM].includes(normalizedStrategy)
  ) {
    return 'oil_news_continuation';
  }
  if (
    ['EURUSD', 'GBPUSD', 'USDCHF', 'USDCAD'].includes(normalizedSymbol)
    && normalizedStrategy === STRATEGY_TYPES.MOMENTUM
  ) {
    return 'm15_intraday_pullback';
  }
  if (
    ['EURUSD', 'GBPUSD', 'USDCHF', 'USDCAD'].includes(normalizedSymbol)
    && normalizedStrategy === STRATEGY_TYPES.MEAN_REVERSION
  ) {
    return 'session_range_reversal';
  }
  if (
    ['NAS100', 'SPX500'].includes(normalizedSymbol)
    && [STRATEGY_TYPES.MOMENTUM, STRATEGY_TYPES.BREAKOUT].includes(normalizedStrategy)
  ) {
    return 'us_session_momentum';
  }
  if (
    ['BTCUSD', 'ETHUSD'].includes(normalizedSymbol)
    && [STRATEGY_TYPES.MOMENTUM, STRATEGY_TYPES.BREAKOUT].includes(normalizedStrategy)
  ) {
    return 'risk_on_momentum';
  }

  return SETUP_TYPE_LEGACY_FALLBACK;
}

function resolveSetupTypeMetadata(trade = {}) {
  const setupType = String(trade.setupType || '').trim();
  if (setupType) {
    return {
      setupType,
      setupTypeSource: 'recorded',
    };
  }

  const inferredSetupType = inferLegacySetupType({
    symbol: trade.symbol,
    strategy: trade.strategy || trade.strategyType,
  });

  if (inferredSetupType !== SETUP_TYPE_LEGACY_FALLBACK) {
    return {
      setupType: inferredSetupType,
      setupTypeSource: 'legacy_inferred',
    };
  }

  return {
    setupType: SETUP_TYPE_LEGACY_FALLBACK,
    setupTypeSource: SETUP_TYPE_LEGACY_FALLBACK,
  };
}

function getSetupType(trade = {}) {
  return resolveSetupTypeMetadata(trade).setupType;
}

function createSetupTypeSourceBreakdown() {
  return SETUP_TYPE_SOURCES.reduce((breakdown, source) => {
    breakdown[source] = 0;
    return breakdown;
  }, {});
}

function buildSetupTypeSourceBreakdown(trades = []) {
  return trades.reduce((breakdown, trade) => {
    const { setupTypeSource } = resolveSetupTypeMetadata(trade);
    breakdown[setupTypeSource] = (breakdown[setupTypeSource] || 0) + 1;
    return breakdown;
  }, createSetupTypeSourceBreakdown());
}

function calculateProfitFactor(grossWin, grossLoss) {
  if (grossLoss === 0 && grossWin > 0) {
    return {
      profitFactor: null,
      profitFactorLabel: 'INF',
    };
  }

  if (grossLoss > 0) {
    return {
      profitFactor: roundNumber(grossWin / grossLoss, 4),
      profitFactorLabel: null,
    };
  }

  return {
    profitFactor: null,
    profitFactorLabel: null,
  };
}

function summarizeTrades(trades = {}) {
  const rows = Array.isArray(trades) ? trades : [];
  const tradeCount = rows.length;
  const netPnl = rows.reduce((sum, trade) => sum + getProfitLoss(trade), 0);
  const grossWin = rows.reduce((sum, trade) => {
    const profitLoss = getProfitLoss(trade);
    return profitLoss > 0 ? sum + profitLoss : sum;
  }, 0);
  const grossLoss = Math.abs(rows.reduce((sum, trade) => {
    const profitLoss = getProfitLoss(trade);
    return profitLoss < 0 ? sum + profitLoss : sum;
  }, 0));
  const winners = rows.filter((trade) => getProfitLoss(trade) > 0).length;
  const rMultiples = rows
    .map((trade) => getRMultiple(trade))
    .filter((value) => value != null);
  const maxSingleLoss = rows.reduce((worst, trade) => {
    const profitLoss = getProfitLoss(trade);
    return profitLoss < worst ? profitLoss : worst;
  }, 0);

  return {
    trades: tradeCount,
    netPnl: roundNumber(netPnl, 2),
    grossWin: roundNumber(grossWin, 2),
    grossLoss: roundNumber(grossLoss, 2),
    ...calculateProfitFactor(grossWin, grossLoss),
    winRate: tradeCount > 0 ? roundNumber(winners / tradeCount, 4) : null,
    avgR: rMultiples.length > 0
      ? roundNumber(rMultiples.reduce((sum, value) => sum + value, 0) / rMultiples.length, 4)
      : null,
    maxSingleLoss: roundNumber(maxSingleLoss, 2),
  };
}

function getComparableProfitFactor(summary = {}) {
  if (summary.profitFactorLabel === 'INF') return Infinity;
  return toFiniteNumber(summary.profitFactor);
}

function buildRecommendation(summary = {}) {
  const trades = summary.trades || 0;
  const netPnl = toFiniteNumber(summary.netPnl) ?? 0;
  const comparableProfitFactor = getComparableProfitFactor(summary);

  if (trades < 5) return 'NEED_MORE_DATA';
  if (netPnl < 0 && comparableProfitFactor != null && comparableProfitFactor < 0.8 && trades >= 10) {
    return 'DISABLE_SUGGESTED';
  }
  if (netPnl > 0 && comparableProfitFactor != null && comparableProfitFactor >= 1.5) {
    return 'KEEP_AS_GROWTH_ENGINE';
  }
  if (netPnl > 0 && comparableProfitFactor != null && comparableProfitFactor >= 1.1) {
    return 'KEEP_SMALL';
  }
  if (netPnl <= 0 && trades >= 5) return 'PAPER_ONLY';
  return 'NEED_MORE_DATA';
}

function groupBy(trades, getKey) {
  return trades.reduce((groups, trade) => {
    const key = getKey(trade);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
    return groups;
  }, new Map());
}

function buildSetupSummaries(trades = []) {
  return Array.from(groupBy(trades, getSetupType).entries())
    .map(([setupType, setupTrades]) => {
      const summary = summarizeTrades(setupTrades);
      return {
        setupType,
        setupTypeSourceBreakdown: buildSetupTypeSourceBreakdown(setupTrades),
        trades: summary.trades,
        netPnl: summary.netPnl,
        profitFactor: summary.profitFactor,
        profitFactorLabel: summary.profitFactorLabel,
        winRate: summary.winRate,
        avgR: summary.avgR,
        maxSingleLoss: summary.maxSingleLoss,
      };
    })
    .sort((left, right) => (
      right.netPnl - left.netPnl
      || right.trades - left.trades
      || left.setupType.localeCompare(right.setupType)
    ));
}

function buildReportFromTrades(trades = [], { scope = DEFAULT_SCOPE, since = normalizeSince() } = {}) {
  const bySymbol = groupBy(trades, (trade) => String(trade.symbol || 'UNKNOWN').trim() || 'UNKNOWN');
  const symbols = Array.from(bySymbol.entries())
    .map(([symbol, symbolTrades]) => {
      const summary = summarizeTrades(symbolTrades);
      const setups = buildSetupSummaries(symbolTrades);
      const bestSetupType = setups.length > 0 ? setups[0].setupType : null;
      const worstSetupType = setups.length > 0 ? setups[setups.length - 1].setupType : null;
      const setupTypeSourceBreakdown = buildSetupTypeSourceBreakdown(symbolTrades);

      return {
        symbol,
        ...summary,
        bestSetupType,
        worstSetupType,
        setupTypeSourceBreakdown,
        recommendation: buildRecommendation(summary),
        setups,
      };
    })
    .sort((left, right) => (
      right.netPnl - left.netPnl
      || right.trades - left.trades
      || left.symbol.localeCompare(right.symbol)
    ));

  return {
    scope,
    since: since.toISOString(),
    count: symbols.length,
    totalTrades: trades.length,
    setupTypeSourceBreakdown: buildSetupTypeSourceBreakdown(trades),
    symbols,
  };
}

function isClosedTradeSince(trade = {}, since) {
  if (String(trade.status || '').toUpperCase() !== 'CLOSED') return false;
  const closedAt = normalizeDateValue(trade.closedAt);
  const openedAt = normalizeDateValue(trade.openedAt);
  const referenceDate = closedAt || openedAt;
  return Boolean(referenceDate && referenceDate >= since);
}

async function getSymbolPlaybookReport(options = {}) {
  const scope = normalizeScope(options.scope);
  const since = normalizeSince(options.since);
  const db = getDbForScope(scope);
  const trades = await db.find({
    status: 'CLOSED',
    $or: [
      { closedAt: { $gte: since } },
      { openedAt: { $gte: since } },
    ],
  }).sort({ closedAt: -1 });

  return buildReportFromTrades(
    trades.filter((trade) => isClosedTradeSince(trade, since)),
    { scope, since }
  );
}

module.exports = {
  DEFAULT_REPORT_SINCE,
  SETUP_TYPE_LEGACY_FALLBACK,
  buildRecommendation,
  buildReportFromTrades,
  getSymbolPlaybookReport,
  inferLegacySetupType,
  resolveSetupTypeMetadata,
};
