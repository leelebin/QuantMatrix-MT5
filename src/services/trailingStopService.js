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

const { getInstrument, STRATEGY_TYPES } = require('../config/instruments');
const { getStrategyExecutionConfig } = require('../config/strategyExecution');
const breakevenService = require('./breakevenService');
const indicatorService = require('./indicatorService');
const strategyEngine = require('./strategyEngine');
const { getStrategyInstance } = require('./strategyInstanceService');
const {
  appendManagementEvent,
  createManagerAction,
  normalizeHigherTfTrendSnapshot,
} = require('../utils/positionExitState');

function normalizeFingerprintNumber(value, digits = 8) {
  if (!Number.isFinite(Number(value))) {
    return null;
  }

  return parseFloat(Number(value).toFixed(digits));
}

function getPricePrecision(instrument) {
  const pipSize = String(instrument?.pipSize || '0.01');
  if (pipSize.includes('e-')) {
    return parseInt(pipSize.split('e-')[1], 10);
  }

  const decimalPart = pipSize.split('.')[1];
  return decimalPart ? decimalPart.length : 2;
}

function normalizePriceForFingerprint(value, instrument) {
  if (!Number.isFinite(Number(value))) {
    return null;
  }

  const digits = getPricePrecision(instrument);
  return parseFloat(Number(value).toFixed(digits));
}

