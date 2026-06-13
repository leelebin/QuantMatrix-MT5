const DEFAULT_INITIAL_BALANCE = 500;
const DEFAULT_RISK_PER_TRADE_PCT = 1;
const {
  DEFAULT_EXECUTION_POLICY,
  calculateExecutionScore,
  resolveExecutionPolicy,
} = require('./executionPolicyService');
const { resolveDirectionControlConfig } = require('./directionControlConfig');
const { evaluateDirectionControl } = require('./directionControlEvaluator');
const { buildDirectionControlSummary } = require('./directionControlSummary');
const { estimateBarDistance } = require('../utils/timeframe');

const EXECUTION_SCORE_TOO_LOW = 'EXECUTION_SCORE_TOO_LOW';
const SYMBOL_CUSTOM_BACKTEST_PROTECTIVE_LEVELS_REQUIRED = 'SYMBOL_CUSTOM_BACKTEST_PROTECTIVE_LEVELS_REQUIRED';
const ZERO_COST_BACKTEST_WARNING = 'ZERO_COST_BACKTEST';

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getBarTime(bar = {}) {
  return bar.time || bar.timestamp || bar.date || null;
}

function toEpoch(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toUtcDateKey(value) {
  const epoch = toEpoch(value);
  if (!epoch) return null;
  return new Date(epoch).toISOString().slice(0, 10);
}

function toUtcHour(value) {
  const epoch = toEpoch(value);
  if (!epoch) return null;
  return new Date(epoch).getUTCHours();
}

function getBarsUpTo(candles = [], currentBar = {}) {
  const currentEpoch = toEpoch(getBarTime(currentBar));
  if (!currentEpoch) return candles.slice();

  return candles.filter((bar) => {
    const barEpoch = toEpoch(getBarTime(bar));
    return !barEpoch || barEpoch <= currentEpoch;
  });
}

function createTimeHistoryCursor(candles = []) {
  return {
    candles: Array.isArray(candles) ? candles : [],
    nextIndex: 0,
    history: [],
  };
}

function advanceTimeHistoryCursor(cursor, currentBar = {}) {
  const currentEpoch = toEpoch(getBarTime(currentBar));
  if (!currentEpoch) return cursor.candles;

  while (cursor.nextIndex < cursor.candles.length) {
    const candle = cursor.candles[cursor.nextIndex];
    const candleEpoch = toEpoch(getBarTime(candle));
    if (candleEpoch && candleEpoch > currentEpoch) break;
    cursor.history.push(candle);
    cursor.nextIndex += 1;
  }

  return cursor.history;
}

function normalizeCandles(candles = {}) {
  const entry = Array.isArray(candles.entry) ? candles.entry : [];
  return {
    setup: Array.isArray(candles.setup) ? candles.setup : entry,
    entry,
    higher: Array.isArray(candles.higher) ? candles.higher : entry,
  };
}

function normalizeCostModel(costModel = {}) {
  return {
    spread: toNumber(costModel.spread, 0),
    commissionPerTrade: toNumber(costModel.commissionPerTrade, 0),
    slippage: toNumber(costModel.slippage, 0),
  };
}

function getZeroCostWarnings(costModel = {}) {
  const isZeroCost = toNumber(costModel.spread, 0) === 0
    && toNumber(costModel.commissionPerTrade, 0) === 0
    && toNumber(costModel.slippage, 0) === 0;

  return isZeroCost
    ? [{
      reasonCode: ZERO_COST_BACKTEST_WARNING,
      message: 'Backtest cost model uses zero spread, commission, and slippage.',
    }]
    : [];
}

function normalizeSignalStats(signalStats = {}) {
  if (typeof signalStats === 'number') {
    return {
      rawSignals: 0,
      openedSignals: 0,
      rejectedSignals: signalStats,
      rejectedSignalDetails: [],
      warnings: [],
    };
  }
  if (!signalStats || typeof signalStats !== 'object') {
    return normalizeSignalStats({});
  }

  const rejectedSignalDetails = Array.isArray(signalStats.rejectedSignalDetails)
    ? signalStats.rejectedSignalDetails
    : [];

  return {
    rawSignals: Math.max(0, Number(signalStats.rawSignals) || 0),
    openedSignals: Math.max(0, Number(signalStats.openedSignals) || 0),
    rejectedSignals: Math.max(0, Number(signalStats.rejectedSignals) || rejectedSignalDetails.length),
    rejectedSignalDetails,
    warnings: Array.isArray(signalStats.warnings) ? signalStats.warnings : [],
  };
}

function resolveBacktestExecutionPolicy({ symbolCustom = {}, result = {}, options = {} } = {}) {
  if (result.executionPolicy && typeof result.executionPolicy === 'object') {
    return resolveExecutionPolicy(null, result.executionPolicy);
  }

  if (options.executionPolicy && typeof options.executionPolicy === 'object') {
    return resolveExecutionPolicy(null, options.executionPolicy);
  }

  if (symbolCustom.executionPolicy && typeof symbolCustom.executionPolicy === 'object') {
    return resolveExecutionPolicy(null, symbolCustom.executionPolicy);
  }

  return resolveExecutionPolicy(null, DEFAULT_EXECUTION_POLICY);
}

function buildExecutionSignal({ symbolCustom, logicName, result, currentBar, parameters }) {
  const metadata = result.metadata && typeof result.metadata === 'object' ? result.metadata : {};

  return {
    source: 'symbolCustom',
    scope: 'backtest',
    symbol: symbolCustom.symbol,
    symbolCustomId: symbolCustom._id || null,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName,
    strategy: symbolCustom.symbolCustomName,
    strategyType: 'SymbolCustom',
    setupType: metadata.setupType || metadata.setup || 'symbol_custom',
    signal: result.signal,
    confidence: result.confidence ?? metadata.confidence,
    marketQualityScore: result.marketQualityScore ?? metadata.marketQualityScore,
    marketQualityThreshold: result.marketQualityThreshold ?? metadata.marketQualityThreshold,
    reason: result.reason || null,
    sl: result.sl ?? result.stopLoss ?? null,
    tp: result.tp ?? result.takeProfit ?? null,
    parameters: cloneValue(parameters || {}),
    timestamp: getBarTime(currentBar),
    metadata: cloneValue(metadata),
  };
}

function buildRejectedSignalDetail({
  symbolCustom,
  logicName,
  result = {},
  currentBar,
  currentIndex,
  reasonCode,
  reasonText,
  executionScore = null,
  executionPolicy = null,
  duplicateReference = null,
}) {
  return {
    symbol: symbolCustom.symbol,
    symbolCustomId: symbolCustom._id || null,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName,
    signal: result.signal || 'NONE',
    time: getBarTime(currentBar),
    index: currentIndex,
    reasonCode,
    reasonText,
    strategyReason: result.reason || null,
    executionScore: executionScore ? executionScore.score : null,
    minExecutionScore: executionScore ? executionScore.minExecutionScore : null,
    executionScoreDetails: executionScore ? cloneValue(executionScore.details) : null,
    executionPolicy: executionPolicy ? cloneValue(executionPolicy) : null,
    duplicateReference: duplicateReference ? cloneValue(duplicateReference) : null,
  };
}

function findBacktestDuplicateEntryReference({
  symbolCustom = {},
  result = {},
  currentBar = {},
  currentIndex = 0,
  closedTrades = [],
  executionPolicy = DEFAULT_EXECUTION_POLICY,
}) {
  const entryWindowBars = Number(executionPolicy.duplicateEntryWindowBars) || 0;
  if (entryWindowBars <= 0 || !Array.isArray(closedTrades) || closedTrades.length === 0) {
    return null;
  }

  const signalSide = String(result.signal || '').toUpperCase();
  const currentTime = getBarTime(currentBar);
  const comparableTimeframe = symbolCustom.timeframes?.setupTimeframe
    || symbolCustom.timeframes?.entryTimeframe
    || '1h';

  return [...closedTrades].reverse().find((trade) => {
    if (String(trade.side || '').toUpperCase() !== signalSide) return false;
    if (trade.symbol && symbolCustom.symbol && trade.symbol !== symbolCustom.symbol) return false;
    if (
      trade.symbolCustomName
      && symbolCustom.symbolCustomName
      && trade.symbolCustomName !== symbolCustom.symbolCustomName
    ) {
      return false;
    }

    const entryIndex = Number(trade.entryIndex);
    if (Number.isFinite(entryIndex)) {
      return Math.max(0, currentIndex - entryIndex) <= entryWindowBars;
    }

    if (!trade.entryTime || !currentTime) return false;
    return estimateBarDistance(trade.entryTime, currentTime, comparableTimeframe) <= entryWindowBars;
  }) || null;
}

function evaluateBacktestExecutionGate({
  symbolCustom,
  logicName,
  result,
  currentBar,
  currentIndex,
  parameters,
  options,
  closedTrades,
}) {
  const executionPolicy = resolveBacktestExecutionPolicy({ symbolCustom, result, options });
  const duplicateReference = findBacktestDuplicateEntryReference({
    symbolCustom,
    result,
    currentBar,
    currentIndex,
    closedTrades,
    executionPolicy,
  });
  const executionSignal = buildExecutionSignal({
    symbolCustom,
    logicName,
    result,
    currentBar,
    parameters,
  });
  const executionScore = calculateExecutionScore(executionSignal, executionPolicy, {
    sameDirectionSymbolPositions: 0,
    sameDirectionCategoryPositions: 0,
    duplicatePenalty: Boolean(duplicateReference),
  });

  if (executionScore.score < executionPolicy.minExecutionScore) {
    return {
      allowed: false,
      reasonCode: EXECUTION_SCORE_TOO_LOW,
      detail: buildRejectedSignalDetail({
        symbolCustom,
        logicName,
        result,
        currentBar,
        currentIndex,
        reasonCode: EXECUTION_SCORE_TOO_LOW,
        reasonText: `Execution score too low: ${executionScore.score.toFixed(2)} < ${executionPolicy.minExecutionScore.toFixed(2)}`,
        executionScore,
        executionPolicy,
        duplicateReference,
      }),
    };
  }

  return {
    allowed: true,
    executionSignal,
    executionScore,
    executionPolicy,
    duplicateReference,
  };
}

function resolveRiskPerTradePct(symbolCustom = {}, options = {}) {
  const fromRiskConfig = Number(symbolCustom.riskConfig?.maxRiskPerTradePct);
  if (Number.isFinite(fromRiskConfig) && fromRiskConfig > 0) return fromRiskConfig;

  const fromOptions = Number(options.riskPerTradePct);
  if (Number.isFinite(fromOptions) && fromOptions > 0) return fromOptions;

  return DEFAULT_RISK_PER_TRADE_PCT;
}

function resolveStopTakeProfit(result = {}, side, entryPrice) {
  let sl = result.sl ?? result.stopLoss;
  let tp = result.tp ?? result.takeProfit;

  if (sl == null && result.slDistance != null) {
    const distance = Math.abs(toNumber(result.slDistance, 0));
    if (distance > 0) sl = side === 'BUY' ? entryPrice - distance : entryPrice + distance;
  }

  if (tp == null && result.tpDistance != null) {
    const distance = Math.abs(toNumber(result.tpDistance, 0));
    if (distance > 0) tp = side === 'BUY' ? entryPrice + distance : entryPrice - distance;
  }

  sl = sl == null ? null : toNumber(sl, null);
  tp = tp == null ? null : toNumber(tp, null);

  return {
    sl: Number.isFinite(sl) ? sl : null,
    tp: Number.isFinite(tp) ? tp : null,
  };
}

function getEntryPrice(side, close, costModel) {
  const adjustment = costModel.spread + costModel.slippage;
  return side === 'BUY' ? close + adjustment : close - adjustment;
}

function calculateQuantity({ balance, entryPrice, sl, riskPerTradePct }) {
  const riskAmount = balance * (riskPerTradePct / 100);
  const slDistance = Math.abs(entryPrice - sl);

  if (riskAmount > 0 && slDistance > 0) {
    return {
      quantity: riskAmount / slDistance,
      positionSizingMode: 'RISK_BASED',
      plannedRiskAmount: riskAmount,
    };
  }

  return {
    quantity: 1,
    positionSizingMode: 'ABSTRACT_UNIT',
    plannedRiskAmount: null,
  };
}

function calculatePnl(position, exitPrice, costModel) {
  const direction = position.side === 'BUY' ? 1 : -1;
  return ((exitPrice - position.entryPrice) * direction * position.quantity) - costModel.commissionPerTrade;
}

function calculateUnrealizedPnl(position, currentBar = {}, costModel = {}) {
  if (!position) return 0;
  const markPrice = toNumber(currentBar.close, position.entryPrice);
  if (!Number.isFinite(markPrice)) return 0;
  return calculatePnl(position, markPrice, normalizeCostModel(costModel));
}

function calculateRMultiple(pnl, plannedRiskAmount) {
  if (!plannedRiskAmount || plannedRiskAmount <= 0) return null;
  return pnl / plannedRiskAmount;
}

function buildEquityCurvePoint(bar, balance, openPosition = null, costModel = {}) {
  const unrealizedPnl = calculateUnrealizedPnl(openPosition, bar, costModel);
  const equity = balance + unrealizedPnl;

  return {
    time: getBarTime(bar),
    balance,
    equity,
    openPosition: openPosition ? {
      side: openPosition.side,
      entryPrice: openPosition.entryPrice,
      quantity: openPosition.quantity,
      markPrice: toNumber(bar.close, openPosition.entryPrice),
      unrealizedPnl,
    } : null,
  };
}

function detectStopTakeProfitExit(position, bar = {}) {
  const high = toNumber(bar.high, null);
  const low = toNumber(bar.low, null);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;

  if (position.side === 'BUY') {
    const hitSl = position.sl != null && low <= position.sl;
    const hitTp = position.tp != null && high >= position.tp;
    if (hitSl && hitTp) {
      return { exitPrice: position.sl, exitReason: 'AMBIGUOUS_SL_TP_SAME_BAR_SL_FIRST' };
    }
    if (hitSl) return { exitPrice: position.sl, exitReason: 'SL' };
    if (hitTp) return { exitPrice: position.tp, exitReason: 'TP' };
  }

  if (position.side === 'SELL') {
    const hitSl = position.sl != null && high >= position.sl;
    const hitTp = position.tp != null && low <= position.tp;
    if (hitSl && hitTp) {
      return { exitPrice: position.sl, exitReason: 'AMBIGUOUS_SL_TP_SAME_BAR_SL_FIRST' };
    }
    if (hitSl) return { exitPrice: position.sl, exitReason: 'SL' };
    if (hitTp) return { exitPrice: position.tp, exitReason: 'TP' };
  }

  return null;
}

function buildStaticContext({ symbolCustom, logicName, parameters }) {
  return {
    scope: 'backtest',
    symbol: symbolCustom.symbol,
    symbolCustomId: symbolCustom._id || null,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName,
    timeframes: cloneValue(symbolCustom.timeframes || {}),
    parameters: cloneValue(parameters || {}),
    riskConfig: cloneValue(symbolCustom.riskConfig || {}),
    sessionFilter: cloneValue(symbolCustom.sessionFilter || {}),
    newsFilter: cloneValue(symbolCustom.newsFilter || {}),
    beConfig: cloneValue(symbolCustom.beConfig || {}),
    entryConfig: cloneValue(symbolCustom.entryConfig || {}),
    exitConfig: cloneValue(symbolCustom.exitConfig || {}),
  };
}

function indexClosedTrade(trade, tradeIndexes = {}) {
  const exitDateUtc = toUtcDateKey(trade?.exitTime);
  if (exitDateUtc) {
    const tradesForExitDate = tradeIndexes.byExitDate.get(exitDateUtc) || [];
    tradesForExitDate.push(trade);
    tradeIndexes.byExitDate.set(exitDateUtc, tradesForExitDate);
  }

  const entryDateUtc = trade?.entryDateUtc;
  if (entryDateUtc) {
    const tradesForEntryDate = tradeIndexes.byEntryDate.get(entryDateUtc) || [];
    tradesForEntryDate.push(trade);
    tradeIndexes.byEntryDate.set(entryDateUtc, tradesForEntryDate);
  }
}

function buildContext({
  symbolCustom,
  logicName,
  parameters,
  candles,
  currentBar,
  currentIndex,
  openPosition,
  balance,
  closedTrades,
  candleHistories,
  staticContext,
  tradeIndexes,
  costModel,
}) {
  const currentTime = getBarTime(currentBar);
  const currentDateUtc = toUtcDateKey(currentTime);
  const lastClosedTrade = closedTrades.length ? closedTrades[closedTrades.length - 1] : null;
  const todayClosedTrades = currentDateUtc
    ? (tradeIndexes?.byExitDate.get(currentDateUtc) || [])
    : [];
  const todayTrades = currentDateUtc
    ? [...(tradeIndexes?.byEntryDate.get(currentDateUtc) || [])]
    : [];
  if (openPosition && openPosition.entryDateUtc === currentDateUtc) {
    todayTrades.push(cloneValue(openPosition));
  }

  const unrealizedPnl = calculateUnrealizedPnl(openPosition, currentBar, costModel || {});

  return {
    ...(staticContext || buildStaticContext({ symbolCustom, logicName, parameters })),
    candles: {
      setup: candleHistories?.setup || getBarsUpTo(candles.setup, currentBar),
      entry: candleHistories?.entry || candles.entry.slice(0, currentIndex + 1),
      higher: candleHistories?.higher || getBarsUpTo(candles.higher, currentBar),
    },
    currentBar,
    currentIndex,
    openPosition: openPosition ? cloneValue(openPosition) : null,
    closedTrades,
    lastClosedTrade,
    currentUtcHour: toUtcHour(currentTime),
    todayClosedTrades,
    todayTrades,
    barsSinceLastExit: lastClosedTrade && Number.isFinite(Number(lastClosedTrade.exitIndex))
      ? currentIndex - Number(lastClosedTrade.exitIndex)
      : null,
    balance,
    equity: balance + unrealizedPnl,
    unrealizedPnl,
  };
}

function buildZeroSummary(signalStats = {}) {
  const normalizedStats = normalizeSignalStats(signalStats);
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    netPnl: 0,
    grossWin: 0,
    grossLoss: 0,
    profitFactor: null,
    winRate: null,
    avgR: null,
    avgWin: 0,
    avgLoss: 0,
    maxDrawdown: 0,
    maxSingleLoss: 0,
    maxWin: 0,
    maxConsecutiveLosses: 0,
    dailyTradeCounts: {},
    modulePerformance: {},
    rawSignals: normalizedStats.rawSignals,
    openedSignals: normalizedStats.openedSignals,
    rejectedSignals: normalizedStats.rejectedSignals,
    rejectedSignalDetails: normalizedStats.rejectedSignalDetails,
    warnings: normalizedStats.warnings,
    directionControl: buildDirectionControlSummary([]),
  };
}

