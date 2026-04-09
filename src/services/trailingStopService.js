/**
 * Trailing Stop Service
 * Manages dynamic stop loss adjustment for open positions
 *
 * Phase 1: Price profit >= 1×ATR → Move SL to entry (breakeven)
 * Phase 2: Price profit >= 1.5×ATR → Trail SL at 1×ATR behind price
 * Phase 3: SL only moves in profit direction, never back
 */

const { getInstrument } = require('../config/instruments');

class TrailingStopService {
  /**
   * Calculate new stop loss for a position
   * @param {object} position - { symbol, type, entryPrice, currentSl, atrAtEntry }
   * @param {number} currentPrice - Current market price
   * @returns {{ shouldUpdate: boolean, newSl: number, phase: string }}
   */
  calculateTrailingStop(position, currentPrice) {
    const { symbol, type, entryPrice, currentSl, atrAtEntry } = position;
    const instrument = getInstrument(symbol);
    if (!instrument || !atrAtEntry || atrAtEntry <= 0) {
      return { shouldUpdate: false, newSl: currentSl, phase: 'none' };
    }

    const atr = atrAtEntry;
    let profitDistance;
    let newSl = currentSl;
    let phase = 'initial';

    if (type === 'BUY') {
      profitDistance = currentPrice - entryPrice;

      if (profitDistance >= 1.5 * atr) {
        // Phase 2: Trail at 1×ATR behind price
        newSl = currentPrice - atr;
        phase = 'trailing';
      } else if (profitDistance >= 1.0 * atr) {
        // Phase 1: Move to breakeven
        newSl = entryPrice + (instrument.spread * instrument.pipSize); // Add spread for true breakeven
        phase = 'breakeven';
      }

      // SL must only increase for BUY positions
      if (newSl <= currentSl) {
        return { shouldUpdate: false, newSl: currentSl, phase };
      }
    } else {
      // SELL position
      profitDistance = entryPrice - currentPrice;

      if (profitDistance >= 1.5 * atr) {
        newSl = currentPrice + atr;
        phase = 'trailing';
      } else if (profitDistance >= 1.0 * atr) {
        newSl = entryPrice - (instrument.spread * instrument.pipSize);
        phase = 'breakeven';
      }

      // SL must only decrease for SELL positions
      if (newSl >= currentSl) {
        return { shouldUpdate: false, newSl: currentSl, phase };
      }
    }

    // Round to appropriate decimal places
    const decimals = instrument.pipSize < 0.001 ? 5 : (instrument.pipSize < 0.01 ? 3 : 2);
    newSl = parseFloat(newSl.toFixed(decimals));

    return { shouldUpdate: true, newSl, phase };
  }

  /**
   * Process all open positions for trailing stop updates
   * @param {Array} positions - Array of position objects
   * @param {Function} getPriceFn - async (symbol) => { bid, ask }
   * @param {Function} modifyFn - async (positionId, newSl, newTp) => result
   */
  async processPositions(positions, getPriceFn, modifyFn) {
    const updates = [];

    for (const position of positions) {
      try {
        const priceData = await getPriceFn(position.symbol);
        if (!priceData) continue;

        // Use bid for buy, ask for sell
        const currentPrice = position.type === 'BUY' ? priceData.bid : priceData.ask;
        if (!currentPrice) continue;

        const result = this.calculateTrailingStop(position, currentPrice);

        if (result.shouldUpdate) {
          await modifyFn(position.mt5PositionId, result.newSl, position.currentTp);
          updates.push({
            symbol: position.symbol,
            positionId: position.mt5PositionId,
            oldSl: position.currentSl,
            newSl: result.newSl,
            phase: result.phase,
            currentPrice,
          });
          console.log(
            `[TrailingStop] ${position.symbol} ${position.type}: SL ${position.currentSl} → ${result.newSl} (${result.phase})`
          );
        }
      } catch (err) {
        console.error(`[TrailingStop] Error processing ${position.symbol}:`, err.message);
      }
    }

    return updates;
  }
}

const trailingStopService = new TrailingStopService();

module.exports = trailingStopService;
