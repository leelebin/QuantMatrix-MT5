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
const { getInstrument } = require('../config/instruments');

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

    await trailingStopService.processPositions(
      positions,
      async (symbol) => mt5Service.getPrice(symbol),
      async (positionId, newSl, newTp) => mt5Service.modifyPosition(positionId, newSl, newTp)
    );

    // Update local DB with new SL values
    const updatedPositions = await positionsDb.find({});
    for (const pos of updatedPositions) {
      if (pos.mt5PositionId) {
        try {
          const priceData = await mt5Service.getPrice(pos.symbol);
          const currentPrice = pos.type === 'BUY' ? priceData.bid : priceData.ask;
          const result = trailingStopService.calculateTrailingStop(pos, currentPrice);
          if (result.shouldUpdate) {
            await positionsDb.update({ _id: pos._id }, { $set: { currentSl: result.newSl } });
          }
        } catch (err) {
          // Price fetch may fail for some symbols - continue
        }
      }
    }
  }

  /**
   * Handle a position that was closed externally (SL/TP hit)
   */
  async _handleExternalClose(localPos) {
    console.log(`[Monitor] Position closed externally: ${localPos.symbol} ${localPos.type}`);

    const instrument = getInstrument(localPos.symbol);

    // Try to determine exit reason and price
    let exitPrice = 0;
    let exitReason = 'EXTERNAL';

    try {
      // Try to get the last price as approximation
      const priceData = await mt5Service.getPrice(localPos.symbol);
      exitPrice = localPos.type === 'BUY' ? priceData.bid : priceData.ask;
    } catch (e) {
      exitPrice = localPos.currentPrice || localPos.entryPrice;
    }

    // Determine if SL or TP was hit
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

    // Update trade record
    await tradesDb.update({ positionDbId: localPos._id }, {
      $set: {
        status: 'CLOSED',
        exitPrice,
        exitReason,
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
    await positionsDb.remove({ _id: localPos._id });

    const closedTrade = {
      ...localPos,
      exitPrice,
      exitReason,
      profitLoss,
      profitPips,
      closedAt: new Date(),
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
