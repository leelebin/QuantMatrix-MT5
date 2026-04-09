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
const { paperPositionsDb } = require('../config/db');
const { getInstrument, getAllSymbols } = require('../config/instruments');
const Strategy = require('../models/Strategy');

class PaperTradingService {
  constructor() {
    this.running = false;
    this.tradingLoopInterval = null;
    this.monitorInterval = null;
    this.analysisIntervalMs = 5 * 60 * 1000;  // 5 minutes
    this.monitorIntervalMs = 30 * 1000;        // 30 seconds
    this.startedAt = null;
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
      const priceData = await mt5Service.getPrice(signal.symbol);
      const entryPrice = signal.signal === 'BUY' ? priceData.ask : priceData.bid;
      signal.entryPrice = entryPrice;

      // Validate through risk manager (uses paper positions DB)
      const riskCheck = await this._validatePaperTrade(signal, accountInfo);
      if (!riskCheck.allowed) {
        console.log(`[PaperTrading] Trade rejected: ${signal.symbol} — ${riskCheck.reason}`);
        websocketService.broadcast('signals', 'paper_trade_rejected', {
          symbol: signal.symbol,
          type: signal.signal,
          reason: riskCheck.reason,
        });
        return;
      }

      // Execute on MT5 demo account
      const comment = `PT|${signal.strategy}|${signal.confidence.toFixed(2)}`;
      const result = await mt5Service.placeOrder(
        signal.symbol,
        signal.signal,
        riskCheck.lotSize,
        signal.sl,
        signal.tp,
        comment
      );

      const instrument = getInstrument(signal.symbol);
      const atrAtEntry = signal.indicatorsSnapshot?.atr || 0;
      const openedAt = new Date();

      // Save to paper positions DB
      const position = await paperPositionsDb.insert({
        symbol: signal.symbol,
        type: signal.signal,
        entryPrice,
        currentSl: signal.sl,
        currentTp: signal.tp,
        lotSize: riskCheck.lotSize,
        mt5PositionId: result.positionId || result.orderId || null,
        strategy: signal.strategy,
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
        mt5PositionId: result.positionId || result.orderId || null,
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
    }
  }

  /**
   * Risk validation for paper trades (uses paperPositionsDb instead of positionsDb)
   */
  async _validatePaperTrade(signal, accountInfo) {
    const instrument = getInstrument(signal.symbol);
    if (!instrument) {
      return { allowed: false, reason: `Unknown instrument: ${signal.symbol}`, lotSize: 0 };
    }

    const { balance, equity } = accountInfo;

    // Track peak balance
    if (balance > riskManager.peakBalance) {
      riskManager.peakBalance = balance;
    }

    // Check paper trading enabled
    if (process.env.PAPER_TRADING_ENABLED !== 'true') {
      return { allowed: false, reason: 'Paper trading is disabled', lotSize: 0 };
    }

    // Daily loss limit
    const maxDailyLoss = parseFloat(process.env.MAX_DAILY_LOSS || 0.05);
    const todayLoss = riskManager._getTodayLoss();
    if (todayLoss >= balance * maxDailyLoss) {
      return { allowed: false, reason: `Daily loss limit reached: ${todayLoss.toFixed(2)}`, lotSize: 0 };
    }

    // Max drawdown
    const maxDrawdown = parseFloat(process.env.MAX_DRAWDOWN || 0.10);
    const currentDrawdown = riskManager.peakBalance > 0 ? (riskManager.peakBalance - equity) / riskManager.peakBalance : 0;
    if (currentDrawdown >= maxDrawdown) {
      return { allowed: false, reason: `Max drawdown reached: ${(currentDrawdown * 100).toFixed(1)}%`, lotSize: 0 };
    }

    // Concurrent position limit
    const maxPositions = parseInt(process.env.MAX_CONCURRENT_POSITIONS || 5);
    const openPositions = await paperPositionsDb.count({});
    if (openPositions >= maxPositions) {
      return { allowed: false, reason: `Max positions reached: ${openPositions}/${maxPositions}`, lotSize: 0 };
    }

    // Per-symbol limit
    const maxPerSymbol = parseInt(process.env.MAX_POSITIONS_PER_SYMBOL || 2);
    const symbolPositions = await paperPositionsDb.count({ symbol: signal.symbol });
    if (symbolPositions >= maxPerSymbol) {
      return { allowed: false, reason: `Max positions for ${signal.symbol}: ${symbolPositions}/${maxPerSymbol}`, lotSize: 0 };
    }

    // Category correlation limit
    const allPaperPositions = await paperPositionsDb.find({});
    const categoryCount = allPaperPositions.filter((p) => {
      const inst = getInstrument(p.symbol);
      return inst && inst.category === instrument.category;
    }).length;
    if (categoryCount >= 3) {
      return { allowed: false, reason: `Max correlated positions for ${instrument.category}: ${categoryCount}/3`, lotSize: 0 };
    }

    // Calculate position size
    const lotSize = riskManager.calculateLotSize(signal, instrument, balance);
    if (lotSize < instrument.minLot) {
      return { allowed: false, reason: `Lot size ${lotSize} below minimum ${instrument.minLot}`, lotSize: 0 };
    }

    // SL distance validation
    const entryPrice = signal.entryPrice || 0;
    if (entryPrice > 0 && signal.sl > 0) {
      const slDistance = Math.abs(entryPrice - signal.sl);
      const minSlDistance = instrument.spread * instrument.pipSize * 3;
      if (slDistance < minSlDistance) {
        return { allowed: false, reason: `SL too close: ${slDistance.toFixed(5)} < ${minSlDistance.toFixed(5)}`, lotSize: 0 };
      }
    }

    return { allowed: true, reason: 'All risk checks passed', lotSize };
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
    const instrument = getInstrument(localPos.symbol);
    let exitPrice = 0;
    let exitReason = 'EXTERNAL';

    try {
      const priceData = await mt5Service.getPrice(localPos.symbol);
      exitPrice = localPos.type === 'BUY' ? priceData.bid : priceData.ask;
    } catch (e) {
      exitPrice = localPos.currentPrice || localPos.entryPrice;
    }

    // Determine SL or TP hit
    if (localPos.currentSl && localPos.currentTp) {
      if (localPos.type === 'BUY') {
        if (exitPrice <= localPos.currentSl * 1.001) exitReason = 'SL_HIT';
        else if (exitPrice >= localPos.currentTp * 0.999) exitReason = 'TP_HIT';
      } else {
        if (exitPrice >= localPos.currentSl * 0.999) exitReason = 'SL_HIT';
        else if (exitPrice <= localPos.currentTp * 1.001) exitReason = 'TP_HIT';
      }
    }

    // Calculate P/L
    const priceDiff = localPos.type === 'BUY'
      ? exitPrice - localPos.entryPrice
      : localPos.entryPrice - exitPrice;
    const profitPips = instrument ? priceDiff / instrument.pipSize : 0;
    const profitLoss = instrument
      ? priceDiff * localPos.lotSize * instrument.contractSize
      : 0;

    const closedAt = new Date();
    const openedAt = new Date(localPos.openedAt);

    // Log closure to trade_log
    await TradeLog.logClose(localPos._id, {
      exitPrice,
      exitReason,
      profitLoss,
      profitPips,
      openedAt,
      closedAt,
    });

    // Track loss for daily limit
    if (profitLoss < 0) {
      riskManager.recordLoss(Math.abs(profitLoss));
    }

    // Remove from paper positions
    await paperPositionsDb.remove({ _id: localPos._id });

    const closedTrade = {
      ...localPos,
      exitPrice,
      exitReason,
      profitLoss,
      profitPips,
      closedAt,
      holdingTime: TradeLog.formatHoldingTime(closedAt - openedAt),
    };

    console.log(
      `[PaperTrading] Position closed: ${localPos.symbol} ${localPos.type} `
      + `| P/L: ${profitLoss.toFixed(2)} (${profitPips.toFixed(1)} pips) `
      + `| Reason: ${exitReason} | Held: ${closedTrade.holdingTime}`
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

    // Close on MT5 demo
    if (position.mt5PositionId) {
      try {
        await mt5Service.closePosition(position.mt5PositionId);
      } catch (err) {
        console.error(`[PaperTrading] MT5 close error: ${err.message}`);
      }
    }

    // Get exit price
    const priceData = await mt5Service.getPrice(position.symbol);
    const exitPrice = position.type === 'BUY' ? priceData.bid : priceData.ask;
    const instrument = getInstrument(position.symbol);

    const priceDiff = position.type === 'BUY'
      ? exitPrice - position.entryPrice
      : position.entryPrice - exitPrice;
    const profitPips = instrument ? priceDiff / instrument.pipSize : 0;
    const profitLoss = instrument
      ? priceDiff * position.lotSize * instrument.contractSize
      : 0;

    const closedAt = new Date();
    const openedAt = new Date(position.openedAt);

    // Log to trade_log
    await TradeLog.logClose(position._id, {
      exitPrice,
      exitReason: reason,
      profitLoss,
      profitPips,
      openedAt,
      closedAt,
    });

    if (profitLoss < 0) {
      riskManager.recordLoss(Math.abs(profitLoss));
    }

    await paperPositionsDb.remove({ _id: positionDbId });

    const closedTrade = {
      ...position,
      exitPrice,
      exitReason: reason,
      profitLoss,
      profitPips,
      closedAt,
      holdingTime: TradeLog.formatHoldingTime(closedAt - openedAt),
    };

    websocketService.broadcast('trades', 'paper_trade_closed', closedTrade);
    await notificationService.notifyTradeClosed(closedTrade);

    return { success: true, profitLoss, profitPips, holdingTime: closedTrade.holdingTime };
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
