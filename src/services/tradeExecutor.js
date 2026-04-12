/**
 * Trade Executor
 * Receives strategy signals, validates through risk manager, executes on MT5
 */

const mt5Service = require('./mt5Service');
const riskManager = require('./riskManager');
const websocketService = require('./websocketService');
const notificationService = require('./notificationService');
const { positionsDb, tradesDb } = require('../config/db');
const ExecutionAudit = require('../models/ExecutionAudit');
const { buildClosedTradeSnapshot } = require('../utils/mt5Reconciliation');
const { buildBrokerComment, buildTradeComment } = require('../utils/tradeComment');

class TradeExecutor {
  async _recordAudit(stage, status, signal, extra = {}) {
    const audit = await ExecutionAudit.create({
      scope: 'live',
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
      source: 'live_executor',
      details: extra.details || null,
      createdAt: extra.createdAt || new Date(),
    });

    websocketService.broadcast('status', 'execution_audit', audit);
    return audit;
  }

  _broadcastRejection(signal, reason, extra = {}) {
    websocketService.broadcast('signals', 'trade_rejected', {
      symbol: signal.symbol,
      type: signal.signal,
      reason,
      stage: extra.stage || null,
      code: extra.code ?? null,
      codeName: extra.codeName || null,
      scope: 'live',
    });
  }

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
      mt5Service.ensureLiveTradingAllowed(accountInfo);

      // Get current price for entry
      const priceData = await mt5Service.getPrice(signal.symbol);
      const quotedEntryPrice = signal.signal === 'BUY' ? priceData.ask : priceData.bid;
      signal.entryPrice = quotedEntryPrice;

      // Validate through risk manager
      const riskCheck = await riskManager.validateTrade(signal, accountInfo);
      if (!riskCheck.allowed) {
        console.log(`[Executor] Trade rejected for ${signal.symbol}: ${riskCheck.reason}`);
        await this._recordAudit('risk', 'BLOCKED', signal, {
          message: riskCheck.reason,
          code: 'RISK_RULE',
          codeName: 'RISK_RULE',
          volume: riskCheck.lotSize || null,
          accountInfo,
          details: { riskCheck },
        });

        // Broadcast rejection via WebSocket
        this._broadcastRejection(signal, riskCheck.reason, {
          stage: 'risk',
          code: 'RISK_RULE',
          codeName: 'RISK_RULE',
        });

        return { success: false, message: riskCheck.reason, trade: null };
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

      const brokerComment = buildBrokerComment(signal, 'QM');
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
        return { success: false, message: preflightMessage, trade: null };
      }

      // Execute on MT5
      const result = await mt5Service.placeOrder(
        signal.symbol,
        signal.signal,
        riskCheck.lotSize,
        signal.sl,
        signal.tp,
        brokerComment
      );

      // Calculate ATR for trailing stop tracking
      const atrAtEntry = signal.indicatorsSnapshot?.atr || 0;
      const executedEntryPrice = result.entryDeal?.price || result.price || quotedEntryPrice;
      const openedAt = result.entryDeal?.time ? new Date(result.entryDeal.time) : new Date();
      const mt5PositionId = result.positionId || result.orderId || null;
      const mt5EntryDealId = result.entryDeal?.id || result.dealId || null;
      const mt5Comment = result.entryDeal?.comment || brokerComment;
      const entryCommission = Number(result.entryDeal?.commission) || 0;
      const entrySwap = Number(result.entryDeal?.swap) || 0;
      const entryFee = Number(result.entryDeal?.fee) || 0;

      // Save position to local DB
      const position = await positionsDb.insert({
        symbol: signal.symbol,
        type: signal.signal,
        entryPrice: executedEntryPrice,
        currentSl: signal.sl,
        currentTp: signal.tp,
        lotSize: riskCheck.lotSize,
        mt5PositionId,
        mt5EntryDealId,
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

      // Save to trade log
      await tradesDb.insert({
        symbol: signal.symbol,
        type: signal.signal,
        entryPrice: executedEntryPrice,
        sl: signal.sl,
        tp: signal.tp,
        lotSize: riskCheck.lotSize,
        strategy: signal.strategy,
        confidence: signal.confidence,
        reason: signal.reason,
        indicatorsSnapshot: signal.indicatorsSnapshot,
        commission: entryCommission,
        swap: entrySwap,
        fee: entryFee,
        mt5PositionId,
        mt5OrderId: result.orderId || null,
        mt5EntryDealId,
        mt5Comment,
        comment: tradeComment,
        positionDbId: position._id,
        status: 'OPEN',
        openedAt,
        closedAt: null,
        exitPrice: null,
        exitReason: null,
        profitLoss: null,
        profitPips: null,
      });

      console.log(
        `[Executor] Trade executed: ${signal.signal} ${riskCheck.lotSize} ${signal.symbol} @ ${executedEntryPrice} | SL: ${signal.sl} TP: ${signal.tp}`
      );

      // Broadcast via WebSocket
      websocketService.broadcast('trades', 'trade_opened', position);
      websocketService.broadcast('positions', 'position_update', { action: 'opened', position });

      // Send Telegram notification
      await notificationService.notifyTradeOpened(position);

      return { success: true, message: 'Trade executed', trade: position };
    } catch (err) {
      console.error(`[Executor] Error executing trade for ${signal.symbol}:`, err.message);
      const auditCode = err.code ?? err.details?.retcode ?? null;
      const auditCodeName = err.codeName ?? err.details?.retcodeName ?? null;
      const auditStage = err.method === 'placeOrder'
        ? 'order_send'
        : err.method === 'preflightOrder'
          ? 'preflight'
          : (String(err.message || '').includes('Live trading') || String(err.message || '').includes('REAL MT5 account'))
            ? 'account_guard'
            : 'execution';

      try {
        const accountInfo = mt5Service.isConnected() ? await mt5Service.getAccountInfo() : null;
        await this._recordAudit(auditStage, 'ERROR', signal, {
          message: err.message,
          code: auditCode,
          codeName: auditCodeName,
          accountInfo,
          details: err.details || { method: err.method || null },
        });
      } catch (auditError) {
        console.error('[Executor] Failed to record execution audit:', auditError.message);
      }

      this._broadcastRejection(signal, err.message, {
        stage: auditStage,
        code: auditCode,
        codeName: auditCodeName,
      });
      return { success: false, message: err.message, trade: null };
    }
  }

