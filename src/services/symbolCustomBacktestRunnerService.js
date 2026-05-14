const DEFAULT_INITIAL_BALANCE = 500;
const DEFAULT_RISK_PER_TRADE_PCT = 1;

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

function getBarsUpTo(candles = [], currentBar = {}) {
  const currentEpoch = toEpoch(getBarTime(currentBar));
  if (!currentEpoch) return candles.slice();

  return candles.filter((bar) => {
    const barEpoch = toEpoch(getBarTime(bar));
    return !barEpoch || barEpoch <= currentEpoch;
  });
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

function calculateRMultiple(pnl, plannedRiskAmount) {
  if (!plannedRiskAmount || plannedRiskAmount <= 0) return null;
  return pnl / plannedRiskAmount;
}

function buildEquityCurvePoint(bar, balance, openPosition = null) {
  return {
    time: getBarTime(bar),
    balance,
    equity: balance,
    openPosition: openPosition ? {
      side: openPosition.side,
      entryPrice: openPosition.entryPrice,
      quantity: openPosition.quantity,
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

function buildContext({
  symbolCustom,
  logicName,
  parameters,
  candles,
  currentBar,
  currentIndex,
  openPosition,
  balance,
}) {
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
    candles: {
      setup: getBarsUpTo(candles.setup, currentBar),
      entry: candles.entry.slice(0, currentIndex + 1),
      higher: getBarsUpTo(candles.higher, currentBar),
    },
    currentBar,
    currentIndex,
    openPosition: openPosition ? cloneValue(openPosition) : null,
    balance,
    equity: balance,
  };
}

function buildZeroSummary(rejectedSignals = 0) {
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
    maxDrawdown: 0,
    maxSingleLoss: 0,
    maxWin: 0,
    rejectedSignals,
  };
}

function buildSummary(trades, equityCurve, initialBalance, rejectedSignals) {
  if (!trades.length) {
    return buildZeroSummary(rejectedSignals);
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
    maxDrawdown,
    maxSingleLoss: losses.length ? Math.min(...losses.map((trade) => trade.pnl)) : 0,
    maxWin: wins.length ? Math.max(...wins.map((trade) => trade.pnl)) : 0,
    rejectedSignals,
  };
}

function openTrade({ symbolCustom, logicName, result, currentBar, balance, riskPerTradePct, costModel }) {
  const side = result.signal;
  const close = toNumber(currentBar.close, null);
  if (!Number.isFinite(close)) return null;

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
    symbol: symbolCustom.symbol,
    symbolCustomName: symbolCustom.symbolCustomName,
    logicName,
    side,
    entryTime: getBarTime(currentBar),
    entryPrice,
    sl,
    tp,
    entryReason: result.reason || null,
    quantity: sizing.quantity,
    positionSizingMode: sizing.positionSizingMode,
    plannedRiskAmount: sizing.plannedRiskAmount,
  };
}

function closeTrade(position, currentBar, exitPrice, exitReason, costModel) {
  const pnl = calculatePnl(position, exitPrice, costModel);
  const plannedRiskAmount = position.plannedRiskAmount;
  return {
    symbol: position.symbol,
    symbolCustomName: position.symbolCustomName,
    logicName: position.logicName,
    side: position.side,
    entryTime: position.entryTime,
    entryPrice: position.entryPrice,
    exitTime: getBarTime(currentBar),
    exitPrice,
    sl: position.sl,
    tp: position.tp,
    pnl,
    rMultiple: calculateRMultiple(pnl, plannedRiskAmount),
    exitReason,
    entryReason: position.entryReason,
    quantity: position.quantity,
    positionSizingMode: position.positionSizingMode,
  };
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
} = {}) {
  const normalizedCandles = normalizeCandles(candles || {});
  const entryCandles = normalizedCandles.entry;
  const startingBalance = toNumber(initialBalance, DEFAULT_INITIAL_BALANCE);
  const costModelUsed = normalizeCostModel(costModel || {});
  const riskPerTradePct = resolveRiskPerTradePct(symbolCustom, options || {});

  let balance = startingBalance;
  let openPosition = null;
  let rejectedSignals = 0;
  const trades = [];
  const equityCurve = [];

  for (let currentIndex = 0; currentIndex < entryCandles.length; currentIndex += 1) {
    const currentBar = entryCandles[currentIndex];

    if (openPosition) {
      const barrierExit = detectStopTakeProfitExit(openPosition, currentBar);
      if (barrierExit) {
        const trade = closeTrade(openPosition, currentBar, barrierExit.exitPrice, barrierExit.exitReason, costModelUsed);
        trades.push(trade);
        balance += trade.pnl;
        openPosition = null;
        equityCurve.push(buildEquityCurvePoint(currentBar, balance, openPosition));
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
    });

    const result = await logic.analyze(context) || {};
    const signal = result.signal || 'NONE';

    if (openPosition && signal === 'CLOSE') {
      const exitPrice = toNumber(currentBar.close, openPosition.entryPrice);
      const trade = closeTrade(openPosition, currentBar, exitPrice, 'CUSTOM_CLOSE', costModelUsed);
      trades.push(trade);
      balance += trade.pnl;
      openPosition = null;
    } else if (!openPosition && (signal === 'BUY' || signal === 'SELL')) {
      const nextPosition = openTrade({
        symbolCustom,
        logicName,
        result,
        currentBar,
        balance,
        riskPerTradePct,
        costModel: costModelUsed,
      });

      if (nextPosition) {
        openPosition = nextPosition;
      } else {
        rejectedSignals += 1;
      }
    }

    equityCurve.push(buildEquityCurvePoint(currentBar, balance, openPosition));
  }

  const finalBar = entryCandles[entryCandles.length - 1] || null;
  if (openPosition && finalBar) {
    const trade = closeTrade(openPosition, finalBar, toNumber(finalBar.close, openPosition.entryPrice), 'END_OF_BACKTEST', costModelUsed);
    trades.push(trade);
    balance += trade.pnl;
    openPosition = null;
    equityCurve.push(buildEquityCurvePoint(finalBar, balance, openPosition));
  }

  return {
    status: 'completed',
    initialBalance: startingBalance,
    finalBalance: balance,
    costModelUsed,
    summary: buildSummary(trades, equityCurve, startingBalance, rejectedSignals),
    trades,
    equityCurve,
    message: 'SymbolCustom backtest completed',
  };
}

module.exports = {
  DEFAULT_INITIAL_BALANCE,
  DEFAULT_RISK_PER_TRADE_PCT,
  SYMBOL_CUSTOM_BACKTEST_RUNNER_MODE: 'symbolCustom',
  runSymbolCustomBacktestSimulation,
  normalizeCandles,
  normalizeCostModel,
  buildSummary,
};
