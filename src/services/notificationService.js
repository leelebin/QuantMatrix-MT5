/**
 * Notification Service
 * Sends trade alerts via Telegram Bot API
 */

const https = require('https');
const http = require('http');

class NotificationService {
  constructor() {
    this.enabled = false;
    this.telegramToken = null;
    this.telegramChatId = null;
    this.sendQueue = [];
    this.sending = false;
  }

  /**
   * Initialize notification service from environment variables
   */
  init() {
    this.telegramToken = process.env.TELEGRAM_TOKEN;
    this.telegramChatId = process.env.TELEGRAM_CHAT_ID;

    if (this.telegramToken && this.telegramChatId) {
      this.enabled = true;
      console.log('[Notify] Telegram notification service enabled');
    } else {
      console.log('[Notify] Telegram not configured (set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID in .env)');
    }
  }

  /**
   * Send a Telegram message
   * @param {string} text - Message text (supports HTML)
   */
  async sendTelegram(text) {
    if (!this.enabled) return;

    const url = `https://api.telegram.org/bot${this.telegramToken}/sendMessage`;
    const body = JSON.stringify({
      chat_id: this.telegramChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            console.error(`[Notify] Telegram API error: ${res.statusCode} ${data}`);
            reject(new Error(`Telegram API error: ${res.statusCode}`));
          }
        });
      });

      req.on('error', (err) => {
        console.error(`[Notify] Telegram request failed: ${err.message}`);
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Notify trade opened
   */
  async notifyTradeOpened(trade) {
    const emoji = trade.type === 'BUY' ? '\u{1F7E2}' : '\u{1F534}';
    const text = `${emoji} <b>Trade Opened</b>\n\n`
      + `<b>Symbol:</b> ${trade.symbol}\n`
      + `<b>Type:</b> ${trade.type}\n`
      + `<b>Lot Size:</b> ${trade.lotSize}\n`
      + `<b>Entry:</b> ${trade.entryPrice}\n`
      + `<b>SL:</b> ${trade.currentSl || trade.sl}\n`
      + `<b>TP:</b> ${trade.currentTp || trade.tp}\n`
      + `<b>Strategy:</b> ${trade.strategy}\n`
      + `<b>Confidence:</b> ${(trade.confidence * 100).toFixed(0)}%\n`
      + `<b>Reason:</b> ${trade.reason}\n`
      + `<b>Time:</b> ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;

    try {
      await this.sendTelegram(text);
    } catch (err) {
      // Don't block trading on notification failure
    }
  }

  /**
   * Notify trade closed
   */
  async notifyTradeClosed(trade) {
    const profit = trade.profitLoss || 0;
    const emoji = profit >= 0 ? '\u{1F4B0}' : '\u{1F4C9}';
    const text = `${emoji} <b>Trade Closed</b>\n\n`
      + `<b>Symbol:</b> ${trade.symbol}\n`
      + `<b>Type:</b> ${trade.type}\n`
      + `<b>Entry:</b> ${trade.entryPrice}\n`
      + `<b>Exit:</b> ${trade.exitPrice || 'N/A'}\n`
      + `<b>P/L:</b> ${profit >= 0 ? '+' : ''}${profit.toFixed(2)} USD\n`
      + `<b>Pips:</b> ${trade.profitPips ? (trade.profitPips >= 0 ? '+' : '') + trade.profitPips.toFixed(1) : 'N/A'}\n`
      + `<b>Reason:</b> ${trade.exitReason || 'MANUAL'}\n`
      + `<b>Strategy:</b> ${trade.strategy}\n`
      + `<b>Time:</b> ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;

    try {
      await this.sendTelegram(text);
    } catch (err) {
      // Don't block on notification failure
    }
  }

  /**
   * Notify trading signal detected
   */
  async notifySignal(signal) {
    const emoji = signal.signal === 'BUY' ? '\u{2B06}\u{FE0F}' : '\u{2B07}\u{FE0F}';
    const text = `${emoji} <b>Signal Detected</b>\n\n`
      + `<b>Symbol:</b> ${signal.symbol}\n`
      + `<b>Signal:</b> ${signal.signal}\n`
      + `<b>Confidence:</b> ${(signal.confidence * 100).toFixed(0)}%\n`
      + `<b>Strategy:</b> ${signal.strategy}\n`
      + `<b>Reason:</b> ${signal.reason}\n`
      + `<b>SL:</b> ${signal.sl}\n`
      + `<b>TP:</b> ${signal.tp}\n`
      + `<b>Time:</b> ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;

    try {
      await this.sendTelegram(text);
    } catch (err) {
      // Don't block on notification failure
    }
  }

  /**
   * Notify risk limit reached
   */
  async notifyRiskAlert(message) {
    const text = `\u{26A0}\u{FE0F} <b>Risk Alert</b>\n\n${message}\n`
      + `<b>Time:</b> ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;

    try {
      await this.sendTelegram(text);
    } catch (err) {
      // Don't block on notification failure
    }
  }

  /**
   * Notify system event (start/stop/error)
   */
  async notifySystem(event, details = '') {
    const emojis = {
      start: '\u{1F680}',
      stop: '\u{1F6D1}',
      error: '\u{274C}',
      info: '\u{2139}\u{FE0F}',
      connected: '\u{1F517}',
      disconnected: '\u{1F50C}',
    };
    const emoji = emojis[event] || '\u{2139}\u{FE0F}';
    const text = `${emoji} <b>System: ${event.toUpperCase()}</b>\n\n${details}\n`
      + `<b>Time:</b> ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;

    try {
      await this.sendTelegram(text);
    } catch (err) {
      // Don't block on notification failure
    }
  }

  /**
   * Notify optimizer result
   */
  async notifyOptimizerComplete(result) {
    if (!result || !result.bestResult) return;

    const best = result.bestResult;
    const text = `\u{1F3AF} <b>Optimizer Complete</b>\n\n`
      + `<b>Symbol:</b> ${result.symbol}\n`
      + `<b>Strategy:</b> ${result.strategy}\n`
      + `<b>Combinations:</b> ${result.totalCombinations}\n`
      + `<b>Best Parameters:</b>\n`
      + Object.entries(best.parameters).map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n\n'
      + `<b>Results:</b>\n`
      + `  Win Rate: ${(best.summary.winRate * 100).toFixed(1)}%\n`
      + `  Profit Factor: ${best.summary.profitFactor}\n`
      + `  Return: ${best.summary.returnPercent}%\n`
      + `  Sharpe: ${best.summary.sharpeRatio}\n`
      + `  Max DD: ${best.summary.maxDrawdownPercent}%`;

    try {
      await this.sendTelegram(text);
    } catch (err) {
      // Don't block on notification failure
    }
  }

  /**
   * Send test notification
   */
  async sendTest() {
    const text = `\u{2705} <b>QuantMatrix Test</b>\n\n`
      + `Telegram notifications are working!\n`
      + `<b>Time:</b> ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;

    return await this.sendTelegram(text);
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      enabled: this.enabled,
      telegramConfigured: !!(this.telegramToken && this.telegramChatId),
    };
  }
}

// Singleton
const notificationService = new NotificationService();

module.exports = notificationService;
