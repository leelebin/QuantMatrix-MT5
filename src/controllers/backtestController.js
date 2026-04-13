const backtestEngine = require('../services/backtestEngine');
const batchBacktestService = require('../services/batchBacktestService');
const mt5Service = require('../services/mt5Service');
const websocketService = require('../services/websocketService');
const breakevenService = require('../services/breakevenService');
const Strategy = require('../models/Strategy');
const RiskProfile = require('../models/RiskProfile');
const { getStrategyExecutionConfig } = require('../config/strategyExecution');
const { getInstrument, getAllSymbols } = require('../config/instruments');
const {
  clampDateRangeToNow,
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
    const { symbol, strategyType, timeframe, startDate, endDate, initialBalance, strategyParams } = req.body;

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
    const strategyConfig = await Strategy.findByName(strategyType);
    const activeProfile = await RiskProfile.getActive();
    const effectiveBreakeven = breakevenService.resolveEffectiveBreakeven(activeProfile, strategyConfig);

    // Connect to MT5 if needed (for fetching historical data)
    if (!mt5Service.isConnected()) {
      await mt5Service.connect();
    }

    const executionConfig = getStrategyExecutionConfig(symbol, strategyType) || instrument;
    const tf = timeframe || executionConfig.timeframe || instrument.timeframe || '1h';
    const normalizedRange = normalizeDateRange(startDate, endDate);
    const { start, endExclusive } = clampDateRangeToNow(normalizedRange.start, normalizedRange.endExclusive);
    const rangeEnd = new Date(endExclusive.getTime() - 1);
    const fetchStart = getWarmupStart(start, tf, DEFAULT_WARMUP_BARS);
    const candleLimit = estimateFetchLimit(tf, fetchStart, endExclusive);

    console.log(`[Backtest] Starting: ${symbol} ${strategyType} ${tf} from ${start.toISOString()} to ${rangeEnd.toISOString()}`);

    const higherTimeframe = executionConfig.higherTimeframe || null;
    const entryTimeframe = executionConfig.entryTimeframe || null;

    const candleRequests = [
      mt5Service.getCandles(symbol, tf, fetchStart, candleLimit, endExclusive),
    ];

    let higherTfMeta = null;
    if (higherTimeframe) {
      const higherTfStart = getWarmupStart(start, higherTimeframe, DEFAULT_WARMUP_BARS);
      const higherTfLimit = estimateFetchLimit(higherTimeframe, higherTfStart, endExclusive);
      higherTfMeta = { timeframe: higherTimeframe, start: higherTfStart, limit: higherTfLimit };
      candleRequests.push(mt5Service.getCandles(symbol, higherTimeframe, higherTfStart, higherTfLimit, endExclusive));
    }

    let lowerTfMeta = null;
    if (entryTimeframe) {
      const lowerTfStart = getWarmupStart(start, entryTimeframe, DEFAULT_WARMUP_BARS);
      const lowerTfLimit = estimateFetchLimit(entryTimeframe, lowerTfStart, endExclusive);
      lowerTfMeta = { timeframe: entryTimeframe, start: lowerTfStart, limit: lowerTfLimit };
      candleRequests.push(mt5Service.getCandles(symbol, entryTimeframe, lowerTfStart, lowerTfLimit, endExclusive));
    }

    const responses = await Promise.all(candleRequests);
    const rawCandles = responses[0];
    const candles = filterCandlesByRange(rawCandles, fetchStart, endExclusive);
    const inRangeCandles = filterCandlesByRange(rawCandles, start, endExclusive);

    const fallbackNow = new Date();
    const effectiveStart = inRangeCandles[0] ? new Date(inRangeCandles[0].time) : null;
    const effectiveEnd = inRangeCandles[inRangeCandles.length - 1]
      ? new Date(inRangeCandles[inRangeCandles.length - 1].time)
      : new Date(Math.min(rangeEnd.getTime(), fallbackNow.getTime()));

    console.log(
      `[Backtest] Candle fetch: ${rawCandles.length} raw, ${candles.length} with warmup, ${inRangeCandles.length} in range`
    );

    if (!candles || candles.length < DEFAULT_WARMUP_BARS + 2 || inRangeCandles.length < 50) {
      return res.status(400).json({
        success: false,
        message: `Insufficient historical data for ${symbol} in the selected range: got ${inRangeCandles.length} candles, need at least 50 after warmup (effective end ${effectiveEnd.toISOString()})`,
      });
    }

    let higherTfCandles = null;
    if (higherTfMeta) {
      higherTfCandles = filterCandlesByRange(responses[1], higherTfMeta.start, endExclusive);
    }

    let lowerTfCandles = null;
    if (lowerTfMeta) {
      const lowerIndex = higherTfMeta ? 2 : 1;
      lowerTfCandles = filterCandlesByRange(responses[lowerIndex], lowerTfMeta.start, endExclusive);
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
      tradeStartTime: (effectiveStart || start).toISOString(),
      tradeEndTime: effectiveEnd.toISOString(),
      storedStrategyParameters: strategyConfig?.parameters || null,
      strategyParams: strategyParams || null,
      breakevenConfig: effectiveBreakeven,
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

// @desc    Start batch backtest job
// @route   POST /api/backtest/batch/run
exports.runBatchBacktest = async (req, res) => {
  try {
    const { startDate, endDate, initialBalance, timeframeMode } = req.body;
    const job = await batchBacktestService.startJob(
      {
        startDate,
        endDate,
        initialBalance,
        timeframeMode,
      },
      {
        onProgress: (data) => {
          websocketService.broadcast('status', 'batch_backtest_progress', data);
        },
        onComplete: (data) => {
          websocketService.broadcast('status', 'batch_backtest_complete', data);
        },
        onError: (data) => {
          websocketService.broadcast('status', 'batch_backtest_error', data);
        },
      }
    );

    res.json({
      success: true,
      message: 'Batch backtest started',
      data: await batchBacktestService.getJob(job._id),
    });
  } catch (err) {
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({ success: false, message: err.message });
  }
};

// @desc    Get batch backtest jobs
// @route   GET /api/backtest/batch/jobs
exports.getBatchJobs = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const jobs = await batchBacktestService.getJobs(limit);
    res.json({ success: true, data: jobs, count: jobs.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get batch backtest job summary
// @route   GET /api/backtest/batch/jobs/:id
exports.getBatchJob = async (req, res) => {
  try {
    const job = await batchBacktestService.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ success: false, message: 'Batch backtest job not found' });
    }
    res.json({ success: true, data: job });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get batch backtest job results
// @route   GET /api/backtest/batch/jobs/:id/results
exports.getBatchJobResults = async (req, res) => {
  try {
    const payload = await batchBacktestService.getJobResults(req.params.id, {
      page: req.query.page,
      pageSize: req.query.pageSize,
      strategy: req.query.strategy,
      symbol: req.query.symbol,
      status: req.query.status,
      minTrades: req.query.minTrades,
      sortBy: req.query.sortBy,
      sortDir: req.query.sortDir,
    });

    if (!payload) {
      return res.status(404).json({ success: false, message: 'Batch backtest job not found' });
    }

    res.json({
      success: true,
      data: payload.items,
      pagination: payload.pagination,
      filters: payload.filters,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get batch backtest report
// @route   GET /api/backtest/batch/jobs/:id/report
exports.getBatchJobReport = async (req, res) => {
  try {
    const report = await batchBacktestService.getJobReport(req.params.id);
    if (!report) {
      return res.status(404).json({ success: false, message: 'Batch backtest job not found' });
    }
    res.json({ success: true, data: report });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get child backtest result for a batch job
// @route   GET /api/backtest/batch/jobs/:id/child/:backtestId
exports.getBatchJobChildResult = async (req, res) => {
  try {
    const result = await batchBacktestService.getJobChildResult(req.params.id, req.params.backtestId);
    if (!result) {
      return res.status(404).json({ success: false, message: 'Batch child backtest not found' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
