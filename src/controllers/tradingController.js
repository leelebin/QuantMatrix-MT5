const mt5Service = require('../services/mt5Service');
const strategyEngine = require('../services/strategyEngine');
const tradeExecutor = require('../services/tradeExecutor');
const positionMonitor = require('../services/positionMonitor');
const riskManager = require('../services/riskManager');
const Strategy = require('../models/Strategy');
const { getAllSymbols } = require('../config/instruments');

let tradingLoopInterval = null;

// @desc    Start automated trading
// @route   POST /api/trading/start
exports.startTrading = async (req, res) => {
  try {
    // Connect to MT5 if not connected
    if (!mt5Service.isConnected()) {
      await mt5Service.connect();
    }

    // Initialize strategy configs in DB
    await Strategy.initDefaults(strategyEngine.getStrategiesInfo());

    // Enable trading
    process.env.TRADING_ENABLED = 'true';

    // Start position monitor
    positionMonitor.start(30000);

    // Start trading loop (analyze every 5 minutes)
    if (!tradingLoopInterval) {
      tradingLoopInterval = setInterval(async () => {
        try {
          // Get enabled strategies
          const strategies = await Strategy.findAll();
          const enabledSymbols = [];
          for (const s of strategies) {
            if (s.enabled && s.symbols) {
              enabledSymbols.push(...s.symbols);
            }
          }

          if (enabledSymbols.length === 0) return;

          // Run analysis
          await strategyEngine.analyzeAll(
            async (symbol, timeframe, count) => {
              // Use null startTime so bridge uses copy_rates_from_pos (latest candles)
              return await mt5Service.getCandles(symbol, timeframe, null, count);
            },
            async (signal) => {
              await tradeExecutor.executeTrade(signal);
            },
            enabledSymbols
          );
        } catch (err) {
          console.error('[Trading Loop] Error:', err.message);
        }
      }, 5 * 60 * 1000); // 5 minutes
    }

    const accountInfo = await mt5Service.getAccountInfo();
    res.json({
      success: true,
      message: 'Trading started',
      data: {
        account: {
          balance: accountInfo.balance,
          equity: accountInfo.equity,
          currency: accountInfo.currency,
        },
        symbols: getAllSymbols().length,
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
    if (connected) {
      const accountInfo = await mt5Service.getAccountInfo();
      riskStatus = await riskManager.getRiskStatus(accountInfo);
    }

    res.json({
      success: true,
      data: {
        mt5Connected: connected,
        tradingEnabled,
        tradingLoopActive: tradingLoopInterval !== null,
        monitor: monitorStatus,
        risk: riskStatus,
        recentSignals: strategyEngine.getRecentSignals(null, 10),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Test order placement - places min lot, then immediately closes
// @route   POST /api/trading/test-order
exports.testOrder = async (req, res) => {
  try {
    if (!mt5Service.isConnected()) {
      await mt5Service.connect();
    }

    const { symbol = 'EURUSD', type = 'BUY' } = req.body;
    const direction = type.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

    // Get current price to verify symbol exists
    const price = await mt5Service.getPrice(symbol);
    if (!price || (!price.bid && !price.ask)) {
      return res.status(400).json({ success: false, message: `Cannot get price for ${symbol}` });
    }

    console.log(`[Test Order] Placing ${direction} 0.01 ${symbol}...`);

    // Place minimum lot order
    const order = await mt5Service.placeOrder(symbol, direction, 0.01, 0, 0, 'QM-TEST-ORDER');

    console.log(`[Test Order] Order placed:`, JSON.stringify(order));

    // Wait 2 seconds then close
    await new Promise(r => setTimeout(r, 2000));

    let closeResult = null;
    if (order && order.positionId) {
      console.log(`[Test Order] Closing position ${order.positionId}...`);
      closeResult = await mt5Service.closePosition(String(order.positionId));
      console.log(`[Test Order] Position closed.`);
    }

    res.json({
      success: true,
      message: `Test order completed: ${direction} 0.01 ${symbol} → opened and closed`,
      data: {
        symbol,
        type: direction,
        volume: 0.01,
        openPrice: price.bid,
        order,
        closeResult,
      },
    });
  } catch (err) {
    console.error('[Test Order] Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
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
