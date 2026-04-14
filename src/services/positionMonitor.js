/**
 * Position Monitor
 * Syncs MT5 positions with local DB, runs trailing stops, detects external closures
 */

const mt5Service = require('./mt5Service');
const trailingStopService = require('./trailingStopService');
const riskManager = require('./riskManager');
const websocketService = require('./websocketService');
const notificationService = require('./notificationService');
const indicatorService = require('./indicatorService');
const strategyEngine = require('./strategyEngine');
const { getInstrument } = require('../config/instruments');
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
   * Run exit-plan lifecycle (BE, trailing, partials, time-exit) on all open
   * positions. Strategies' evaluateExit() hooks are invoked with fresh
   * candle + indicator context so they can adapt to current market state.
   */
  async runTrailingStops() {
    if (!mt5Service.isConnected()) return;

    const positions = await positionsDb.find({});
    if (positions.length === 0) return;

    // Per-tick cache so multiple positions on the same symbol/timeframe share
    // one candle fetch + indicator computation.
    const candleCache = new Map();
    const indicatorCache = new Map();

    const getLiveContext = async (position) => {
      const instrument = getInstrument(position.symbol);
      if (!instrument) return null;
      const timeframe = instrument.timeframe || '1h';
      const cacheKey = `${position.symbol}:${timeframe}`;
      try {
        if (!candleCache.has(cacheKey)) {
          const candles = await mt5Service.getCandles(
            position.symbol,
            timeframe,
            new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
            251
          );
          candleCache.set(cacheKey, Array.isArray(candles) ? candles : []);
        }
        const rawCandles = candleCache.get(cacheKey);
        const closedCandles = rawCandles && rawCandles.length > 1
          ? rawCandles.slice(0, -1)
          : rawCandles || [];
        if (closedCandles.length < 20) return null;
        if (!indicatorCache.has(cacheKey)) {
          indicatorCache.set(cacheKey, indicatorService.calculateAll(closedCandles));
        }
        return {
          candles: closedCandles,
          indicators: indicatorCache.get(cacheKey),
        };
      } catch (err) {
        console.warn(`[Monitor] Live context fetch failed for ${position.symbol}: ${err.message}`);
        return null;
      }
    };

    const getStrategy = (name) => {
      if (!name) return null;
      const strategies = strategyEngine.strategies || {};
      return strategies[name] || null;
    };

    const updates = await trailingStopService.processPositions(
      positions,
      async (symbol) => mt5Service.getPrice(symbol),
      async (positionId, newSl, newTp) => mt5Service.modifyPosition(positionId, newSl, newTp),
      {
        getStrategy,
        getLiveContext,
        closePositionFn: async (positionId) => mt5Service.closePosition(positionId),
        partialCloseFn: async (positionId, volume) => {
          if (typeof mt5Service.partialClosePosition !== 'function') {
            throw new Error('partialClosePosition not supported by MT5 bridge');
          }
          return mt5Service.partialClosePosition(positionId, volume);
        },
        updatePositionFn: async (localId, patch) => {
          const query = localId && typeof localId === 'string' && localId.length >= 16
            ? { _id: localId }
            : { mt5PositionId: String(localId) };
          await positionsDb.update(query, { $set: patch });
        },
      }
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
      if (update.newSl !== undefined) {
        await positionsDb.update(
          { _id: localPosition._id },
          { $set: { currentSl: update.newSl } }
        );
      }
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
