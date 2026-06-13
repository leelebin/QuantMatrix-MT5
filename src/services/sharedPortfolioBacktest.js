/**
 * Shared Portfolio Backtest
 *
 * Runs every (symbol, strategy) combination against ONE shared account:
 *   - one initial balance
 *   - one equity / drawdown curve
 *   - one open-position pool (with portfolio-level max concurrency)
 *   - one trade log
 *
 * Unlike the per-sleeve independent aggregator, all signals across every
 * combination are processed in chronological order. Position sizing is
 * computed from the CURRENT shared balance at the moment a signal fires,
 * so winners fuel size for later trades and losers shrink future risk.
 *
 * This is a real simulation, not a post-hoc aggregation of independent
 * runs. It reuses low-level helpers on BacktestEngine (indicator builds,
 * trailing stop, SL/TP checks, trade close math) to guarantee the same
 * per-trade P/L computation as the single-sleeve engine.
 */

const backtestEngine = require('./backtestEngine');
const breakevenService = require('./breakevenService');
const { getInstrument } = require('../config/instruments');
const { resolveStrategyParameters } = require('../config/strategyParameters');
const {
  getStrategyExecutionConfig,
  getForcedTimeframeExecutionConfig,
} = require('../config/strategyExecution');
const { getSymbolCustomLogic } = require('../symbolCustom/registry');
const symbolCustomRunner = require('./symbolCustomBacktestRunnerService');
const { resolveDirectionControlConfig } = require('./directionControlConfig');
const { buildDirectionControlSummary } = require('./directionControlSummary');
const instrumentValuation = require('../utils/instrumentValuation');
const backtestCostModel = require('../utils/backtestCostModel');

const WARMUP = 250;
const DEFAULT_MAX_CONCURRENT_POSITIONS = 10;
const MAX_EQUITY_POINTS = 2000;
const BREAKEVEN_EXIT_REASONS = new Set(['BREAKEVEN_SL_HIT', 'BREAKEVEN']);
const PROTECTIVE_EXIT_REASONS = new Set([
  'BREAKEVEN_SL_HIT',
  'TRAILING_SL_HIT',
  'PROTECTIVE_SL_HIT',
  'BREAKEVEN',
  'TRAILING_STOP',
]);

function toTimeMs(value) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function downsample(curve, cap = MAX_EQUITY_POINTS) {
  if (!Array.isArray(curve) || curve.length <= cap) return curve || [];
  const step = curve.length / cap;
  const result = [];
  for (let i = 0; i < cap; i++) {
    result.push(curve[Math.floor(i * step)]);
  }
  // always include the last point so the final equity is accurate
  if (result[result.length - 1] !== curve[curve.length - 1]) {
    result.push(curve[curve.length - 1]);
  }
  return result;
}

function round2(value) {
  return parseFloat(Number(value).toFixed(2));
}

function round4(value) {
  return parseFloat(Number(value).toFixed(4));
}

function classifyTradeOutcome(trade, basis = 'net') {
  if (typeof backtestEngine._classifyTradeOutcome === 'function') {
    return backtestEngine._classifyTradeOutcome(trade, basis);
  }
  const value = basis === 'net'
    ? Number(trade && trade.profitLoss)
    : Number(trade && trade.profitPips);
  if (value > 0) return 'win';
  if (value < 0) return 'loss';
  return 'neutral';
}

function isBreakevenExit(trade) {
  return Boolean(trade && BREAKEVEN_EXIT_REASONS.has(trade.exitReason));
}

function isProtectiveExitOrTriggered(trade) {
  return Boolean(trade && (
    trade.breakevenActivated
    || trade.trailingActivated
    || PROTECTIVE_EXIT_REASONS.has(trade.exitReason)
  ));
}

function isSymbolCustomCombo(combo = {}) {
  return combo.source === 'symbolCustom' || combo.type === 'symbolCustom';
}

function getComboKey(combo = {}) {
  return isSymbolCustomCombo(combo)
    ? `${combo.symbol}:${combo.symbolCustomId || combo.symbolCustomName || combo.strategy}`
    : `${combo.symbol}:${combo.strategy}`;
}

function getSymbolCustomLogicName(symbolCustom = {}, combo = {}) {
  return String(
    combo.logicName
      || symbolCustom.logicName
      || symbolCustom.registryLogicName
      || symbolCustom.symbolCustomName
      || combo.strategy
      || ''
  ).trim();
}

function getTradeProfitLoss(trade = {}) {
  if (trade.profitLoss != null) return Number(trade.profitLoss) || 0;
  if (trade.pnl != null) return Number(trade.pnl) || 0;
  return 0;
}

function normalizeSymbolCustomClosedTrade(trade = {}, combo = {}, comboIdx = null) {
  const profitLoss = getTradeProfitLoss(trade);
  const normalized = {
    ...trade,
    type: trade.type || trade.side,
    direction: trade.direction || trade.side,
    strategy: combo.strategy || trade.symbolCustomName || combo.symbolCustomName || 'SymbolCustom',
    symbol: combo.symbol || trade.symbol,
    symbolCustomId: combo.symbolCustomId || trade.symbolCustomId || null,
    symbolCustomName: combo.symbolCustomName || trade.symbolCustomName || combo.strategy || null,
    logicName: combo.logicName || trade.logicName || null,
    profitLoss,
    grossProfitLoss: trade.grossProfitLoss != null ? trade.grossProfitLoss : profitLoss,
    comboIndex: comboIdx,
  };

  if (normalized.exitReason && !normalized.reason) {
    normalized.reason = normalized.exitReason;
  }

  return normalized;
}

function markToMarketSymbolCustomPosition(position, latest) {
  if (!position || !latest) return 0;
  const close = symbolCustomRunner.toNumber(latest.close, null);
  if (!Number.isFinite(close)) return 0;
  const entryPrice = symbolCustomRunner.toNumber(position.entryPrice, close);
  const quantity = symbolCustomRunner.toNumber(position.quantity, 0);
  const direction = position.side === 'SELL' ? -1 : 1;
  return (close - entryPrice) * direction * quantity;
}

