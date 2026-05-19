/**
 * Daily Report Service
 * Generates scoped trading reports and sends them to Telegram via the
 * notification hub so long reports are safely chunked.
 */

const TradeLog = require('../models/TradeLog');
const notificationHubService = require('./notificationHubService');
const { paperPositionsDb, positionsDb, tradesDb } = require('../config/db');

const DEFAULT_SCOPE = 'paper';

class DailyReportService {
  constructor() {
    this.schedulerInterval = null;
    this.reportHour = 23;
    this.reportMinute = 55;
    this.lastReportDate = null;
  }

  start() {
    const hour = parseInt(process.env.DAILY_REPORT_HOUR || '23', 10);
    const minute = parseInt(process.env.DAILY_REPORT_MINUTE || '55', 10);
    this.reportHour = hour;
    this.reportMinute = minute;

    this.schedulerInterval = setInterval(async () => {
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];

      if (
        now.getHours() === this.reportHour
        && now.getMinutes() === this.reportMinute
        && this.lastReportDate !== todayStr
      ) {
        this.lastReportDate = todayStr;
        try {
          await this.generateAndSendReport(now);
        } catch (err) {
          console.error('[DailyReport] Error generating report:', err.message);
        }
      }
    }, 60 * 1000);

    console.log(`[DailyReport] Scheduler started (report at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')})`);
  }

  stop() {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
    console.log('[DailyReport] Scheduler stopped');
  }

  async generateAndSendReport(date = new Date(), options = {}) {
    const reportDate = new Date(date);
    reportDate.setHours(0, 0, 0, 0);
    const dateStr = formatDateKey(reportDate);
    const scope = normalizeReportScope(options.scope || process.env.DAILY_REPORT_SCOPE || DEFAULT_SCOPE);
    const includeSymbolCustom = parseBoolean(
      options.includeSymbolCustom ?? process.env.DAILY_REPORT_INCLUDE_SYMBOLCUSTOM,
      true
    );

    console.log(`[DailyReport] Generating report for ${dateStr} (${scope})...`);

    const data = await this._loadReportData(reportDate, { scope, includeSymbolCustom });
    const report = this._buildReportMessage(dateStr, data, { scope, includeSymbolCustom });

    try {
      await notificationHubService.enqueueTelegram({
        type: 'daily_report',
        scope,
        priority: 4,
        title: `Daily report ${dateStr}`,
        message: report,
        dedupeKey: `daily_report:${scope}:${dateStr}`,
        immediate: true,
      });
      console.log(`[DailyReport] Report sent for ${dateStr}`);
    } catch (err) {
      console.error(`[DailyReport] Failed to send report: ${err.message}`);
    }

    return report;
  }

  async _loadReportData(reportDate, options = {}) {
    const { start, end } = getDayRange(reportDate);
    const scopes = expandScopes(options.scope);
    const result = {};

    if (scopes.includes('paper')) {
      const closedTrades = await TradeLog.findClosedByDate(reportDate);
      const todayTrades = await TradeLog.findToday();
      const openedToday = todayTrades.filter((trade) => isWithinDay(trade.openedAt, start, end));
      const openPositions = await paperPositionsDb.find({});
      const allTimeStats = await TradeLog.getStats();

      result.paper = normalizeScopeData({
        scope: 'paper',
        closedTrades,
        openedToday,
        openPositions,
        allTimeStats,
        includeSymbolCustom: options.includeSymbolCustom,
      });
    }

    if (scopes.includes('live')) {
      const closedTrades = await tradesDb
        .find({ status: 'CLOSED', closedAt: { $gte: start, $lte: end } })
        .sort({ closedAt: -1 });
      const openedToday = await tradesDb
        .find({ openedAt: { $gte: start, $lte: end } })
        .sort({ openedAt: -1 });
      const openPositions = await positionsDb.find({});
      const allClosed = await tradesDb.find({ status: 'CLOSED' });

      result.live = normalizeScopeData({
        scope: 'live',
        closedTrades,
        openedToday,
        openPositions,
        allTimeStats: buildStats(allClosed),
        includeSymbolCustom: options.includeSymbolCustom,
      });
    }

    return result;
  }

  _buildReportMessage(dateStr, data, options = {}) {
    const lines = [];
    const scopes = expandScopes(options.scope).filter((scope) => data[scope]);

    lines.push(`<b>Trading Daily Report v2</b>`);
    lines.push(`<b>Date:</b> ${escapeHtml(dateStr)}`);
    lines.push(`<b>Scope:</b> ${escapeHtml(options.scope || DEFAULT_SCOPE)}`);
    lines.push('');

    for (const scope of scopes) {
      appendScopeSection(lines, data[scope], { includeSymbolCustom: options.includeSymbolCustom });
    }

    if (scopes.length === 0) {
      lines.push('No report scope selected.');
    }

    return lines.join('\n');
  }

  getStatus() {
    return {
      running: this.schedulerInterval !== null,
      reportTime: `${String(this.reportHour).padStart(2, '0')}:${String(this.reportMinute).padStart(2, '0')}`,
      lastReportDate: this.lastReportDate,
      scope: normalizeReportScope(process.env.DAILY_REPORT_SCOPE || DEFAULT_SCOPE),
      includeSymbolCustom: parseBoolean(process.env.DAILY_REPORT_INCLUDE_SYMBOLCUSTOM, true),
    };
  }
}