function getTradeModuleName(trade = {}) {
  return trade.moduleName
    || trade.executionSignal?.metadata?.moduleName
    || trade.executionSignal?.metadata?.module
    || trade.executionSignal?.metadata?.setupType
    || 'UNKNOWN';
}

function buildDailyTradeCounts(trades = []) {
  return trades.reduce((counts, trade) => {
    const key = trade.entryDateUtc || toUtcDateKey(trade.entryTime) || 'UNKNOWN';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function buildModulePerformance(trades = []) {
  return trades.reduce((modules, trade) => {
    const moduleName = getTradeModuleName(trade);
    if (!modules[moduleName]) {
      modules[moduleName] = {
        trades: 0,
        wins: 0,
        losses: 0,
        netPnl: 0,
        grossWin: 0,
        grossLoss: 0,
        profitFactor: null,
      };
    }
    const bucket = modules[moduleName];
    const pnl = toNumber(trade.pnl, 0);
    bucket.trades += 1;
    bucket.netPnl += pnl;
    if (pnl > 0) {
      bucket.wins += 1;
      bucket.grossWin += pnl;
    } else if (pnl < 0) {
      bucket.losses += 1;
      bucket.grossLoss += Math.abs(pnl);
    }
    bucket.profitFactor = bucket.grossLoss > 0 ? bucket.grossWin / bucket.grossLoss : null;
    return modules;
  }, {});
}

function calculateMaxConsecutiveLosses(trades = []) {
  let current = 0;
  let max = 0;
  trades.forEach((trade) => {
    if (toNumber(trade.pnl, 0) < 0) {
      current += 1;
      max = Math.max(max, current);
    } else if (toNumber(trade.pnl, 0) > 0) {
      current = 0;
    }
  });
  return max;
}

function buildSummary(trades, equityCurve, initialBalance, signalStats = {}) {
  const normalizedStats = normalizeSignalStats(signalStats);
  if (!trades.length) {
    return buildZeroSummary(normalizedStats);
  }

  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl < 0);
  const netPnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = losses.reduce((sum, trade) => sum + Math.abs(trade.pnl), 0);
  const rValues = trades
    .map((trade) => trade.rMultiple)
    .filter((value) => Number.isFinite(value));

  let peak = initialBalance;
  let maxDrawdown = 0;
  equityCurve.forEach((point) => {
    const equity = toNumber(point.equity, peak);
    if (equity > peak) peak = equity;
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  });

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    netPnl,
    grossWin,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? null : null),
    winRate: trades.length ? wins.length / trades.length : null,
    avgR: rValues.length ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length : null,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    maxDrawdown,
    maxSingleLoss: losses.length ? Math.min(...losses.map((trade) => trade.pnl)) : 0,
    maxWin: wins.length ? Math.max(...wins.map((trade) => trade.pnl)) : 0,
    maxConsecutiveLosses: calculateMaxConsecutiveLosses(trades),
    dailyTradeCounts: buildDailyTradeCounts(trades),
    modulePerformance: buildModulePerformance(trades),
    rawSignals: normalizedStats.rawSignals,
    openedSignals: normalizedStats.openedSignals,
    rejectedSignals: normalizedStats.rejectedSignals,
    rejectedSignalDetails: normalizedStats.rejectedSignalDetails,
    warnings: normalizedStats.warnings,
    directionControl: buildDirectionControlSummary(trades),
  };
}

