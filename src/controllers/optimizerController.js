const optimizerService = require('../services/optimizerService');
const mt5Service = require('../services/mt5Service');
const websocketService = require('../services/websocketService');
const notificationService = require('../services/notificationService');
const Strategy = require('../models/Strategy');
const OptimizerRun = require('../models/OptimizerRun');
const RiskProfile = require('../models/RiskProfile');
const breakevenService = require('../services/breakevenService');
const { getStrategyInstance } = require('../services/strategyInstanceService');
const {
  FORCED_TIMEFRAME_OPTIONS,
  getForcedTimeframeExecutionConfig,
  getStrategyExecutionConfig,
  isValidForcedTimeframe,
} = require('../config/strategyExecution');
const { getInstrument, getAllSymbols } = require('../config/instruments');
const {
  clampDateRangeToNow,
  DEFAULT_WARMUP_BARS,
  estimateFetchLimit,
  filterCandlesByRange,
  getWarmupStart,
  normalizeDateRange,
} = require('../utils/candleRange');

const DEFAULT_OPTIMIZER_INITIAL_BALANCE = 10000;

function normalizeInitialBalanceInput(value) {
  if (value == null || value === '') return DEFAULT_OPTIMIZER_INITIAL_BALANCE;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    const err = new Error('initialBalance must be a positive number');
    err.statusCode = 400;
    throw err;
  }

  return parsed;
}