function appendScopeSection(lines, data, options = {}) {
  const summary = data.summary;
  lines.push(`<b>--- ${data.scope.toUpperCase()} Summary ---</b>`);
  lines.push(`Closed: ${summary.closedCount} | Opened: ${summary.openedCount} | Open Positions: ${summary.openPositionCount}`);
  lines.push(`Win Rate: ${formatPercent(summary.winRate)} | P/L: ${formatMoney(summary.profitLoss)} | Pips: ${formatSigned(summary.profitPips, 1)}`);
  lines.push('');

  appendSourceBreakdown(lines, data.bySource, options);
  appendBreakdown(lines, 'By Strategy', data.byStrategy);
  appendBreakdown(lines, 'By Symbol', data.bySymbol);
  appendTopTrades(lines, 'Top Winners', data.topWinners);
  appendTopTrades(lines, 'Top Losers', data.topLosers);
  appendOpenPositions(lines, data.openPositions);

  lines.push(`<b>All-Time ${data.scope.toUpperCase()}</b>`);
  lines.push(`Trades: ${data.allTimeStats.totalTrades || 0} | WR: ${formatPercent(data.allTimeStats.winRate || 0)} | P/L: ${formatMoney(data.allTimeStats.totalProfit || 0)}`);
  if (data.allTimeStats.profitFactor !== undefined) {
    lines.push(`Profit Factor: ${data.allTimeStats.profitFactor}`);
  }
  lines.push('');
}

function appendSourceBreakdown(lines, bySource, options = {}) {
  lines.push('<b>By Source</b>');
  appendAggregateLine(lines, 'six_strategy', bySource.six_strategy);

  if (options.includeSymbolCustom !== false && bySource.symbolCustom && bySource.symbolCustom.trades > 0) {
    appendAggregateLine(lines, 'symbolCustom', bySource.symbolCustom);
    if (bySource.symbolCustom.children.length > 0) {
      lines.push('<b>SymbolCustom</b>');
      for (const row of bySource.symbolCustom.children) {
        lines.push(
          `${escapeHtml(row.symbolCustomName)}`
          + `${row.logicName ? ` | ${escapeHtml(row.logicName)}` : ''}`
          + `${row.candidatePreset ? ` | ${escapeHtml(row.candidatePreset)}` : ''}`
          + ` | Trades ${row.trades} | WR ${formatPercent(row.winRate)} | P/L ${formatMoney(row.profit)}`
          + `${row.avgR !== null ? ` | avgR ${formatSigned(row.avgR, 2)}` : ''}`
        );
      }
    }
  }
  lines.push('');
}

function appendBreakdown(lines, title, rows) {
  if (!rows.length) return;
  lines.push(`<b>${escapeHtml(title)}</b>`);
  rows.slice(0, 12).forEach((row) => appendAggregateLine(lines, row.key, row));
  lines.push('');
}

function appendAggregateLine(lines, label, row = null) {
  const data = row || createAggregate();
  lines.push(
    `${escapeHtml(label)}: ${data.trades} trades | WR ${formatPercent(data.winRate)} | P/L ${formatMoney(data.profit)}`
    + `${data.avgR !== null ? ` | avgR ${formatSigned(data.avgR, 2)}` : ''}`
  );
}