  /**
   * Close a position
   * @param {string} positionDbId - Local DB position ID
   * @param {string} reason - Exit reason
   */
  async closePosition(positionDbId, reason = 'MANUAL') {
    let position = null;

    try {
      position = await positionsDb.findOne({ _id: positionDbId });
      if (!position) {
        return { success: false, message: 'Position not found' };
      }

      // Close on MT5
      let closeResult = null;
      if (position.mt5PositionId) {
        closeResult = await mt5Service.closePosition(position.mt5PositionId);
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
          console.warn(`[Executor] Deal reconciliation failed for ${position.symbol}: ${reconciliationError.message}`);
        }
      }

      const closedSnapshot = buildClosedTradeSnapshot(position, dealSummary, {
        exitPrice: closeResult?.closeDeal?.price || closeResult?.price,
        reason,
      });

      // Update position in DB
      await positionsDb.update({ _id: positionDbId }, {
        $set: { status: 'CLOSED', closedAt: closedSnapshot.closedAt },
      });

      // Update trade record
      await tradesDb.update({ positionDbId }, {
        $set: {
          status: 'CLOSED',
          exitPrice: closedSnapshot.exitPrice,
          exitReason: closedSnapshot.exitReason,
          profitLoss: closedSnapshot.profitLoss,
          profitPips: closedSnapshot.profitPips,
          closedAt: closedSnapshot.closedAt,
          commission: closedSnapshot.commission,
          swap: closedSnapshot.swap,
          fee: closedSnapshot.fee,
          mt5CloseDealId: closeResult?.closeDeal?.id || closeResult?.dealId || null,
        },
      });

      // Track loss for daily limit
      if (closedSnapshot.profitLoss < 0) {
        await riskManager.recordLoss(Math.abs(closedSnapshot.profitLoss), closedSnapshot.closedAt);
      }

      // Remove from active positions
      await positionsDb.remove({ _id: positionDbId });

      console.log(
        `[Executor] Position closed: ${position.symbol} ${position.type} | P/L: ${closedSnapshot.profitLoss.toFixed(2)} (${closedSnapshot.profitPips.toFixed(1)} pips) | Reason: ${closedSnapshot.exitReason}`
      );

      const closedTrade = {
        ...position,
        ...closedSnapshot,
      };

      // Broadcast via WebSocket
      websocketService.broadcast('trades', 'trade_closed', closedTrade);
      websocketService.broadcast('positions', 'position_update', { action: 'closed', position: closedTrade });

      // Send Telegram notification
      await notificationService.notifyTradeClosed(closedTrade);

      return {
        success: true,
        message: 'Position closed',
        profitLoss: closedSnapshot.profitLoss,
        profitPips: closedSnapshot.profitPips,
      };
    } catch (err) {
      console.error(`[Executor] Error closing position ${positionDbId}:`, err.message);
      if (position) {
        try {
          const accountInfo = mt5Service.isConnected() ? await mt5Service.getAccountInfo() : null;
          await this._recordAudit('close', 'ERROR', {
            symbol: position.symbol,
            signal: position.type,
            strategy: position.strategy,
          }, {
            message: err.message,
            code: err.code ?? err.details?.retcode ?? null,
            codeName: err.codeName ?? err.details?.retcodeName ?? null,
            volume: position.lotSize,
            accountInfo,
            details: err.details || { positionDbId, reason },
          });
        } catch (auditError) {
          console.error('[Executor] Failed to record close audit:', auditError.message);
        }
      }
      return { success: false, message: err.message };
    }
  }
}

const tradeExecutor = new TradeExecutor();

module.exports = tradeExecutor;