function buildComboState({
  combo,
  candles,
  higherTfCandles,
  lowerTfCandles,
  strategyInstance,
  storedStrategyParameters,
  breakevenConfig,
  forcedTimeframe,
  requestCostModel = null,
}) {
  const instrument = getInstrument(combo.symbol);
  if (!instrument) {
    throw new Error(`Unknown symbol: ${combo.symbol}`);
  }

  const executionConfig = forcedTimeframe
    ? getForcedTimeframeExecutionConfig(combo.symbol, combo.strategy, forcedTimeframe)
    : getStrategyExecutionConfig(combo.symbol, combo.strategy);

  const resolvedParams = strategyInstance?.parameters || resolveStrategyParameters({
    strategyType: combo.strategy,
    instrument,
    storedParameters: storedStrategyParameters || {},
    overrides: null,
  });

  const tradingInstrument = backtestEngine._buildTradingInstrument(
    instrument,
    resolvedParams,
    combo.strategy,
    forcedTimeframe ? executionConfig : null
  );
  const { costModel: resolvedCostModel, sources: costModelSources } = backtestCostModel.resolveCostModel({
    instrumentCostModel: instrument.costModel || null,
    strategyCostModel: resolvedParams && resolvedParams.costModel ? resolvedParams.costModel : null,
    requestCostModel,
  });

  const effectiveBreakeven = strategyInstance?.effectiveBreakeven
    || strategyInstance?.effectiveTradeManagement?.breakeven
    || (breakevenConfig
    ? breakevenService.normalizeBreakevenConfig(breakevenConfig, {
        partial: false,
        defaults: breakevenService.DEFAULT_BREAKEVEN_CONFIG,
        baseConfig: breakevenService.DEFAULT_BREAKEVEN_CONFIG,
      })
    : breakevenService.getDefaultBreakevenConfig());

  const strategy = backtestEngine._createStrategy(combo.strategy);
  const fullIndicators = backtestEngine._buildIndicators(candles, resolvedParams, combo.strategy);
  const preparedIndicators = backtestEngine._prepareIndicatorSeries(fullIndicators, candles.length);
  const fullVolumeFeatureSeries = backtestEngine._buildVolumeFeatureSeries(
    candles,
    resolvedParams,
    combo.strategy
  );
  const candleTimes = candles.map((candle) => toTimeMs(candle.time));
  const lowerTfTimes = lowerTfCandles ? lowerTfCandles.map((c) => toTimeMs(c.time)) : null;
  const needsEntryIndicators = backtestEngine._strategyNeedsEntryIndicators(combo.strategy);
  const fullLowerIndicators = lowerTfCandles && tradingInstrument.entryTimeframe && needsEntryIndicators
    ? backtestEngine._buildIndicators(lowerTfCandles, resolvedParams, combo.strategy)
    : null;
  const preparedLowerIndicators = fullLowerIndicators
    ? backtestEngine._prepareIndicatorSeries(fullLowerIndicators, lowerTfCandles.length)
    : null;
  const higherTfTimes = higherTfCandles ? higherTfCandles.map((c) => toTimeMs(c.time)) : null;
  const higherTrendSeries = backtestEngine._buildHigherTimeframeTrendSeries(
    higherTfCandles,
    resolvedParams
  );

  const valuation = instrumentValuation.getValuationContext(tradingInstrument);
  const costModelSpreadPips = Number.isFinite(resolvedCostModel.spreadPips) ? resolvedCostModel.spreadPips : null;
  const costModelSlippagePips = Number.isFinite(resolvedCostModel.slippagePips) ? resolvedCostModel.slippagePips : null;
  const effectiveSpreadPips = costModelSpreadPips !== null
    ? costModelSpreadPips
    : (valuation.spreadPips || 0);
  const effectiveSlippagePips = costModelSlippagePips !== null
    ? costModelSlippagePips
    : 0.5;
  const spread = effectiveSpreadPips * valuation.pipSize;
  const slippage = effectiveSlippagePips * valuation.pipSize;

  return {
    combo,
    strategyInstance: strategyInstance || null,
    instrument,
    executionConfig,
    resolvedParams,
    tradingInstrument,
    effectiveBreakeven,
    strategy,
    candles,
    candleTimes,
    higherTfCandles,
    higherTfTimes,
    higherTrendSeries,
    lowerTfCandles,
    lowerTfTimes,
    fullIndicators,
    preparedIndicators,
    fullVolumeFeatureSeries,
    fullLowerIndicators,
    preparedLowerIndicators,
    needsEntryIndicators,
    valuation,
    costModel: resolvedCostModel,
    costModelSources,
    directionControlConfig: resolveDirectionControlConfig({ strategyInstance }),
    spread,
    slippage,
    historyWindowState: backtestEngine._createRollingArrayWindowState(candles),
    indicatorWindowState: backtestEngine._createRollingIndicatorWindowState(preparedIndicators),
    lowerHistoryWindowState: lowerTfCandles && tradingInstrument.entryTimeframe
      ? backtestEngine._createRollingArrayWindowState(lowerTfCandles)
      : null,
    lowerIndicatorWindowState: preparedLowerIndicators
      ? backtestEngine._createRollingIndicatorWindowState(preparedLowerIndicators)
      : null,
    lowerCursor: -1,
    higherCursor: -1,
    openPosition: null,
    disabled: false,
  };
}

function buildSymbolCustomComboState({
  combo,
  candles,
  requestCostModel = null,
}) {
  const symbolCustom = combo.symbolCustom;
  if (!symbolCustom) {
    throw new Error(`SymbolCustom record not loaded: ${combo.symbolCustomId || combo.strategy || combo.symbol}`);
  }

  const logicName = getSymbolCustomLogicName(symbolCustom, combo);
  const logic = combo.logic || getSymbolCustomLogic(logicName);
  if (!logic) {
    throw new Error(`SymbolCustom logic is not registered: ${logicName || '(empty)'}`);
  }

  const normalizedCandles = symbolCustomRunner.normalizeCandles(candles || {});
  const entryCandles = normalizedCandles.entry;
  const parameters = {
    ...(symbolCustom.parameters || {}),
    ...(combo.parameters || {}),
  };
  const costModel = symbolCustomRunner.normalizeCostModel(requestCostModel || combo.costModel || {});

  return {
    kind: 'symbolCustom',
    combo: {
      ...combo,
      source: 'symbolCustom',
      strategy: combo.strategy || symbolCustom.symbolCustomName,
      symbolCustomName: combo.symbolCustomName || symbolCustom.symbolCustomName,
      logicName,
    },
    symbolCustom,
    logic,
    logicName,
    parameters,
    costModel,
    riskPerTradePct: symbolCustomRunner.resolveRiskPerTradePct(symbolCustom, combo.options || {}),
    directionControlConfig: resolveDirectionControlConfig({
      symbolCustom,
      source: 'symbolCustom',
    }),
    normalizedCandles,
    candles: entryCandles,
    candleTimes: entryCandles.map((candle) => toTimeMs(symbolCustomRunner.getBarTime(candle))),
    setupHistoryCursor: symbolCustomRunner.createTimeHistoryCursor(normalizedCandles.setup),
    higherHistoryCursor: symbolCustomRunner.createTimeHistoryCursor(normalizedCandles.higher),
    entryHistory: [],
    staticContext: symbolCustomRunner.buildStaticContext({ symbolCustom, logicName, parameters }),
    tradeIndexes: {
      byExitDate: new Map(),
      byEntryDate: new Map(),
    },
    closedTrades: [],
    rawSignals: 0,
    openedSignals: 0,
    rejectedSignalDetails: [],
    openPosition: null,
    disabled: false,
    startBarIndex: 0,
  };
}

