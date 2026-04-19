const backtestEngine = require('./backtestEngine');
const mt5Service = require('./mt5Service');
const strategyEngine = require('./strategyEngine');
const breakevenService = require('./breakevenService');
const { runSharedPortfolioBacktest } = require('./sharedPortfolioBacktest');
const Strategy = require('../models/Strategy');
const RiskProfile = require('../models/RiskProfile');
const BatchBacktestJob = require('../models/BatchBacktestJob');
const { getAllSymbols } = require('../config/instruments');
const { getStrategyInstance } = require('./strategyInstanceService');
const {
  FORCED_TIMEFRAME_OPTIONS,
  getStrategyExecutionConfig,
  getForcedTimeframeExecutionConfig,
  isValidForcedTimeframe,
} = require('../config/strategyExecution');
const {
  clampDateRangeToNow,
  DEFAULT_WARMUP_BARS,
  estimateFetchLimit,
  filterCandlesByRange,
  getWarmupStart,
  normalizeDateRange,
} = require('../utils/candleRange');
const {
  buildBatchAggregate,
  buildBatchReport,
  buildSharedPortfolioReport,
  filterBatchResults,
  paginateBatchResults,
  sortBatchResults,
} = require('../utils/batchBacktestAnalysis');

const RUN_MODELS = ['independent', 'shared_portfolio'];

function buildCombinationKey(symbol, strategy) {
  return `${symbol}:${strategy}`;
}

class BatchBacktestService {
  constructor() {
    this.activeJobId = null;
  }

  get running() {
    return Boolean(this.activeJobId);
  }

  async startJob(params = {}, hooks = {}) {
    if (this.activeJobId) {
      const error = new Error('A batch backtest job is already running');
      error.statusCode = 409;
      throw error;
    }

    const normalizedRange = normalizeDateRange(params.startDate, params.endDate);
    const { start, endExclusive } = clampDateRangeToNow(normalizedRange.start, normalizedRange.endExclusive);
    const rangeEnd = new Date(endExclusive.getTime() - 1);

    const runModel = params.runModel || 'independent';
    if (!RUN_MODELS.includes(runModel)) {
      const error = new Error(
        `Unsupported runModel: ${runModel}. Expected one of: ${RUN_MODELS.join(', ')}.`
      );
      error.statusCode = 400;
      throw error;
    }

    const timeframeMode = params.timeframeMode || 'strategy_default';
    if (!['strategy_default', 'forced_timeframe'].includes(timeframeMode)) {
      const error = new Error(
        `Unsupported timeframeMode: ${timeframeMode}. Expected 'strategy_default' or 'forced_timeframe'.`
      );
      error.statusCode = 400;
      throw error;
    }

    let forcedTimeframe = null;
    if (timeframeMode === 'forced_timeframe') {
      forcedTimeframe = params.forcedTimeframe;
      if (!isValidForcedTimeframe(forcedTimeframe)) {
        const error = new Error(
          `Invalid forcedTimeframe: ${forcedTimeframe}. Allowed: ${FORCED_TIMEFRAME_OPTIONS.join(', ')}`
        );
        error.statusCode = 400;
        throw error;
      }
    }

    const strategyScopeMode = params.strategyScopeMode || 'enabled_assigned_only';
    if (!['enabled_assigned_only', 'all_strategies'].includes(strategyScopeMode)) {
      const error = new Error(
        `Unsupported strategyScopeMode: ${strategyScopeMode}. Expected 'enabled_assigned_only' or 'all_strategies'.`
      );
      error.statusCode = 400;
      throw error;
    }

    const strategyInfos = strategyEngine.getStrategiesInfo();
    await Strategy.initDefaults(strategyInfos);
    const strategyRecords = await Strategy.findAll();
    const eligibleScope = strategyScopeMode === 'all_strategies'
      ? this._buildAllStrategiesScope(strategyInfos)
      : await this._buildEligibleScope(strategyRecords);

    if (eligibleScope.combinations.length === 0) {
      const error = new Error(
        strategyScopeMode === 'all_strategies'
          ? 'No strategies or symbols available for all_strategies scope.'
          : 'No enabled strategy assignments are available for batch backtest. Assign strategies to symbols in Strategies first.'
      );
      error.statusCode = 400;
      throw error;
    }

    const combinations = eligibleScope.combinations;
    const progress = this._createProgress(combinations.length);

    const job = await BatchBacktestJob.create({
      status: 'queued',
      scope: {
        symbols: eligibleScope.symbols,
        strategies: eligibleScope.strategies,
        assignmentsBySymbol: eligibleScope.assignmentsBySymbol,
        eligibilityRule: eligibleScope.eligibilityRule,
      },
      runModel,
      period: {
        start: start.toISOString(),
        end: rangeEnd.toISOString(),
      },
      initialBalance: Number(params.initialBalance) || 10000,
      strategyScopeMode,
      timeframeMode,
      forcedTimeframe,
      progress,
      aggregate: null,
      results: [],
      reportText: '',
      reportMarkdown: '',
      error: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    });

    this.activeJobId = job._id;

    setImmediate(() => {
      this._runJob(job._id, hooks).catch((err) => {
        console.error('[Batch Backtest] Fatal job error:', err.message);
      });
    });

    return job;
  }