function resolveSymbolCustomEntryThesisLevels(result = {}) {
  const metadata = result.metadata && typeof result.metadata === 'object' ? result.metadata : {};
  const indicators = result.indicators || metadata.indicators || metadata.indicatorsSnapshot || {};
  return {
    zone_boundary: result.zoneBoundary
      ?? result.zone_boundary
      ?? metadata.zoneBoundary
      ?? metadata.zone_boundary
      ?? indicators.zoneBoundary
      ?? indicators.zone_boundary,
    pinbar_extreme: result.pinbarExtreme
      ?? result.pinbar_extreme
      ?? metadata.pinbarExtreme
      ?? metadata.pinbar_extreme
      ?? indicators.pinbarExtreme
      ?? indicators.pinbar_extreme,
    entry_swing: result.entrySwing
      ?? result.entry_swing
      ?? result.structureAnchor
      ?? metadata.entrySwing
      ?? metadata.entry_swing
      ?? metadata.structureAnchor
      ?? indicators.entrySwing
      ?? indicators.entry_swing
      ?? indicators.structureAnchor,
  };
}

function isOpposingSignalForPosition(position, signal) {
  if (!position || !signal) return false;
  const side = String(position.side || position.type || '').toUpperCase();
  const direction = String(signal || '').toUpperCase();
  return (side === 'BUY' && direction === 'SELL') || (side === 'SELL' && direction === 'BUY');
}

