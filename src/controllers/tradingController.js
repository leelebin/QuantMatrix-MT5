const mt5Service = require('../services/mt5Service');
const strategyEngine = require('../services/strategyEngine');
const tradeExecutor = require('../services/tradeExecutor');
const positionMonitor = require('../services/positionMonitor');
const riskManager = require('../services/riskManager');
const indicatorService = require('../services/indicatorService');
const websocketService = require('../services/websocketService');
const Strategy = require('../models/Strategy');
const ExecutionAudit = require('../models/ExecutionAudit');
const { getAllSymbols, getInstrument } = require('../config/instruments');

let tradingLoopInterval = null;

function getActiveAssignmentStats(strategies) {
  const activeSymbols = new Set();
  let activeAssignments = 0;

  for (const strategy of strategies) {
    if (!strategy.enabled || !Array.isArray(strategy.symbols)) {
      continue;
    }

    const uniqueSymbols = [...new Set(strategy.symbols)];
    activeAssignments += uniqueSymbols.length;
    uniqueSymbols.forEach((symbol) => activeSymbols.add(symbol));
  }

  return {
    activeAssignments,
    activeSymbols: activeSymbols.size,
  };
}

function getPricePrecision(instrument) {
  const pipSize = String(instrument?.pipSize || '0.01');
  if (pipSize.includes('e-')) {
    return parseInt(pipSize.split('e-')[1], 10);
  }

  const decimalPart = pipSize.split('.')[1];
  return decimalPart ? decimalPart.length : 2;
}

function roundPrice(value, instrument) {
  return parseFloat(Number(value).toFixed(getPricePrecision(instrument)));
}

async function recordTestOrderAudit(stage, status, signal, extra = {}) {
  const audit = await ExecutionAudit.create({
    scope: 'live',
    stage,
    status,
    symbol: signal?.symbol || extra.symbol || null,
    type: signal?.signal || extra.type || null,
    strategy: signal?.strategy || 'TestOrder',
    volume: extra.volume ?? null,
    code: extra.code ?? null,
    codeName: extra.codeName || null,
    message: extra.message || '',
    accountMode: extra.accountInfo ? mt5Service.getAccountModeName(extra.accountInfo) : null,
    accountLogin: extra.accountInfo?.login || null,
    accountServer: extra.accountInfo?.server || null,
    source: 'test_order',
    details: extra.details || null,
    createdAt: extra.createdAt || new Date(),
  });

  websocketService.broadcast('status', 'execution_audit', audit);
  return audit;
}

async function buildProtectedTestSignal(symbol, direction, priceData) {
  const instrument = getInstrument(symbol);
  if (!instrument) {
    throw new Error(`Unknown instrument: ${symbol}`);
  }

  const entryPrice = direction === 'BUY' ? Number(priceData.ask) : Number(priceData.bid);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error(`Cannot determine entry price for ${symbol}`);
  }

  let atr = null;
  try {
    const candles = await mt5Service.getCandles(symbol, instrument.timeframe || '1h', null, 120);
    const closedCandles = Array.isArray(candles) && candles.length > 1 ? candles.slice(0, -1) : [];
    if (closedCandles.length >= 20) {
      const atrSeries = indicatorService.atr(closedCandles, 14);
      const latestAtr = atrSeries[atrSeries.length - 1];
      if (Number.isFinite(latestAtr) && latestAtr > 0) {
        atr = latestAtr;
      }
    }
  } catch (err) {
    atr = null;
  }

  const minSlDistance = instrument.spread * instrument.pipSize * 3;
  const slDistance = atr
    ? Math.max(atr * (Number(instrument.riskParams?.slMultiplier) || 1), minSlDistance)
    : minSlDistance;
  const tpDistance = atr
    ? Math.max(atr * (Number(instrument.riskParams?.tpMultiplier) || 2), minSlDistance)
    : (minSlDistance * Math.max(Number(instrument.riskParams?.tpMultiplier) || 2, 1));

  const sl = direction === 'BUY'
    ? roundPrice(entryPrice - slDistance, instrument)
    : roundPrice(entryPrice + slDistance, instrument);
  const tp = direction === 'BUY'
    ? roundPrice(entryPrice + tpDistance, instrument)
    : roundPrice(entryPrice - tpDistance, instrument);

  return {
    symbol,
    signal: direction,
    strategy: 'TestOrder',
    confidence: 1,
    entryPrice,
    sl,
    tp,
    reason: atr ? 'Protected live test order' : 'Protected live test order (fallback distance)',
    indicatorsSnapshot: atr ? { atr } : {},
  };
}