function appendTopTrades(lines, title, trades) {
  if (!trades.length) return;
  lines.push(`<b>${escapeHtml(title)}</b>`);
  for (const trade of trades.slice(0, 5)) {
    lines.push(
      `${escapeHtml(trade.symbol || '-')}`
      + ` ${escapeHtml(trade.type || trade.side || '-')}`
      + ` | ${escapeHtml(trade.strategy || trade.symbolCustomName || '-')}`
      + ` | P/L ${formatMoney(trade.profitLoss || 0)}`
      + `${trade.realizedRMultiple !== undefined && trade.realizedRMultiple !== null ? ` | R ${formatSigned(trade.realizedRMultiple, 2)}` : ''}`
      + ` | ${escapeHtml(trade.exitReason || '-')}`
    );
  }
  lines.push('');
}

function appendOpenPositions(lines, positions) {
  if (!positions.length) return;
  lines.push('<b>Open Positions</b>');
  for (const position of positions.slice(0, 20)) {
    const source = getSourceKey(position, true);
    const label = source === 'symbolCustom'
      ? (position.symbolCustomName || position.strategy || 'SymbolCustom')
      : (position.strategy || 'Unknown');
    lines.push(
      `${escapeHtml(position.scope.toUpperCase())} ${escapeHtml(position.symbol || '-')} ${escapeHtml(position.type || '-')}`
      + ` | source ${escapeHtml(source)}`
      + ` | ${escapeHtml(label)}`
      + ` | Unrealized ${formatMoney(firstDefined(position.unrealizedPl, position.unrealizedProfit, position.profitLoss, 0))}`
      + ` | SL ${formatValue(firstDefined(position.currentSl, position.stopLoss, position.sl))}`
      + ` | TP ${formatValue(firstDefined(position.currentTp, position.takeProfit, position.tp))}`
    );
  }
  lines.push('');
}

function normalizeScopeData({ scope, closedTrades, openedToday, openPositions, allTimeStats, includeSymbolCustom }) {
  const normalizedClosed = closedTrades.map((trade) => ({ ...trade, scope }));
  const normalizedOpened = openedToday.map((trade) => ({ ...trade, scope }));
  const normalizedOpenPositions = openPositions.map((position) => ({ ...position, scope }));
  const stats = buildStats(normalizedClosed);

  return {
    scope,
    closedTrades: normalizedClosed,
    openedToday: normalizedOpened,
    openPositions: normalizedOpenPositions,
    summary: {
      closedCount: normalizedClosed.length,
      openedCount: normalizedOpened.length,
      openPositionCount: normalizedOpenPositions.length,
      winRate: stats.winRate,
      profitLoss: stats.totalProfit,
      profitPips: stats.totalPips,
    },
    bySource: buildSourceBreakdown(normalizedClosed, includeSymbolCustom),
    byStrategy: aggregateBy(normalizedClosed, (trade) => trade.strategy || 'Unknown'),
    bySymbol: aggregateBy(normalizedClosed, (trade) => trade.symbol || 'Unknown'),
    topWinners: normalizedClosed
      .filter((trade) => Number(trade.profitLoss) > 0)
      .sort((a, b) => Number(b.profitLoss || 0) - Number(a.profitLoss || 0)),
    topLosers: normalizedClosed
      .filter((trade) => Number(trade.profitLoss) < 0)
      .sort((a, b) => Number(a.profitLoss || 0) - Number(b.profitLoss || 0)),
    allTimeStats: allTimeStats || buildStats([]),
  };
}

function buildSourceBreakdown(trades, includeSymbolCustom) {
  const sixStrategyTrades = trades.filter((trade) => getSourceKey(trade, includeSymbolCustom) === 'six_strategy');
  const symbolCustomTrades = trades.filter((trade) => getSourceKey(trade, includeSymbolCustom) === 'symbolCustom');
  const symbolCustomAggregate = createAggregateFromTrades(symbolCustomTrades);

  symbolCustomAggregate.children = aggregateBy(
    symbolCustomTrades,
    (trade) => [
      trade.symbolCustomName || trade.logicName || trade.strategy || 'SymbolCustom',
      trade.logicName || '',
      compactPreset(trade.candidatePreset) || '',
    ].join('|'),
    (row, trade) => {
      row.symbolCustomName = trade.symbolCustomName || row.symbolCustomName || 'SymbolCustom';
      row.logicName = trade.logicName || row.logicName || '';
      row.candidatePreset = compactPreset(trade.candidatePreset) || row.candidatePreset || '';
    }
  );

  return {
    six_strategy: createAggregateFromTrades(sixStrategyTrades),
    symbolCustom: symbolCustomAggregate,
  };
}