function buildFingerprint(position, instrument, details = {}) {
  const payload = {
    positionId: String(position?._id || position?.mt5PositionId || position?.symbol || 'unknown'),
    actionType: String(details.actionType || 'UNKNOWN').toUpperCase(),
    targetStop: normalizePriceForFingerprint(details.targetStop, instrument),
    closeFraction: normalizeFingerprintNumber(details.closeFraction, 6),
    closeReason: details.closeReason ? String(details.closeReason) : null,
    targetTp: normalizePriceForFingerprint(details.targetTp, instrument),
    targetLimit: normalizePriceForFingerprint(details.targetLimit, instrument),
  };

  return JSON.stringify(payload);
}

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

  _getClosedCandles(rawCandles) {
    if (!Array.isArray(rawCandles)) return [];
    return rawCandles.length > 1 ? rawCandles.slice(0, -1) : rawCandles;
  }

  _buildHigherTfTrendSnapshot(candles, params = {}, timeframe = null) {
    const closedCandles = this._getClosedCandles(candles);
    if (closedCandles.length === 0) return null;

    const closes = closedCandles.map((candle) => candle.close);
    const emaPeriod = Number(params.ema_trend) || 200;
    const emaSeries = indicatorService.ema(closes, emaPeriod);
    const latestEma = emaSeries.length > 0 ? emaSeries[emaSeries.length - 1] : null;
    const latestPrice = closedCandles[closedCandles.length - 1]?.close;

    if (!Number.isFinite(latestEma) || !Number.isFinite(latestPrice)) {
      return null;
    }

    return normalizeHigherTfTrendSnapshot({
      trend: latestPrice > latestEma ? 'BULLISH' : 'BEARISH',
      ema200: latestEma,
      price: latestPrice,
      timeframe,
    });
  }

  createPositionManagementHooks({
    getCandlesFn,
    updatePositionFn = null,
    closePositionFn = null,
    partialCloseFn = null,
  } = {}) {
    const candleCache = new Map();
    const indicatorCache = new Map();
    const strategyInstanceCache = new Map();

    const getStrategy = (name) => {
      if (!name) return null;
      const strategies = strategyEngine.strategies || {};
      return strategies[name] || null;
    };

    const getCachedStrategyInstance = async (symbol, strategyName) => {
      const cacheKey = `${symbol}:${strategyName}`;
      if (!strategyInstanceCache.has(cacheKey)) {
        strategyInstanceCache.set(cacheKey, getStrategyInstance(symbol, strategyName));
      }
      return strategyInstanceCache.get(cacheKey);
    };

    const fetchCachedCandles = async (symbol, timeframe) => {
      const cacheKey = `${symbol}:${timeframe}`;
      if (!candleCache.has(cacheKey)) {
        candleCache.set(cacheKey, Promise.resolve(getCandlesFn(symbol, timeframe)));
      }
      return candleCache.get(cacheKey);
    };

    const buildIndicatorCacheKey = (symbol, timeframe, strategyName, strategyParams) => (
      `${symbol}:${timeframe}:${strategyName}:${JSON.stringify(strategyParams || {})}`
    );

    const getLiveContext = async (position, evaluatorName = null) => {
      if (!getCandlesFn) return null;

      const strategyName = evaluatorName || position?.strategy;
      if (!strategyName) return null;

      const executionConfig = getStrategyExecutionConfig(position.symbol, strategyName);
      if (!executionConfig) return null;

      const strategyInstance = await getCachedStrategyInstance(position.symbol, strategyName);
      const strategyParams = strategyInstance?.parameters || {};

      const primaryCandles = await fetchCachedCandles(position.symbol, executionConfig.timeframe);
      const closedCandles = this._getClosedCandles(primaryCandles);
      if (closedCandles.length < 20) return null;

      const indicatorCacheKey = buildIndicatorCacheKey(
        position.symbol,
        executionConfig.timeframe,
        strategyName,
        strategyParams
      );

      if (!indicatorCache.has(indicatorCacheKey)) {
        indicatorCache.set(
          indicatorCacheKey,
          indicatorService.calculateForStrategy(strategyName, closedCandles, strategyParams)
        );
      }

      const context = {
        candles: closedCandles,
        indicators: indicatorCache.get(indicatorCacheKey),
        strategyParams,
      };

      if (executionConfig.higherTimeframe) {
        const higherTfCandles = await fetchCachedCandles(position.symbol, executionConfig.higherTimeframe);
        const closedHigherTfCandles = this._getClosedCandles(higherTfCandles);
        if (closedHigherTfCandles.length > 0) {
          context.higherTfCandles = closedHigherTfCandles;
          if (strategyName === STRATEGY_TYPES.MULTI_TIMEFRAME) {
            context.higherTfTrend = this._buildHigherTfTrendSnapshot(
              higherTfCandles,
              strategyParams,
              executionConfig.higherTimeframe
            );
          }
        }
      }

      if (executionConfig.entryTimeframe) {
        const entryCandles = await fetchCachedCandles(position.symbol, executionConfig.entryTimeframe);
        const closedEntryCandles = this._getClosedCandles(entryCandles);
        if (closedEntryCandles.length > 0) {
          const entryIndicatorCacheKey = buildIndicatorCacheKey(
            position.symbol,
            executionConfig.entryTimeframe,
            strategyName,
            strategyParams
          );
          if (!indicatorCache.has(entryIndicatorCacheKey)) {
            indicatorCache.set(
              entryIndicatorCacheKey,
              indicatorService.calculateForStrategy(strategyName, closedEntryCandles, strategyParams)
            );
          }
          context.entryCandles = closedEntryCandles;
          context.entryIndicators = indicatorCache.get(entryIndicatorCacheKey);
        }
      }

      return context;
    };

    return {
      getStrategy,
      getLiveContext,
      closePositionFn,
      partialCloseFn,
      updatePositionFn,
    };
  }

  /**
   * Process all open positions.
   * @param {Array} positions
   * @param {Function} getPriceFn - async (symbol) => { bid, ask }
   * @param {Function} modifyFn   - async (positionId, newSl, newTp) => result
   * @param {object}   hooks      - Optional:
   *   - getStrategy(name): returns a strategy instance for evaluateExit
   *   - getLiveContext(position, evaluatorName): returns { indicators, candles }
   *     for the position's symbol (used by evaluateExit)
   *   - closePositionFn(position, reason): async close (used by timeExit)
   *   - partialCloseFn(position, volume): async partial close (used by partials)
   *   - updatePositionFn(localId, patch): persists updates (maxFavourablePrice,
   *     partialsExecutedIndices, exitPlanOverride)
   */
  async processPositions(positions, getPriceFn, modifyFn, hooks = {}, runtime = {}) {
    const updates = [];
    const {
      getStrategy = null,
      getLiveContext = null,
      closePositionFn = null,
      partialCloseFn = null,
      updatePositionFn = null,
    } = hooks;
    const {
      scanMode = 'heavy',
      cycleState = null,
      scanMetadataByPosition = new Map(),
    } = runtime;
    const fingerprintStore = cycleState?.fingerprints instanceof Set
      ? cycleState.fingerprints
      : new Set();

    for (const position of positions) {
      try {
        const workingPosition = {
          ...position,
          managementEvents: Array.isArray(position.managementEvents) ? [...position.managementEvents] : [],
        };
        const positionKey = String(position._id || position.mt5PositionId || position.symbol);
        const scanMetadata = scanMetadataByPosition.get(positionKey)
          || scanMetadataByPosition.get(String(position.mt5PositionId || ''))
          || {};
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
          ...workingPosition,
          maxFavourablePrice: favourablePrice,
        };

        // ── 2. Resolve base plan (snapshot) and apply adaptive override ──
        const basePlan = breakevenService.getPositionExitPlan(positionWithMaxFav);

        let adaptivePlan = basePlan;
        const evaluatorName = basePlan.adaptiveEvaluator || position.strategy;
        if (scanMode === 'heavy' && evaluatorName && getStrategy && getLiveContext) {
          try {
            const strategy = getStrategy(evaluatorName);
            if (strategy && typeof strategy.evaluateExit === 'function') {
              const context = await getLiveContext(positionWithMaxFav, evaluatorName);
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
          const timeExitFingerprint = buildFingerprint(position, instrument, {
            actionType: 'TIME_EXIT',
            closeReason: timeExit.reason,
            targetLimit: currentPrice,
          });
          if (fingerprintStore.has(timeExitFingerprint)) {
            continue;
          }
          fingerprintStore.add(timeExitFingerprint);
          if (closePositionFn) {
            const action = createManagerAction('TIME_EXIT', {
              reason: timeExit.reason,
              elapsedMinutes: timeExit.elapsedMinutes,
              currentPrice,
            });
            try {
              if (updatePositionFn) {
                workingPosition.managementEvents = appendManagementEvent(workingPosition, action, {
                  status: 'PENDING',
                });
                workingPosition.pendingExitAction = action;
                workingPosition.managerActionId = action.id;
                await updatePositionFn(position._id || position.mt5PositionId, {
                  pendingExitAction: action,
                  managerActionId: action.id,
                  managementEvents: workingPosition.managementEvents,
                });
              }
              await closePositionFn(positionWithMaxFav, timeExit.reason);
              console.log(
                `[TrailingStop] ${position.symbol} ${position.type}: time exit (${timeExit.reason}, held ${Math.round(timeExit.elapsedMinutes)}m)`
              );
              updates.push({
                symbol: position.symbol,
                positionId: position.mt5PositionId,
                kind: 'TIME_EXIT',
                phase: 'time_exit',
                reason: timeExit.reason,
                message: `Time exit triggered: ${timeExit.reason}`,
                currentPrice,
                scanMode,
                scanReason: scanMetadata.scanReason || 'cadence',
                category: scanMetadata.category || null,
                categoryFallback: scanMetadata.categoryFallback === true,
              });
            } catch (closeErr) {
              console.warn(`[TrailingStop] time exit close failed: ${closeErr.message}`);
              if (updatePositionFn) {
                workingPosition.managementEvents = appendManagementEvent(workingPosition, action, {
                  status: 'FAILED',
                  error: closeErr.message,
                });
                workingPosition.pendingExitAction = null;
                await updatePositionFn(position._id || position.mt5PositionId, {
                  pendingExitAction: null,
                  managementEvents: workingPosition.managementEvents,
                });
              }
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
            const partialFingerprint = buildFingerprint(position, instrument, {
              actionType: 'PARTIAL_TP',
              closeFraction: trigger.closeFraction,
              closeReason: trigger.label || `partial_${trigger.index}`,
              targetLimit: currentPrice,
            });
            if (fingerprintStore.has(partialFingerprint)) {
              continue;
            }
            fingerprintStore.add(partialFingerprint);
            const action = createManagerAction('PARTIAL_TP', {
              label: trigger.label || `partial_${trigger.index}`,
              index: trigger.index,
              closeFraction: trigger.closeFraction,
              volume: closeLots,
              currentPrice,
            });
            try {
              if (updatePositionFn) {
                workingPosition.managementEvents = appendManagementEvent(workingPosition, action, {
                  status: 'PENDING',
                });
                await updatePositionFn(position._id || position.mt5PositionId, {
                  pendingExitAction: action,
                  managerActionId: action.id,
                  managementEvents: workingPosition.managementEvents,
                });
              }
              await partialCloseFn(positionWithMaxFav, closeLots, trigger);
              remainingLots -= closeLots;
              executed.push(trigger.index);
              workingPosition.managementEvents = appendManagementEvent(workingPosition, action, {
                status: 'EXECUTED',
                remainingLots,
              });
              updates.push({
                symbol: position.symbol,
                positionId: position.mt5PositionId,
                kind: 'PARTIAL_TP',
                phase: 'partial',
                label: trigger.label || `partial_${trigger.index}`,
                volume: closeLots,
                volumeClosed: closeLots,
                message: `Partial close ${trigger.label || trigger.index} executed (${closeLots})`,
                currentPrice,
                scanMode,
                scanReason: scanMetadata.scanReason || 'cadence',
                category: scanMetadata.category || null,
                categoryFallback: scanMetadata.categoryFallback === true,
              });
              console.log(
                `[TrailingStop] ${position.symbol} ${position.type}: partial ${trigger.label || trigger.index} closed ${closeLots}`
              );
            } catch (partialErr) {
              console.warn(`[TrailingStop] partial close failed: ${partialErr.message}`);
              if (updatePositionFn) {
                workingPosition.managementEvents = appendManagementEvent(workingPosition, action, {
                  status: 'FAILED',
                  error: partialErr.message,
                });
                await updatePositionFn(position._id || position.mt5PositionId, {
                  pendingExitAction: null,
                  managementEvents: workingPosition.managementEvents,
                });
              }
              break;
            }
          }

          if (updatePositionFn) {
            try {
              await updatePositionFn(position._id || position.mt5PositionId, {
                partialsExecutedIndices: executed,
                lotSize: remainingLots,
                pendingExitAction: null,
                managementEvents: workingPosition.managementEvents,
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
          const stopFingerprint = buildFingerprint(position, instrument, {
            actionType: result.phase === 'breakeven' ? 'BREAKEVEN' : 'TRAILING_STOP',
            targetStop: result.newSl,
            targetTp: position.currentTp,
            closeReason: result.phase,
          });
          if (fingerprintStore.has(stopFingerprint)) {
            continue;
          }
          fingerprintStore.add(stopFingerprint);
          const action = createManagerAction(result.phase === 'breakeven' ? 'BREAKEVEN' : 'TRAILING_STOP', {
            phase: result.phase,
            previousSl: position.currentSl,
            newSl: result.newSl,
            currentPrice,
          });
          if (updatePositionFn) {
            workingPosition.managementEvents = appendManagementEvent(workingPosition, action, {
              status: 'PENDING',
            });
            await updatePositionFn(position._id || position.mt5PositionId, {
              pendingExitAction: action,
              managerActionId: action.id,
              managementEvents: workingPosition.managementEvents,
            });
          }
          const modifyResult = await modifyFn(position.mt5PositionId, result.newSl, position.currentTp);
          const brokerRetcodeModify = modifyResult?.retcode ?? modifyResult?.retcodeExternal ?? null;
          workingPosition.managementEvents = appendManagementEvent(workingPosition, action, {
            status: 'APPLIED',
            brokerRetcodeModify,
          });
          workingPosition.currentSl = result.newSl;
          workingPosition.protectiveStopState = {
            phase: result.phase,
            sl: result.newSl,
            updatedAt: new Date().toISOString(),
          };
          if (updatePositionFn) {
            await updatePositionFn(position._id || position.mt5PositionId, {
              currentSl: result.newSl,
              pendingExitAction: null,
              managerActionId: action.id,
              managementEvents: workingPosition.managementEvents,
              protectiveStopState: workingPosition.protectiveStopState,
              brokerRetcodeModify,
            });
          }
          updates.push({
            symbol: position.symbol,
            positionId: position.mt5PositionId,
            oldSl: position.currentSl,
            newSl: result.newSl,
            phase: result.phase,
            kind: 'SL_UPDATE',
            currentPrice,
            managerActionId: action.id,
            brokerRetcodeModify,
            scanMode,
            scanReason: scanMetadata.scanReason || 'cadence',
            category: scanMetadata.category || null,
            categoryFallback: scanMetadata.categoryFallback === true,
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