function markToMarketEquity(state) {
  let eq = state.balance;
  state.openPositionComboIdx.forEach((idx) => {
    const s = state.combos[idx];
    const pos = s.openPosition;
    const latest = state.latestCandleBySymbol[s.combo.symbol];
    if (!pos || !latest) return;
    if (s.kind === 'symbolCustom') {
      eq += markToMarketSymbolCustomPosition(pos, latest);
      return;
    }
    eq += instrumentValuation.calculateGrossProfitLoss({
      type: pos.type,
      entryPrice: pos.entryPrice,
      exitPrice: latest.close,
      lotSize: pos.lotSize,
      instrument: s.tradingInstrument,
    });
  });
  return eq;
}

function isEquityBust(state, ruinThreshold) {
  return markToMarketEquity(state) <= ruinThreshold;
}

function recordEquityPoint(state, time, equity) {
  state.equityCurve.push({ time, equity: round2(equity), balance: round2(state.balance) });
  if (equity > state.peakEquity) state.peakEquity = equity;
  const dd = state.peakEquity > 0 ? (state.peakEquity - equity) / state.peakEquity : 0;
  if (dd > state.maxDrawdown) state.maxDrawdown = dd;
}

function closePositionForCombo(state, comboIdx, exitPrice, reason, exitTime) {
  const s = state.combos[comboIdx];
  if (!s.openPosition) return null;
  if (s.kind === 'symbolCustom') {
    const currentIndex = Number.isFinite(Number(s.openPosition.currentIndex))
      ? Number(s.openPosition.currentIndex)
      : Math.max(0, s.candles.length - 1);
    const currentBar = {
      ...(state.latestCandleBySymbol[s.combo.symbol] || s.candles[currentIndex] || {}),
      time: exitTime,
      close: exitPrice,
    };
    symbolCustomRunner.updateSymbolCustomDirectionControlPostTrigger(s.openPosition, currentBar);
    const rawTrade = symbolCustomRunner.closeTrade(
      s.openPosition,
      currentBar,
      currentIndex,
      exitPrice,
      reason,
      s.costModel
    );
    const trade = normalizeSymbolCustomClosedTrade(rawTrade, s.combo, comboIdx);
    state.balance += trade.profitLoss;
    state.trades.push(trade);
    s.closedTrades.push(rawTrade);
    symbolCustomRunner.indexClosedTrade(rawTrade, s.tradeIndexes);
    state.openPositionComboIdx.delete(comboIdx);
    s.openPosition = null;
    if (state.balance > state.peakBalance) state.peakBalance = state.balance;
    return trade;
  }

  if (typeof backtestEngine._updateDirectionControlPostTriggerExcursion === 'function') {
    backtestEngine._updateDirectionControlPostTriggerExcursion(
      s.openPosition,
      state.latestCandleBySymbol[s.combo.symbol] || { time: exitTime, high: exitPrice, low: exitPrice, close: exitPrice }
    );
  }
  const trade = backtestEngine._closeTrade(
    s.openPosition,
    exitPrice,
    reason,
    exitTime,
    s.tradingInstrument
  );
  trade.symbol = s.combo.symbol;
  trade.strategy = s.combo.strategy;
  trade.comboIndex = comboIdx;
  state.balance += trade.profitLoss;
  state.trades.push(trade);
  state.openPositionComboIdx.delete(comboIdx);
  s.openPosition = null;
  if (state.balance > state.peakBalance) state.peakBalance = state.balance;
  return trade;
}

function triggerBustAndHalt(state, ruinThreshold, currentCandleTime, eventIndex, totalEvents) {
  const equityAtBust = round2(markToMarketEquity(state));
  let forcedCloseCount = 0;

  Array.from(state.openPositionComboIdx).forEach((comboIdx) => {
    const s = state.combos[comboIdx];
    const latest = state.latestCandleBySymbol[s.combo.symbol];
    if (!s.openPosition || !latest) return;

    const exitPrice = s.kind === 'symbolCustom'
      ? latest.close
      : (s.openPosition.type === 'BUY'
        ? latest.close - s.spread / 2
        : latest.close + s.spread / 2);
    const trade = closePositionForCombo(state, comboIdx, exitPrice, 'BUST', currentCandleTime);
    if (trade) forcedCloseCount += 1;
  });

  state.bust = {
    triggered: true,
    time: currentCandleTime,
    balance: round2(state.balance),
    equityAtBust,
    forcedCloseCount,
    remainingEventsSkipped: Math.max(0, totalEvents - (eventIndex + 1)),
    reason: 'RUIN_EQUITY',
  };

  recordEquityPoint(state, currentCandleTime, state.balance);
}

