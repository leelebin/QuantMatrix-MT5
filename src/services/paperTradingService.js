/**
 * Paper Trading Service
 * Connects to MT5 demo account, runs strategies with risk management,
 * executes trades on demo, and logs everything to trade_log.
 */

const mt5Service = require('./mt5Service');
const strategyEngine = require('./strategyEngine');
const riskManager = require('./riskManager');
const websocketService = require('./websocketService');
const notificationService = require('./notificationService');
const TradeLog = require('../models/TradeLog');
const ExecutionAudit = require('../models/ExecutionAudit');
const { paperPositionsDb } = require('../config/db');
const { getInstrument } = require('../config/instruments');
const Strategy = require('../models/Strategy');
const { buildClosedTradeSnapshot } = require('../utils/mt5Reconciliation');
const { buildBrokerComment, buildTradeComment } = require('../utils/tradeComment');

class PaperTradingService {
  constructor() {
    this.running = false;
    this.tradingLoopInterval = null;
    this.monitorInterval = null;
    this.analysisIntervalMs = 5 * 60 * 1000;  // 5 minutes
    this.monitorIntervalMs = 30 * 1000;        // 30 seconds
    this.startedAt = null;
  }

  async _recordAudit(stage, status, signal, extra = {}) {
    const audit = await ExecutionAudit.create({
      scope: 'paper',
      stage,
      status,
      symbol: signal?.symbol || extra.symbol || null,
      type: signal?.signal || extra.type || null,
      strategy: signal?.strategy || null,
      volume: extra.volume ?? null,
      code: extra.code ?? null,
      codeName: extra.codeName || null,
      message: extra.message || '',
      accountMode: extra.accountInfo ? mt5Service.getAccountModeName(extra.accountInfo) : null,
      accountLogin: extra.accountInfo?.login || null,
      accountServer: extra.accountInfo?.server || null,
      source: 'paper_trading',
      details: extra.details || null,
      createdAt: extra.createdAt || new Date(),
    });

    websocketService.broadcast('status', 'execution_audit', audit);
    return audit;
  }

  _broadcastRejection(signal, reason, extra = {}) {
    websocketService.broadcast('signals', 'paper_trade_rejected', {
      symbol: signal.symbol,
      type: signal.signal,
      reason,
      stage: extra.stage || null,
      code: extra.code ?? null,
      codeName: extra.codeName || null,
      scope: 'paper',
    });
  }

  /**
   * Start paper trading mode
   * Connects to MT5 demo account and begins the analysis/execution loop
   */
  async start() {
    if (this.running) {
      return { success: false, message: 'Paper trading is already running' };
    }

    try {
      // Connect to MT5 (demo account configured in .env)
      if (!mt5Service.isConnected()) {
        await mt5Service.connect();
      }

      // Verify it's a demo account
      const accountInfo = await mt5Service.getAccountInfo();
      mt5Service.ensurePaperTradingAccount(accountInfo);
      console.log(`[PaperTrading] Connected to account: ${accountInfo.login} | Server: ${accountInfo.server}`);
      console.log(`[PaperTrading] Balance: ${accountInfo.balance} ${accountInfo.currency} | Leverage: 1:${accountInfo.leverage}`);

      // Initialize strategy configs in DB
      await Strategy.initDefaults(strategyEngine.getStrategiesInfo());

      // Enable trading flag for risk manager
      process.env.PAPER_TRADING_ENABLED = 'true';

      // Start position monitor (sync MT5 demo positions with local DB)
      this._startPositionMonitor();

      // Start the analysis & trading loop
      this._startTradingLoop();

      this.running = true;
      this.startedAt = new Date();

      // Notify via Telegram
      await notificationService.notifySystem('start',
        `Paper Trading started\n`
        + `Account: ${accountInfo.login}\n`
        + `Balance: ${accountInfo.balance} ${accountInfo.currency}\n`
        + `Leverage: 1:${accountInfo.leverage}`
      );

      // Broadcast via WebSocket
      websocketService.broadcast('status', 'paper_trading_started', {
        account: accountInfo.login,
        balance: accountInfo.balance,
        currency: accountInfo.currency,
      });

      return {
        success: true,
        message: 'Paper trading started',
        data: {
          account: {
            login: accountInfo.login,
            balance: accountInfo.balance,
            equity: accountInfo.equity,
            currency: accountInfo.currency,
            leverage: accountInfo.leverage,
            mode: mt5Service.getAccountModeName(accountInfo),
          },
        },
      };
    } catch (err) {
      console.error('[PaperTrading] Start error:', err.message);
      this.running = false;
      return { success: false, message: err.message };
    }
  }