  async _runJob(jobId, hooks = {}) {
    let progress = null;
    try {
      let job = await BatchBacktestJob.findById(jobId);
      if (!job) {
        throw new Error(`Batch backtest job not found: ${jobId}`);
      }

      if (!mt5Service.isConnected()) {
        await mt5Service.connect();
      }

      const strategyInfos = strategyEngine.getStrategiesInfo();
      await Strategy.initDefaults(strategyInfos);
      const strategyRecords = await Strategy.findAll();
      const activeProfile = await RiskProfile.getActive();
      const effectiveBreakevenByStrategy = new Map(
        strategyRecords.map((strategy) => [
          strategy.name,
          breakevenService.resolveEffectiveBreakeven(activeProfile, strategy),
        ])
      );

      const start = new Date(job.period.start);
      const endExclusive = new Date(new Date(job.period.end).getTime() + 1);
      const combinations = this._buildCombinationsFromScope(job.scope || {});
      const storedParametersByCombination = await this._buildStoredParametersByCombination(combinations);
      const jobTimeframeMode = job.timeframeMode || 'strategy_default';
      const jobForcedTimeframe = jobTimeframeMode === 'forced_timeframe' ? job.forcedTimeframe || null : null;
      const jobRunModel = job.runModel || 'independent';
      const candleCache = new Map();

      if (jobRunModel === 'shared_portfolio') {
        return await this._runSharedPortfolioJob(jobId, {
          job,
          combinations,
          start,
          endExclusive,
          candleCache,
          storedParametersByCombination,
          effectiveBreakevenByStrategy,
          jobForcedTimeframe,
          hooks,
        });
      }

      const results = [];

      progress = {
        ...(job.progress || this._createProgress(combinations.length)),
        total: combinations.length,
        queued: 0,
        percent: 0,
      };

      job = await BatchBacktestJob.update(jobId, {
        status: 'running',
        startedAt: new Date().toISOString(),
        progress,
      });

      for (let index = 0; index < combinations.length; index++) {
        const combo = combinations[index];
        progress.current = index + 1;
        progress.queued = Math.max(0, progress.total - progress.current + 1);
        progress.currentSymbol = combo.symbol;
        progress.currentStrategy = combo.strategy;

        let resultItem;
        try {
          resultItem = await this._runCombination({
            jobId,
            combo,
            start,
            endExclusive,
            initialBalance: job.initialBalance,
            candleCache,
            storedStrategyParameters: storedParametersByCombination.get(
              buildCombinationKey(combo.symbol, combo.strategy)
            ) || {},
            breakevenConfig: effectiveBreakevenByStrategy.get(combo.strategy) || breakevenService.getDefaultBreakevenConfig(),
            forcedTimeframe: jobForcedTimeframe,
          });
        } catch (err) {
          resultItem = {
            symbol: combo.symbol,
            strategy: combo.strategy,
            timeframe: null,
            status: this._classifyError(err),
            summary: null,
            parameters: null,
            parameterSource: null,
            error: err.message,
            backtestId: null,
          };
        }

        results.push(resultItem);
        progress = this._advanceProgress(progress, resultItem.status);

        await BatchBacktestJob.update(jobId, {
          progress,
          results,
        });

        if (typeof hooks.onProgress === 'function') {
          hooks.onProgress({
            jobId,
            status: 'running',
            progress,
            latestResult: resultItem,
          });
        }
      }

      const aggregate = buildBatchAggregate(results, { initialBalance: job.initialBalance });
      const report = buildBatchReport(job, aggregate);
      const completedJob = await BatchBacktestJob.update(jobId, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        progress: {
          ...progress,
          percent: 100,
          queued: 0,
        },
        aggregate,
        results,
        reportText: report.reportText,
        reportMarkdown: report.reportMarkdown,
        recommendations: report.recommendations,
        error: null,
      });

      if (typeof hooks.onComplete === 'function') {
        hooks.onComplete(await this.getJob(jobId));
      }

      return completedJob;
    } catch (err) {
      await BatchBacktestJob.update(jobId, {
        status: 'error',
        completedAt: new Date().toISOString(),
        error: err.message,
        progress: progress
          ? {
              ...progress,
              queued: Math.max(0, progress.total - progress.current),
            }
          : null,
      });

      if (typeof hooks.onError === 'function') {
        hooks.onError({
          jobId,
          status: 'error',
          error: err.message,
          progress,
        });
      }

      return null;
    } finally {
      if (this.activeJobId === jobId) {
        this.activeJobId = null;
      }
    }
  }

  async _runSharedPortfolioJob(jobId, {
    job,
    combinations,
    start,
    endExclusive,
    candleCache,
    storedParametersByCombination,
    effectiveBreakevenByStrategy,
    jobForcedTimeframe,
    hooks,
  }) {
    const progress = {
      ...(job.progress || this._createProgress(combinations.length)),
      total: combinations.length,
      current: 0,
      queued: combinations.length,
      percent: 0,
      phase: 'prepare',
      runModel: 'shared_portfolio',
    };

    await BatchBacktestJob.update(jobId, {
      status: 'running',
      startedAt: new Date().toISOString(),
      progress,
    });

    const fetchCandles = async (symbol, timeframe) => {
      return this._fetchCandlesWindow(candleCache, symbol, timeframe, start, endExclusive);
    };

    const portfolioResult = await runSharedPortfolioBacktest({
      combinations,
      initialBalance: job.initialBalance,
      start,
      endExclusive,
      fetchCandles,
      storedParametersByCombination,
      breakevenByStrategy: effectiveBreakevenByStrategy,
      forcedTimeframe: jobForcedTimeframe,
      onProgress: async (update) => {
        if (update.phase === 'prepare') {
          progress.phase = 'prepare';
          progress.current = update.preparedCount || 0;
          progress.queued = Math.max(0, progress.total - progress.current);
          progress.percent = progress.total > 0
            ? Math.round((progress.current / progress.total) * 50)
            : 0;
          progress.currentSymbol = update.currentSymbol;
          progress.currentStrategy = update.currentStrategy;
        } else if (update.phase === 'simulate') {
          progress.phase = 'simulate';
          progress.percent = 50 + Math.round((update.percent || 0) * 0.5);
          progress.balance = update.balance;
          progress.openPositions = update.openPositions;
          progress.trades = update.trades;
          progress.processedEvents = update.processedEvents;
          progress.totalEvents = update.totalEvents;
        }

        if (typeof hooks.onProgress === 'function') {
          hooks.onProgress({
            jobId,
            status: 'running',
            runModel: 'shared_portfolio',
            progress: { ...progress },
          });
        }
      },
    });

    // Convert skipped entries into synthetic "results" so the results table
    // (filters + listing) continues to work for the portfolio job.
    const syntheticResults = (portfolioResult.skipped || []).map((item) => ({
      symbol: item.symbol,
      strategy: item.strategy,
      timeframe: item.timeframe || null,
      status: item.status || 'error',
      summary: null,
      parameters: null,
      parameterSource: null,
      error: item.reason || null,
      backtestId: null,
    }));

    const report = buildSharedPortfolioReport(
      { ...job, runModel: 'shared_portfolio' },
      portfolioResult
    );

    const finalProgress = {
      ...progress,
      percent: 100,
      queued: 0,
      phase: 'completed',
      current: combinations.length,
      trades: portfolioResult.summary.totalTrades,
      balance: portfolioResult.summary.finalBalance,
      openPositions: 0,
    };

    const completedJob = await BatchBacktestJob.update(jobId, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      progress: finalProgress,
      aggregate: null,
      portfolioResult,
      results: syntheticResults,
      reportText: report.reportText,
      reportMarkdown: report.reportMarkdown,
      recommendations: report.recommendations,
      error: null,
    });

    if (typeof hooks.onComplete === 'function') {
      hooks.onComplete(await this.getJob(jobId));
    }

    return completedJob;
  }

  async _runCombination({
    jobId,
    combo,
    start,
    endExclusive,
    initialBalance,
    candleCache,
    storedStrategyParameters,
    breakevenConfig,
    forcedTimeframe = null,
  }) {
    const executionConfig = forcedTimeframe
      ? getForcedTimeframeExecutionConfig(combo.symbol, combo.strategy, forcedTimeframe)
      : getStrategyExecutionConfig(combo.symbol, combo.strategy);
    if (!executionConfig) {
      throw new Error(`Unknown symbol: ${combo.symbol}`);
    }

    const primaryWindow = await this._fetchCandlesWindow(
      candleCache,
      combo.symbol,
      executionConfig.timeframe,
      start,
      endExclusive
    );

    if (
      !primaryWindow.candles ||
      primaryWindow.candles.length < DEFAULT_WARMUP_BARS + 2 ||
      primaryWindow.inRangeCandles.length < 50
    ) {
      return {
        symbol: combo.symbol,
        strategy: combo.strategy,
        timeframe: executionConfig.timeframe,
        higherTimeframe: executionConfig.higherTimeframe || null,
        entryTimeframe: executionConfig.entryTimeframe || null,
        status: 'insufficient_data',
        summary: null,
        parameters: null,
        parameterSource: null,
        error: `Insufficient historical data: ${primaryWindow.inRangeCandles.length} candles in range`,
        backtestId: null,
      };
    }

    let higherTfCandles = null;
    if (executionConfig.higherTimeframe) {
      const higherWindow = await this._fetchCandlesWindow(
        candleCache,
        combo.symbol,
        executionConfig.higherTimeframe,
        start,
        endExclusive
      );
      higherTfCandles = higherWindow.candles;
    }

    let lowerTfCandles = null;
    if (executionConfig.entryTimeframe) {
      const lowerWindow = await this._fetchCandlesWindow(
        candleCache,
        combo.symbol,
        executionConfig.entryTimeframe,
        start,
        endExclusive
      );
      lowerTfCandles = lowerWindow.candles;
    }

    const tradeEnd = new Date(endExclusive.getTime() - 1);
    const result = await backtestEngine.run({
      symbol: combo.symbol,
      strategyType: combo.strategy,
      timeframe: executionConfig.timeframe,
      candles: primaryWindow.candles,
      higherTfCandles,
      lowerTfCandles,
      initialBalance,
      tradeStartTime: start.toISOString(),
      tradeEndTime: tradeEnd.toISOString(),
      storedStrategyParameters,
      breakevenConfig,
      batchJobId: jobId,
      executionConfigOverride: forcedTimeframe ? executionConfig : null,
    });

    return {
      symbol: combo.symbol,
      strategy: combo.strategy,
      timeframe: executionConfig.timeframe,
      higherTimeframe: executionConfig.higherTimeframe || null,
      entryTimeframe: executionConfig.entryTimeframe || null,
      forcedTimeframe: forcedTimeframe || null,
      higherTimeframeDisabled: executionConfig.higherTimeframeDisabled || null,
      entryTimeframeDisabled: executionConfig.entryTimeframeDisabled || null,
      status: result.summary.totalTrades > 0 ? 'completed' : 'no_trades',
      summary: result.summary,
      parameters: result.parameters,
      parameterSource: result.parameterSource,
      error: null,
      backtestId: result.backtestId,
    };
  }

  _buildCombinations(symbols, strategies) {
    const combinations = [];
    for (const symbol of symbols) {
      for (const strategy of strategies) {
        combinations.push({ symbol, strategy });
      }
    }
    return combinations;
  }

  async _buildEligibleScope(strategyRecords = []) {
    const validSymbols = getAllSymbols();
    const validSymbolSet = new Set(validSymbols);
    const assignmentsBySymbol = new Map();
    const strategies = [];
    const seenStrategies = new Set();

    for (const strategyRecord of strategyRecords) {
      if (!Array.isArray(strategyRecord.symbols)) {
        continue;
      }

      const eligibleSymbols = [];
      const symbols = [...new Set(strategyRecord.symbols)]
        .filter((symbol) => validSymbolSet.has(symbol));

      for (const symbol of symbols) {
        const strategyInstance = await getStrategyInstance(symbol, strategyRecord.name);
        if (strategyInstance.enabled === false) {
          continue;
        }
        eligibleSymbols.push(symbol);
      }

      if (eligibleSymbols.length === 0) {
        continue;
      }

      if (!seenStrategies.has(strategyRecord.name)) {
        seenStrategies.add(strategyRecord.name);
        strategies.push(strategyRecord.name);
      }

      eligibleSymbols.forEach((symbol) => {
        if (!assignmentsBySymbol.has(symbol)) {
          assignmentsBySymbol.set(symbol, []);
        }

        const assignedStrategies = assignmentsBySymbol.get(symbol);
        if (!assignedStrategies.includes(strategyRecord.name)) {
          assignedStrategies.push(strategyRecord.name);
        }
      });
    }

    const symbols = validSymbols.filter((symbol) => assignmentsBySymbol.has(symbol));
    const normalizedAssignmentsBySymbol = Object.fromEntries(
      symbols.map((symbol) => [symbol, assignmentsBySymbol.get(symbol)])
    );

    return {
      symbols,
      strategies,
      assignmentsBySymbol: normalizedAssignmentsBySymbol,
      eligibilityRule: 'enabled_assignments',
      combinations: this._buildCombinationsFromScope({
        symbols,
        strategies,
        assignmentsBySymbol: normalizedAssignmentsBySymbol,
      }),
    };
  }

  // Builds a full cross product of every registered strategy and every
  // supported symbol, irrespective of user assignments or enabled flags.
  // This is the input for the `all_strategies` scope mode — useful for
  // exploratory benchmarks across the complete strategy library.
  _buildAllStrategiesScope(strategyInfos = []) {
    const validSymbols = getAllSymbols();
    const strategies = strategyInfos
      .map((info) => (info && info.name ? info.name : null))
      .filter(Boolean);

    const assignmentsBySymbol = Object.fromEntries(
      validSymbols.map((symbol) => [symbol, [...strategies]])
    );

    return {
      symbols: validSymbols,
      strategies,
      assignmentsBySymbol,
      eligibilityRule: 'all_strategies',
      combinations: this._buildCombinationsFromScope({
        symbols: validSymbols,
        strategies,
        assignmentsBySymbol,
      }),
    };
  }

  _buildCombinationsFromScope(scope = {}) {
    const assignmentsBySymbol = scope.assignmentsBySymbol;
    if (assignmentsBySymbol && typeof assignmentsBySymbol === 'object' && !Array.isArray(assignmentsBySymbol)) {
      const orderedSymbols = Array.isArray(scope.symbols) && scope.symbols.length > 0
        ? scope.symbols
        : Object.keys(assignmentsBySymbol);
      const allowedStrategies = Array.isArray(scope.strategies) && scope.strategies.length > 0
        ? new Set(scope.strategies)
        : null;
      const combinations = [];
      const seen = new Set();

      for (const symbol of orderedSymbols) {
        const strategies = Array.isArray(assignmentsBySymbol[symbol]) ? assignmentsBySymbol[symbol] : [];
        for (const strategy of strategies) {
          if (allowedStrategies && !allowedStrategies.has(strategy)) {
            continue;
          }

          const key = `${symbol}:${strategy}`;
          if (seen.has(key)) {
            continue;
          }

          seen.add(key);
          combinations.push({ symbol, strategy });
        }
      }

      return combinations;
    }

    return this._buildCombinations(scope.symbols || [], scope.strategies || []);
  }

  async _buildStoredParametersByCombination(combinations = []) {
    const storedParameters = new Map();

    for (const combo of combinations) {
      const strategyInstance = await getStrategyInstance(combo.symbol, combo.strategy);
      storedParameters.set(
        buildCombinationKey(combo.symbol, combo.strategy),
        strategyInstance.parameters || {}
      );
    }

    return storedParameters;
  }

  _createProgress(total) {
    return {
      total,
      current: 0,
      percent: 0,
      queued: total,
      completedRuns: 0,
      noTradeRuns: 0,
      insufficientDataRuns: 0,
      errorRuns: 0,
      currentSymbol: null,
      currentStrategy: null,
    };
  }

  _advanceProgress(progress, status) {
    const next = {
      ...progress,
      percent: progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 100,
    };

    if (status === 'completed') next.completedRuns += 1;
    else if (status === 'no_trades') next.noTradeRuns += 1;
    else if (status === 'insufficient_data') next.insufficientDataRuns += 1;
    else next.errorRuns += 1;

    return next;
  }

  async _fetchCandlesWindow(cache, symbol, timeframe, start, endExclusive) {
    const fetchStart = getWarmupStart(start, timeframe, DEFAULT_WARMUP_BARS);
    const candleLimit = estimateFetchLimit(timeframe, fetchStart, endExclusive);
    const cacheKey = [
      symbol,
      timeframe,
      fetchStart.toISOString(),
      endExclusive.toISOString(),
      candleLimit,
    ].join(':');

    if (!cache.has(cacheKey)) {
      cache.set(
        cacheKey,
        mt5Service.getCandles(symbol, timeframe, fetchStart, candleLimit, endExclusive).then((rawCandles) => {
          return {
            candles: filterCandlesByRange(rawCandles, fetchStart, endExclusive),
            inRangeCandles: filterCandlesByRange(rawCandles, start, endExclusive),
            fetchStart,
            endExclusive,
          };
        })
      );
    }

    return cache.get(cacheKey);
  }

  _classifyError(err) {
    const message = String(err && err.message ? err.message : err || '').toLowerCase();
    if (message.includes('insufficient') || message.includes('need at least') || message.includes('historical data')) {
      return 'insufficient_data';
    }
    return 'error';
  }

  async getJobs(limit = 20) {
    const jobs = await BatchBacktestJob.findAll(limit);
    return jobs.map((job) => {
      const summary = BatchBacktestJob.toSummary(job);
      // For list view only expose the portfolio summary header, not the
      // full trades/equityCurve payload (can be tens of MB on big jobs).
      if (summary.portfolioResult) {
        summary.portfolioResult = {
          runModel: summary.portfolioResult.runModel,
          initialBalance: summary.portfolioResult.initialBalance,
          finalBalance: summary.portfolioResult.finalBalance,
          summary: summary.portfolioResult.summary,
          combinationsRequested: summary.portfolioResult.combinationsRequested,
          combinationsUsed: (summary.portfolioResult.combinationsUsed || []).length,
        };
      }
      return {
        ...summary,
        reportAvailable: Boolean(job.reportText || job.reportMarkdown),
        error: job.error || null,
      };
    });
  }

  async getJob(jobId) {
    const job = await BatchBacktestJob.findById(jobId);
    if (!job) return null;

    return {
      ...BatchBacktestJob.toSummary(job),
      reportAvailable: Boolean(job.reportText || job.reportMarkdown),
      error: job.error || null,
      recommendations: job.recommendations || [],
    };
  }

  async getJobResults(jobId, query = {}) {
    const job = await BatchBacktestJob.findById(jobId);
    if (!job) return null;

    const filtered = filterBatchResults(job.results || [], {
      strategy: query.strategy || '',
      symbol: query.symbol || '',
      status: query.status || '',
      minTrades: query.minTrades,
    });
    const sorted = sortBatchResults(filtered, query.sortBy, query.sortDir);
    const paginated = paginateBatchResults(sorted, query.page, query.pageSize);

    return {
      jobId,
      items: paginated.items,
      pagination: paginated.pagination,
      filters: {
        strategy: query.strategy || '',
        symbol: query.symbol || '',
        status: query.status || '',
        minTrades: query.minTrades != null ? Number(query.minTrades) || 0 : 0,
      },
    };
  }

  async getJobReport(jobId) {
    const job = await BatchBacktestJob.findById(jobId);
    if (!job) return null;

    return {
      jobId,
      reportText: job.reportText || '',
      reportMarkdown: job.reportMarkdown || '',
      recommendations: job.recommendations || [],
    };
  }

  async getJobChildResult(jobId, backtestId) {
    const job = await BatchBacktestJob.findById(jobId);
    if (!job) return null;

    const linked = (job.results || []).find((item) => item.backtestId === backtestId);
    if (!linked) return null;

    return backtestEngine.getResult(backtestId);
  }
}

module.exports = new BatchBacktestService();