function buildSymbolCustomOpposingSignal(position, result = {}, currentBar, currentIndex) {
  const signal = result.signal || 'NONE';
  if (!isOpposingSignalForPosition(position, signal)) return null;
  const metadata = result.metadata && typeof result.metadata === 'object' ? result.metadata : {};
  return {
    name: result.reasonCode || metadata.signalName || metadata.reasonCode || metadata.module || signal,
    direction: signal,
    signalTime: getBarTime(currentBar),
    barIndex: currentIndex,
    repaintSafe: result.repaintSafe === true
      || metadata.repaintSafe === true
      || metadata.closedBarSafe === true,
  };
}

function updateSymbolCustomDirectionControlPostTrigger(position, bar = {}) {
  if (!position?.directionControl?.firstTriggered) return;
  const triggerPrice = Number(position.directionControlTriggerPrice);
  const entryPrice = Number(position.entryPrice);
  const stopLoss = Number(position.sl);
  const high = Number(bar.high);
  const low = Number(bar.low);
  if (
    !Number.isFinite(triggerPrice)
    || !Number.isFinite(entryPrice)
    || !Number.isFinite(stopLoss)
    || !Number.isFinite(high)
    || !Number.isFinite(low)
  ) {
    return;
  }
  const riskDistance = Math.abs(entryPrice - stopLoss);
  if (!Number.isFinite(riskDistance) || riskDistance <= 0) return;
  const favourable = position.side === 'SELL'
    ? (triggerPrice - low) / riskDistance
    : (high - triggerPrice) / riskDistance;
  const adverse = position.side === 'SELL'
    ? (triggerPrice - high) / riskDistance
    : (low - triggerPrice) / riskDistance;
  if (Number.isFinite(favourable)) {
    position.directionControlPostTriggerMfeR = Math.max(
      Number(position.directionControlPostTriggerMfeR) || 0,
      favourable
    );
  }
  if (Number.isFinite(adverse)) {
    position.directionControlPostTriggerMaeR = Math.min(
      Number(position.directionControlPostTriggerMaeR) || 0,
      adverse
    );
  }
}