  /**
   * Stop paper trading mode
   */
  async stop() {
    if (!this.running) {
      return { success: false, message: 'Paper trading is not running' };
    }

    process.env.PAPER_TRADING_ENABLED = 'false';

    if (this.tradingLoopInterval) {
      clearInterval(this.tradingLoopInterval);
      this.tradingLoopInterval = null;
    }

    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }

    this.running = false;
    const runtime = this.startedAt ? TradeLog.formatHoldingTime(Date.now() - this.startedAt.getTime()) : 'N/A';
    this.startedAt = null;

    await notificationService.notifySystem('stop', `Paper Trading stopped\nRuntime: ${runtime}`);

    websocketService.broadcast('status', 'paper_trading_stopped', { runtime });

    console.log(`[PaperTrading] Stopped (runtime: ${runtime})`);
    return { success: true, message: 'Paper trading stopped', runtime };
  }

  /**
   * Start the strategy analysis and trade execution loop
   */
  _startTradingLoop() {
    // Run immediately once, then on interval
    this._runAnalysisCycle();

    this.tradingLoopInterval = setInterval(async () => {
      try {
        await this._runAnalysisCycle();
      } catch (err) {
        console.error('[PaperTrading] Trading loop error:', err.message);
      }
    }, this.analysisIntervalMs);

    console.log(`[PaperTrading] Trading loop started (interval: ${this.analysisIntervalMs / 1000}s)`);
  }

  /**
   * Run one full analysis cycle across all enabled symbols
   */
  async _runAnalysisCycle() {
    if (!mt5Service.isConnected()) return;

    // Get enabled strategies/symbols
    const strategies = await Strategy.findAll();
    const enabledSymbols = [];
    for (const s of strategies) {
      if (s.enabled && s.symbols) {
        enabledSymbols.push(...s.symbols);
      }
    }

    if (enabledSymbols.length === 0) {
      console.log('[PaperTrading] No enabled symbols to analyze');
      return;
    }

    // Run strategy engine analysis
    await strategyEngine.analyzeAll(
      // Candle data fetcher
      async (symbol, timeframe, count) => {
        const startTime = new Date(Date.now() - count * 60 * 60 * 1000);
        return await mt5Service.getCandles(symbol, timeframe, startTime, count);
      },
      // Signal handler — execute paper trade
      async (signal) => {
        await this._executePaperTrade(signal);
      },
      enabledSymbols
    );
  }

  /**
   * Execute a paper trade on MT5 demo account with full logging
   * @param {object} signal - Strategy signal
   */
  async _executePaperTrade(signal) {
    if (signal.signal === 'NONE') return;

    try {
      const accountInfo = await mt5Service.getAccountInfo();
      mt5Service.ensurePaperTradingAccount(accountInfo);
      const priceData = await mt5Service.getPrice(signal.symbol);
      const quotedEntryPrice = signal.signal === 'BUY' ? priceData.ask : priceData.bid;
      signal.entryPrice = quotedEntryPrice;

      // Validate through risk manager (uses paper positions DB)
      const riskCheck = await this._validatePaperTrade(signal, accountInfo);
      if (!riskCheck.allowed) {
        await this._recordAudit('risk', 'BLOCKED', signal, {
          message: riskCheck.reason,
          code: 'RISK_RULE',
          codeName: 'RISK_RULE',
          volume: riskCheck.lotSize || null,
          accountInfo,
          details: { riskCheck },
        });
        console.log(`[PaperTrading] Trade rejected: ${signal.symbol} - ${riskCheck.reason}`);
        this._broadcastRejection(signal, riskCheck.reason, {
          stage: 'risk',
          code: 'RISK_RULE',
          codeName: 'RISK_RULE',
        });
        return;
      }

      if (riskCheck.overrideApplied && riskCheck.auditMessage) {
        await this._recordAudit('risk', 'INFO', signal, {
          message: riskCheck.auditMessage,
          code: 'AGGRESSIVE_MIN_LOT',
          codeName: 'AGGRESSIVE_MIN_LOT',
          volume: riskCheck.lotSize,
          accountInfo,
          details: { riskCheck },
        });
      }

      // Execute on MT5 demo account
      const brokerComment = buildBrokerComment(signal, 'PT');
      const tradeComment = buildTradeComment(signal, brokerComment);
      const preflight = await mt5Service.preflightOrder(
        signal.symbol,
        signal.signal,
        riskCheck.lotSize,
        signal.sl,
        signal.tp,
        brokerComment
      );
      if (!mt5Service.isOrderAllowed(preflight)) {
        const preflightMessage = mt5Service.getPreflightMessage(preflight);
        await this._recordAudit('preflight', 'BLOCKED', signal, {
          message: preflightMessage,
          code: preflight.retcode,
          codeName: preflight.retcodeName,
          volume: riskCheck.lotSize,
          accountInfo,
          details: preflight,
        });
        this._broadcastRejection(signal, preflightMessage, {
          stage: 'preflight',
          code: preflight.retcode,
          codeName: preflight.retcodeName,
        });
        return;
      }
      const result = await mt5Service.placeOrder(
        signal.symbol,
        signal.signal,
        riskCheck.lotSize,
        signal.sl,
        signal.tp,
        brokerComment
      );

      const atrAtEntry = signal.indicatorsSnapshot?.atr || 0;
      const entryPrice = result.entryDeal?.price || result.price || quotedEntryPrice;
      const openedAt = result.entryDeal?.time ? new Date(result.entryDeal.time) : new Date();
      const mt5PositionId = result.positionId || result.orderId || null;
      const mt5DealId = result.entryDeal?.id || result.dealId || null;
      const mt5Comment = result.entryDeal?.comment || brokerComment;
      const entryCommission = Number(result.entryDeal?.commission) || 0;
      const entrySwap = Number(result.entryDeal?.swap) || 0;
      const entryFee = Number(result.entryDeal?.fee) || 0;

      // Save to paper positions DB
      const position = await paperPositionsDb.insert({
        symbol: signal.symbol,
        type: signal.signal,
        entryPrice,
        currentSl: signal.sl,
        currentTp: signal.tp,
        lotSize: riskCheck.lotSize,
        mt5PositionId,
        mt5EntryDealId: mt5DealId,
        mt5Comment,
        strategy: signal.strategy,
        comment: tradeComment,
        confidence: signal.confidence,
        reason: signal.reason,
        atrAtEntry,
        indicatorsSnapshot: signal.indicatorsSnapshot,
        openedAt,
        status: 'OPEN',
      });

      // Log to trade_log with all required fields
      await TradeLog.logOpen({
        symbol: signal.symbol,
        type: signal.signal,
        lotSize: riskCheck.lotSize,
        entryPrice,
        stopLoss: signal.sl,
        takeProfit: signal.tp,
        signalReason: signal.reason,
        strategy: signal.strategy,
        confidence: signal.confidence,
        indicatorsSnapshot: signal.indicatorsSnapshot,
        commission: entryCommission,
        swap: entrySwap,
        fee: entryFee,
        mt5PositionId,
        mt5DealId,
        mt5Comment,
        comment: tradeComment,
        positionDbId: position._id,
        openedAt,
      });

      console.log(
        `[PaperTrading] Trade executed: ${signal.signal} ${riskCheck.lotSize} ${signal.symbol} `
        + `@ ${entryPrice} | SL: ${signal.sl} TP: ${signal.tp} | ${signal.reason}`
      );

      // Broadcast + notify
      websocketService.broadcast('trades', 'paper_trade_opened', position);
      await notificationService.notifyTradeOpened(position);

    } catch (err) {
      console.error(`[PaperTrading] Execute error for ${signal.symbol}:`, err.message);
      try {
        const accountInfo = mt5Service.isConnected() ? await mt5Service.getAccountInfo() : null;
        const auditCode = err.code ?? err.details?.retcode ?? null;
        const auditCodeName = err.codeName ?? err.details?.retcodeName ?? null;
        const auditStage = err.method === 'placeOrder'
          ? 'order_send'
          : err.method === 'preflightOrder'
            ? 'preflight'
            : 'execution';

        await this._recordAudit(auditStage, 'ERROR', signal, {
          message: err.message,
          code: auditCode,
          codeName: auditCodeName,
          accountInfo,
          details: err.details || { method: err.method || null },
        });
        this._broadcastRejection(signal, err.message, {
          stage: auditStage,
          code: auditCode,
          codeName: auditCodeName,
        });
      } catch (auditError) {
        console.error('[PaperTrading] Failed to record execution audit:', auditError.message);
      }
    }
  }

  /**
   * Risk validation for paper trades (uses paperPositionsDb instead of positionsDb)
   */
  async _validatePaperTrade(signal, accountInfo) {
    return await riskManager.validateTrade(signal, accountInfo, {
      scope: 'paper',
      positionsStore: paperPositionsDb,
      tradingEnabled: process.env.PAPER_TRADING_ENABLED === 'true',
    });
  }

  /**
   * Start position monitor for paper trading
   * Syncs MT5 demo positions, detects closures, logs to trade_log
   */
  _startPositionMonitor() {
    this.monitorInterval = setInterval(async () => {
      try {
        await this._syncPaperPositions();
      } catch (err) {
        console.error('[PaperTrading] Monitor error:', err.message);
      }
    }, this.monitorIntervalMs);

    console.log(`[PaperTrading] Position monitor started (interval: ${this.monitorIntervalMs / 1000}s)`);
  }

  /**
   * Sync MT5 demo positions with paper positions DB
   * Detect externally closed positions (SL/TP hit) and log them
   */
  async _syncPaperPositions() {
    if (!mt5Service.isConnected()) return;

    const mt5Positions = await mt5Service.getPositions();
    const localPositions = await paperPositionsDb.find({});
    const mt5PositionIds = new Set(mt5Positions.map((p) => String(p.id)));

    // Detect positions closed externally (SL/TP hit or manual close on MT5)
    for (const localPos of localPositions) {
      if (localPos.mt5PositionId && !mt5PositionIds.has(String(localPos.mt5PositionId))) {
        await this._handlePaperClose(localPos);
      }
    }

    // Update local positions with current MT5 data
    for (const mt5Pos of mt5Positions) {
      const localPos = localPositions.find(
        (lp) => String(lp.mt5PositionId) === String(mt5Pos.id)
      );
      if (localPos) {
        await paperPositionsDb.update({ _id: localPos._id }, {
          $set: {
            currentSl: mt5Pos.stopLoss || localPos.currentSl,
            currentTp: mt5Pos.takeProfit || localPos.currentTp,
            currentPrice: mt5Pos.currentPrice,
            unrealizedPl: mt5Pos.unrealizedProfit || mt5Pos.profit || 0,
          },
        });
      }
    }

    // Broadcast update
    const updatedPositions = await paperPositionsDb.find({});
    websocketService.broadcast('positions', 'paper_positions_sync', updatedPositions);
  }

  /**
   * Handle a paper position that was closed externally
   */
  async _handlePaperClose(localPos) {
    let dealSummary = null;
    if (localPos.mt5PositionId) {
      const reconciliationStart = localPos.openedAt
        ? new Date(new Date(localPos.openedAt).getTime() - (60 * 60 * 1000))
        : new Date(Date.now() - (7 * 24 * 60 * 60 * 1000));

      try {
        dealSummary = await mt5Service.getPositionDealSummary(
          localPos.mt5PositionId,
          reconciliationStart,
          new Date()
        );
      } catch (reconciliationError) {
        console.warn(`[PaperTrading] Deal reconciliation failed for ${localPos.symbol}: ${reconciliationError.message}`);
      }
    }

    let fallbackExitPrice = null;
    if (!dealSummary?.exitPrice) {
      try {
        const priceData = await mt5Service.getPrice(localPos.symbol);
        fallbackExitPrice = localPos.type === 'BUY' ? priceData.bid : priceData.ask;
      } catch (priceError) {
        fallbackExitPrice = localPos.currentPrice || localPos.entryPrice;
      }
    }

    const closedSnapshot = buildClosedTradeSnapshot(localPos, dealSummary, {
      exitPrice: fallbackExitPrice,
      reason: 'EXTERNAL',
    });

    const openedAt = new Date(localPos.openedAt);

    // Log closure to trade_log
    await TradeLog.logClose(localPos._id, {
      exitPrice: closedSnapshot.exitPrice,
      exitReason: closedSnapshot.exitReason,
      profitLoss: closedSnapshot.profitLoss,
      profitPips: closedSnapshot.profitPips,
      commission: closedSnapshot.commission,
      swap: closedSnapshot.swap,
      fee: closedSnapshot.fee,
      openedAt,
      closedAt: closedSnapshot.closedAt,
    });

    // Track loss for daily limit
    if (closedSnapshot.profitLoss < 0) {
      await riskManager.recordLoss(Math.abs(closedSnapshot.profitLoss), closedSnapshot.closedAt, 'paper');
    }

    // Remove from paper positions
    await paperPositionsDb.remove({ _id: localPos._id });

    const closedTrade = {
      ...localPos,
      ...closedSnapshot,
      holdingTime: TradeLog.formatHoldingTime(closedSnapshot.closedAt - openedAt),
    };

    console.log(
      `[PaperTrading] Position closed: ${localPos.symbol} ${localPos.type} `
      + `| P/L: ${closedSnapshot.profitLoss.toFixed(2)} (${closedSnapshot.profitPips.toFixed(1)} pips) `
      + `| Reason: ${closedSnapshot.exitReason} | Held: ${closedTrade.holdingTime}`
    );

    websocketService.broadcast('trades', 'paper_trade_closed', closedTrade);
    await notificationService.notifyTradeClosed(closedTrade);
  }

  /**
   * Manually close a paper position
   */
  async closePosition(positionDbId, reason = 'MANUAL') {
    const position = await paperPositionsDb.findOne({ _id: positionDbId });
    if (!position) {
      return { success: false, message: 'Paper position not found' };
    }

    if (mt5Service.isConnected()) {
      const accountInfo = await mt5Service.getAccountInfo();
      mt5Service.ensurePaperTradingAccount(accountInfo);
    }

    // Close on MT5 demo
    let closeResult = null;
    if (position.mt5PositionId) {
      try {
        closeResult = await mt5Service.closePosition(position.mt5PositionId);
      } catch (err) {
        console.error(`[PaperTrading] MT5 close error: ${err.message}`);
      }
    }

    let dealSummary = null;
    if (position.mt5PositionId) {
      const reconciliationStart = position.openedAt
        ? new Date(new Date(position.openedAt).getTime() - (60 * 60 * 1000))
        : new Date(Date.now() - (7 * 24 * 60 * 60 * 1000));

      try {
        dealSummary = await mt5Service.getPositionDealSummary(
          position.mt5PositionId,
          reconciliationStart,
          new Date()
        );
      } catch (reconciliationError) {
        console.warn(`[PaperTrading] Deal reconciliation failed for ${position.symbol}: ${reconciliationError.message}`);
      }
    }

    let fallbackExitPrice = closeResult?.closeDeal?.price || closeResult?.price || null;
    if (!dealSummary?.exitPrice && !fallbackExitPrice) {
      const priceData = await mt5Service.getPrice(position.symbol);
      fallbackExitPrice = position.type === 'BUY' ? priceData.bid : priceData.ask;
    }

    const closedSnapshot = buildClosedTradeSnapshot(position, dealSummary, {
      exitPrice: fallbackExitPrice,
      reason,
    });

    const openedAt = new Date(position.openedAt);

    // Log to trade_log
    await TradeLog.logClose(position._id, {
      exitPrice: closedSnapshot.exitPrice,
      exitReason: closedSnapshot.exitReason,
      profitLoss: closedSnapshot.profitLoss,
      profitPips: closedSnapshot.profitPips,
      commission: closedSnapshot.commission,
      swap: closedSnapshot.swap,
      fee: closedSnapshot.fee,
      openedAt,
      closedAt: closedSnapshot.closedAt,
    });

    if (closedSnapshot.profitLoss < 0) {
      await riskManager.recordLoss(Math.abs(closedSnapshot.profitLoss), closedSnapshot.closedAt, 'paper');
    }

    await paperPositionsDb.remove({ _id: positionDbId });

    const closedTrade = {
      ...position,
      ...closedSnapshot,
      holdingTime: TradeLog.formatHoldingTime(closedSnapshot.closedAt - openedAt),
    };

    websocketService.broadcast('trades', 'paper_trade_closed', closedTrade);
    await notificationService.notifyTradeClosed(closedTrade);

    return {
      success: true,
      profitLoss: closedSnapshot.profitLoss,
      profitPips: closedSnapshot.profitPips,
      holdingTime: closedTrade.holdingTime,
    };
  }

  /**
   * Get current paper trading status
   */
  async getStatus() {
    const openPositions = await paperPositionsDb.find({});
    const todayTrades = await TradeLog.findToday();
    const allTimeStats = await TradeLog.getStats();

    return {
      running: this.running,
      startedAt: this.startedAt,
      runtime: this.startedAt ? TradeLog.formatHoldingTime(Date.now() - this.startedAt.getTime()) : null,
      openPositions: openPositions.length,
      positions: openPositions,
      todayTrades: todayTrades.length,
      allTimeStats,
    };
  }

  /**
   * Get open paper positions
   */
  async getPositions() {
    return await paperPositionsDb.find({});
  }
}

// Singleton
const paperTradingService = new PaperTradingService();

module.exports = paperTradingService;
