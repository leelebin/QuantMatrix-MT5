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

const WARMUP = 250;
const DEFAULT_MAX_CONCURRENT_POSITIONS = 10;
const MAX_EQUITY_POINTS = 2000;

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

function buildComboState({
  combo,
  candles,
  higherTfCandles,
  lowerTfCandles,
  storedStrategyParameters,
  breakevenConfig,
  forcedTimeframe,
}) {
  const instrument = getInstrument(combo.symbol);
  if (!instrument) {
    throw new Error(`Unknown symbol: ${combo.symbol}`);
  }

  const executionConfig = forcedTimeframe
    ? getForcedTimeframeExecutionConfig(combo.symbol, combo.strategy, forcedTimeframe)
    : getStrategyExecutionConfig(combo.symbol, combo.strategy);

  const resolvedParams = resolveStrategyParameters({
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

  const effectiveBreakeven = breakevenConfig
    ? breakevenService.normalizeBreakevenConfig(breakevenConfig, {
        partial: false,
        defaults: breakevenService.DEFAULT_BREAKEVEN_CONFIG,
        baseConfig: breakevenService.DEFAULT_BREAKEVEN_CONFIG,
      })
    : breakevenService.getDefaultBreakevenConfig();

  const strategy = backtestEngine._createStrategy(combo.strategy);
  const fullIndicators = backtestEngine._buildIndicators(candles, resolvedParams);
  const candleTimes = candles.map((candle) => toTimeMs(candle.time));
  const lowerTfTimes = lowerTfCandles ? lowerTfCandles.map((c) => toTimeMs(c.time)) : null;
  const fullLowerIndicators = lowerTfCandles && tradingInstrument.entryTimeframe
    ? backtestEngine._buildIndicators(lowerTfCandles, resolvedParams)
    : null;
  const higherTfTimes = higherTfCandles ? higherTfCandles.map((c) => toTimeMs(c.time)) : null;
  const higherTrendSeries = backtestEngine._buildHigherTimeframeTrendSeries(
    higherTfCandles,
    resolvedParams
  );

  const spread = (instrument.spread || 0) * instrument.pipSize;
  const slippage = 0.5 * instrument.pipSize;

  return {
    combo,
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
    fullLowerIndicators,
    spread,
    slippage,
    lowerCursor: -1,
    higherCursor: -1,
    openPosition: null,
    disabled: false,
  };
}

function markToMarketEquity(state) {
  let eq = state.balance;
  state.openPositionComboIdx.forEach((idx) => {
    const s = state.combos[idx];
    const pos = s.openPosition;
    const latest = state.latestCandleBySymbol[s.combo.symbol];
    if (!pos || !latest) return;
    const priceDiff = pos.type === 'BUY'
      ? latest.close - pos.entryPrice
      : pos.entryPrice - latest.close;
    eq += priceDiff * pos.lotSize * s.tradingInstrument.contractSize;
  });
  return eq;
}

function recordEquityPoint(state, time, equity) {
  state.equityCurve.push({ time, equity: round2(equity) });
  if (equity > state.peakEquity) state.peakEquity = equity;
  const dd = state.peakEquity > 0 ? (state.peakEquity - equity) / state.peakEquity : 0;
  if (dd > state.maxDrawdown) state.maxDrawdown = dd;
}

function closePositionForCombo(state, comboIdx, exitPrice, reason, exitTime) {
  const s = state.combos[comboIdx];
  if (!s.openPosition) return null;
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

function processEvent(state, comboIdx, barIdx) {
  const s = state.combos[comboIdx];
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
    }
  }

  let pendingEntry = null;
  if (!s.openPosition && nextCandle) {
    const historyStart = Math.max(0, barIdx - 250);
    const historyEnd = barIdx + 1;
    const historicalCandles = s.candles.slice(historyStart, historyEnd);
    const ind = backtestEngine._sliceIndicatorWindow(
      s.fullIndicators,
      s.candles.length,
      historyStart,
      historyEnd
    );

    let lowerHistoricalCandles = null;
    let lowerInd = null;
    if (s.lowerTfCandles && s.tradingInstrument.entryTimeframe && s.lowerCursor >= 0) {
      const lowerStart = Math.max(0, s.lowerCursor - 250);
      const lowerEnd = s.lowerCursor + 1;
      lowerHistoricalCandles = s.lowerTfCandles.slice(lowerStart, lowerEnd);
      lowerInd = backtestEngine._sliceIndicatorWindow(
        s.fullLowerIndicators,
        s.lowerTfCandles.length,
        lowerStart,
        lowerEnd
      );
    }

    let result = null;
    try {
      result = s.strategy.analyze(historicalCandles, ind, s.tradingInstrument, {
        higherTfCandles: s.higherTfCandles,
        entryCandles: lowerHistoricalCandles,
        entryIndicators: lowerInd,
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
        const slDistance = Math.abs(entryPrice - result.sl);
        const slPips = slDistance / s.tradingInstrument.pipSize;
        const riskAmount = state.balance * s.tradingInstrument.riskParams.riskPercent;
        let lotSize = slPips > 0 && s.tradingInstrument.pipValue > 0
          ? riskAmount / (slPips * s.tradingInstrument.pipValue)
          : 0;
        lotSize = Math.max(
          s.tradingInstrument.minLot,
          Math.floor(lotSize / s.tradingInstrument.lotStep) * s.tradingInstrument.lotStep
        );
        lotSize = Math.min(lotSize, 5.0);

        if (!(lotSize > 0) || !Number.isFinite(lotSize) || state.balance <= 0) {
          state.rejectedSignals.zeroSize += 1;
        } else {
          const currentAtr = ind.atr && ind.atr.length > 0 ? ind.atr[ind.atr.length - 1] : 0;
          pendingEntry = {
            id: state.trades.length + state.openPositionComboIdx.size + 1,
            type: result.signal,
            entryPrice,
            entryTime: nextCandle.time,
            sl: result.sl,
            tp: result.tp,
            currentSl: result.sl,
            lotSize,
            atrAtEntry: currentAtr,
            breakevenConfig: s.effectiveBreakeven,
            indicatorsSnapshot: result.indicatorsSnapshot,
            reason: result.reason,
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
      byStrategy.set(strategyKey, { strategy: strategyKey, trades: 0, wins: 0, losses: 0, netMoney: 0, grossProfit: 0, grossLoss: 0 });
    }
    if (!bySymbol.has(symbolKey)) {
      bySymbol.set(symbolKey, { symbol: symbolKey, trades: 0, wins: 0, losses: 0, netMoney: 0, grossProfit: 0, grossLoss: 0 });
    }
    const s = byStrategy.get(strategyKey);
    const y = bySymbol.get(symbolKey);
    s.trades += 1;
    y.trades += 1;
    s.netMoney += trade.profitLoss;
    y.netMoney += trade.profitLoss;
    if (trade.profitLoss > 0) {
      s.wins += 1; y.wins += 1;
      s.grossProfit += trade.profitLoss;
      y.grossProfit += trade.profitLoss;
    } else if (trade.profitLoss < 0) {
      s.losses += 1; y.losses += 1;
      s.grossLoss += Math.abs(trade.profitLoss);
      y.grossLoss += Math.abs(trade.profitLoss);
    }
  });

  const finalize = (entry) => ({
    ...entry,
    netMoney: round2(entry.netMoney),
    grossProfit: round2(entry.grossProfit),
    grossLoss: round2(entry.grossLoss),
    winRate: entry.trades > 0 ? round4(entry.wins / entry.trades) : 0,
    profitFactor: entry.grossLoss > 0
      ? round2(entry.grossProfit / entry.grossLoss)
      : (entry.grossProfit > 0 ? 999 : 0),
  });

  return {
    perStrategy: Array.from(byStrategy.values()).map(finalize).sort((a, b) => b.netMoney - a.netMoney),
    perSymbol: Array.from(bySymbol.values()).map(finalize).sort((a, b) => b.netMoney - a.netMoney),
  };
}

function buildSummary(state, initialBalance) {
  const trades = state.trades;
  const totalTrades = trades.length;
  const winners = trades.filter((t) => t.profitLoss > 0);
  const losers = trades.filter((t) => t.profitLoss < 0);
  const grossProfit = winners.reduce((s, t) => s + t.profitLoss, 0);
  const grossLoss = losers.reduce((s, t) => s + Math.abs(t.profitLoss), 0);
  const netProfit = state.balance - initialBalance;

  let maxConsWins = 0;
  let maxConsLosses = 0;
  let consWins = 0;
  let consLosses = 0;
  for (const trade of trades) {
    if (trade.profitLoss > 0) {
      consWins += 1; consLosses = 0;
    } else {
      consLosses += 1; consWins = 0;
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
    winRate: totalTrades > 0 ? round4(winners.length / totalTrades) : 0,
    lossRate: totalTrades > 0 ? round4(losers.length / totalTrades) : 0,
    grossProfitMoney: round2(grossProfit),
    grossLossMoney: round2(grossLoss),
    profitFactor: grossLoss > 0 ? round2(grossProfit / grossLoss) : (grossProfit > 0 ? 999 : 0),
    averageTradeMoney: totalTrades > 0 ? round2(netProfit / totalTrades) : 0,
    maxDrawdownPercent: round2(state.maxDrawdown * 100),
    maxConsecutiveWins: maxConsWins,
    maxConsecutiveLosses: maxConsLosses,
    peakBalance: round2(state.peakBalance),
    peakEquity: round2(state.peakEquity),
  };
}

async function runSharedPortfolioBacktest({
  combinations,
  initialBalance,
  start,
  endExclusive,
  fetchCandles,
  storedParametersByCombination,
  breakevenByStrategy,
  forcedTimeframe = null,
  maxConcurrentPositions = null,
  onProgress = null,
}) {
  if (!Array.isArray(combinations) || combinations.length === 0) {
    throw new Error('No combinations provided for shared portfolio backtest.');
  }
  if (typeof fetchCandles !== 'function') {
    throw new Error('fetchCandles function is required.');
  }

  const safeInitialBalance = Number(initialBalance) || 10000;
  const tradeStartMs = start ? toTimeMs(start) : null;

  const state = {
    balance: safeInitialBalance,
    peakBalance: safeInitialBalance,
    peakEquity: safeInitialBalance,
    maxDrawdown: 0,
    trades: [],
    equityCurve: [{ time: start ? new Date(start).toISOString() : '', equity: safeInitialBalance }],
    openPositionComboIdx: new Set(),
    latestCandleBySymbol: {},
    rejectedSignals: { noCapacity: 0, zeroSize: 0 },
    errors: [],
    combos: [],
    maxConcurrentPositions: Number(maxConcurrentPositions)
      || Math.min(combinations.length, DEFAULT_MAX_CONCURRENT_POSITIONS),
  };

  const skipped = [];
  const prepared = [];
  const readiedCombos = [];
  const readiedComboInfo = [];

  for (let idx = 0; idx < combinations.length; idx++) {
    const combo = combinations[idx];
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
        storedStrategyParameters: storedParametersByCombination
          ? storedParametersByCombination.get(`${combo.symbol}:${combo.strategy}`)
          : null,
        breakevenConfig: breakevenByStrategy
          ? breakevenByStrategy.get(combo.strategy)
          : null,
        forcedTimeframe,
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
    for (let bar = WARMUP; bar < s.candles.length; bar++) {
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
    processEvent(state, ev.comboIdx, ev.barIdx);
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

  // Close any remaining open positions at their combo's last candle
  state.openPositionComboIdx.forEach((cIdx) => {
    const s = state.combos[cIdx];
    const lastCandle = s.candles[s.candles.length - 1];
    if (!lastCandle || !s.openPosition) return;
    const exitPrice = s.openPosition.type === 'BUY'
      ? lastCandle.close - s.spread / 2
      : lastCandle.close + s.spread / 2;
    closePositionForCombo(state, cIdx, exitPrice, 'END_OF_DATA', lastCandle.time);
  });
  if (state.openPositionComboIdx.size > 0) state.openPositionComboIdx.clear();
  recordEquityPoint(state, state.equityCurve[state.equityCurve.length - 1].time, state.balance);

  const summary = buildSummary(state, safeInitialBalance);
  const contributions = buildContributions(state.trades);

  return {
    runModel: 'shared_portfolio',
    initialBalance: safeInitialBalance,
    finalBalance: summary.finalBalance,
    summary,
    trades: state.trades,
    equityCurve: downsample(state.equityCurve, MAX_EQUITY_POINTS),
    equityCurvePoints: state.equityCurve.length,
    perStrategyContribution: contributions.perStrategy,
    perSymbolContribution: contributions.perSymbol,
    rejectedSignals: state.rejectedSignals,
    skipped,
    errors: state.errors,
    combinationsUsed: readiedComboInfo,
    combinationsRequested: combinations.length,
    maxConcurrentPositions: state.maxConcurrentPositions,
  };
}

module.exports = {
  runSharedPortfolioBacktest,
};