async function processSymbolCustomEvent(state, comboIdx, barIdx) {
  const s = state.combos[comboIdx];
  if (s.disabled) return;
  const currentBar = s.candles[barIdx];
  if (!currentBar) return;

  const currentTime = symbolCustomRunner.getBarTime(currentBar);
  state.latestCandleBySymbol[s.combo.symbol] = currentBar;
  s.entryHistory.push(currentBar);
  const setupHistory = symbolCustomRunner.advanceTimeHistoryCursor(s.setupHistoryCursor, currentBar);
  const higherHistory = symbolCustomRunner.advanceTimeHistoryCursor(s.higherHistoryCursor, currentBar);

  if (s.openPosition) {
    s.openPosition.currentIndex = barIdx;
    const barrierExit = symbolCustomRunner.detectStopTakeProfitExit(s.openPosition, currentBar);
    if (barrierExit) {
      symbolCustomRunner.updateSymbolCustomDirectionControlPostTrigger(s.openPosition, currentBar);
      closePositionForCombo(state, comboIdx, barrierExit.exitPrice, barrierExit.exitReason, currentTime);
      recordEquityPoint(state, currentTime, markToMarketEquity(state));
      return;
    }
  }

  const context = symbolCustomRunner.buildContext({
    symbolCustom: s.symbolCustom,
    logicName: s.logicName,
    parameters: s.parameters,
    candles: s.normalizedCandles,
    currentBar,
    currentIndex: barIdx,
    openPosition: s.openPosition,
    balance: state.balance,
    closedTrades: s.closedTrades,
    candleHistories: {
      setup: setupHistory,
      entry: s.entryHistory,
      higher: higherHistory,
    },
    staticContext: s.staticContext,
    tradeIndexes: s.tradeIndexes,
  });

  let result = null;
  try {
    result = await s.logic.analyze(context) || {};
  } catch (err) {
    s.disabled = true;
    state.errors.push({
      symbol: s.combo.symbol,
      strategy: s.combo.strategy,
      symbolCustomId: s.combo.symbolCustomId || null,
      message: err.message,
    });
    recordEquityPoint(state, currentTime, markToMarketEquity(state));
    return;
  }

  const signal = result.signal || 'NONE';
  if (s.openPosition) {
    symbolCustomRunner.evaluateSymbolCustomDirectionControlAudit({
      position: s.openPosition,
      config: s.directionControlConfig,
      candles: s.candles,
      currentBar,
      currentIndex: barIdx,
      symbolCustom: s.symbolCustom,
      logicName: s.logicName,
      result,
    });
  }

  if (s.openPosition && signal === 'CLOSE') {
    const exitPrice = symbolCustomRunner.toNumber(currentBar.close, s.openPosition.entryPrice);
    const exitReason = result.exitReason
      || result.metadata?.exitRule
      || result.reasonCode
      || 'CUSTOM_CLOSE';
    closePositionForCombo(state, comboIdx, exitPrice, exitReason, currentTime);
  } else if (!s.openPosition && (signal === 'BUY' || signal === 'SELL')) {
    s.rawSignals += 1;
    if (state.openPositionComboIdx.size >= state.maxConcurrentPositions) {
      state.rejectedSignals.noCapacity += 1;
    } else {
      const executionGate = symbolCustomRunner.evaluateBacktestExecutionGate({
        symbolCustom: s.symbolCustom,
        logicName: s.logicName,
        result,
        currentBar,
        currentIndex: barIdx,
        parameters: s.parameters,
        options: s.combo.options || {},
        closedTrades: s.closedTrades,
      });

      if (!executionGate.allowed) {
        s.rejectedSignalDetails.push(executionGate.detail);
      } else {
        const nextPosition = symbolCustomRunner.openTrade({
          symbolCustom: s.symbolCustom,
          logicName: s.logicName,
          result,
          currentBar,
          currentIndex: barIdx,
          balance: state.balance,
          riskPerTradePct: s.riskPerTradePct,
          costModel: s.costModel,
          executionGate,
        });

        if (nextPosition) {
          nextPosition.currentIndex = barIdx;
          s.openPosition = nextPosition;
          state.openPositionComboIdx.add(comboIdx);
          s.openedSignals += 1;
        } else {
          state.rejectedSignals.zeroSize += 1;
          s.rejectedSignalDetails.push(symbolCustomRunner.buildRejectedSignalDetail({
            symbolCustom: s.symbolCustom,
            logicName: s.logicName,
            result,
            currentBar,
            currentIndex: barIdx,
            reasonCode: symbolCustomRunner.SYMBOL_CUSTOM_BACKTEST_PROTECTIVE_LEVELS_REQUIRED,
            reasonText: 'BUY/SELL signal rejected because SL/TP protective levels were missing or invalid',
            executionScore: executionGate.executionScore,
            executionPolicy: executionGate.executionPolicy,
          }));
        }
      }
    }
  }

  recordEquityPoint(state, currentTime, markToMarketEquity(state));
}

