const optimizerService = require('../services/optimizerService');
const mt5Service = require('../services/mt5Service');
const websocketService = require('../services/websocketService');
const notificationService = require('../services/notificationService');
const { getInstrument, getAllSymbols } = require('../config/instruments');

// @desc    Run optimizer
// @route   POST /api/optimizer/run
exports.runOptimizer = async (req, res) => {
  try {
    const { symbol, strategyType, timeframe, startDate, endDate, paramRanges, optimizeFor } = req.body;

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

    if (optimizerService.running) {
      return res.status(409).json({ success: false, message: 'Optimizer is already running' });
    }

    // Connect to MT5 if needed
    if (!mt5Service.isConnected()) {
      await mt5Service.connect();
    }

    const tf = timeframe || instrument.timeframe || '1h';
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    // Fetch candles
    const candles = await mt5Service.getCandles(symbol, tf, start, 10000);
    if (!candles || candles.length < 300) {
      return res.status(400).json({
        success: false,
        message: `Insufficient data: got ${candles ? candles.length : 0} candles, need 300+`,
      });
    }

    let higherTfCandles = null;
    if (instrument.higherTimeframe) {
      higherTfCandles = await mt5Service.getCandles(symbol, instrument.higherTimeframe, start, 5000);
    }

    // Start optimizer in background
    res.json({
      success: true,
      message: 'Optimizer started',
      data: {
        symbol,
        strategyType,
        candles: candles.length,
        paramRanges: paramRanges || optimizerService.getDefaultRanges(strategyType),
      },
    });

    // Run async
    try {
      const result = await optimizerService.run({
        symbol,
        strategyType,
        candles,
        higherTfCandles,
        paramRanges: paramRanges || undefined,
        optimizeFor: optimizeFor || 'profitFactor',
      });

      websocketService.broadcast('status', 'optimizer_complete', result);
      await notificationService.notifyOptimizerComplete(result);
    } catch (err) {
      console.error('[Optimizer] Error:', err.message);
      websocketService.broadcast('status', 'optimizer_error', { error: err.message });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get optimizer progress
// @route   GET /api/optimizer/progress
exports.getProgress = (req, res) => {
  res.json({ success: true, data: optimizerService.getProgress() });
};

// @desc    Get last optimizer result
// @route   GET /api/optimizer/result
exports.getResult = (req, res) => {
  const result = optimizerService.getLastResult();
  if (!result) {
    return res.status(404).json({ success: false, message: 'No optimizer results available' });
  }
  // Return without allResults to keep response size manageable
  const { allResults, ...summary } = result;
  res.json({ success: true, data: summary });
};

// @desc    Get full optimizer result with all combinations
// @route   GET /api/optimizer/result/full
exports.getFullResult = (req, res) => {
  const result = optimizerService.getLastResult();
  if (!result) {
    return res.status(404).json({ success: false, message: 'No optimizer results available' });
  }
  res.json({ success: true, data: result });
};

// @desc    Get default parameter ranges for a strategy
// @route   GET /api/optimizer/ranges/:strategyType
exports.getDefaultRanges = (req, res) => {
  const ranges = optimizerService.getDefaultRanges(req.params.strategyType);
  if (!ranges) {
    return res.status(404).json({ success: false, message: 'No default ranges for this strategy' });
  }
  res.json({ success: true, data: ranges });
};
