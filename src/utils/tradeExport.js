const {
  buildEntryIndicatorsSnapshot,
  isPlainObject,
} = require('./tradeDataCapture');
const {
  normalizeDateValue,
  normalizeDateStart,
  normalizeDateEnd,
} = require('./tradeTime');

function escapeCsv(value) {
  if (value == null) return '';
  const stringValue = String(value);
  if (/[",\r\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function serializeCell(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function hasValue(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

function firstValue(...values) {
  for (const value of values) {
    if (hasValue(value)) return value;
  }
  return '';
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundNumber(value, digits = 4) {
  const number = toFiniteNumber(value);
  return number == null ? '' : parseFloat(number.toFixed(digits));
}

function parseJsonValue(value) {
  if (!hasValue(value)) return null;
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function getLinkedPosition(row = {}) {
  const candidates = [
    row.positionSnapshot,
    row.linkedPositionSnapshot,
    row.linkedPosition,
    row.position,
  ];
  for (const candidate of candidates) {
    const parsed = parseJsonValue(candidate);
    if (isPlainObject(parsed)) return parsed;
  }
  return {};
}

function getDealSummary(row = {}) {
  const candidates = [
    row.dealSummary,
    row.mt5DealSummary,
    row.brokerDealSummary,
  ];
  for (const candidate of candidates) {
    const parsed = parseJsonValue(candidate);
    if (isPlainObject(parsed)) return parsed;
  }
  return {};
}

function readFromSource(source = {}, keys = []) {
  if (!isPlainObject(source)) return '';
  for (const key of keys) {
    if (hasValue(source[key])) return source[key];
  }
  return '';
}

function readExportValue(row = {}, keys = [], options = {}) {
  const linkedPosition = options.linkedPosition || getLinkedPosition(row);
  const dealSummary = options.dealSummary || getDealSummary(row);
  const positionKeys = options.positionKeys || keys;
  const dealKeys = options.dealKeys || keys;

  return firstValue(
    readFromSource(row, keys),
    readFromSource(linkedPosition, positionKeys),
    readFromSource(dealSummary, dealKeys)
  );
}

function parseConfidence(value) {
  if (!hasValue(value)) return null;
  const stringValue = String(value).trim();
  const numericText = stringValue.endsWith('%') ? stringValue.slice(0, -1) : stringValue;
  const number = Number(numericText);
  if (!Number.isFinite(number)) return null;
  if (stringValue.endsWith('%')) return parseFloat((number / 100).toFixed(4));
  if (number > 1 && number <= 100) return parseFloat((number / 100).toFixed(4));
  return number;
}

function parseCommentFields(row = {}) {
  const result = {};
  const comments = [row.comment, row.mt5Comment, row.mt5_comment].filter(hasValue);

  for (const comment of comments) {
    const parts = String(comment).split('|').map((part) => part.trim()).filter(Boolean);

    for (const part of parts) {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex < 0) continue;
      const key = part.slice(0, separatorIndex).trim().toLowerCase();
      const value = part.slice(separatorIndex + 1).trim();
      if (!value) continue;
      if (key === 'reason' && !result.reason) result.reason = value;
      if (key === 'confidence' && result.confidence == null) {
        result.confidence = parseConfidence(value);
      }
    }

    if (parts.length >= 4 && (parts[0] === 'QM' || parts[0] === 'PT')) {
      const confidence = parseConfidence(parts[3]);
      if (confidence != null && result.confidence == null) {
        result.confidence = confidence;
      }
    }
  }

  return result;
}

function firstParsedObject(...values) {
  for (const value of values) {
    const parsed = parseJsonValue(value);
    if (isPlainObject(parsed) && Object.keys(parsed).length > 0) return parsed;
  }
  return {};
}

function buildIndicatorsSnapshotForExport(row = {}) {
  const linkedPosition = getLinkedPosition(row);
  const rawSnapshot = firstParsedObject(
    row.indicatorsSnapshot,
    row.indicators_snapshot,
    linkedPosition.indicatorsSnapshot,
    linkedPosition.indicators_snapshot
  );

  const snapshot = buildEntryIndicatorsSnapshot({
    indicatorsSnapshot: rawSnapshot,
    atrAtEntry: readExportValue(row, ['atrAtEntry', 'atr_at_entry'], { linkedPosition }),
    setupTimeframe: readExportValue(row, ['setupTimeframe', 'setup_timeframe'], { linkedPosition }),
    entryTimeframe: readExportValue(row, ['entryTimeframe', 'entry_timeframe'], { linkedPosition }),
    setupCandleTime: readExportValue(row, ['setupCandleTime', 'setup_candle_time'], { linkedPosition }),
    entryCandleTime: readExportValue(row, ['entryCandleTime', 'entry_candle_time'], { linkedPosition }),
    higherTfTrend: readExportValue(row, ['higherTfTrend', 'higher_tf_trend'], { linkedPosition }),
    marketRegime: readExportValue(row, ['marketRegime', 'market_regime'], { linkedPosition }),
  });

  return Object.keys(snapshot).length > 0 ? snapshot : null;
}

function parseManagementEvents(row = {}) {
  const linkedPosition = getLinkedPosition(row);
  const rawEvents = firstValue(row.managementEvents, row.management_events, linkedPosition.managementEvents);
  const parsed = parseJsonValue(rawEvents);
  return Array.isArray(parsed) ? parsed : [];
}

function eventText(event = {}) {
  return JSON.stringify(event || {}).toUpperCase();
}

function summarizeManagementEvents(row = {}) {
  const events = parseManagementEvents(row);
  const linkedPosition = getLinkedPosition(row);
  const executedPartials = firstValue(row.partialsExecutedIndices, linkedPosition.partialsExecutedIndices);
  const parsedPartials = parseJsonValue(executedPartials);
  const partialsFromState = Array.isArray(parsedPartials) ? parsedPartials.length : 0;
  let partialCloseCount = partialsFromState;

  let breakevenTriggered = false;
  let trailingTriggered = false;
  events.forEach((event) => {
    const text = eventText(event);
    if (text.includes('BREAKEVEN')) breakevenTriggered = true;
    if (text.includes('TRAILING')) trailingTriggered = true;
    if (
      text.includes('PARTIAL')
      && !text.includes('"STATUS":"PENDING"')
      && !text.includes('"STATUS":"FAILED"')
    ) {
      partialCloseCount += 1;
    }
  });

  return {
    events,
    breakevenTriggered,
    trailingTriggered,
    partialCloseCount,
  };
}

function isStopLossReason(reason) {
  const normalized = String(reason || '').toUpperCase();
  return normalized.includes('SL') || normalized.includes('STOP_LOSS') || normalized === 'STOP';
}

function classifyProtectiveStop(row = {}) {
  const entryPrice = toFiniteNumber(readExportValue(row, ['entryPrice', 'entry_price']));
  const finalSl = toFiniteNumber(readExportValue(row, [
    'finalSl',
    'finalSL',
    'final_sl',
    'currentSl',
    'currentSL',
    'current_sl',
    'sl',
    'stopLoss',
    'stop_loss',
  ]));
  if (entryPrice == null || finalSl == null) return null;

  const side = String(readExportValue(row, ['type', 'side'])).toUpperCase();
  const epsilon = Math.max(Math.abs(entryPrice) * 1e-8, 1e-10);
  if (side === 'BUY' && finalSl >= entryPrice - epsilon) {
    return Math.abs(finalSl - entryPrice) <= epsilon ? 'BREAKEVEN_SL_HIT' : 'PROTECTIVE_SL_HIT';
  }
  if (side === 'SELL' && finalSl <= entryPrice + epsilon) {
    return Math.abs(finalSl - entryPrice) <= epsilon ? 'BREAKEVEN_SL_HIT' : 'PROTECTIVE_SL_HIT';
  }

  return null;
}

function normalizeExitReasonDetail(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) return '';
  if (normalized.includes('TRAILING')) return 'TRAILING_SL_HIT';
  if (normalized.includes('BREAKEVEN')) return 'BREAKEVEN_SL_HIT';
  if (normalized.includes('PROTECTIVE')) return 'PROTECTIVE_SL_HIT';
  if (normalized.includes('INITIAL_SL') || normalized === 'SL_HIT' || normalized === 'SL') return 'INITIAL_SL_HIT';
  if (normalized.includes('PARTIAL')) return 'PARTIAL_TP';
  if (normalized.includes('TP')) return 'TP_HIT';
  if (normalized.includes('TIME')) return 'TIME_EXIT';
  if (normalized.includes('MANUAL') || normalized.includes('CLIENT')) return 'MANUAL_CLOSE';
  if (normalized.includes('NEWS')) return 'NEWS_PROTECTION_EXIT';
  if (normalized.includes('INVALID')) return 'INVALIDATION_EXIT';
  if (normalized.includes('END_OF_DATA')) return 'END_OF_DATA';
  if (normalized.includes('EXTERNAL') || normalized.includes('BROKER')) return 'EXTERNAL_CLOSE';
  return normalized;
}

function deriveExitReasonDetail(row = {}) {
  const explicit = readExportValue(row, ['exitReasonDetail', 'exit_reason_detail']);
  if (hasValue(explicit)) return normalizeExitReasonDetail(explicit);

  const exitReason = readExportValue(row, ['exitReason', 'exit_reason']);
  const normalized = String(exitReason || '').trim().toUpperCase();
  const management = summarizeManagementEvents(row);

  if (isStopLossReason(normalized)) {
    if (management.trailingTriggered) return 'TRAILING_SL_HIT';
    if (management.breakevenTriggered) return 'BREAKEVEN_SL_HIT';
    const protectiveDetail = classifyProtectiveStop(row);
    return protectiveDetail || normalizeExitReasonDetail(normalized);
  }

  return normalizeExitReasonDetail(normalized);
}

function deriveRMultipleFromPrice(row = {}, key) {
  const explicit = readExportValue(row, [key]);
  if (hasValue(explicit)) return roundNumber(explicit);

  const entryPrice = toFiniteNumber(readExportValue(row, ['entryPrice', 'entry_price']));
  const initialSl = toFiniteNumber(readExportValue(row, ['initialSl', 'initialSL', 'initial_sl', 'sl', 'stopLoss', 'stop_loss']));
  const side = String(readExportValue(row, ['type', 'side'])).toUpperCase();
  const riskDistance = entryPrice != null && initialSl != null ? Math.abs(entryPrice - initialSl) : null;
  if (!(riskDistance > 0)) return '';

  if (key === 'maxFavourableR') {
    const favourablePrice = toFiniteNumber(readExportValue(row, ['maxFavourablePrice', 'max_favourable_price']));
    if (favourablePrice == null) return '';
    const favourableDistance = side === 'SELL' ? entryPrice - favourablePrice : favourablePrice - entryPrice;
    return roundNumber(Math.max(0, favourableDistance) / riskDistance);
  }

  const adversePrice = toFiniteNumber(readExportValue(row, ['maxAdversePrice', 'max_adverse_price']));
  if (adversePrice == null) return '';
  const adverseDistance = side === 'SELL' ? adversePrice - entryPrice : entryPrice - adversePrice;
  return roundNumber(Math.max(0, adverseDistance) / riskDistance);
}

function deriveGrossProfitLoss(row = {}) {
  const explicit = readExportValue(row, ['grossProfitLoss', 'gross_profit_loss'], {
    dealKeys: ['grossProfitLoss', 'grossProfit', 'gross_profit'],
  });
  if (hasValue(explicit)) return roundNumber(explicit);

  const netProfit = toFiniteNumber(readExportValue(row, ['profitLoss', 'profit_loss_usd', 'realizedProfit']));
  if (netProfit == null) return '';
  const commission = toFiniteNumber(readExportValue(row, ['commission'])) || 0;
  const swap = toFiniteNumber(readExportValue(row, ['swap'])) || 0;
  const fee = toFiniteNumber(readExportValue(row, ['fee'])) || 0;
  return roundNumber(netProfit - commission - swap - fee);
}

function deriveHoldingMinutes(row = {}) {
  const explicit = readExportValue(row, ['holdingMinutes', 'holding_minutes']);
  if (hasValue(explicit)) return roundNumber(explicit, 2);
  const openedAt = normalizeDateValue(readExportValue(row, ['openedAt', 'mt5_open_time']));
  const closedAt = normalizeDateValue(readExportValue(row, ['closedAt', 'mt5_close_time']));
  if (!openedAt || !closedAt) return '';
  return roundNumber((closedAt.getTime() - openedAt.getTime()) / 60000, 2);
}

function deriveSession(row = {}) {
  const openedAt = normalizeDateValue(readExportValue(row, ['openedAt', 'mt5_open_time']));
  if (!openedAt) return '';
  const hour = openedAt.getUTCHours();
  if (hour >= 13 && hour < 17) return 'Overlap';
  if (hour >= 0 && hour < 7) return 'Asia';
  if (hour >= 7 && hour < 13) return 'London';
  if (hour >= 17 && hour < 22) return 'NewYork';
  return 'OffHours';
}

function deriveWeekday(row = {}) {
  const openedAt = normalizeDateValue(readExportValue(row, ['openedAt', 'mt5_open_time']));
  if (!openedAt) return '';
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][openedAt.getUTCDay()];
}

function prepareTradeExportRow(row = {}) {
  const linkedPosition = getLinkedPosition(row);
  const parsedComment = parseCommentFields(row);
  const management = summarizeManagementEvents(row);
  const confidence = firstValue(
    row.confidence,
    linkedPosition.confidence,
    parsedComment.confidence
  );
  const signalReason = firstValue(
    row.signalReason,
    row.signal_reason,
    row.reason,
    linkedPosition.signalReason,
    linkedPosition.reason,
    parsedComment.reason
  );
  const entryReason = firstValue(
    row.entryReason,
    row.entry_reason,
    linkedPosition.entryReason,
    linkedPosition.entry_reason,
    signalReason
  );
  const setupReason = firstValue(
    row.setupReason,
    row.setup_reason,
    linkedPosition.setupReason,
    linkedPosition.setup_reason
  );
  const triggerReason = firstValue(
    row.triggerReason,
    row.trigger_reason,
    linkedPosition.triggerReason,
    linkedPosition.trigger_reason
  );
  const initialSl = firstValue(
    readExportValue(row, ['initialSl', 'initialSL', 'initial_sl'], { linkedPosition }),
    readExportValue(row, ['sl', 'stopLoss', 'stop_loss'], { linkedPosition })
  );
  const initialTp = firstValue(
    readExportValue(row, ['initialTp', 'initialTP', 'initial_tp'], { linkedPosition }),
    readExportValue(row, ['tp', 'takeProfit', 'take_profit'], { linkedPosition })
  );
  const finalSl = firstValue(
    readExportValue(row, ['finalSl', 'finalSL', 'final_sl', 'currentSl', 'currentSL', 'current_sl'], { linkedPosition }),
    initialSl
  );
  const finalTp = firstValue(
    readExportValue(row, ['finalTp', 'finalTP', 'final_tp', 'currentTp', 'currentTP', 'current_tp'], { linkedPosition }),
    initialTp
  );

  const prepared = {
    ...row,
    confidence,
    reason: signalReason,
    signalReason,
    entryReason,
    setupReason,
    triggerReason,
    sl: firstValue(row.sl, row.stopLoss, initialSl),
    tp: firstValue(row.tp, row.takeProfit, initialTp),
    initialSl,
    initialTp,
    finalSl,
    finalTp,
    plannedRiskAmount: firstValue(readExportValue(row, ['plannedRiskAmount', 'planned_risk_amount'], { linkedPosition })),
    realizedRMultiple: firstValue(readExportValue(row, ['realizedRMultiple', 'realized_r_multiple'], { linkedPosition })),
    targetRMultiple: firstValue(readExportValue(row, ['targetRMultiple', 'target_r_multiple'], { linkedPosition })),
    targetRMultipleCaptured: firstValue(readExportValue(row, ['targetRMultipleCaptured', 'target_r_multiple_captured'], { linkedPosition })),
    executionScore: firstValue(readExportValue(row, ['executionScore', 'execution_score'], { linkedPosition })),
    executionScoreDetails: firstValue(readExportValue(row, ['executionScoreDetails', 'execution_score_details'], { linkedPosition })),
    managementEvents: management.events.length > 0 ? management.events : null,
    breakevenTriggered: management.breakevenTriggered,
    trailingTriggered: management.trailingTriggered,
    partialCloseCount: management.partialCloseCount,
    maxFavourableR: deriveRMultipleFromPrice(row, 'maxFavourableR'),
    maxAdverseR: deriveRMultipleFromPrice(row, 'maxAdverseR'),
    grossProfitLoss: deriveGrossProfitLoss(row),
    spreadAtEntry: firstValue(readExportValue(row, ['spreadAtEntry', 'spread_at_entry'], { linkedPosition })),
    slippageEstimate: firstValue(readExportValue(row, ['slippageEstimate', 'slippage_estimate'], { linkedPosition })),
    holdingMinutes: deriveHoldingMinutes(row),
    brokerRetcodeOpen: firstValue(readExportValue(row, ['brokerRetcodeOpen', 'broker_retcode_open'], { linkedPosition })),
    brokerRetcodeClose: firstValue(readExportValue(row, ['brokerRetcodeClose', 'broker_retcode_close'], { linkedPosition })),
    brokerRetcodeModify: firstValue(readExportValue(row, ['brokerRetcodeModify', 'broker_retcode_modify'], { linkedPosition })),
    indicatorsSnapshot: buildIndicatorsSnapshotForExport(row),
    session: firstValue(row.session, deriveSession(row)),
    weekday: firstValue(row.weekday, deriveWeekday(row)),
  };

  prepared.exitReasonDetail = deriveExitReasonDetail(prepared);
  return prepared;
}

function prepareTradeExportRows(rows = []) {
  return rows.map((row) => prepareTradeExportRow(row));
}

function resolveColumnValue(column, row) {
  if (typeof column.value === 'function') return column.value(row);
  return row[column.key];
}

function buildCsv(columns, rows) {
  const header = columns.map((column) => escapeCsv(column.header)).join(',');
  const preparedRows = prepareTradeExportRows(rows);
  const body = preparedRows.map((row) => (
    columns.map((column) => escapeCsv(serializeCell(resolveColumnValue(column, row)))).join(',')
  ));

  return '\uFEFF' + [header, ...body].join('\r\n');
}

function buildExportFilename(filters = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const parts = ['quantmatrix-trades'];
  if (filters.source) parts.push(filters.source);
  if (filters.symbol) parts.push(filters.symbol);
  if (filters.strategy) parts.push(filters.strategy);
  if (filters.status) parts.push(filters.status);
  parts.push(today);
  return `${parts.join('-').replace(/[^a-zA-Z0-9-_]+/g, '_')}.csv`;
}

const LIVE_TRADE_COLUMNS = [
  { key: 'openedAt', header: 'mt5_open_time' },
  { key: 'closedAt', header: 'mt5_close_time' },
  { key: 'symbol', header: 'symbol' },
  { key: 'type', header: 'side' },
  { key: 'strategy', header: 'strategy' },
  { key: 'confidence', header: 'confidence' },
  { key: 'comment', header: 'comment' },
  { key: 'mt5Comment', header: 'mt5_comment' },
  { key: 'reason', header: 'signal_reason' },
  { key: 'entryPrice', header: 'entry_price' },
  { key: 'exitPrice', header: 'exit_price' },
  { key: 'sl', header: 'stop_loss' },
  { key: 'tp', header: 'take_profit' },
  { key: 'lotSize', header: 'lot_size' },
  { key: 'profitLoss', header: 'profit_loss_usd' },
  { key: 'profitPips', header: 'profit_pips' },
  { key: 'commission', header: 'commission' },
  { key: 'swap', header: 'swap' },
  { key: 'fee', header: 'fee' },
  { key: 'exitReason', header: 'exit_reason' },
  { key: 'status', header: 'status' },
  { key: 'mt5PositionId', header: 'mt5_position_id' },
  { key: 'mt5OrderId', header: 'mt5_order_id' },
  { key: 'mt5EntryDealId', header: 'mt5_entry_deal_id' },
  { key: 'mt5CloseDealId', header: 'mt5_close_deal_id' },
  { key: 'brokerSyncSource', header: 'broker_sync_source' },
  { key: 'brokerSyncedAt', header: 'broker_synced_at' },
  { key: 'indicatorsSnapshot', header: 'indicators_snapshot' },
  { key: 'entryReason', header: 'entry_reason' },
  { key: 'setupReason', header: 'setup_reason' },
  { key: 'triggerReason', header: 'trigger_reason' },
  { key: 'executionScore', header: 'execution_score' },
  { key: 'executionScoreDetails', header: 'execution_score_details' },
  { key: 'initialSl', header: 'initial_sl' },
  { key: 'initialTp', header: 'initial_tp' },
  { key: 'finalSl', header: 'final_sl' },
  { key: 'finalTp', header: 'final_tp' },
  { key: 'plannedRiskAmount', header: 'planned_risk_amount' },
  { key: 'realizedRMultiple', header: 'realized_r_multiple' },
  { key: 'targetRMultiple', header: 'target_r_multiple' },
  { key: 'targetRMultipleCaptured', header: 'target_r_multiple_captured' },
  { key: 'exitReasonDetail', header: 'exit_reason_detail' },
  { key: 'managementEvents', header: 'management_events' },
  { key: 'breakevenTriggered', header: 'breakeven_triggered' },
  { key: 'trailingTriggered', header: 'trailing_triggered' },
  { key: 'partialCloseCount', header: 'partial_close_count' },
  { key: 'maxFavourableR', header: 'max_favourable_r' },
  { key: 'maxAdverseR', header: 'max_adverse_r' },
  { key: 'grossProfitLoss', header: 'gross_profit_loss' },
  { key: 'spreadAtEntry', header: 'spread_at_entry' },
  { key: 'slippageEstimate', header: 'slippage_estimate' },
  { key: 'holdingMinutes', header: 'holding_minutes' },
  { key: 'brokerRetcodeOpen', header: 'broker_retcode_open' },
  { key: 'brokerRetcodeClose', header: 'broker_retcode_close' },
  { key: 'brokerRetcodeModify', header: 'broker_retcode_modify' },
  { key: 'session', header: 'session' },
  { key: 'weekday', header: 'weekday' },
  { key: 'ledgerSource', header: 'ledger_source' },
  { key: 'canonicalTradeId', header: 'canonical_trade_id' },
  { key: 'matchedBrokerTradeId', header: 'matched_broker_trade_id' },
  { key: 'matchedPaperTradeId', header: 'matched_paper_trade_id' },
  { key: 'matchMethod', header: 'match_method' },
  { key: 'timeOffsetMinutes', header: 'time_offset_minutes' },
  { key: 'dataQualityFlags', header: 'data_quality_flags' },
  { key: 'brokerOpenedAt', header: 'broker_opened_at_raw' },
  { key: 'paperOpenedAt', header: 'paper_opened_at_raw' },
  { key: 'brokerClosedAt', header: 'broker_closed_at_raw' },
  { key: 'paperClosedAt', header: 'paper_closed_at_raw' },
];

module.exports = {
  LIVE_TRADE_COLUMNS,
  buildCsv,
  buildExportFilename,
  deriveExitReasonDetail,
  prepareTradeExportRow,
  prepareTradeExportRows,
  normalizeDateStart,
  normalizeDateEnd,
};