async function processEvent(state, comboIdx, barIdx) {
  const s = state.combos[comboIdx];
  if (s.kind === 'symbolCustom') {
    await processSymbolCustomEvent(state, comboIdx, barIdx);
    return;
  }
  if (s.disabled) return;
  const currentCandle = s.candles[barIdx];
  const currentTimeMs = s.candleTimes[barIdx];
  const nextCandle = s.candles[barIdx + 1] || null;

  state.latestCandleBySymbol[s.combo.symbol] = currentCandle;

  if (s.lowerTfCandles && s.tradingInstrument.entryTimeframe) {
    while (
      s.lowerCursor + 1 < s.lowerTfTimes.length
      && s.lowerTfTimes[s.lowerCursor + 1] <= currentTimeMs
    ) {
      s.lowerCursor += 1;
    }
  }

  if (s.higherTfCandles && s.strategy.setHigherTimeframeTrend) {
    while (
      s.higherCursor + 1 < s.higherTfTimes.length
      && s.higherTfTimes[s.higherCursor + 1] <= currentTimeMs
    ) {
      s.higherCursor += 1;
    }
    backtestEngine._applyHigherTimeframeTrend(
      s.strategy,
      s.higherTfCandles,
      s.higherTrendSeries,
      s.higherCursor
    );
  }

  if (s.openPosition) {
    const hit = backtestEngine._checkSlTp(s.openPosition, currentCandle);
    if (hit) {
      closePositionForCombo(state, comboIdx, hit.exitPrice, hit.reason, currentCandle.time);
      const mtm = markToMarketEquity(state);
      recordEquityPoint(state, currentCandle.time, mtm);
      return;
    }
    const trailing = backtestEngine._simulateTrailingStop(
      s.openPosition,
      currentCandle,
      s.tradingInstrument
    );
    if (trailing.updated) {
      s.openPosition.currentSl = trailing.newSl;
      backtestEngine._markBreakevenState(s.openPosition, trailing.phase);
    }
    if (typeof backtestEngine._evaluateBacktestDirectionControlAudit === 'function') {
      backtestEngine._evaluateBacktestDirectionControlAudit({
        position: s.openPosition,
        config: s.directionControlConfig,
        candles: s.candles,
        currentBar: currentCandle,
        currentIndex: barIdx,
        indicators: {},
        strategyType: s.combo.strategy,
        strategyInstance: s.strategyInstance,
        symbol: s.combo.symbol,
      });
    }
  }

  let pendingEntry = null;
  if (!s.openPosition && nextCandle) {
    const historicalCandles = backtestEngine._advanceRollingArrayWindowState(
      s.historyWindowState,
      barIdx
    );
    const ind = backtestEngine._advanceRollingIndicatorWindowState(
      s.indicatorWindowState,
      barIdx
    );

    let lowerHistoricalCandles = null;
    let lowerInd = null;
    if (s.lowerTfCandles && s.tradingInstrument.entryTimeframe && s.lowerCursor >= 0) {
      lowerHistoricalCandles = backtestEngine._advanceRollingArrayWindowState(
        s.lowerHistoryWindowState,
        s.lowerCursor
      );
      if (s.preparedLowerIndicators) {
        lowerInd = backtestEngine._advanceRollingIndicatorWindowState(
          s.lowerIndicatorWindowState,
          s.lowerCursor
        );
      }
      if (s.needsEntryIndicators && lowerHistoricalCandles.length > 1) {
        lowerInd = lowerInd || {};
      }
    }

    let result = null;
    try {
      result = s.strategy.analyze(historicalCandles, ind, s.tradingInstrument, {
        higherTfCandles: s.higherTfCandles,
        entryCandles: lowerHistoricalCandles,
        entryIndicators: s.needsEntryIndicators ? lowerInd : null,
        volumeFeatureSnapshot: s.fullVolumeFeatureSeries ? s.fullVolumeFeatureSeries[barIdx] : null,
        strategyParams: s.resolvedParams,
      });
    } catch (err) {
      s.disabled = true;
      state.errors.push({
        symbol: s.combo.symbol,
        strategy: s.combo.strategy,
        message: err.message,
      });
      return;
    }

    if (result && result.signal && result.signal !== 'NONE') {
      if (state.openPositionComboIdx.size >= state.maxConcurrentPositions) {
        state.rejectedSignals.noCapacity += 1;
      } else {
        const entryPrice = result.signal === 'BUY'
          ? nextCandle.open + s.spread / 2 + s.slippage
          : nextCandle.open - s.spread / 2 - s.slippage;
        const lotSize = instrumentValuation.calculateLotSize({
          entryPrice,
          slPrice: result.sl,
          balance: state.balance,
          riskPercent: s.tradingInstrument.riskParams.riskPercent,
          instrument: s.tradingInstrument,
        });
        const plannedRiskAmount = parseFloat(
          instrumentValuation.calculatePlannedRiskAmount({
            entryPrice,
            slPrice: result.sl,
            lotSize,
            instrument: s.tradingInstrument,
          }).toFixed(4)
        );

        if (!(lotSize > 0) || !Number.isFinite(lotSize) || state.balance <= 0) {
          state.rejectedSignals.zeroSize += 1;
        } else {
          const currentAtr = ind.atr && ind.atr.length > 0 ? ind.atr[ind.atr.length - 1] : 0;
          pendingEntry = {
            id: state.trades.length + state.openPositionComboIdx.size + 1,
            symbol: s.combo.symbol,
            strategy: s.combo.strategy,
            strategyInstanceId: s.strategyInstance?._id || null,
            type: result.signal,
            side: result.signal,
            entryPrice,
            entryTime: nextCandle.time,
            entryIndex: barIdx + 1,
            sl: result.sl,
            tp: result.tp,
            currentSl: result.sl,
            breakevenActivated: false,
            trailingActivated: false,
            breakevenPhase: null,
            lotSize,
            plannedRiskAmount,
            atrAtEntry: currentAtr,
            breakevenConfig: s.effectiveBreakeven,
            costModel: s.costModel,
            costModelSources: s.costModelSources,
            indicatorsSnapshot: result.indicatorsSnapshot,
            entryThesisLevels: typeof backtestEngine._resolveBacktestEntryThesisLevels === 'function'
              ? backtestEngine._resolveBacktestEntryThesisLevels(result)
              : {},
            reason: result.reason,
            entryReason: result.entryReason || [result.reason, result.triggerReason].filter(Boolean).join(' | ') || result.reason,
            setupReason: result.setupReason || result.reason || '',
            triggerReason: result.triggerReason || '',
            setupTimeframe: result.setupTimeframe || s.executionConfig.timeframe,
            entryTimeframe: result.entryTimeframe || null,
            setupCandleTime: result.setupCandleTime || currentCandle.time,
            entryCandleTime: result.entryCandleTime || result.setupCandleTime || currentCandle.time,
            managementEvents: [],
            directionControlEvents: [],
            directionControl: null,
          };
        }
      }
    }
  }

  const mtm = markToMarketEquity(state);
  recordEquityPoint(state, currentCandle.time, mtm);

  if (!s.openPosition && pendingEntry) {
    s.openPosition = pendingEntry;
    state.openPositionComboIdx.add(comboIdx);
  }
}

function buildContributions(trades) {
  const byStrategy = new Map();
  const bySymbol = new Map();

  trades.forEach((trade) => {
    const strategyKey = trade.strategy || 'unknown';
    const symbolKey = trade.symbol || 'unknown';
    if (!byStrategy.has(strategyKey)) {
      byStrategy.set(strategyKey, { strategy: strategyKey, trades: 0, wins: 0, losses: 0, neutrals: 0, breakevenExitTrades: 0, breakevenTriggeredTrades: 0, netMoney: 0, grossProfit: 0, grossLoss: 0 });
    }
    if (!bySymbol.has(symbolKey)) {
      bySymbol.set(symbolKey, { symbol: symbolKey, trades: 0, wins: 0, losses: 0, neutrals: 0, breakevenExitTrades: 0, breakevenTriggeredTrades: 0, netMoney: 0, grossProfit: 0, grossLoss: 0 });
    }
    const s = byStrategy.get(strategyKey);
    const y = bySymbol.get(symbolKey);
    s.trades += 1;
    y.trades += 1;
    s.netMoney += trade.profitLoss;
    y.netMoney += trade.profitLoss;
    if (isBreakevenExit(trade)) {
      s.breakevenExitTrades += 1; y.breakevenExitTrades += 1;
    }
    if (isProtectiveExitOrTriggered(trade)) {
      s.breakevenTriggeredTrades += 1; y.breakevenTriggeredTrades += 1;
    }
    const outcome = classifyTradeOutcome(trade, 'net');
    if (outcome === 'win') {
      s.wins += 1; y.wins += 1;
    } else if (outcome === 'loss') {
      s.losses += 1; y.losses += 1;
    } else {
      s.neutrals += 1; y.neutrals += 1;
    }
    if (trade.profitLoss > 0) {
      s.grossProfit += trade.profitLoss;
      y.grossProfit += trade.profitLoss;
    } else if (trade.profitLoss < 0) {
      s.grossLoss += Math.abs(trade.profitLoss);
      y.grossLoss += Math.abs(trade.profitLoss);
    }
  });

  const finalize = (entry) => ({
    ...entry,
    netMoney: round2(entry.netMoney),
    grossProfit: round2(entry.grossProfit),
    grossLoss: round2(entry.grossLoss),
    neutralTrades: entry.neutrals,
    neutralRate: entry.trades > 0 ? round4(entry.neutrals / entry.trades) : 0,
    winRate: (entry.wins + entry.losses) > 0 ? round4(entry.wins / (entry.wins + entry.losses)) : 0,
    lossRate: (entry.wins + entry.losses) > 0 ? round4(entry.losses / (entry.wins + entry.losses)) : 0,
    breakevenExitRate: entry.trades > 0 ? round4(entry.breakevenExitTrades / entry.trades) : 0,
    breakevenTriggerRate: entry.trades > 0 ? round4(entry.breakevenTriggeredTrades / entry.trades) : 0,
    profitFactor: entry.grossLoss > 0
      ? round2(entry.grossProfit / entry.grossLoss)
      : (entry.grossProfit > 0 ? 999 : 0),
  });

  return {
    perStrategy: Array.from(byStrategy.values()).map(finalize).sort((a, b) => b.netMoney - a.netMoney),
    perSymbol: Array.from(bySymbol.values()).map(finalize).sort((a, b) => b.netMoney - a.netMoney),
  };
}