function evaluateSymbolCustomDirectionControlAudit({
  position,
  config,
  candles,
  currentBar,
  currentIndex,
  symbolCustom,
  logicName,
  result,
}) {
  if (!position || !config || config.enabled !== true) return null;
  updateSymbolCustomDirectionControlPostTrigger(position, currentBar);
  const metadata = result?.metadata && typeof result.metadata === 'object' ? result.metadata : {};
  const opposingSignal = buildSymbolCustomOpposingSignal(position, result || {}, currentBar, currentIndex);
  const evaluation = evaluateDirectionControl({
    config,
    position,
    candles,
    currentBar,
    currentIndex,
    existingState: position.directionControl || null,
    strategyContext: {
      symbol: symbolCustom?.symbol || position.symbol,
      symbolCustomId: symbolCustom?._id || position.symbolCustomId || null,
      symbolCustomName: symbolCustom?.symbolCustomName || position.symbolCustomName || null,
      strategy: position.strategyName || position.symbolCustomName || logicName,
      atr: metadata.atr ?? result?.atr ?? currentBar?.atr ?? null,
      entryThesisLevels: position.entryThesisLevels || null,
      opposingSignal,
      currentBarClosed: true,
    },
    serverTime: getBarTime(currentBar),
  });

  if (!evaluation?.event || !evaluation.statePatch?.directionControl) {
    return evaluation;
  }

  const existingEvents = Array.isArray(position.directionControlEvents)
    ? position.directionControlEvents
    : [];
  if (existingEvents.some((event) => event.eventKey === evaluation.event.eventKey)) {
    return evaluation;
  }

  position.directionControlEvents = [...existingEvents, evaluation.event];
  position.managementEvents = [
    ...(Array.isArray(position.managementEvents) ? position.managementEvents : []),
    evaluation.event,
  ];
  position.directionControl = {
    ...(position.directionControl || {}),
    ...evaluation.statePatch.directionControl,
  };
  position.directionControlTriggerPrice = Number(evaluation.event.currentPrice);
  position.directionControlPostTriggerMfeR = 0;
  position.directionControlPostTriggerMaeR = 0;
  updateSymbolCustomDirectionControlPostTrigger(position, currentBar);
  return evaluation;
}

