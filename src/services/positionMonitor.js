/**
 * Position Monitor
 * Syncs MT5 positions with local DB, runs trailing stops, detects external closures
 */

const mt5Service = require('./mt5Service');
const trailingStopService = require('./trailingStopService');
const riskManager = require('./riskManager');
const websocketService = require('./websocketService');
const notificationService = require('./notificationService');
const { positionsDb, tradesDb } = require('../config/db');
const { buildClosedTradeSnapshot } = require('../utils/mt5Reconciliation');

class PositionMonitor {
  constructor() {
    this.monitorInterval = null;
    this.running = false;
  }

  /**
   * Start monitoring positions
   * @param {number} intervalMs - Check interval in ms (default 30s)
   */
  start(intervalMs = 30000) {
    if (this.running) return;
    this.running = true;

    this.monitorInterval = setInterval(async () => {
      try {
        await this.syncPositions();
        await this.runTrailingStops();
      } catch (err) {
        console.error('[Monitor] Error:', err.message);
      }
    }, intervalMs);

    console.log(`[Monitor] Started (interval: ${intervalMs / 1000}s)`);
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.running = false;
    console.log('[Monitor] Stopped');
  }

  /**
   * Sync MT5 positions with local database
   * Detects positions closed externally (by SL/TP hit or manual close)
   */
  async syncPositions() {
    if (!mt5Service.isConnected()) return;

    const mt5Positions = await mt5Service.getPositions();
    const localPositions = await positionsDb.find({});

    const mt5PositionIds = new Set(mt5Positions.map((p) => String(p.id)));

    // Find locally tracked positions that no longer exist on MT5 (closed externally)
    for (const localPos of localPositions) {
      if (localPos.mt5PositionId && !mt5PositionIds.has(String(localPos.mt5PositionId))) {
        await this._handleExternalClose(localPos);
      }
    }

    // Update local positions with current MT5 data
    for (const mt5Pos of mt5Positions) {
      const localPos = localPositions.find(
        (lp) => String(lp.mt5PositionId) === String(mt5Pos.id)
      );
      if (localPos) {
        await positionsDb.update({ _id: localPos._id }, {
          $set: {
            currentSl: mt5Pos.stopLoss || localPos.currentSl,
            currentTp: mt5Pos.takeProfit || localPos.currentTp,
            currentPrice: mt5Pos.currentPrice,
            unrealizedPl: mt5Pos.unrealizedProfit || mt5Pos.profit || 0,
          },
        });
      }
    }

    // Broadcast positions update
    const updatedPositions = await positionsDb.find({});
    websocketService.broadcast('positions', 'positions_sync', updatedPositions);
  }

  /**
   * Run trailing stop logic on all open positions
   */
  async runTrailingStops() {
    if (!mt5Service.isConnected()) return;

    const positions = await positionsDb.find({});
    if (positions.length === 0) return;

    const updates = await trailingStopService.processPositions(
      positions,
      async (symbol) => mt5Service.getPrice(symbol),
      async (positionId, newSl, newTp) => mt5Service.modifyPosition(positionId, newSl, newTp)
    );

    if (updates.length === 0) {
      return;
    }

    const positionsByMt5Id = new Map(
      positions
        .filter((position) => position.mt5PositionId != null)
        .map((position) => [String(position.mt5PositionId), position])
    );

    for (const update of updates) {
      const localPosition = positionsByMt5Id.get(String(update.positionId));
      if (!localPosition) continue;

      await positionsDb.update(
        { _id: localPosition._id },
        { $set: { currentSl: update.newSl } }
      );
    }

    const refreshedPositions = await positionsDb.find({});
    websocketService.broadcast('positions', 'positions_sync', refreshedPositions);
  }

  /**
   * Handle a position that was closed externally (SL/TP hit)
   */
  async _handleExternalClose(localPos) {
    console.log(`[Monitor] Position closed externally: ${localPos.symbol} ${localPos.type}`);
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
        console.warn(`[Monitor] Deal reconciliation failed for ${localPos.symbol}: ${reconciliationError.message}`);
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

    // Update trade record
    await tradesDb.update({ positionDbId: localPos._id }, {
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
        mt5CloseDealId: dealSummary?.lastExitDeal?.id || null,
      },
    });

    // Track loss for daily limit
    if (closedSnapshot.profitLoss < 0) {
      await riskManager.recordLoss(Math.abs(closedSnapshot.profitLoss), closedSnapshot.closedAt);
    }

    // Remove from active positions
    await positionsDb.remove({ _id: localPos._id });

    const closedTrade = {
      ...localPos,
      ...closedSnapshot,
    };

    // Broadcast via WebSocket
    websocketService.broadcast('trades', 'trade_closed', closedTrade);
    websocketService.broadcast('positions', 'position_update', { action: 'closed', position: closedTrade });

    // Send Telegram notification
    await notificationService.notifyTradeClosed(closedTrade);
  }

  /**
   * Get monitoring status
   */
  getStatus() {
    return {
      running: this.running,
      intervalMs: this.monitorInterval ? 30000 : 0,
    };
  }
}

const positionMonitor = new PositionMonitor();

module.exports = positionMonitor;