function buildComboResultSummary(trades = [], initialBalance = 0) {
  const totalTrades = trades.length;
  const outcomes = trades.map((trade) => classifyTradeOutcome(trade, 'net'));
  const winningTrades = outcomes.filter((outcome) => outcome === 'win').length;
  const losingTrades = outcomes.filter((outcome) => outcome === 'loss').length;
  const neutralTrades = outcomes.filter((outcome) => outcome === 'neutral').length;
  const decisiveTrades = winningTrades + losingTrades;
  const netProfitMoney = trades.reduce((sum, trade) => sum + getTradeProfitLoss(trade), 0);
  const grossProfitMoney = trades.reduce((sum, trade) => {
    const value = getTradeProfitLoss(trade);
    return value > 0 ? sum + value : sum;
  }, 0);
  const grossLossMoney = trades.reduce((sum, trade) => {
    const value = getTradeProfitLoss(trade);
    return value < 0 ? sum + Math.abs(value) : sum;
  }, 0);

  return {
    totalTrades,
    winningTrades,
    losingTrades,
    neutralTrades,
    decisiveTrades,
    winRate: decisiveTrades > 0 ? round4(winningTrades / decisiveTrades) : 0,
    lossRate: decisiveTrades > 0 ? round4(losingTrades / decisiveTrades) : 0,
    neutralRate: totalTrades > 0 ? round4(neutralTrades / totalTrades) : 0,
    netProfitMoney: round2(netProfitMoney),
    returnPercent: initialBalance > 0 ? round2((netProfitMoney / initialBalance) * 100) : 0,
    grossProfitMoney: round2(grossProfitMoney),
    grossLossMoney: round2(grossLossMoney),
    profitFactor: grossLossMoney > 0 ? round2(grossProfitMoney / grossLossMoney) : (grossProfitMoney > 0 ? 999 : 0),
    netProfitFactor: grossLossMoney > 0 ? round2(grossProfitMoney / grossLossMoney) : (grossProfitMoney > 0 ? 999 : 0),
    maxDrawdownPercent: 0,
    totalTradingCosts: 0,
  };
}

function buildComboResults(state, readiedComboInfo = [], initialBalance = 0) {
  return readiedComboInfo.map((info, comboIndex) => {
    const trades = state.trades.filter((trade) => trade.comboIndex === comboIndex);
    return {
      ...info,
      status: trades.length > 0 ? 'completed' : 'no_trades',
      summary: buildComboResultSummary(trades, initialBalance),
      parameters: info.parameters || null,
      parameterSource: info.parameterSource || null,
      error: null,
      backtestId: null,
    };
  });
}

function buildSummary(state, initialBalance) {
  const trades = state.trades;
  const totalTrades = trades.length;
  const outcomes = trades.map((trade) => classifyTradeOutcome(trade, 'net'));
  const winners = trades.filter((_, index) => outcomes[index] === 'win');
  const losers = trades.filter((_, index) => outcomes[index] === 'loss');
  const neutrals = trades.filter((_, index) => outcomes[index] === 'neutral');
  const decisiveTrades = winners.length + losers.length;
  const moneyWinners = trades.filter((t) => t.profitLoss > 0);
  const moneyLosers = trades.filter((t) => t.profitLoss < 0);
  const grossProfit = moneyWinners.reduce((s, t) => s + t.profitLoss, 0);
  const grossLoss = moneyLosers.reduce((s, t) => s + Math.abs(t.profitLoss), 0);
  const netProfit = state.balance - initialBalance;
  const breakevenExitTrades = trades.filter(isBreakevenExit).length;
  const breakevenTriggeredTrades = trades.filter(isProtectiveExitOrTriggered).length;
  const costs = backtestCostModel.summarizeCosts(trades);
  const grossNet = trades.reduce((sum, trade) => {
    const gross = Number(trade.grossProfitLoss);
    if (Number.isFinite(gross)) return sum + gross;
    return sum + (Number(trade.profitLoss) || 0);
  }, 0);
  const decisiveNetWinners = trades.filter((trade, index) => outcomes[index] === 'win' && trade.profitLoss > 0);
  const decisiveNetLosers = trades.filter((trade, index) => outcomes[index] === 'loss' && trade.profitLoss < 0);
  const decisiveNetProfit = decisiveNetWinners.reduce((sum, trade) => sum + trade.profitLoss, 0);
  const decisiveNetLoss = decisiveNetLosers.reduce((sum, trade) => sum + Math.abs(trade.profitLoss), 0);
  const avgWin = decisiveNetWinners.length > 0 ? decisiveNetProfit / decisiveNetWinners.length : 0;
  const avgLoss = decisiveNetLosers.length > 0 ? decisiveNetLoss / decisiveNetLosers.length : 0;
  let requiredBreakevenWinRate = 0;
  if (avgWin > 0 && avgLoss > 0) {
    requiredBreakevenWinRate = avgLoss / (avgWin + avgLoss);
  } else if (avgWin <= 0 && avgLoss > 0) {
    requiredBreakevenWinRate = 1;
  }

  let maxConsWins = 0;
  let maxConsLosses = 0;
  let consWins = 0;
  let consLosses = 0;
  for (const trade of trades) {
    const outcome = classifyTradeOutcome(trade, 'net');
    if (outcome === 'win') {
      consWins += 1; consLosses = 0;
    } else if (outcome === 'loss') {
      consLosses += 1; consWins = 0;
    } else {
      consWins = 0; consLosses = 0;
    }
    if (consWins > maxConsWins) maxConsWins = consWins;
    if (consLosses > maxConsLosses) maxConsLosses = consLosses;
  }

  return {
    initialBalance: round2(initialBalance),
    finalBalance: round2(state.balance),
    netProfitMoney: round2(netProfit),
    returnPercent: initialBalance > 0 ? round2((netProfit / initialBalance) * 100) : 0,
    totalTrades,
    winningTrades: winners.length,
    losingTrades: losers.length,
    neutralTrades: neutrals.length,
    decisiveTrades,
    winRate: decisiveTrades > 0 ? round4(winners.length / decisiveTrades) : 0,
    lossRate: decisiveTrades > 0 ? round4(losers.length / decisiveTrades) : 0,
    neutralRate: totalTrades > 0 ? round4(neutrals.length / totalTrades) : 0,
    grossProfitMoney: round2(grossProfit),
    grossLossMoney: round2(grossLoss),
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : (grossProfit > 0 ? 999 : 0),
    breakevenExitTrades,
    breakevenExitRate: totalTrades > 0 ? round4(breakevenExitTrades / totalTrades) : 0,
    breakevenTriggeredTrades,
    breakevenTriggerRate: totalTrades > 0 ? round4(breakevenTriggeredTrades / totalTrades) : 0,
    requiredBreakevenWinRate: round4(requiredBreakevenWinRate),
    averageTradeMoney: totalTrades > 0 ? round2(netProfit / totalTrades) : 0,
    netWinningTrades: winners.length,
    netLosingTrades: losers.length,
    netNeutralTrades: neutrals.length,
    netDecisiveTrades: decisiveTrades,
    netWinRate: decisiveTrades > 0 ? round4(winners.length / decisiveTrades) : 0,
    netProfitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : (grossProfit > 0 ? 999 : 0),
    netGrossProfitMoney: round2(grossProfit),
    netGrossLossMoney: round2(grossLoss),
    averageNetTradeMoney: totalTrades > 0 ? round2(netProfit / totalTrades) : 0,
    totalCommission: round2(costs.totalCommission),
    totalSwap: round2(costs.totalSwap),
    totalFees: round2(costs.totalFees),
    totalTradingCosts: round2(costs.totalTradingCosts),
    grossNetDifference: round2(grossNet - netProfit),
    maxDrawdownPercent: round2(state.maxDrawdown * 100),
    maxConsecutiveWins: maxConsWins,
    maxConsecutiveLosses: maxConsLosses,
    peakBalance: round2(state.peakBalance),
    peakEquity: round2(state.peakEquity),
    directionControl: buildDirectionControlSummary(trades),
  };
}