// @desc    Start automated trading
// @route   POST /api/trading/start
exports.startTrading = async (req, res) => {
  try {
    if (!mt5Service.isConnected()) {
      await mt5Service.connect();
    }

    const accountInfo = await mt5Service.getAccountInfo();
    mt5Service.ensureLiveTradingAllowed(accountInfo);

    await Strategy.initDefaults(strategyEngine.getStrategiesInfo());
    process.env.TRADING_ENABLED = 'true';
    positionMonitor.start(30000);

    if (!tradingLoopInterval) {
      tradingLoopInterval = setInterval(async () => {
        try {
          const strategies = await Strategy.findAll();
          const assignmentStats = getActiveAssignmentStats(strategies);
          if (assignmentStats.activeAssignments === 0) return;

          await strategyEngine.analyzeAll(
            async (symbol, timeframe, count) => await mt5Service.getCandles(symbol, timeframe, null, count),
            async (signal) => {
              await tradeExecutor.executeTrade(signal);
            },
            null,
            { scope: 'live' }
          );
        } catch (err) {
          console.error('[Trading Loop] Error:', err.message);
        }
      }, 5 * 60 * 1000);
    }

    const strategies = await Strategy.findAll();
    const assignmentStats = getActiveAssignmentStats(strategies);

    res.json({
      success: true,
      message: 'Trading started',
      data: {
        account: {
          balance: accountInfo.balance,
          equity: accountInfo.equity,
          currency: accountInfo.currency,
          mode: mt5Service.getAccountModeName(accountInfo),
        },
        symbols: assignmentStats.activeSymbols || getAllSymbols().length,
        activeAssignments: assignmentStats.activeAssignments,
        activeSymbols: assignmentStats.activeSymbols,
        monitorRunning: true,
      },
    });
  } catch (err) {
    console.error('[Trading] Start error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Stop automated trading
// @route   POST /api/trading/stop
exports.stopTrading = async (req, res) => {
  try {
    process.env.TRADING_ENABLED = 'false';

    if (tradingLoopInterval) {
      clearInterval(tradingLoopInterval);
      tradingLoopInterval = null;
    }

    positionMonitor.stop();

    res.json({ success: true, message: 'Trading stopped' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get trading status
// @route   GET /api/trading/status
exports.getStatus = async (req, res) => {
  try {
    const connected = mt5Service.isConnected();
    const tradingEnabled = process.env.TRADING_ENABLED === 'true';
    const monitorStatus = positionMonitor.getStatus();

    let riskStatus = null;
    let account = null;
    await Strategy.initDefaults(strategyEngine.getStrategiesInfo());
    const strategies = await Strategy.findAll();
    const assignmentStats = getActiveAssignmentStats(strategies);
    if (connected) {
      const accountInfo = await mt5Service.getAccountInfo();
      riskStatus = await riskManager.getRiskStatus(accountInfo);
      account = {
        login: accountInfo.login,
        server: accountInfo.server,
        mode: mt5Service.getAccountModeName(accountInfo),
        tradeAllowed: accountInfo.tradeAllowed,
      };
    }

    res.json({
      success: true,
      data: {
        mt5Connected: connected,
        account,
        tradingEnabled,
        tradingLoopActive: tradingLoopInterval !== null,
        activeAssignments: assignmentStats.activeAssignments,
        activeSymbols: assignmentStats.activeSymbols,
        monitor: monitorStatus,
        risk: riskStatus,
        recentSignals: strategyEngine.getRecentSignals(null, 10),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Test order placement - places a protected order, then immediately closes
// @route   POST /api/trading/test-order
exports.testOrder = async (req, res) => {
  let order = null;

  try {
    if (!mt5Service.isConnected()) {
      await mt5Service.connect();
    }

    const accountInfo = await mt5Service.getAccountInfo();
    mt5Service.ensureLiveTradingAllowed(accountInfo);

    const { symbol = 'EURUSD', type = 'BUY' } = req.body || {};
    const direction = type.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    const price = await mt5Service.getPrice(symbol);
    if (!price || (!price.bid && !price.ask)) {
      return res.status(400).json({ success: false, message: `Cannot get price for ${symbol}` });
    }

    const signal = await buildProtectedTestSignal(symbol, direction, price);
    const riskCheck = await riskManager.validateTrade(signal, accountInfo, { scope: 'live' });
    if (!riskCheck.allowed) {
      await recordTestOrderAudit('risk', 'BLOCKED', signal, {
        message: riskCheck.reason,
        code: 'RISK_RULE',
        codeName: 'RISK_RULE',
        volume: riskCheck.lotSize || null,
        accountInfo,
        details: { riskCheck },
      });
      return res.status(400).json({ success: false, message: riskCheck.reason });
    }

    if (riskCheck.overrideApplied && riskCheck.auditMessage) {
      await recordTestOrderAudit('risk', 'INFO', signal, {
        message: riskCheck.auditMessage,
        code: 'AGGRESSIVE_MIN_LOT',
        codeName: 'AGGRESSIVE_MIN_LOT',
        volume: riskCheck.lotSize,
        accountInfo,
        details: { riskCheck },
      });
    }

    const brokerComment = 'QM-TEST-ORDER';
    const preflight = await mt5Service.preflightOrder(
      symbol,
      direction,
      riskCheck.lotSize,
      signal.sl,
      signal.tp,
      brokerComment
    );
    if (!mt5Service.isOrderAllowed(preflight)) {
      const preflightMessage = mt5Service.getPreflightMessage(preflight);
      await recordTestOrderAudit('preflight', 'BLOCKED', signal, {
        message: preflightMessage,
        code: preflight.retcode,
        codeName: preflight.retcodeName,
        volume: riskCheck.lotSize,
        accountInfo,
        details: preflight,
      });
      return res.status(400).json({ success: false, message: preflightMessage });
    }

    console.log(`[Test Order] Placing protected ${direction} ${riskCheck.lotSize} ${symbol}...`);

    order = await mt5Service.placeOrder(
      symbol,
      direction,
      riskCheck.lotSize,
      signal.sl,
      signal.tp,
      brokerComment
    );

    console.log('[Test Order] Order placed:', JSON.stringify(order));

    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (order && order.positionId) {
      try {
        const closeResult = await mt5Service.closePosition(String(order.positionId));
        console.log('[Test Order] Position closed.');

        return res.json({
          success: true,
          message: `Test order completed: ${direction} ${riskCheck.lotSize} ${symbol} opened and closed with protection`,
          data: {
            symbol,
            type: direction,
            volume: riskCheck.lotSize,
            openPrice: order?.price || signal.entryPrice,
            accountMode: mt5Service.getAccountModeName(accountInfo),
            stopLoss: signal.sl,
            takeProfit: signal.tp,
            order,
            closeResult,
          },
        });
      } catch (closeErr) {
        const message = `Test order opened with protective SL/TP, but auto-close failed: ${closeErr.message}`;
        await recordTestOrderAudit('test_order_close', 'ERROR', signal, {
          message,
          code: closeErr.code ?? closeErr.details?.retcode ?? null,
          codeName: closeErr.codeName ?? closeErr.details?.retcodeName ?? null,
          volume: riskCheck.lotSize,
          accountInfo,
          details: {
            order,
            stopLoss: signal.sl,
            takeProfit: signal.tp,
            error: closeErr.message,
          },
        });

        return res.status(500).json({
          success: false,
          message,
          data: {
            symbol,
            type: direction,
            volume: riskCheck.lotSize,
            stopLoss: signal.sl,
            takeProfit: signal.tp,
            order,
          },
        });
      }
    }

    const message = 'Test order was placed with protective SL/TP, but no position id was returned for auto-close.';
    await recordTestOrderAudit('test_order_close', 'ERROR', signal, {
      message,
      volume: riskCheck.lotSize,
      accountInfo,
      details: { order, stopLoss: signal.sl, takeProfit: signal.tp },
    });

    return res.status(500).json({
      success: false,
      message,
      data: {
        symbol,
        type: direction,
        volume: riskCheck.lotSize,
        stopLoss: signal.sl,
        takeProfit: signal.tp,
        order,
      },
    });
  } catch (err) {
    console.error('[Test Order] Error:', err.message);
    res.status(500).json({ success: false, message: err.message, data: order ? { order } : undefined });
  }
};

// @desc    Get MT5 account info
// @route   GET /api/trading/account
exports.getAccount = async (req, res) => {
  try {
    if (!mt5Service.isConnected()) {
      await mt5Service.connect();
    }
    const accountInfo = await mt5Service.getAccountInfo();
    res.json({ success: true, data: accountInfo });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