function openTrade({
  symbolCustom,
  logicName,
  result,
  currentBar,
  currentIndex,
  balance,
  riskPerTradePct,
  costModel,
  executionGate = null,
}) {
  const side = result.signal;
  const close = toNumber(currentBar.close, null);
  if (!Number.isFinite(close)) return null;
  const metadata = result.metadata && typeof result.metadata === 'object' ? result.metadata : {};

  const entryPrice = getEntryPrice(side, close, costModel);
  const { sl, tp } = resolveStopTakeProfit(result, side, entryPrice);
  if (sl == null || tp == null) return null;

  const sizing = calculateQuantity({
    balance,
    entryPrice,
    sl,
    riskPerTradePct,
  });

  return {
    id: `${symbolCustom._id || symbolCustom.symbolCustomName || symbolCustom.symbol}:${currentIndex}`,
    symbol: symbolCustom.symbol,
    symbolCustomId: symbolCustom._id || null,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName,
    strategy: symbolCustom.symbolCustomName,
    side,
    entryTime: getBarTime(currentBar),
    entryIndex: currentIndex,
    entryHourUtc: toUtcHour(getBarTime(currentBar)),
    entryDateUtc: toUtcDateKey(getBarTime(currentBar)),
    entryPrice,
    sl,
    tp,
    entryReason: result.reason || null,
    strategyName: result.strategyName || metadata.strategyName || symbolCustom.symbolCustomName,
    moduleName: result.moduleName || metadata.moduleName || metadata.module || null,
    entryThesisLevels: resolveSymbolCustomEntryThesisLevels(result),
    indicators: cloneValue(result.indicators || metadata.indicators || metadata.indicatorsSnapshot || null),
    quantity: sizing.quantity,
    positionSizingMode: sizing.positionSizingMode,
    plannedRiskAmount: sizing.plannedRiskAmount,
    confidence: result.confidence ?? result.metadata?.confidence ?? null,
    executionScore: executionGate?.executionScore?.score ?? null,
    executionScoreDetails: executionGate?.executionScore?.details ? cloneValue(executionGate.executionScore.details) : null,
    executionPolicy: executionGate?.executionPolicy ? cloneValue(executionGate.executionPolicy) : null,
    executionSignal: executionGate?.executionSignal ? cloneValue(executionGate.executionSignal) : null,
    managementEvents: [],
    directionControlEvents: [],
    directionControl: null,
  };
}

