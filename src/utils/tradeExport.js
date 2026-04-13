function normalizeDateValue(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeDateStart(value) {
  const date = normalizeDateValue(value);
  if (!date) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

function normalizeDateEnd(value) {
  const date = normalizeDateValue(value);
  if (!date) return null;
  date.setHours(23, 59, 59, 999);
  return date;
}

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

function buildCsv(columns, rows) {
  const header = columns.map((column) => escapeCsv(column.header)).join(',');
  const body = rows.map((row) => (
    columns.map((column) => escapeCsv(serializeCell(row[column.key]))).join(',')
  ));

  return '\uFEFF' + [header, ...body].join('\r\n');
}

function buildExportFilename(filters = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const parts = ['quantmatrix-trades'];
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
];

module.exports = {
  LIVE_TRADE_COLUMNS,
  buildCsv,
  buildExportFilename,
  normalizeDateStart,
  normalizeDateEnd,
};
