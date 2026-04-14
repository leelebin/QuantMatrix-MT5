/**
 * Trailing Stop / Exit Plan Service
 *
 * Executes the exitPlan lifecycle on every monitor tick for every open
 * position:
 *   1. Fetch the live price (bid/ask based on direction).
 *   2. Track max-favourable price (used for chandelier trailing).
 *   3. Invoke the strategy's evaluateExit() hook to obtain adaptive
 *      overrides that reflect the current market state.
 *   4. Apply BE / trailing phase updates.
 *   5. Fire partial take-profits whose profit threshold has been crossed.
 *   6. Force-close positions whose timeExit has expired.
 *
 * For back-compat, positions created before the exitPlan contract existed
 * (i.e. only carrying a legacy breakevenConfig snapshot) still work: the
 * breakevenService fallback lifts them into the exitPlan shape.
 */

const { getInstrument } = require('../config/instruments');
const breakevenService = require('./breakevenService');

class TrailingStopService {
  /**
   * Calculate the next SL for a position based on its (possibly adapted)
   * exit plan. This is the legacy entry point kept for back-compat; new
   * callers should prefer processPositions().
   */
  calculateTrailingStop(position, currentPrice, adaptedPlan = null) {
    const instrument = getInstrument(position?.symbol);
    return breakevenService.calculateExitAdjustment(
      position,
      currentPrice,
      instrument,
      adaptedPlan
    );
  }

  _mergeAdaptive(basePlan, adaptiveOverride) {
    if (!adaptiveOverride) return basePlan;
    try {
      return breakevenService.normalizeExitPlan(adaptiveOverride, { baseConfig: basePlan });
    } catch (err) {
      return basePlan;
    }
  }

  /**
   * Process all open positions.
   * @param {Array} positions
   * @param {Function} getPriceFn - async (symbol) => { bid, ask }
   * @param {Function} modifyFn   - async (positionId, newSl, newTp) => result
   * @param {object}   hooks      - Optional:
   *   - getStrategy(name): returns a strategy instance for evaluateExit
   *   - getLiveContext(position): returns { indicators, candles } for the
   *     position's symbol (used by evaluateExit)
   *   - closePositionFn(positionId): async close (used by timeExit)
   *   - partialCloseFn(positionId, volume): async partial close (used by partials)
   *   - updatePositionFn(localId, patch): persists updates (maxFavourablePrice,
   *     partialsExecutedIndices, exitPlanOverride)
   */
  async processPositions(positions, getPriceFn, modifyFn, hooks = {}) {
    const updates = [];
    const {
      getStrategy = null,
      getLiveContext = null,
      closePositionFn = null,
      partialCloseFn = null,
      updatePositionFn = null,
    } = hooks;

    for (const position of positions) {
      try {
        const priceData = await getPriceFn(position.symbol);
        if (!priceData) continue;

        const currentPrice = position.type === 'BUY' ? priceData.bid : priceData.ask;
        if (!currentPrice) continue;

        const instrument = getInstrument(position.symbol);
        if (!instrument) continue;

        // ── 1. Update max-favourable price (for chandelier trailing) ──
        const favourablePrice = position.type === 'BUY'
          ? Math.max(Number(position.maxFavourablePrice || position.entryPrice), currentPrice)
          : Math.min(Number(position.maxFavourablePrice || position.entryPrice), currentPrice);

        const positionWithMaxFav = {
          ...position,
          maxFavourablePrice: favourablePrice,
        };

        // ── 2. Resolve base plan (snapshot) and apply adaptive override ──
        const basePlan = breakevenService.getPositionExitPlan(positionWithMaxFav);

        let adaptivePlan = basePlan;
        const evaluatorName = basePlan.adaptiveEvaluator || position.strategy;
        if (evaluatorName && getStrategy && getLiveContext) {
          try {
            const strategy = getStrategy(evaluatorName);
            if (strategy && typeof strategy.evaluateExit === 'function') {
              const context = await getLiveContext(positionWithMaxFav);
              if (context) {
                const override = strategy.evaluateExit(positionWithMaxFav, {
                  ...context,
                  instrument,
                  price: currentPrice,
                });
                if (override) {
                  adaptivePlan = this._mergeAdaptive(basePlan, override);
                }
              }
            }
          } catch (evalErr) {
            console.warn(
              `[TrailingStop] evaluateExit(${evaluatorName}) failed for ${position.symbol}: ${evalErr.message}`
            );
          }
        }

        // ── 3. Time-based exit ──
        const timeExit = breakevenService.isTimeExitTriggered(
          positionWithMaxFav,
          Date.now(),
          adaptivePlan
        );
        if (timeExit.exceeded) {
          if (closePositionFn && position.mt5PositionId) {
            try {
              await closePositionFn(position.mt5PositionId);
              console.log(
                `[TrailingStop] ${position.symbol} ${position.type}: time exit (${timeExit.reason}, held ${Math.round(timeExit.elapsedMinutes)}m)`
              );
              updates.push({
                symbol: position.symbol,
                positionId: position.mt5PositionId,
                phase: 'time_exit',
                reason: timeExit.reason,
                currentPrice,
              });
            } catch (closeErr) {
              console.warn(`[TrailingStop] time exit close failed: ${closeErr.message}`);
            }
          }
          continue;
        }

        // ── 4. Partial take-profits ──
        const partialTriggers = breakevenService.findPartialTriggers(
          positionWithMaxFav,
          currentPrice,
          adaptivePlan
        );
        if (partialTriggers.length > 0 && partialCloseFn && position.mt5PositionId) {
          const executed = Array.isArray(position.partialsExecutedIndices)
            ? [...position.partialsExecutedIndices]
            : [];
          let remainingLots = Number(position.lotSize) || 0;
          const originalLots = Number(position.originalLotSize || position.lotSize) || remainingLots;

          for (const trigger of partialTriggers) {
            const closeLots = Math.max(0, originalLots * trigger.closeFraction);
            const minLot = Number(instrument.minLot) || 0.01;
            if (closeLots < minLot || remainingLots - closeLots < minLot) {
              executed.push(trigger.index);
              continue;
            }
            try {
              await partialCloseFn(position.mt5PositionId, closeLots);
              remainingLots -= closeLots;
              executed.push(trigger.index);
              updates.push({
                symbol: position.symbol,
                positionId: position.mt5PositionId,
                phase: 'partial',
                label: trigger.label || `partial_${trigger.index}`,
                volumeClosed: closeLots,
                currentPrice,
              });
              console.log(
                `[TrailingStop] ${position.symbol} ${position.type}: partial ${trigger.label || trigger.index} closed ${closeLots}`
              );
            } catch (partialErr) {
              console.warn(`[TrailingStop] partial close failed: ${partialErr.message}`);
              break;
            }
          }

          if (updatePositionFn) {
            try {
              await updatePositionFn(position._id || position.mt5PositionId, {
                partialsExecutedIndices: executed,
                lotSize: remainingLots,
              });
            } catch (persistErr) {
              console.warn(`[TrailingStop] persist partials failed: ${persistErr.message}`);
            }
          }
        }

        // ── 5. BE / Trail SL update ──
        const result = breakevenService.calculateExitAdjustment(
          positionWithMaxFav,
          currentPrice,
          instrument,
          adaptivePlan
        );

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

        // ── 6. Persist max-favourable price ──
        if (updatePositionFn && favourablePrice !== position.maxFavourablePrice) {
          try {
            await updatePositionFn(position._id || position.mt5PositionId, {
              maxFavourablePrice: favourablePrice,
            });
          } catch (persistErr) {
            // non-critical
          }
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
