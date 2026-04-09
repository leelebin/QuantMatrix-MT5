/**
 * Trade Executor
 * Receives strategy signals, validates through risk manager, executes on MT5
 */

const mt5Service = require('./mt5Service');
const riskManager = require('./riskManager');
const websocketService = require('./websocketService');
const notificationService = require('./notificationService');
const { positionsDb, tradesDb } = require('../config/db');
const { getInstrument } = require('../config/instruments');

class TradeExecutor {
  /**
   * Execute a trade based on a strategy signal
   * @param {object} signal - { symbol, signal, confidence, sl, tp, reason, indicatorsSnapshot, strategy }
   * @returns {{ success: boolean, message: string, trade: object|null }}
   */
  async executeTrade(signal) {
    if (signal.signal === 'NONE') {
      return { success: false, message: 'No signal to execute', trade: null };
    }

    try {
      // Get account info for risk checks
      const accountInfo = await mt5Service.getAccountInfo();

      // Get current price for entry
      const priceData = await mt5Service.getPrice(signal.symbol);
      const entryPrice = signal.signal === 'BUY' ? priceData.ask : priceData.bid;
      signal.entryPrice = entryPrice;

      // Validate through risk manager
      const riskCheck = await riskManager.validateTrade(signal, accountInfo);
      if (!riskCheck.allowed) {
        console.log(`[Executor] Trade rejected for ${signal.symbol}: ${riskCheck.reason}`);

        // Broadcast rejection via WebSocket
        websocketService.broadcast('signals', 'trade_rejected', {
          symbol: signal.symbol,
          type: signal.signal,
          reason: riskCheck.reason,
        });

        return { success: false, message: riskCheck.reason, trade: null };
      }

      // Execute on MT5
      const comment = `QM|${signal.strategy}|${signal.confidence.toFixed(2)}`;
      const result = await mt5Service.placeOrder(
        signal.symbol,
        signal.signal,
        riskCheck.lotSize,
        signal.sl,
        signal.tp,
        comment
      );

      // Calculate ATR for trailing stop tracking
      const instrument = getInstrument(signal.symbol);
      const atrAtEntry = signal.indicatorsSnapshot?.atr || 0;

      // Save position to local DB
      const position = await positionsDb.insert({
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
        openedAt: new Date(),
        status: 'OPEN',
      });

      // Save to trade log
      await tradesDb.insert({
        symbol: signal.symbol,
        type: signal.signal,
        entryPrice,
        sl: signal.sl,
        tp: signal.tp,
        lotSize: riskCheck.lotSize,
        strategy: signal.strategy,
        confidence: signal.confidence,
        reason: signal.reason,
        indicatorsSnapshot: signal.indicatorsSnapshot,
        mt5OrderId: result.positionId || result.orderId || null,
        positionDbId: position._id,
        status: 'OPEN',
        openedAt: new Date(),
        closedAt: null,
        exitPrice: null,
        exitReason: null,
        profitLoss: null,
        profitPips: null,
      });

      console.log(
        `[Executor] Trade executed: ${signal.signal} ${riskCheck.lotSize} ${signal.symbol} @ ${entryPrice} | SL: ${signal.sl} TP: ${signal.tp}`
      );

      // Broadcast via WebSocket
      websocketService.broadcast('trades', 'trade_opened', position);
      websocketService.broadcast('positions', 'position_update', { action: 'opened', position });

      // Send Telegram notification
      await notificationService.notifyTradeOpened(position);

      return { success: true, message: 'Trade executed', trade: position };
    } catch (err) {
      console.error(`[Executor] Error executing trade for ${signal.symbol}:`, err.message);
      return { success: false, message: err.message, trade: null };
    }
  }

  /**
   * Close a position
   * @param {string} positionDbId - Local DB position ID
   * @param {string} reason - Exit reason
   */
  async closePosition(positionDbId, reason = 'MANUAL') {
    try {
      const position = await positionsDb.findOne({ _id: positionDbId });
      if (!position) {
        return { success: false, message: 'Position not found' };
      }

      // Close on MT5
      if (position.mt5PositionId) {
        await mt5Service.closePosition(position.mt5PositionId);
      }

      // Get exit price
      const priceData = await mt5Service.getPrice(position.symbol);
      const exitPrice = position.type === 'BUY' ? priceData.bid : priceData.ask;

      // Calculate P/L
      const instrument = getInstrument(position.symbol);
      const priceDiff = position.type === 'BUY'
        ? exitPrice - position.entryPrice
        : position.entryPrice - exitPrice;
      const profitPips = priceDiff / (instrument ? instrument.pipSize : 0.0001);
      const profitLoss = priceDiff * position.lotSize * (instrument ? instrument.contractSize : 100000);

      // Update position in DB
      await positionsDb.update({ _id: positionDbId }, {
        $set: { status: 'CLOSED', closedAt: new Date() },
      });

      // Update trade record
      await tradesDb.update({ positionDbId }, {
        $set: {
          status: 'CLOSED',
          exitPrice,
          exitReason: reason,
          profitLoss,
          profitPips,
          closedAt: new Date(),
        },
      });

      // Track loss for daily limit
      if (profitLoss < 0) {
        riskManager.recordLoss(Math.abs(profitLoss));
      }

      // Remove from active positions
      await positionsDb.remove({ _id: positionDbId });

      console.log(
        `[Executor] Position closed: ${position.symbol} ${position.type} | P/L: ${profitLoss.toFixed(2)} (${profitPips.toFixed(1)} pips) | Reason: ${reason}`
      );

      const closedTrade = {
        ...position,
        exitPrice,
        exitReason: reason,
        profitLoss,
        profitPips,
        closedAt: new Date(),
      };

      // Broadcast via WebSocket
      websocketService.broadcast('trades', 'trade_closed', closedTrade);
      websocketService.broadcast('positions', 'position_update', { action: 'closed', position: closedTrade });

      // Send Telegram notification
      await notificationService.notifyTradeClosed(closedTrade);

      return { success: true, message: 'Position closed', profitLoss, profitPips };
    } catch (err) {
      console.error(`[Executor] Error closing position ${positionDbId}:`, err.message);
      return { success: false, message: err.message };
    }
  }
}

const tradeExecutor = new TradeExecutor();

module.exports = tradeExecutor;