// @desc    Run optimizer
// @route   POST /api/optimizer/run
exports.runOptimizer = async (req, res) => {
  try {
    const {
      symbol,
      strategyType,
      timeframe,
      startDate,
      endDate,
      paramRanges,
      optimizeFor,
      parallelWorkers,
      initialBalance,
    } = req.body;
    const normalizedInitialBalance = normalizeInitialBalanceInput(initialBalance);
    const instrument = getInstrument(symbol);
    if (!instrument) {
      return res.status(400).json({
        success: false,
        message: `Invalid symbol: ${symbol}. Available: ${getAllSymbols().join(', ')}`,
      });
    }

    const validStrategies = ['TrendFollowing', 'MeanReversion', 'MultiTimeframe', 'Momentum', 'Breakout', 'VolumeFlowHybrid'];
    if (!validStrategies.includes(strategyType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid strategy: ${strategyType}. Available: ${validStrategies.join(', ')}`,
      });
    }

    if (timeframe && !isValidForcedTimeframe(timeframe)) {
      return res.status(400).json({
        success: false,
        message: `Invalid timeframe: ${timeframe}. Allowed: ${FORCED_TIMEFRAME_OPTIONS.join(', ')}`,
      });
    }

    if (optimizerService.running) {
      return res.status(409).json({ success: false, message: 'Optimizer is already running' });
    }

    const strategyInstance = await getStrategyInstance(symbol, strategyType);
    const effectiveBreakeven = strategyInstance.effectiveBreakeven
      || strategyInstance.effectiveTradeManagement?.breakeven
      || breakevenService.resolveEffectiveBreakeven(
        await RiskProfile.getActive(),
        await Strategy.findByName(strategyType)
      );

    // Connect to MT5 if needed
    if (!mt5Service.isConnected()) {
      await mt5Service.connect();
    }

    const executionConfig = timeframe
      ? getForcedTimeframeExecutionConfig(symbol, strategyType, timeframe)
      : (getStrategyExecutionConfig(symbol, strategyType) || instrument);
    const tf = executionConfig.timeframe || instrument.timeframe || timeframe || '1h';
    const normalizedRange = normalizeDateRange(startDate, endDate);
    const { start, endExclusive } = clampDateRangeToNow(normalizedRange.start, normalizedRange.endExclusive);
    const rangeEnd = new Date(endExclusive.getTime() - 1);
    const fetchStart = getWarmupStart(start, tf, DEFAULT_WARMUP_BARS);
    const candleLimit = estimateFetchLimit(tf, fetchStart, endExclusive);
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
      `[Optimizer] Candle fetch: ${rawCandles.length} raw, ${candles.length} with warmup, ${inRangeCandles.length} in range`
    );

    if (!candles || candles.length < DEFAULT_WARMUP_BARS + 2 || inRangeCandles.length < 50) {
      return res.status(400).json({
        success: false,
        message: `Insufficient data in the selected range: got ${inRangeCandles.length} candles, need at least 50 after warmup`,
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

    // Start optimizer in background
    res.json({
      success: true,
      message: 'Optimizer started',
      data: {
        symbol,
        strategyType,
        initialBalance: normalizedInitialBalance,
        candles: candles.length,
        paramRanges: paramRanges || optimizerService.getDefaultRanges(strategyType),
      },
    });

    // Run async
    try {
      const result = await optimizerService.run({
        symbol,
        strategyType,
        timeframe: tf,
        candles,
        higherTfCandles,
        lowerTfCandles,
        initialBalance: normalizedInitialBalance,
        paramRanges: paramRanges || undefined,
        optimizeFor: optimizeFor || 'profitFactor',
        parallelWorkers: parallelWorkers || undefined,
        tradeStartTime: (effectiveStart || start).toISOString(),
        tradeEndTime: effectiveEnd.toISOString(),
        storedStrategyParameters: strategyInstance.parameters,
        breakevenConfig: effectiveBreakeven,
        executionPolicy: strategyInstance.executionPolicy,
        onProgress: (progress) => {
          websocketService.broadcast('status', 'optimizer_progress', progress);
        },
      });
      let historyRecord = null;
      try {
        historyRecord = await OptimizerRun.createFromResult(result, {
          period: {
            start: (effectiveStart || start).toISOString(),
            end: effectiveEnd.toISOString(),
          },
        });
      } catch (historyErr) {
        console.error('[Optimizer] Failed to save history:', historyErr.message);
      }
      const payload = {
        ...result,
        historyId: historyRecord && historyRecord._id ? historyRecord._id : null,
      };

      if (result.stopped) {
        websocketService.broadcast('status', 'optimizer_stopped', payload);
      } else {
        websocketService.broadcast('status', 'optimizer_complete', payload);
        await notificationService.notifyOptimizerComplete(payload);
      }
    } catch (err) {
      console.error('[Optimizer] Error:', err.message);
      websocketService.broadcast('status', 'optimizer_error', { error: err.message });
    }
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

// @desc    Request optimizer stop
// @route   POST /api/optimizer/stop
exports.stopOptimizer = (req, res) => {
  const stopState = optimizerService.requestStop();

  if (stopState.accepted) {
    websocketService.broadcast('status', 'optimizer_stop_requested', stopState);
  }

  res.json({
    success: true,
    message: stopState.message,
    data: stopState,
  });
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

// @desc    Get optimizer history
// @route   GET /api/optimizer/history
exports.getHistory = async (req, res) => {
  try {
    const requested = Number(req.query.limit);
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), 100)
      : 50;
    const history = await OptimizerRun.findAll(limit);
    res.json({ success: true, data: history });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get latest optimizer best-result for a symbol + strategy
// @route   GET /api/optimizer/latest
exports.getLatestBestResult = async (req, res) => {
  try {
    const symbol = String(req.query.symbol || '').trim();
    const strategy = String(req.query.strategy || '').trim();

    if (!symbol || !strategy) {
      return res.status(400).json({
        success: false,
        message: 'symbol and strategy are required',
      });
    }

    const record = await OptimizerRun.findLatestBestResult(symbol, strategy);
    if (!record || !record.bestResult || !record.bestResult.parameters) {
      return res.status(404).json({
        success: false,
        message: `No optimizer best result found for ${symbol} / ${strategy}`,
      });
    }

    res.json({
      success: true,
      data: {
        historyId: record._id,
        symbol: record.symbol,
        strategy: record.strategy,
        timeframe: record.timeframe || null,
        initialBalance: record.initialBalance,
        optimizeFor: record.optimizeFor || null,
        completedAt: record.completedAt || null,
        createdAt: record.createdAt || null,
        bestResult: record.bestResult,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get optimizer history detail
// @route   GET /api/optimizer/history/:id
exports.getHistoryDetail = async (req, res) => {
  try {
    const record = await OptimizerRun.findById(req.params.id);
    if (!record) {
      return res.status(404).json({ success: false, message: 'Optimizer history record not found' });
    }
    res.json({ success: true, data: record });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
