const backtestEngine = require('../services/backtestEngine');
const mt5Service = require('../services/mt5Service');
const { getInstrument, getAllSymbols } = require('../config/instruments');
const {
  DEFAULT_WARMUP_BARS,
  estimateFetchLimit,
  filterCandlesByRange,
  getWarmupStart,
  normalizeDateRange,
} = require('../utils/candleRange');

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
    const { start, endExclusive } = normalizeDateRange(startDate, endDate);
    const rangeEnd = new Date(endExclusive.getTime() - 1);
    const fetchStart = getWarmupStart(start, tf, DEFAULT_WARMUP_BARS);
    const candleLimit = estimateFetchLimit(tf, fetchStart, endExclusive);

    console.log(`[Backtest] Starting: ${symbol} ${strategyType} ${tf} from ${start.toISOString()} to ${rangeEnd.toISOString()}`);

    // Fetch historical candles
    const rawCandles = await mt5Service.getCandles(symbol, tf, fetchStart, candleLimit);
    const candles = filterCandlesByRange(rawCandles, fetchStart, endExclusive);
    const inRangeCandles = filterCandlesByRange(rawCandles, start, endExclusive);

    if (!candles || candles.length < DEFAULT_WARMUP_BARS + 2 || inRangeCandles.length < 50) {
      return res.status(400).json({
        success: false,
        message: `Insufficient historical data for ${symbol} in the selected range: got ${inRangeCandles.length} candles, need at least 50 after warmup`,
      });
    }

    // Fetch higher TF candles if needed
    let higherTfCandles = null;
    if (instrument.higherTimeframe) {
      const higherTfStart = getWarmupStart(start, instrument.higherTimeframe, DEFAULT_WARMUP_BARS);
      const higherTfLimit = estimateFetchLimit(instrument.higherTimeframe, higherTfStart, endExclusive);
      const rawHigherTfCandles = await mt5Service.getCandles(
        symbol,
        instrument.higherTimeframe,
        higherTfStart,
        higherTfLimit
      );
      higherTfCandles = filterCandlesByRange(rawHigherTfCandles, higherTfStart, endExclusive);
    }

    let lowerTfCandles = null;
    if (instrument.entryTimeframe) {
      const lowerTfStart = getWarmupStart(start, instrument.entryTimeframe, DEFAULT_WARMUP_BARS);
      const lowerTfLimit = estimateFetchLimit(instrument.entryTimeframe, lowerTfStart, endExclusive);
      const rawLowerTfCandles = await mt5Service.getCandles(
        symbol,
        instrument.entryTimeframe,
        lowerTfStart,
        lowerTfLimit
      );
      lowerTfCandles = filterCandlesByRange(rawLowerTfCandles, lowerTfStart, endExclusive);
    }

    // Run backtest
    const result = await backtestEngine.run({
      symbol,
      strategyType,
      timeframe: tf,
      candles,
      higherTfCandles,
      lowerTfCandles,
      initialBalance: initialBalance || 10000,
      tradeStartTime: start.toISOString(),
      tradeEndTime: rangeEnd.toISOString(),
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