function closeTrade(position, currentBar, currentIndex, exitPrice, exitReason, costModel) {
  const pnl = calculatePnl(position, exitPrice, costModel);
  const plannedRiskAmount = position.plannedRiskAmount;
  return {
    id: position.id || null,
    symbol: position.symbol,
    symbolCustomId: position.symbolCustomId || null,
    symbolCustomName: position.symbolCustomName,
    logicName: position.logicName,
    side: position.side,
    entryTime: position.entryTime,
    entryIndex: position.entryIndex,
    entryHourUtc: position.entryHourUtc,
    entryDateUtc: position.entryDateUtc,
    entryPrice: position.entryPrice,
    exitTime: getBarTime(currentBar),
    exitIndex: currentIndex,
    exitPrice,
    sl: position.sl,
    tp: position.tp,
    pnl,
    rMultiple: calculateRMultiple(pnl, plannedRiskAmount),
    exitReason,
    entryReason: position.entryReason,
    strategyName: position.strategyName || null,
    moduleName: position.moduleName || null,
    indicators: cloneValue(position.indicators || null),
    quantity: position.quantity,
    positionSizingMode: position.positionSizingMode,
    plannedRiskAmount,
    confidence: position.confidence,
    executionScore: position.executionScore,
    executionScoreDetails: position.executionScoreDetails ? cloneValue(position.executionScoreDetails) : null,
    executionPolicy: position.executionPolicy ? cloneValue(position.executionPolicy) : null,
    executionSignal: position.executionSignal ? cloneValue(position.executionSignal) : null,
    managementEvents: Array.isArray(position.managementEvents) ? cloneValue(position.managementEvents) : [],
    directionControlEvents: Array.isArray(position.directionControlEvents)
      ? cloneValue(position.directionControlEvents)
      : [],
    directionControl: position.directionControl ? cloneValue(position.directionControl) : null,
    directionControlPostTriggerMfeR: Number.isFinite(Number(position.directionControlPostTriggerMfeR))
      ? parseFloat(Number(position.directionControlPostTriggerMfeR).toFixed(4))
      : null,
    directionControlPostTriggerMaeR: Number.isFinite(Number(position.directionControlPostTriggerMaeR))
      ? parseFloat(Number(position.directionControlPostTriggerMaeR).toFixed(4))
      : null,
  };
}

