const { tradesDb, tradeLogDb } = require('../config/db');
const { normalizeStrategyName, getStrategyNameAliases } = require('../utils/tradeComment');
const { normalizeDateValue, normalizeDateStart, normalizeDateEnd, diffMinutes } = require('../utils/tradeTime');

const DEFAULT_FALLBACK_WINDOW_MINUTES = 90;
const UNKNOWN_STRATEGY = 'Unknown';

function hasValue(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === 'object' && value.$$date != null) return true;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function firstValue(...values) {
  for (const value of values) {
    if (hasValue(value)) return value;
  }
  return '';
}

function normalizeRef(value) {
  if (!hasValue(value)) return '';
  return String(value).trim();
}

function normalizeSymbol(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function normalizeSide(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeStrategy(value) {
  const normalized = normalizeStrategyName(value);
  return String(normalized || '').trim();
}

function isUnknownStrategy(value) {
  const strategy = normalizeStrategy(value);
  return !strategy || strategy === UNKNOWN_STRATEGY;
}

function getOpenedAt(trade = {}) {
  return normalizeDateValue(trade.openedAt || trade.mt5_open_time || trade.entryTime || trade.openTime);
}

function getClosedAt(trade = {}) {
  return normalizeDateValue(trade.closedAt || trade.mt5_close_time || trade.exitTime || trade.closeTime);
}

function getEntryDealId(trade = {}) {
  return normalizeRef(trade.mt5EntryDealId || trade.mt5DealId || trade.entryDealId || trade.dealId);
}

function getTradeRefs(trade = {}) {
  return {
    positionId: normalizeRef(trade.mt5PositionId || trade.positionId || trade.positionTicket),
    orderId: normalizeRef(trade.mt5OrderId || trade.orderId),
    entryDealId: getEntryDealId(trade),
  };
}

function buildIndex(records = [], refGetter) {
  const map = new Map();
  records.forEach((record, index) => {
    const ref = normalizeRef(refGetter(record));
    if (!ref) return;
    if (!map.has(ref)) map.set(ref, []);
    map.get(ref).push(index);
  });
  return map;
}

function getSingleUnused(indexes, ref, usedPaperIndexes) {
  const candidates = indexes.get(normalizeRef(ref)) || [];
  const unused = candidates.filter((index) => !usedPaperIndexes.has(index));
  return unused.length === 1 ? unused[0] : null;
}

function findReferenceMatch(brokerTrade, paperIndexes, usedPaperIndexes) {
  const refs = getTradeRefs(brokerTrade);
  const byPosition = getSingleUnused(paperIndexes.byPositionId, refs.positionId, usedPaperIndexes);
  if (byPosition != null) return { index: byPosition, matchMethod: 'mt5PositionId' };

  const byOrder = getSingleUnused(paperIndexes.byOrderId, refs.orderId, usedPaperIndexes);
  if (byOrder != null) return { index: byOrder, matchMethod: 'mt5OrderId' };

  const byEntryDeal = getSingleUnused(paperIndexes.byEntryDealId, refs.entryDealId, usedPaperIndexes);
  if (byEntryDeal != null) return { index: byEntryDeal, matchMethod: 'mt5EntryDealId' };

  return null;
}

function detectDominantOffsetMinutes(matches = []) {
  const counts = new Map();
  matches.forEach(({ brokerTrade, paperTrade }) => {
    const minutes = diffMinutes(getOpenedAt(brokerTrade), getOpenedAt(paperTrade));
    if (minutes == null || Math.abs(minutes) > 24 * 60) return;
    counts.set(minutes, (counts.get(minutes) || 0) + 1);
  });

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return 0;
  const [minutes, count] = sorted[0];
  return count >= 2 ? minutes : 0;
}

function adjustedPaperOpenTime(paperTrade, offsetMinutes) {
  const openedAt = getOpenedAt(paperTrade);
  if (!openedAt) return null;
  return new Date(openedAt.getTime() + (offsetMinutes * 60000));
}

function findUniqueTimeMatch(brokerTrade, paperTrades, usedPaperIndexes, offsetMinutes, windowMinutes) {
  const brokerOpenedAt = getOpenedAt(brokerTrade);
  if (!brokerOpenedAt) return null;

  const brokerSymbol = normalizeSymbol(brokerTrade.symbol);
  const brokerSide = normalizeSide(brokerTrade.type || brokerTrade.side);
  const candidates = [];

  paperTrades.forEach((paperTrade, index) => {
    if (usedPaperIndexes.has(index)) return;
    if (normalizeSymbol(paperTrade.symbol) !== brokerSymbol) return;
    if (normalizeSide(paperTrade.type || paperTrade.side) !== brokerSide) return;

    const paperOpenedAt = adjustedPaperOpenTime(paperTrade, offsetMinutes);
    if (!paperOpenedAt) return;
    const distance = Math.abs(brokerOpenedAt.getTime() - paperOpenedAt.getTime()) / 60000;
    if (distance <= windowMinutes) {
      candidates.push({ index, distance });
    }
  });

  if (candidates.length !== 1) return null;
  return {
    index: candidates[0].index,
    matchMethod: 'symbol_side_entry_time',
  };
}

function buildDataQualityFlags(row = {}, source) {
  const flags = [];
  if (source) flags.push(source);
  if (!hasValue(row.confidence)) flags.push('missing_confidence');
  if (!hasValue(row.signalReason) && !hasValue(row.reason) && !hasValue(row.entryReason)) {
    flags.push('missing_signal_reason');
  }
  if (!hasValue(row.indicatorsSnapshot)) flags.push('missing_indicators_snapshot');
  if (!hasValue(row.mt5PositionId) && !hasValue(row.mt5EntryDealId)) flags.push('missing_ticket');
  if (row.timeOffsetMinutes !== '' && row.timeOffsetMinutes != null && Number(row.timeOffsetMinutes) !== 0) {
    flags.push(`time_offset_${row.timeOffsetMinutes}m`);
  }
  return flags;
}

function pickStrategy(brokerTrade = {}, paperTrade = {}) {
  if (!isUnknownStrategy(brokerTrade.strategy)) return normalizeStrategy(brokerTrade.strategy);
  if (!isUnknownStrategy(paperTrade.strategy)) return normalizeStrategy(paperTrade.strategy);
  return normalizeStrategy(firstValue(brokerTrade.strategy, paperTrade.strategy)) || UNKNOWN_STRATEGY;
}

function withCanonicalDiagnostics(row, diagnostics) {
  const rowWithDiagnostics = {
    ...row,
    ledgerSource: diagnostics.ledgerSource,
    canonicalTradeId: diagnostics.canonicalTradeId,
    matchedBrokerTradeId: diagnostics.matchedBrokerTradeId || '',
    matchedPaperTradeId: diagnostics.matchedPaperTradeId || '',
    matchMethod: diagnostics.matchMethod || '',
    timeOffsetMinutes: diagnostics.timeOffsetMinutes ?? '',
  };
  return {
    ...rowWithDiagnostics,
    dataQualityFlags: buildDataQualityFlags(rowWithDiagnostics, diagnostics.ledgerSource),
  };
}

function mergeMatchedTrade(brokerTrade = {}, paperTrade = {}, matchMethod = 'mt5PositionId') {
  const offset = diffMinutes(getOpenedAt(brokerTrade), getOpenedAt(paperTrade));
  const brokerRefs = getTradeRefs(brokerTrade);
  const paperRefs = getTradeRefs(paperTrade);

  const row = {
    ...brokerTrade,
    symbol: firstValue(brokerTrade.symbol, paperTrade.symbol),
    type: firstValue(brokerTrade.type, brokerTrade.side, paperTrade.type, paperTrade.side),
    strategy: pickStrategy(brokerTrade, paperTrade),
    confidence: firstValue(paperTrade.confidence, brokerTrade.confidence),
    rawConfidence: firstValue(paperTrade.rawConfidence, brokerTrade.rawConfidence),
    reason: firstValue(paperTrade.signalReason, paperTrade.reason, brokerTrade.reason),
    signalReason: firstValue(paperTrade.signalReason, paperTrade.reason, brokerTrade.signalReason, brokerTrade.reason),
    entryReason: firstValue(paperTrade.entryReason, brokerTrade.entryReason),
    setupReason: firstValue(paperTrade.setupReason, brokerTrade.setupReason),
    triggerReason: firstValue(paperTrade.triggerReason, brokerTrade.triggerReason),
    indicatorsSnapshot: firstValue(paperTrade.indicatorsSnapshot, brokerTrade.indicatorsSnapshot),
    executionPolicy: firstValue(paperTrade.executionPolicy, brokerTrade.executionPolicy),
    executionScore: firstValue(paperTrade.executionScore, brokerTrade.executionScore),
    executionScoreDetails: firstValue(paperTrade.executionScoreDetails, brokerTrade.executionScoreDetails),
    plannedRiskAmount: firstValue(paperTrade.plannedRiskAmount, brokerTrade.plannedRiskAmount),
    realizedRMultiple: firstValue(paperTrade.realizedRMultiple, brokerTrade.realizedRMultiple),
    targetRMultiple: firstValue(paperTrade.targetRMultiple, brokerTrade.targetRMultiple),
    targetRMultipleCaptured: firstValue(paperTrade.targetRMultipleCaptured, brokerTrade.targetRMultipleCaptured),
    initialSl: firstValue(paperTrade.initialSl, brokerTrade.initialSl, paperTrade.stopLoss, brokerTrade.sl),
    initialTp: firstValue(paperTrade.initialTp, brokerTrade.initialTp, paperTrade.takeProfit, brokerTrade.tp),
    finalSl: firstValue(paperTrade.finalSl, brokerTrade.finalSl, paperTrade.stopLoss, brokerTrade.sl),
    finalTp: firstValue(paperTrade.finalTp, brokerTrade.finalTp, paperTrade.takeProfit, brokerTrade.tp),
    managementEvents: firstValue(paperTrade.managementEvents, brokerTrade.managementEvents),
    maxFavourableR: firstValue(paperTrade.maxFavourableR, brokerTrade.maxFavourableR),
    maxAdverseR: firstValue(paperTrade.maxAdverseR, brokerTrade.maxAdverseR),
    spreadAtEntry: firstValue(paperTrade.spreadAtEntry, brokerTrade.spreadAtEntry),
    slippageEstimate: firstValue(paperTrade.slippageEstimate, brokerTrade.slippageEstimate),
    brokerRetcodeOpen: firstValue(paperTrade.brokerRetcodeOpen, brokerTrade.brokerRetcodeOpen),
    brokerRetcodeClose: firstValue(brokerTrade.brokerRetcodeClose, paperTrade.brokerRetcodeClose),
    brokerRetcodeModify: firstValue(paperTrade.brokerRetcodeModify, brokerTrade.brokerRetcodeModify),
    positionSnapshot: firstValue(paperTrade.positionSnapshot, brokerTrade.positionSnapshot),
    positionDbId: firstValue(paperTrade.positionDbId, brokerTrade.positionDbId),
    mt5PositionId: firstValue(brokerRefs.positionId, paperRefs.positionId),
    mt5OrderId: firstValue(brokerRefs.orderId, paperRefs.orderId),
    mt5EntryDealId: firstValue(brokerRefs.entryDealId, paperRefs.entryDealId),
    mt5DealId: firstValue(paperTrade.mt5DealId, brokerTrade.mt5DealId, brokerRefs.entryDealId, paperRefs.entryDealId),
    mt5CloseDealId: firstValue(brokerTrade.mt5CloseDealId, paperTrade.mt5CloseDealId),
    mt5Comment: firstValue(brokerTrade.mt5Comment, paperTrade.mt5Comment),
    comment: firstValue(paperTrade.comment, brokerTrade.comment),
    openedAt: firstValue(brokerTrade.openedAt, paperTrade.openedAt),
    closedAt: firstValue(brokerTrade.closedAt, paperTrade.closedAt),
    exitPrice: firstValue(brokerTrade.exitPrice, paperTrade.exitPrice),
    exitReason: firstValue(brokerTrade.exitReason, paperTrade.exitReason),
    profitLoss: firstValue(brokerTrade.profitLoss, paperTrade.profitLoss),
    grossProfitLoss: firstValue(brokerTrade.grossProfitLoss, paperTrade.grossProfitLoss),
    profitPips: firstValue(brokerTrade.profitPips, paperTrade.profitPips),
    commission: firstValue(brokerTrade.commission, paperTrade.commission, 0),
    swap: firstValue(brokerTrade.swap, paperTrade.swap, 0),
    fee: firstValue(brokerTrade.fee, paperTrade.fee, 0),
    status: firstValue(brokerTrade.status, paperTrade.status),
    brokerOpenedAt: brokerTrade.openedAt || null,
    paperOpenedAt: paperTrade.openedAt || null,
    brokerClosedAt: brokerTrade.closedAt || null,
    paperClosedAt: paperTrade.closedAt || null,
  };

  const canonicalId = firstValue(row.mt5PositionId, row.mt5EntryDealId, brokerTrade._id, paperTrade._id);
  return withCanonicalDiagnostics(row, {
    ledgerSource: 'matched',
    canonicalTradeId: `mt5:${canonicalId}`,
    matchedBrokerTradeId: brokerTrade._id,
    matchedPaperTradeId: paperTrade._id,
    matchMethod,
    timeOffsetMinutes: offset,
  });
}

function buildBrokerOnlyTrade(brokerTrade = {}) {
  const row = {
    ...brokerTrade,
    strategy: normalizeStrategy(brokerTrade.strategy) || UNKNOWN_STRATEGY,
    brokerOpenedAt: brokerTrade.openedAt || null,
    brokerClosedAt: brokerTrade.closedAt || null,
    paperOpenedAt: null,
    paperClosedAt: null,
  };
  const refs = getTradeRefs(row);
  const canonicalId = firstValue(refs.positionId, refs.entryDealId, row._id);
  return withCanonicalDiagnostics(row, {
    ledgerSource: 'broker_only',
    canonicalTradeId: `broker:${canonicalId}`,
    matchedBrokerTradeId: row._id,
  });
}

function buildPaperOnlyTrade(paperTrade = {}) {
  const row = {
    ...paperTrade,
    strategy: normalizeStrategy(paperTrade.strategy) || UNKNOWN_STRATEGY,
    mt5EntryDealId: firstValue(paperTrade.mt5EntryDealId, paperTrade.mt5DealId),
    brokerOpenedAt: null,
    brokerClosedAt: null,
    paperOpenedAt: paperTrade.openedAt || null,
    paperClosedAt: paperTrade.closedAt || null,
    brokerSyncSource: firstValue(paperTrade.brokerSyncSource, 'paper'),
  };
  const refs = getTradeRefs(row);
  const canonicalId = firstValue(refs.positionId, refs.entryDealId, row._id);
  return withCanonicalDiagnostics(row, {
    ledgerSource: 'paper_only',
    canonicalTradeId: `paper:${canonicalId}`,
    matchedPaperTradeId: row._id,
  });
}

function sortLedgerRows(rows = []) {
  return [...rows].sort((a, b) => {
    const aTime = getOpenedAt(a)?.getTime() || 0;
    const bTime = getOpenedAt(b)?.getTime() || 0;
    return bTime - aTime;
  });
}

function matchesFilters(row = {}, filters = {}) {
  if (filters.symbol && normalizeSymbol(row.symbol) !== normalizeSymbol(filters.symbol)) return false;
  if (filters.status && String(row.status || '').toUpperCase() !== String(filters.status).toUpperCase()) return false;

  if (filters.strategy) {
    const aliases = getStrategyNameAliases(filters.strategy).map(normalizeStrategy);
    if (!aliases.includes(normalizeStrategy(row.strategy))) return false;
  }

  const startDate = normalizeDateStart(filters.startDate);
  const endDate = normalizeDateEnd(filters.endDate);
  if (startDate || endDate) {
    const openedAt = getOpenedAt(row);
    if (!openedAt) return false;
    if (startDate && openedAt < startDate) return false;
    if (endDate && openedAt > endDate) return false;
  }

  return true;
}

function buildCanonicalLedgerRows({
  brokerTrades = [],
  paperTrades = [],
  filters = {},
  limit = 0,
  fallbackWindowMinutes = DEFAULT_FALLBACK_WINDOW_MINUTES,
} = {}) {
  const paperIndexes = {
    byPositionId: buildIndex(paperTrades, (trade) => getTradeRefs(trade).positionId),
    byOrderId: buildIndex(paperTrades, (trade) => getTradeRefs(trade).orderId),
    byEntryDealId: buildIndex(paperTrades, (trade) => getTradeRefs(trade).entryDealId),
  };

  const directMatches = [];
  const usedPaperIndexes = new Set();
  const matchedBrokerIndexes = new Set();

  brokerTrades.forEach((brokerTrade, brokerIndex) => {
    const match = findReferenceMatch(brokerTrade, paperIndexes, usedPaperIndexes);
    if (!match) return;
    usedPaperIndexes.add(match.index);
    matchedBrokerIndexes.add(brokerIndex);
    directMatches.push({
      brokerIndex,
      paperIndex: match.index,
      brokerTrade,
      paperTrade: paperTrades[match.index],
      matchMethod: match.matchMethod,
    });
  });

  const detectedOffsetMinutes = detectDominantOffsetMinutes(directMatches);
  const timeMatches = [];

  brokerTrades.forEach((brokerTrade, brokerIndex) => {
    if (matchedBrokerIndexes.has(brokerIndex)) return;
    const match = findUniqueTimeMatch(
      brokerTrade,
      paperTrades,
      usedPaperIndexes,
      detectedOffsetMinutes,
      fallbackWindowMinutes
    );
    if (!match) return;
    usedPaperIndexes.add(match.index);
    matchedBrokerIndexes.add(brokerIndex);
    timeMatches.push({
      brokerIndex,
      paperIndex: match.index,
      brokerTrade,
      paperTrade: paperTrades[match.index],
      matchMethod: match.matchMethod,
    });
  });

  const rows = [...directMatches, ...timeMatches].map((match) => (
    mergeMatchedTrade(match.brokerTrade, match.paperTrade, match.matchMethod)
  ));

  brokerTrades.forEach((brokerTrade, brokerIndex) => {
    if (!matchedBrokerIndexes.has(brokerIndex)) rows.push(buildBrokerOnlyTrade(brokerTrade));
  });

  paperTrades.forEach((paperTrade, paperIndex) => {
    if (!usedPaperIndexes.has(paperIndex)) rows.push(buildPaperOnlyTrade(paperTrade));
  });

  const filtered = sortLedgerRows(rows).filter((row) => matchesFilters(row, filters));
  return limit > 0 ? filtered.slice(0, limit) : filtered;
}

function buildDbQuery(filters = {}) {
  const query = {};
  if (filters.symbol) query.symbol = filters.symbol;

  const startDate = normalizeDateStart(filters.startDate);
  const endDate = normalizeDateEnd(filters.endDate);
  if (startDate || endDate) {
    query.openedAt = {};
    if (startDate) query.openedAt.$gte = new Date(startDate.getTime() - (24 * 60 * 60 * 1000));
    if (endDate) query.openedAt.$lte = new Date(endDate.getTime() + (24 * 60 * 60 * 1000));
  }

  return query;
}

async function loadBrokerTrades(filters = {}) {
  return tradesDb.find(buildDbQuery(filters)).sort({ openedAt: -1 });
}

async function loadPaperTrades(filters = {}) {
  return tradeLogDb.find(buildDbQuery(filters)).sort({ openedAt: -1 });
}

async function getLedgerRows(filters = {}, options = {}) {
  const [brokerTrades, paperTrades] = await Promise.all([
    loadBrokerTrades(filters),
    loadPaperTrades(filters),
  ]);

  return buildCanonicalLedgerRows({
    brokerTrades,
    paperTrades,
    filters,
    limit: options.limit || 0,
  });
}

async function getBrokerRows(filters = {}, options = {}) {
  let rows = await loadBrokerTrades(filters);
  rows = sortLedgerRows(rows).filter((row) => matchesFilters(row, filters));
  return options.limit > 0 ? rows.slice(0, options.limit) : rows;
}

async function getPaperRows(filters = {}, options = {}) {
  let rows = await loadPaperTrades(filters);
  rows = sortLedgerRows(rows).filter((row) => matchesFilters(row, filters));
  return options.limit > 0 ? rows.slice(0, options.limit) : rows;
}

async function getRows({ source = 'canonical', filters = {}, limit = 0 } = {}) {
  const normalizedSource = normalizeLedgerSource(source);
  if (normalizedSource === 'broker') return getBrokerRows(filters, { limit });
  if (normalizedSource === 'paper') return getPaperRows(filters, { limit });
  return getLedgerRows(filters, { limit });
}

function normalizeLedgerSource(source = 'canonical') {
  const normalized = String(source || 'canonical').trim().toLowerCase();
  if (['canonical', 'broker', 'paper'].includes(normalized)) return normalized;
  return 'canonical';
}

module.exports = {
  buildCanonicalLedgerRows,
  detectDominantOffsetMinutes,
  getRows,
  getLedgerRows,
  getBrokerRows,
  getPaperRows,
  normalizeLedgerSource,
  matchesFilters,
};
