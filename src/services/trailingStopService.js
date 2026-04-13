/**
 * Trailing Stop Service
 * Manages dynamic stop loss adjustment for open positions
 */

const { getInstrument } = require('../config/instruments');
const breakevenService = require('./breakevenService');

class TrailingStopService {
  /**
   * Calculate new stop loss for a position
   * @param {object} position - { symbol, type, entryPrice, currentSl, atrAtEntry }
   * @param {number} currentPrice - Current market price
   * @returns {{ shouldUpdate: boolean, newSl: number, phase: string }}
   */
  calculateTrailingStop(position, currentPrice) {
    const instrument = getInstrument(position?.symbol);
    return breakevenService.calculateBreakevenStop(position, currentPrice, instrument);
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
            `[TrailingStop] ${position.symbol} ${position.type}: SL ${position.currentSl} -> ${result.newSl} (${result.phase})`
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