function aggregateBy(trades, getKey, decorate = null) {
  const map = new Map();
  for (const trade of trades) {
    const key = String(getKey(trade) || 'Unknown');
    if (!map.has(key)) {
      map.set(key, { key, ...createAggregate(), rSum: 0, rCount: 0 });
    }
    const row = map.get(key);
    addTradeToAggregate(row, trade);
    if (decorate) decorate(row, trade);
  }

  return Array.from(map.values())
    .map(finalizeAggregate)
    .sort((a, b) => Math.abs(b.profit) - Math.abs(a.profit));
}

function createAggregateFromTrades(trades) {
  const aggregate = createAggregate();
  for (const trade of trades) addTradeToAggregate(aggregate, trade);
  return finalizeAggregate(aggregate);
}

function createAggregate() {
  return {
    trades: 0,
    wins: 0,
    profit: 0,
    pips: 0,
    rSum: 0,
    rCount: 0,
    winRate: 0,
    avgR: null,
  };
}

function addTradeToAggregate(aggregate, trade) {
  aggregate.trades += 1;
  if (Number(trade.profitLoss || 0) > 0) aggregate.wins += 1;
  aggregate.profit += Number(trade.profitLoss || 0);
  aggregate.pips += Number(trade.profitPips || 0);
  const realizedR = Number(trade.realizedRMultiple);
  if (Number.isFinite(realizedR)) {
    aggregate.rSum += realizedR;
    aggregate.rCount += 1;
  }
}

function finalizeAggregate(aggregate) {
  return {
    ...aggregate,
    profit: round(aggregate.profit, 2),
    pips: round(aggregate.pips, 1),
    winRate: aggregate.trades > 0 ? aggregate.wins / aggregate.trades : 0,
    avgR: aggregate.rCount > 0 ? round(aggregate.rSum / aggregate.rCount, 2) : null,
  };
}

function buildStats(trades) {
  const aggregate = createAggregateFromTrades(trades || []);
  const grossProfit = (trades || [])
    .filter((trade) => Number(trade.profitLoss || 0) > 0)
    .reduce((sum, trade) => sum + Number(trade.profitLoss || 0), 0);
  const grossLoss = Math.abs((trades || [])
    .filter((trade) => Number(trade.profitLoss || 0) <= 0)
    .reduce((sum, trade) => sum + Number(trade.profitLoss || 0), 0));

  return {
    totalTrades: aggregate.trades,
    winRate: aggregate.winRate,
    totalProfit: aggregate.profit,
    totalPips: aggregate.pips,
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 2) : grossProfit > 0 ? Infinity : 0,
  };
}

function getSourceKey(record = {}, includeSymbolCustom = true) {
  const source = String(record.source || '').trim();
  if (
    includeSymbolCustom !== false
    && (
      source === 'symbolCustom'
      || record.symbolCustomName
      || record.logicName
      || record.candidatePreset
    )
  ) {
    return 'symbolCustom';
  }
  return 'six_strategy';
}

function normalizeReportScope(value) {
  const normalized = String(value || DEFAULT_SCOPE).trim().toLowerCase();
  return ['paper', 'live', 'all'].includes(normalized) ? normalized : DEFAULT_SCOPE;
}

function expandScopes(scope) {
  const normalized = normalizeReportScope(scope);
  return normalized === 'all' ? ['live', 'paper'] : [normalized];
}

function getDayRange(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function formatDateKey(date) {
  const value = date instanceof Date ? date : new Date(date);
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-');
}

function isWithinDay(value, start, end) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date >= start && date <= end;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function compactPreset(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'object') return value.name || value.id || value.key || JSON.stringify(value).slice(0, 80);
  return String(value);
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0.0%';
  const percent = Math.abs(numeric) <= 1 ? numeric * 100 : numeric;
  return `${percent.toFixed(1)}%`;
}

function formatMoney(value) {
  const numeric = Number(value || 0);
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(2)} USD`;
}

function formatSigned(value, digits = 2) {
  const numeric = Number(value || 0);
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(digits)}`;
}

function formatValue(value) {
  if (value === undefined || value === null || value === '') return '-';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return escapeHtml(value);
  return String(numeric);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function escapeHtml(value) {
  return notificationHubService._internals.escapeHtml(value);
}

const dailyReportService = new DailyReportService();

module.exports = dailyReportService;
module.exports._internals = {
  buildStats,
  formatDateKey,
  getSourceKey,
  normalizeReportScope,
  parseBoolean,
};
