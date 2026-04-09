/**
 * Daily Report Service
 * Generates daily paper trading reports and sends them to Telegram.
 * Runs on a configurable schedule (default: every day at 23:55 server time).
 */

const TradeLog = require('../models/TradeLog');
const notificationService = require('./notificationService');
const { paperPositionsDb } = require('../config/db');

class DailyReportService {
  constructor() {
    this.schedulerInterval = null;
    this.reportHour = 23;
    this.reportMinute = 55;
    this.lastReportDate = null;  // Prevent duplicate reports
  }

  /**
   * Start the daily report scheduler
   * Checks every minute if it's time to send the report
   */
  start() {
    const hour = parseInt(process.env.DAILY_REPORT_HOUR || '23', 10);
    const minute = parseInt(process.env.DAILY_REPORT_MINUTE || '55', 10);
    this.reportHour = hour;
    this.reportMinute = minute;

    // Check every 60 seconds if it's time to send
    this.schedulerInterval = setInterval(async () => {
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];

      if (
        now.getHours() === this.reportHour &&
        now.getMinutes() === this.reportMinute &&
        this.lastReportDate !== todayStr
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

  /**
   * Stop the scheduler
   */
  stop() {
    if (this.schedulerInterval) {
      clearInterval(this.schedulerInterval);
      this.schedulerInterval = null;
    }
    console.log('[DailyReport] Scheduler stopped');
  }

  /**
   * Generate daily report for a given date and send to Telegram
   * @param {Date} date - The date to generate report for (default: today)
   */
  async generateAndSendReport(date = new Date()) {
    const reportDate = new Date(date);
    reportDate.setHours(0, 0, 0, 0);
    const dateStr = reportDate.toISOString().split('T')[0];

    console.log(`[DailyReport] Generating report for ${dateStr}...`);

    // Get today's closed trades
    const closedTrades = await TradeLog.findClosedByDate(reportDate);

    // Get trades that were opened today (even if not yet closed)
    const todayTrades = await TradeLog.findToday();
    const openedToday = todayTrades.filter((t) => {
      const openDate = new Date(t.openedAt).toISOString().split('T')[0];
      return openDate === dateStr;
    });

    // Get currently open positions
    const openPositions = await paperPositionsDb.find({});

    // Get all-time stats
    const allTimeStats = await TradeLog.getStats();

    // Build the report message
    const report = this._buildReportMessage(dateStr, closedTrades, openedToday, openPositions, allTimeStats);

    // Send to Telegram
    try {
      await notificationService.sendTelegram(report);
      console.log(`[DailyReport] Report sent for ${dateStr}`);
    } catch (err) {
      console.error(`[DailyReport] Failed to send report: ${err.message}`);
    }

    return report;
  }

  /**
   * Build the Telegram report message (HTML format)
   */
  _buildReportMessage(dateStr, closedTrades, openedToday, openPositions, allTimeStats) {
    const lines = [];

    // Header
    lines.push(`\u{1F4CA} <b>Paper Trading Daily Report</b>`);
    lines.push(`\u{1F4C5} ${dateStr}\n`);

    // Summary
    const totalPL = closedTrades.reduce((s, t) => s + (t.profitLoss || 0), 0);
    const totalPips = closedTrades.reduce((s, t) => s + (t.profitPips || 0), 0);
    const winners = closedTrades.filter((t) => t.profitLoss > 0).length;
    const winRate = closedTrades.length > 0
      ? ((winners / closedTrades.length) * 100).toFixed(1)
      : '0.0';

    lines.push(`<b>--- Today's Summary ---</b>`);
    lines.push(`Trades Closed: ${closedTrades.length}`);
    lines.push(`Trades Opened: ${openedToday.length}`);
    lines.push(`Win Rate: ${winRate}%`);
    lines.push(`P/L: ${totalPL >= 0 ? '+' : ''}${totalPL.toFixed(2)} USD`);
    lines.push(`Pips: ${totalPips >= 0 ? '+' : ''}${totalPips.toFixed(1)}`);
    lines.push(`Open Positions: ${openPositions.length}\n`);

    // Trade details
    if (closedTrades.length > 0) {
      lines.push(`<b>--- Closed Trades ---</b>`);
      for (const t of closedTrades) {
        const plSign = (t.profitLoss || 0) >= 0 ? '+' : '';
        const emoji = (t.profitLoss || 0) >= 0 ? '\u{2705}' : '\u{274C}';
        lines.push(
          `${emoji} <b>${t.symbol}</b> ${t.type}`
          + ` | Entry: ${t.entryPrice} \u2192 Exit: ${t.exitPrice}`
          + ` | SL: ${t.stopLoss}`
          + ` | P/L: ${plSign}${(t.profitLoss || 0).toFixed(2)}`
          + ` (${plSign}${(t.profitPips || 0).toFixed(1)} pips)`
          + ` | ${t.holdingTime || 'N/A'}`
          + ` | ${t.exitReason}`
          + ` | ${t.signalReason || t.strategy}`
        );
      }
      lines.push('');
    }

    // Open positions
    if (openPositions.length > 0) {
      lines.push(`<b>--- Open Positions ---</b>`);
      for (const p of openPositions) {
        const unrealized = p.unrealizedPl ? `${p.unrealizedPl >= 0 ? '+' : ''}${p.unrealizedPl.toFixed(2)}` : 'N/A';
        lines.push(
          `\u{1F7E1} <b>${p.symbol}</b> ${p.type}`
          + ` | Entry: ${p.entryPrice}`
          + ` | SL: ${p.currentSl} TP: ${p.currentTp}`
          + ` | Unrealized: ${unrealized}`
          + ` | ${p.strategy}`
        );
      }
      lines.push('');
    }

    // Strategy breakdown (today)
    if (closedTrades.length > 0) {
      const byStrategy = {};
      for (const t of closedTrades) {
        const key = t.strategy || 'Unknown';
        if (!byStrategy[key]) byStrategy[key] = { trades: 0, wins: 0, profit: 0 };
        byStrategy[key].trades++;
        if (t.profitLoss > 0) byStrategy[key].wins++;
        byStrategy[key].profit += t.profitLoss || 0;
      }

      lines.push(`<b>--- By Strategy (Today) ---</b>`);
      for (const [name, data] of Object.entries(byStrategy)) {
        const wr = ((data.wins / data.trades) * 100).toFixed(0);
        lines.push(`${name}: ${data.trades} trades | WR: ${wr}% | P/L: ${data.profit >= 0 ? '+' : ''}${data.profit.toFixed(2)}`);
      }
      lines.push('');
    }

    // All-time stats
    lines.push(`<b>--- All-Time Stats ---</b>`);
    lines.push(`Total Trades: ${allTimeStats.totalTrades}`);
    lines.push(`Win Rate: ${(allTimeStats.winRate * 100).toFixed(1)}%`);
    lines.push(`Total P/L: ${allTimeStats.totalProfit >= 0 ? '+' : ''}${allTimeStats.totalProfit.toFixed(2)} USD`);
    lines.push(`Profit Factor: ${allTimeStats.profitFactor}`);
    lines.push(`Max Drawdown: ${allTimeStats.maxDrawdown.toFixed(2)} USD`);
    lines.push(`Avg Holding: ${allTimeStats.averageHoldingTime}`);

    return lines.join('\n');
  }

  /**
   * Get scheduler status
   */
  getStatus() {
    return {
      running: this.schedulerInterval !== null,
      reportTime: `${String(this.reportHour).padStart(2, '0')}:${String(this.reportMinute).padStart(2, '0')}`,
      lastReportDate: this.lastReportDate,
    };
  }
}

// Singleton
const dailyReportService = new DailyReportService();

module.exports = dailyReportService;