function yieldToEventLoop() {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') {
      setImmediate(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

async function runSymbolCustomBacktestSimulation({
  symbolCustom,
  logic,
  logicName,
  candles,
  parameters,
  costModel,
  initialBalance,
  options,
  onProgress,
} = {}) {
  const normalizedCandles = normalizeCandles(candles || {});
  const entryCandles = normalizedCandles.entry;
  const startingBalance = toNumber(initialBalance, DEFAULT_INITIAL_BALANCE);
  const costModelUsed = normalizeCostModel(costModel || {});
  const riskPerTradePct = resolveRiskPerTradePct(symbolCustom, options || {});
  const warnings = getZeroCostWarnings(costModelUsed);
  const directionControlConfig = resolveDirectionControlConfig({
    symbolCustom,
    source: 'symbolCustom',
  });

  let balance = startingBalance;
  let openPosition = null;
  let rawSignals = 0;
  let openedSignals = 0;
  const rejectedSignalDetails = [];
  const trades = [];
  const equityCurve = [];
  const entryHistory = [];
  const setupHistoryCursor = createTimeHistoryCursor(normalizedCandles.setup);
  const higherHistoryCursor = createTimeHistoryCursor(normalizedCandles.higher);
  const staticContext = buildStaticContext({ symbolCustom, logicName, parameters });
  const tradeIndexes = {
    byExitDate: new Map(),
    byEntryDate: new Map(),
  };
  const totalCandles = entryCandles.length;
  let lastProgressPercent = -1;
  let lastProgressAt = 0;
  const reportProgress = async (currentIndex, force = false) => {
    if (typeof onProgress !== 'function') return;
    const current = Math.max(0, Math.min(totalCandles, currentIndex + 1));
    const ratio = totalCandles > 0 ? current / totalCandles : 0;
    const percent = Math.min(92, 20 + Math.floor(ratio * 72));
    const now = Date.now();
    const shouldReport = force
      || percent !== lastProgressPercent
      || now - lastProgressAt >= 1000
      || current === totalCandles;

    if (shouldReport) {
      onProgress({
        stage: 'Simulating trades',
        message: `Simulating ${current}/${totalCandles} entry candles`,
        percent,
        current,
        total: totalCandles,
      });
      lastProgressPercent = percent;
      lastProgressAt = now;
    }

    if (force || current % 250 === 0) {
      await yieldToEventLoop();
    }
  };

  await reportProgress(-1, true);

  for (let currentIndex = 0; currentIndex < entryCandles.length; currentIndex += 1) {
    const currentBar = entryCandles[currentIndex];
    entryHistory.push(currentBar);
    const setupHistory = advanceTimeHistoryCursor(setupHistoryCursor, currentBar);
    const higherHistory = advanceTimeHistoryCursor(higherHistoryCursor, currentBar);

    if (openPosition) {
      const barrierExit = detectStopTakeProfitExit(openPosition, currentBar);
      if (barrierExit) {
        updateSymbolCustomDirectionControlPostTrigger(openPosition, currentBar);
        const trade = closeTrade(openPosition, currentBar, currentIndex, barrierExit.exitPrice, barrierExit.exitReason, costModelUsed);
        trades.push(trade);
        indexClosedTrade(trade, tradeIndexes);
        balance += trade.pnl;
        openPosition = null;
        equityCurve.push(buildEquityCurvePoint(currentBar, balance, openPosition));
        await reportProgress(currentIndex);
        continue;
      }
    }

    const context = buildContext({
      symbolCustom,
      logicName,
      parameters,
      candles: normalizedCandles,
      currentBar,
      currentIndex,
      openPosition,
      balance,
      closedTrades: trades,
      candleHistories: {
        setup: setupHistory,
        entry: entryHistory,
        higher: higherHistory,
      },
      staticContext,
      tradeIndexes,
      costModel: costModelUsed,
    });

    const result = await logic.analyze(context) || {};
    const signal = result.signal || 'NONE';

    if (openPosition) {
      evaluateSymbolCustomDirectionControlAudit({
        position: openPosition,
        config: directionControlConfig,
        candles: entryCandles,
        currentBar,
        currentIndex,
        symbolCustom,
        logicName,
        result,
      });
    }

    if (openPosition && signal === 'CLOSE') {
      const exitPrice = toNumber(currentBar.close, openPosition.entryPrice);
      const exitReason = result.exitReason
        || result.metadata?.exitRule
        || result.reasonCode
        || 'CUSTOM_CLOSE';
      const trade = closeTrade(openPosition, currentBar, currentIndex, exitPrice, exitReason, costModelUsed);
      trades.push(trade);
      indexClosedTrade(trade, tradeIndexes);
      balance += trade.pnl;
      openPosition = null;
    } else if (!openPosition && (signal === 'BUY' || signal === 'SELL')) {
      rawSignals += 1;
      const executionGate = evaluateBacktestExecutionGate({
        symbolCustom,
        logicName,
        result,
        currentBar,
        currentIndex,
        parameters,
        options: options || {},
        closedTrades: trades,
      });

      if (!executionGate.allowed) {
        rejectedSignalDetails.push(executionGate.detail);
        equityCurve.push(buildEquityCurvePoint(currentBar, balance, openPosition, costModelUsed));
        await reportProgress(currentIndex);
        continue;
      }

      const nextPosition = openTrade({
        symbolCustom,
        logicName,
        result,
        currentBar,
        currentIndex,
        balance,
        riskPerTradePct,
        costModel: costModelUsed,
        executionGate,
      });

      if (nextPosition) {
        openPosition = nextPosition;
        openedSignals += 1;
      } else {
        rejectedSignalDetails.push(buildRejectedSignalDetail({
          symbolCustom,
          logicName,
          result,
          currentBar,
          currentIndex,
          reasonCode: SYMBOL_CUSTOM_BACKTEST_PROTECTIVE_LEVELS_REQUIRED,
          reasonText: 'BUY/SELL signal rejected because SL/TP protective levels were missing or invalid',
          executionScore: executionGate.executionScore,
          executionPolicy: executionGate.executionPolicy,
        }));
      }
    }

    equityCurve.push(buildEquityCurvePoint(currentBar, balance, openPosition, costModelUsed));
    await reportProgress(currentIndex);
  }

  const finalBar = entryCandles[entryCandles.length - 1] || null;
  if (openPosition && finalBar) {
    const finalIndex = entryCandles.length - 1;
    updateSymbolCustomDirectionControlPostTrigger(openPosition, finalBar);
    const trade = closeTrade(openPosition, finalBar, finalIndex, toNumber(finalBar.close, openPosition.entryPrice), 'END_OF_BACKTEST', costModelUsed);
    trades.push(trade);
    indexClosedTrade(trade, tradeIndexes);
    balance += trade.pnl;
    openPosition = null;
    equityCurve.push(buildEquityCurvePoint(finalBar, balance, openPosition));
  }

  await reportProgress(totalCandles - 1, true);

  return {
    status: 'completed',
    initialBalance: startingBalance,
    finalBalance: balance,
    costModelUsed,
    summary: buildSummary(trades, equityCurve, startingBalance, {
      rawSignals,
      openedSignals,
      rejectedSignals: rejectedSignalDetails.length,
      rejectedSignalDetails,
      warnings,
    }),
    trades,
    equityCurve,
    message: 'SymbolCustom backtest completed',
  };
}

module.exports = {
  DEFAULT_INITIAL_BALANCE,
  DEFAULT_RISK_PER_TRADE_PCT,
  EXECUTION_SCORE_TOO_LOW,
  SYMBOL_CUSTOM_BACKTEST_PROTECTIVE_LEVELS_REQUIRED,
  ZERO_COST_BACKTEST_WARNING,
  SYMBOL_CUSTOM_BACKTEST_RUNNER_MODE: 'symbolCustom',
  runSymbolCustomBacktestSimulation,
  advanceTimeHistoryCursor,
  buildContext,
  buildRejectedSignalDetail,
  buildStaticContext,
  normalizeCandles,
  normalizeCostModel,
  calculatePnl,
  calculateUnrealizedPnl,
  closeTrade,
  createTimeHistoryCursor,
  detectStopTakeProfitExit,
  evaluateBacktestExecutionGate,
  evaluateSymbolCustomDirectionControlAudit,
  getBarTime,
  getZeroCostWarnings,
  indexClosedTrade,
  openTrade,
  resolveRiskPerTradePct,
  toNumber,
  buildSummary,
  updateSymbolCustomDirectionControlPostTrigger,
};
