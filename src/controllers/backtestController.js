const backtestEngine = require('../services/backtestEngine');
const mt5Service = require('../services/mt5Service');
const { getInstrument, getAllSymbols } = require('../config/instruments');

// @desc    Run a backtest
// @route   POST /api/backtest/run
exports.runBacktest = async (req, res) => {
  try {
    const { symbol, strategyType, timeframe, startDate, endDate, initialBalance } = req.body;

    // Validate inputs
    const instrument = getInstrument(symbol);
    if (!instrument) {
      return res.status(400).json({
        success: false,
        message: `Invalid symbol: ${symbol}. Available: ${getAllSymbols().join(', ')}`,
      });
    }

    const validStrategies = ['TrendFollowing', 'MeanReversion', 'MultiTimeframe', 'Momentum', 'Breakout'];
    if (!validStrategies.includes(strategyType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid strategy: ${strategyType}. Available: ${validStrategies.join(', ')}`,
      });
    }

    // Connect to MT5 if needed (for fetching historical data)
    if (!mt5Service.isConnected()) {
      await mt5Service.connect();
    }

    const tf = timeframe || instrument.timeframe || '1h';
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000); // Default 1 year
    const end = endDate ? new Date(endDate) : new Date();

    console.log(`[Backtest] Starting: ${symbol} ${strategyType} ${tf} from ${start.toISOString()} to ${end.toISOString()}`);

    // Fetch historical candles
    const candles = await mt5Service.getCandles(symbol, tf, start, 10000);
    if (!candles || candles.length < 300) {
      return res.status(400).json({
        success: false,
        message: `Insufficient historical data for ${symbol}: got ${candles ? candles.length : 0} candles, need at least 300`,
      });
    }

    // Fetch higher TF candles if needed
    let higherTfCandles = null;
    if (instrument.higherTimeframe) {
      higherTfCandles = await mt5Service.getCandles(symbol, instrument.higherTimeframe, start, 5000);
    }

    // Run backtest
    const result = await backtestEngine.run({
      symbol,
      strategyType,
      timeframe: tf,
      candles,
      higherTfCandles,
      initialBalance: initialBalance || 10000,
    });

    console.log(`[Backtest] Completed: ${result.summary.totalTrades} trades, WR: ${(result.summary.winRate * 100).toFixed(1)}%, PF: ${result.summary.profitFactor}`);

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[Backtest] Error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get all backtest results
// @route   GET /api/backtest/results
exports.getResults = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const results = await backtestEngine.getResults(limit);
    res.json({ success: true, data: results, count: results.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get single backtest result (full details)
// @route   GET /api/backtest/results/:id
exports.getResult = async (req, res) => {
  try {
    const result = await backtestEngine.getResult(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Backtest result not found' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Delete backtest result
// @route   DELETE /api/backtest/results/:id
exports.deleteResult = async (req, res) => {
  try {
    await backtestEngine.deleteResult(req.params.id);
    res.json({ success: true, message: 'Backtest result deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