async function runSharedPortfolioBacktest({
  combinations,
  initialBalance,
  ruinThreshold = 0,
  start,
  endExclusive,
  fetchCandles,
  fetchSymbolCustomCandles = null,
  strategyInstancesByCombination,
  forcedTimeframe = null,
  maxConcurrentPositions = null,
  onProgress = null,
  costModel: requestCostModel = null,
}) {
  if (!Array.isArray(combinations) || combinations.length === 0) {
    throw new Error('No combinations provided for shared portfolio backtest.');
  }
  if (typeof fetchCandles !== 'function') {
    throw new Error('fetchCandles function is required.');
  }

  const safeInitialBalance = Number(initialBalance) || 10000;
  const safeRuinThreshold = Math.max(0, Number(ruinThreshold) || 0);
  const tradeStartMs = start ? toTimeMs(start) : null;

  const state = {
    balance: safeInitialBalance,
    peakBalance: safeInitialBalance,
    peakEquity: safeInitialBalance,
    maxDrawdown: 0,
    trades: [],
    equityCurve: [{
      time: start ? new Date(start).toISOString() : '',
      equity: safeInitialBalance,
      balance: safeInitialBalance,
    }],
    openPositionComboIdx: new Set(),
    latestCandleBySymbol: {},
    rejectedSignals: { noCapacity: 0, zeroSize: 0 },
    errors: [],
    combos: [],
    bust: {
      triggered: false,
      time: null,
      balance: null,
      equityAtBust: null,
      forcedCloseCount: 0,
      remainingEventsSkipped: 0,
      reason: null,
    },
    maxConcurrentPositions: Number(maxConcurrentPositions)
      || Math.min(combinations.length, DEFAULT_MAX_CONCURRENT_POSITIONS),
  };

  const skipped = [];
  const prepared = [];
  const readiedCombos = [];
  const readiedComboInfo = [];

  for (let idx = 0; idx < combinations.length; idx++) {
    const combo = combinations[idx];
    if (isSymbolCustomCombo(combo)) {
      try {
        if (typeof fetchSymbolCustomCandles !== 'function') {
          throw new Error('fetchSymbolCustomCandles function is required for SymbolCustom portfolio combinations.');
        }
        const customCandles = await fetchSymbolCustomCandles(combo.symbolCustom || combo);
        const entryCandles = customCandles && Array.isArray(customCandles.entry)
          ? customCandles.entry
          : [];
        if (entryCandles.length < 2) {
          skipped.push({
            source: 'symbolCustom',
            symbol: combo.symbol,
            strategy: combo.strategy,
            symbolCustomId: combo.symbolCustomId || null,
            symbolCustomName: combo.symbolCustomName || combo.strategy,
            logicName: combo.logicName || null,
            status: 'insufficient_data',
            timeframe: combo.symbolCustom?.timeframes?.entryTimeframe || null,
            reason: `Insufficient historical data: ${entryCandles.length} entry candles in range`,
          });
          continue;
        }

        const comboState = buildSymbolCustomComboState({
          combo,
          candles: customCandles,
          requestCostModel,
        });
        prepared.push({ comboState, primaryCandles: comboState.candles });
        state.combos.push(comboState);
        readiedCombos.push(comboState.combo);
        readiedComboInfo.push({
          source: 'symbolCustom',
          symbol: comboState.combo.symbol,
          strategy: comboState.combo.strategy,
          symbolCustomId: comboState.combo.symbolCustomId || comboState.symbolCustom._id || null,
          symbolCustomName: comboState.combo.symbolCustomName || comboState.symbolCustom.symbolCustomName,
          logicName: comboState.logicName,
          timeframe: comboState.symbolCustom.timeframes?.entryTimeframe || null,
          setupTimeframe: comboState.symbolCustom.timeframes?.setupTimeframe || null,
          higherTimeframe: comboState.symbolCustom.timeframes?.higherTimeframe || null,
          entryTimeframe: comboState.symbolCustom.timeframes?.entryTimeframe || null,
          costModelUsed: comboState.costModel,
          parameters: comboState.parameters,
        });

        if (typeof onProgress === 'function') {
          onProgress({
            phase: 'prepare',
            preparedCount: prepared.length,
            totalCombinations: combinations.length,
            currentSymbol: combo.symbol,
            currentStrategy: combo.strategy,
          });
        }
      } catch (err) {
        skipped.push({
          source: 'symbolCustom',
          symbol: combo.symbol,
          strategy: combo.strategy,
          symbolCustomId: combo.symbolCustomId || null,
          symbolCustomName: combo.symbolCustomName || combo.strategy,
          logicName: combo.logicName || null,
          status: 'error',
          reason: err.message,
        });
      }
      continue;
    }

    const baseExec = forcedTimeframe
      ? getForcedTimeframeExecutionConfig(combo.symbol, combo.strategy, forcedTimeframe)
      : getStrategyExecutionConfig(combo.symbol, combo.strategy);
    if (!baseExec) {
      skipped.push({
        symbol: combo.symbol,
        strategy: combo.strategy,
        status: 'error',
        reason: 'Unknown symbol',
      });
      continue;
    }

    try {
      const primary = await fetchCandles(combo.symbol, baseExec.timeframe);
      if (
        !primary
        || !primary.candles
        || primary.candles.length < WARMUP + 2
        || primary.inRangeCandles.length < 50
      ) {
        skipped.push({
          symbol: combo.symbol,
          strategy: combo.strategy,
          status: 'insufficient_data',
          timeframe: baseExec.timeframe,
          reason: `Insufficient historical data: ${primary?.inRangeCandles?.length || 0} candles in range`,
        });
        continue;
      }

      let higher = null;
      if (baseExec.higherTimeframe) {
        const w = await fetchCandles(combo.symbol, baseExec.higherTimeframe);
        higher = w ? w.candles : null;
      }
      let lower = null;
      if (baseExec.entryTimeframe) {
        const w = await fetchCandles(combo.symbol, baseExec.entryTimeframe);
        lower = w ? w.candles : null;
      }

      const comboState = buildComboState({
        combo,
        candles: primary.candles,
        higherTfCandles: higher,
        lowerTfCandles: lower,
        strategyInstance: strategyInstancesByCombination
          ? strategyInstancesByCombination.get(`${combo.symbol}:${combo.strategy}`)
          : null,
        storedStrategyParameters: null,
        breakevenConfig: null,
        forcedTimeframe,
        requestCostModel,
      });
      prepared.push({ comboState, primaryCandles: primary.candles });
      state.combos.push(comboState);
      readiedCombos.push(combo);
      readiedComboInfo.push({
        symbol: combo.symbol,
        strategy: combo.strategy,
        timeframe: comboState.executionConfig.timeframe,
        higherTimeframe: comboState.executionConfig.higherTimeframe || null,
        entryTimeframe: comboState.executionConfig.entryTimeframe || null,
        forcedTimeframe: forcedTimeframe || null,
        higherTimeframeDisabled: comboState.executionConfig.higherTimeframeDisabled || null,
        entryTimeframeDisabled: comboState.executionConfig.entryTimeframeDisabled || null,
        costModelUsed: {
          costModel: comboState.costModel,
          sources: comboState.costModelSources,
        },
      });

      if (typeof onProgress === 'function') {
        onProgress({
          phase: 'prepare',
          preparedCount: prepared.length,
          totalCombinations: combinations.length,
          currentSymbol: combo.symbol,
          currentStrategy: combo.strategy,
        });
      }
    } catch (err) {
      skipped.push({
        symbol: combo.symbol,
        strategy: combo.strategy,
        status: 'error',
        reason: err.message,
      });
    }
  }

  if (state.combos.length === 0) {
    throw new Error('No combinations had enough data for shared portfolio simulation.');
  }

  const events = [];
  for (let cIdx = 0; cIdx < state.combos.length; cIdx++) {
    const s = state.combos[cIdx];
    const startBarIndex = Number.isInteger(s.startBarIndex) ? s.startBarIndex : WARMUP;
    for (let bar = startBarIndex; bar < s.candles.length; bar++) {
      const timeMs = s.candleTimes[bar];
      if (tradeStartMs !== null && timeMs < tradeStartMs) continue;
      events.push({ timeMs, comboIdx: cIdx, barIdx: bar });
    }
  }

  events.sort((a, b) => {
    if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
    return a.comboIdx - b.comboIdx;
  });

  const progressEvery = Math.max(1, Math.floor(events.length / 25));
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    await processEvent(state, ev.comboIdx, ev.barIdx);
    if (isEquityBust(state, safeRuinThreshold)) {
      const currentCandleTime = state.combos[ev.comboIdx]?.candles?.[ev.barIdx]?.time || null;
      triggerBustAndHalt(state, safeRuinThreshold, currentCandleTime, i, events.length);
      if (typeof onProgress === 'function') {
        onProgress({
          phase: 'bust',
          processedEvents: i + 1,
          totalEvents: events.length,
          percent: Math.round(((i + 1) / events.length) * 100),
          balance: state.bust.balance,
          openPositions: 0,
          trades: state.trades.length,
          bust: state.bust,
        });
      }
      break;
    }
    if (typeof onProgress === 'function' && i % progressEvery === 0) {
      onProgress({
        phase: 'simulate',
        processedEvents: i + 1,
        totalEvents: events.length,
        percent: Math.round(((i + 1) / events.length) * 100),
        balance: round2(state.balance),
        openPositions: state.openPositionComboIdx.size,
        trades: state.trades.length,
      });
    }
  }

  if (!state.bust.triggered) {
    // Close any remaining open positions at their combo's last candle
    state.openPositionComboIdx.forEach((cIdx) => {
      const s = state.combos[cIdx];
      const lastCandle = s.candles[s.candles.length - 1];
      if (!lastCandle || !s.openPosition) return;
      const exitPrice = s.kind === 'symbolCustom'
        ? symbolCustomRunner.toNumber(lastCandle.close, s.openPosition.entryPrice)
        : (s.openPosition.type === 'BUY'
          ? lastCandle.close - s.spread / 2
          : lastCandle.close + s.spread / 2);
      closePositionForCombo(state, cIdx, exitPrice, 'END_OF_DATA', symbolCustomRunner.getBarTime(lastCandle));
    });
    if (state.openPositionComboIdx.size > 0) state.openPositionComboIdx.clear();
    recordEquityPoint(state, state.equityCurve[state.equityCurve.length - 1].time, state.balance);
  }

  const summary = buildSummary(state, safeInitialBalance);
  const contributions = buildContributions(state.trades);
  const comboResults = buildComboResults(state, readiedComboInfo, safeInitialBalance);

  return {
    runModel: 'shared_portfolio',
    initialBalance: safeInitialBalance,
    finalBalance: summary.finalBalance,
    summary,
    trades: state.trades,
    equityCurve: downsample(state.equityCurve, MAX_EQUITY_POINTS),
    equityCurvePoints: state.equityCurve.length,
    comboResults,
    perStrategyContribution: contributions.perStrategy,
    perSymbolContribution: contributions.perSymbol,
    rejectedSignals: state.rejectedSignals,
    bust: state.bust,
    skipped,
    errors: state.errors,
    combinationsUsed: readiedComboInfo,
    combinationsRequested: combinations.length,
    maxConcurrentPositions: state.maxConcurrentPositions,
    costModelUsed: requestCostModel || null,
  };
}

module.exports = {
  runSharedPortfolioBacktest,
};
