/**
 * Strategy Parameter Optimizer
 * Runs a grid search by reusing the formal backtest engine.
 */

const os = require('os');
const path = require('path');

const backtestEngine = require('./backtestEngine');
const {
  getOptimizerParameterRanges,
} = require('../config/strategyParameters');
const {
  MAX_OPTIMIZER_COMBINATIONS,
  buildParamSpecs,
  countCombinations,
  iterateCombinations,
} = require('./optimizerGrid');
const {
  DEFAULT_OPTIMIZER_OBJECTIVE,
  DEFAULT_OPTIMIZER_MINIMUM_TRADES,
  OPTIMIZER_OBJECTIVES,
  buildMinimumTradesWarning,
  normalizeOptimizerMinimumTrades,
  normalizeOptimizerObjective,
} = require('../utils/optimizerInputs');
const {
  attachOptimizerRecommendations,
  buildRecommendationSummary,
} = require('../utils/optimizerRecommendations');

let WorkerThread = null;
try {
  ({ Worker: WorkerThread } = require('worker_threads'));
} catch (err) {
  WorkerThread = null;
}

const OPTIMIZER_WORKER_SCRIPT = path.resolve(__dirname, '../workers/optimizerWorker.js');
const DEFAULT_MAX_PARALLEL_WORKERS = 4;
const MIN_COMBINATIONS_PER_WORKER = 25;
const MEDIUM_DATASET_CANDLE_THRESHOLD = 120000;
const LARGE_DATASET_CANDLE_THRESHOLD = 300000;
const VERY_LARGE_DATASET_CANDLE_THRESHOLD = 900000;
const VERY_SMALL_SAMPLE_FLAG = 'VERY_SMALL_SAMPLE';
const DEFAULT_SECONDARY_OBJECTIVES = ['robustScore', 'profitFactor', 'returnToDrawdown', 'totalTrades'];
const ROBUST_SCORE_SECONDARY_OBJECTIVES = ['profitFactor', 'returnToDrawdown', 'expectancyPerTrade', 'totalTrades'];

class OptimizerService {
  constructor() {
    this.running = false;
    this.progress = null;
    this.lastResult = null;
    this.stopRequested = false;
    this.activeWorkers = [];
    this.activeWorkerCount = 1;
  }

  _parsePositiveInt(value) {
    const numeric = Number(value);
    if (!Number.isInteger(numeric) || numeric <= 0) {
      return null;
    }
    return numeric;
  }

  _estimateCandleLoad(candles = null, higherTfCandles = null, lowerTfCandles = null) {
    return (candles ? candles.length : 0)
      + (higherTfCandles ? higherTfCandles.length : 0)
      + (lowerTfCandles ? lowerTfCandles.length : 0);
  }

  _resolveWorkerCount({
    parallelWorkers = null,
    totalCombinations,
    candles,
    higherTfCandles = null,
    lowerTfCandles = null,
  }) {
    const logicalCpuCount = Math.max(1, Array.isArray(os.cpus()) ? os.cpus().length : 1);
    const envRequested = this._parsePositiveInt(process.env.OPTIMIZER_MAX_WORKERS);
    const configuredDefault = envRequested || Math.min(DEFAULT_MAX_PARALLEL_WORKERS, logicalCpuCount);
    let workerCount = this._parsePositiveInt(parallelWorkers) || configuredDefault;

    workerCount = Math.max(1, Math.min(workerCount, logicalCpuCount, totalCombinations));

    while (workerCount > 1 && (totalCombinations / workerCount) < MIN_COMBINATIONS_PER_WORKER) {
      workerCount -= 1;
    }

    const candleLoad = this._estimateCandleLoad(candles, higherTfCandles, lowerTfCandles);
    if (candleLoad >= VERY_LARGE_DATASET_CANDLE_THRESHOLD) {
      workerCount = 1;
    } else if (candleLoad >= LARGE_DATASET_CANDLE_THRESHOLD) {
      workerCount = Math.min(workerCount, 2);
    } else if (candleLoad >= MEDIUM_DATASET_CANDLE_THRESHOLD) {
      workerCount = Math.min(workerCount, 3);
    }

    if (!WorkerThread) {
      workerCount = 1;
    }

    return workerCount;
  }

  _updateProgress({ current, total, currentParams = null, onProgress = null, workerCount = 1 }) {
    this.progress = {
      current,
      total,
      percent: total > 0 ? parseFloat(((current / total) * 100).toFixed(1)) : 0,
      currentParams,
      stopRequested: this.stopRequested,
      workerCount,
    };

    if (typeof onProgress === 'function') {
      onProgress(this.progress);
    }
  }

  _getSortableSummaryValue(result, summaryKey) {
    const rawValue = result?.summary?.[summaryKey];
    if (rawValue == null) {
      return Number.NEGATIVE_INFINITY;
    }
    const value = Number(rawValue);
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  }

  _hasVerySmallSampleWarning(result) {
    return Array.isArray(result?.summary?.warningFlags)
      && result.summary.warningFlags.includes(VERY_SMALL_SAMPLE_FLAG);
  }

  _getPrimarySortValue(result, objective) {
    const value = this._getSortableSummaryValue(result, objective.summaryKey);
    if (objective.summaryKey === 'robustScore' || !this._hasVerySmallSampleWarning(result)) {
      return value;
    }

    if (value === Number.NEGATIVE_INFINITY) {
      return value;
    }

    if (objective.summaryKey === 'profitFactor') {
      return Math.min(value, 1.2);
    }

    if (objective.summaryKey === 'winRate') {
      return Math.min(value, 0.5);
    }

    if (
      objective.summaryKey === 'returnPercent'
      || objective.summaryKey === 'sharpeRatio'
      || objective.summaryKey === 'returnToDrawdown'
      || objective.summaryKey === 'expectancyPerTrade'
      || objective.summaryKey === 'avgRealizedR'
      || objective.summaryKey === 'medianRealizedR'
    ) {
      return Math.min(value, 0);
    }

    return value * 0.5;
  }

  _getSortKeysForObjective(objective) {
    const secondaryKeys = objective.summaryKey === 'robustScore'
      ? ROBUST_SCORE_SECONDARY_OBJECTIVES
      : DEFAULT_SECONDARY_OBJECTIVES;
    return [
      { key: objective.summaryKey, primary: true },
      ...secondaryKeys
        .filter((key) => key !== objective.summaryKey)
        .map((key) => ({ key, primary: false })),
    ];
  }

  _sortResults(results, objective) {
    const sortKeys = this._getSortKeysForObjective(objective);
    results.sort((a, b) => {
      for (const sortKey of sortKeys) {
        const valueA = sortKey.primary
          ? this._getPrimarySortValue(a, objective)
          : this._getSortableSummaryValue(a, sortKey.key);
        const valueB = sortKey.primary
          ? this._getPrimarySortValue(b, objective)
          : this._getSortableSummaryValue(b, sortKey.key);
        if (valueB !== valueA) {
          return valueB - valueA;
        }
      }
      return (a.combinationIndex ?? 0) - (b.combinationIndex ?? 0);
    });
  }

  _stripInternalResultFields(results) {
    return results.map(({ combinationIndex, ...row }) => row);
  }

  _prepareOptimizerResults(results, context) {
    return attachOptimizerRecommendations(this._stripInternalResultFields(results), context);
  }

  async _runSequential(params) {
    const {
      symbol,
      strategyType,
      timeframe,
      candles,
      higherTfCandles = null,
      lowerTfCandles = null,
      initialBalance = 10000,
      costModel = null,
      tradeStartTime = null,
      tradeEndTime = null,
      storedStrategyParameters = null,
      breakevenConfig = null,
      executionPolicy = null,
      onProgress = null,
      minimumTrades = DEFAULT_OPTIMIZER_MINIMUM_TRADES,
      paramSpecs,
      totalCombinations,
      workerCount,
    } = params;

    const results = [];
    let processedCombinations = 0;

    for (const combo of iterateCombinations(paramSpecs)) {
      if (this.stopRequested) {
        break;
      }

      processedCombinations += 1;
      this._updateProgress({
        current: processedCombinations,
        total: totalCombinations,
        currentParams: combo,
        onProgress,
        workerCount,
      });

      try {
        const simulation = await backtestEngine.simulate({
          symbol,
          strategyType,
          timeframe,
          candles,
          higherTfCandles,
          lowerTfCandles,
          initialBalance,
          costModel,
          tradeStartTime,
          tradeEndTime,
          strategyParams: combo,
          storedStrategyParameters,
          breakevenConfig,
          executionPolicy,
        });

        if (simulation.summary.totalTrades >= minimumTrades) {
          results.push({
            combinationIndex: processedCombinations - 1,
            parameters: simulation.parameters,
            parameterSource: simulation.parameterSource,
            breakevenConfigUsed: simulation.breakevenConfigUsed || breakevenConfig || null,
            summary: simulation.summary,
          });
        }
      } catch (err) {
        // Skip failed combinations but continue the search.
      }

      if (this.stopRequested) {
        break;
      }

      if (processedCombinations % 10 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    return { processedCombinations, results };
  }

  _buildWorkerSpecs(totalCombinations, workerCount) {
    const specs = [];
    const chunkSize = Math.ceil(totalCombinations / workerCount);

    for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
      const startIndex = workerIndex * chunkSize;
      const endIndex = Math.min(totalCombinations, startIndex + chunkSize);
      if (startIndex >= endIndex) {
        break;
      }
      specs.push({ workerIndex, startIndex, endIndex });
    }

    return specs;
  }

  _sumProcessedCombinations(progressByWorker) {
    let total = 0;
    for (const processed of progressByWorker.values()) {
      total += processed;
    }
    return total;
  }

  async _runParallel(params) {
    const {
      symbol,
      strategyType,
      timeframe,
      candles,
      higherTfCandles = null,
      lowerTfCandles = null,
      initialBalance = 10000,
      costModel = null,
      tradeStartTime = null,
      tradeEndTime = null,
      storedStrategyParameters = null,
      breakevenConfig = null,
      executionPolicy = null,
      onProgress = null,
      minimumTrades = DEFAULT_OPTIMIZER_MINIMUM_TRADES,
      paramSpecs,
      totalCombinations,
      workerCount,
    } = params;

    const workerSpecs = this._buildWorkerSpecs(totalCombinations, workerCount);
    const progressByWorker = new Map(workerSpecs.map((spec) => [spec.workerIndex, 0]));
    const workers = [];

    const sharedRunParams = {
      symbol,
      strategyType,
      timeframe,
      candles,
      higherTfCandles,
      lowerTfCandles,
      initialBalance,
      costModel,
      tradeStartTime,
      tradeEndTime,
      storedStrategyParameters,
      breakevenConfig,
      executionPolicy,
    };

    this.activeWorkers = workers;
    this.activeWorkerCount = workerSpecs.length;

    try {
      const workerResults = await Promise.all(workerSpecs.map((spec) => new Promise((resolve, reject) => {
        let settled = false;
        const progressEvery = Math.max(1, Math.min(25, Math.floor((spec.endIndex - spec.startIndex) / 50) || 1));
        const worker = new WorkerThread(OPTIMIZER_WORKER_SCRIPT, {
          workerData: {
            ...spec,
            paramSpecs,
            sharedRunParams,
            minimumTrades,
            progressEvery,
          },
        });

        workers.push(worker);

        const cleanup = () => {
          worker.removeAllListeners('message');
          worker.removeAllListeners('error');
          worker.removeAllListeners('exit');
        };

        const fail = (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        };

        const finish = (payload) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(payload);
        };

        worker.on('message', (message) => {
          if (!message || typeof message !== 'object') {
            return;
          }

          if (message.type === 'progress') {
            progressByWorker.set(spec.workerIndex, message.processed || 0);
            this._updateProgress({
              current: this._sumProcessedCombinations(progressByWorker),
              total: totalCombinations,
              currentParams: message.currentParams || null,
              onProgress,
              workerCount,
            });
            return;
          }

          if (message.type === 'done') {
            progressByWorker.set(spec.workerIndex, message.processed || 0);
            this._updateProgress({
              current: this._sumProcessedCombinations(progressByWorker),
              total: totalCombinations,
              currentParams: null,
              onProgress,
              workerCount,
            });
            finish({
              processedCombinations: message.processed || 0,
              results: Array.isArray(message.results) ? message.results : [],
            });
            return;
          }

          if (message.type === 'error') {
            const err = new Error(message.error?.message || 'Optimizer worker failed');
            if (message.error?.stack) {
              err.stack = message.error.stack;
            }
            fail(err);
          }
        });

        worker.on('error', fail);
        worker.on('exit', (code) => {
          if (!settled && code !== 0) {
            fail(new Error(`Optimizer worker exited with code ${code}`));
          }
        });

        if (this.stopRequested) {
          try {
            worker.postMessage({ type: 'stop' });
          } catch (err) {
            // Ignore stop races against worker teardown.
          }
        }
      })));

      const results = [];
      let processedCombinations = 0;
      for (const workerResult of workerResults) {
        processedCombinations += workerResult.processedCombinations || 0;
        if (Array.isArray(workerResult.results) && workerResult.results.length > 0) {
          results.push(...workerResult.results);
        }
      }

      return { processedCombinations, results };
    } catch (err) {
      await Promise.allSettled(workers.map((worker) => worker.terminate()));
      throw err;
    } finally {
      await Promise.allSettled(workers.map((worker) => worker.terminate()));
      this.activeWorkers = [];
      this.activeWorkerCount = 1;
    }
  }

  async run(params) {
    const {
      symbol,
      strategyType,
      timeframe,
      candles,
      higherTfCandles = null,
      lowerTfCandles = null,
      initialBalance = 10000,
      costModel = null,
      paramRanges = null,
      optimizeFor = DEFAULT_OPTIMIZER_OBJECTIVE,
      tradeStartTime = null,
      tradeEndTime = null,
      storedStrategyParameters = null,
      breakevenConfig = null,
      executionPolicy = null,
      onProgress = null,
      minimumTrades = DEFAULT_OPTIMIZER_MINIMUM_TRADES,
      parallelWorkers = null,
    } = params;

    if (this.running) {
      throw new Error('Optimizer is already running');
    }

    const objective = normalizeOptimizerObjective(optimizeFor);
    const normalizedMinimumTrades = normalizeOptimizerMinimumTrades(minimumTrades);
    const minimumTradesWarningMessage = buildMinimumTradesWarning(normalizedMinimumTrades);

    const ranges = paramRanges || getOptimizerParameterRanges(strategyType);
    if (!ranges || Object.keys(ranges).length === 0) {
      throw new Error(`No optimizer ranges for strategy: ${strategyType}`);
    }

    const paramSpecs = buildParamSpecs(ranges);
    const totalCombinations = countCombinations(paramSpecs, MAX_OPTIMIZER_COMBINATIONS);
    const workerCount = this._resolveWorkerCount({
      parallelWorkers,
      totalCombinations,
      candles,
      higherTfCandles,
      lowerTfCandles,
    });

    this.running = true;
    this.stopRequested = false;
    this.lastResult = null;
    this.activeWorkerCount = workerCount;
    this._updateProgress({
      current: 0,
      total: totalCombinations,
      currentParams: null,
      onProgress,
      workerCount,
    });

    console.log(
      `[Optimizer] Starting grid search: ${symbol} ${strategyType} | ${totalCombinations} combinations`
      + ` | workers: ${workerCount}`
    );

    try {
      const runState = workerCount > 1
        ? await this._runParallel({
            symbol,
            strategyType,
            timeframe,
            candles,
            higherTfCandles,
            lowerTfCandles,
            initialBalance,
            costModel,
            tradeStartTime,
            tradeEndTime,
            storedStrategyParameters,
            breakevenConfig,
            executionPolicy,
            onProgress,
            minimumTrades: normalizedMinimumTrades,
            paramSpecs,
            totalCombinations,
            workerCount,
          })
        : await this._runSequential({
            symbol,
            strategyType,
            timeframe,
            candles,
            higherTfCandles,
            lowerTfCandles,
            initialBalance,
            costModel,
            tradeStartTime,
            tradeEndTime,
            storedStrategyParameters,
            breakevenConfig,
            executionPolicy,
            onProgress,
            minimumTrades: normalizedMinimumTrades,
            paramSpecs,
            totalCombinations,
            workerCount,
          });

      this._sortResults(runState.results, objective);
      const normalizedResults = this._prepareOptimizerResults(runState.results, {
        symbol,
        strategy: strategyType,
      });
      const processedCombinations = runState.processedCombinations || 0;
      const stopped = this.stopRequested && processedCombinations < totalCombinations;
      const optimizerResult = {
        symbol,
        strategy: strategyType,
        timeframe: timeframe || null,
        initialBalance,
        totalCombinations,
        processedCombinations,
        validResults: normalizedResults.length,
        optimizeFor: objective.key,
        requestedOptimizeFor: objective.requestedKey,
        optimizeForLabel: objective.label,
        costModelUsed: costModel || null,
        minimumTrades: normalizedMinimumTrades,
        minimumTradesWarning: Boolean(minimumTradesWarningMessage),
        minimumTradesWarningMessage,
        recommendationSummary: buildRecommendationSummary(normalizedResults),
        stopped,
        status: stopped ? 'stopped' : 'completed',
        workerCount,
        breakevenConfigUsed: normalizedResults[0]?.breakevenConfigUsed || breakevenConfig || null,
        bestResult: normalizedResults[0] || null,
        top10: normalizedResults.slice(0, 10),
        allResults: normalizedResults,
        completedAt: new Date().toISOString(),
      };

      this.lastResult = optimizerResult;

      if (stopped) {
        console.log(
          `[Optimizer] Stopped: ${normalizedResults.length} valid results from `
          + `${processedCombinations}/${totalCombinations} combinations`
          + (normalizedResults[0] ? ` | Best ${objective.key}: ${normalizedResults[0].summary[objective.summaryKey]}` : '')
        );
      } else {
        console.log(
          `[Optimizer] Complete: ${normalizedResults.length} valid results from ${totalCombinations} combinations`
          + (normalizedResults[0] ? ` | Best ${objective.key}: ${normalizedResults[0].summary[objective.summaryKey]}` : '')
        );
      }

      return optimizerResult;
    } catch (err) {
      if (workerCount > 1 && WorkerThread) {
        console.warn(`[Optimizer] Parallel worker run failed, falling back to sequential mode: ${err.message}`);
        this.activeWorkers = [];
        this.activeWorkerCount = 1;
        this.stopRequested = false;
        this._updateProgress({
          current: 0,
          total: totalCombinations,
          currentParams: null,
          onProgress,
          workerCount: 1,
        });

        const sequentialState = await this._runSequential({
          symbol,
          strategyType,
          timeframe,
          candles,
          higherTfCandles,
          lowerTfCandles,
          initialBalance,
          costModel,
          tradeStartTime,
          tradeEndTime,
          storedStrategyParameters,
          breakevenConfig,
          executionPolicy,
          onProgress,
          minimumTrades: normalizedMinimumTrades,
          paramSpecs,
          totalCombinations,
          workerCount: 1,
        });

        this._sortResults(sequentialState.results, objective);
        const normalizedResults = this._prepareOptimizerResults(sequentialState.results, {
          symbol,
          strategy: strategyType,
        });
        const processedCombinations = sequentialState.processedCombinations || 0;
        const stopped = this.stopRequested && processedCombinations < totalCombinations;
        const optimizerResult = {
          symbol,
          strategy: strategyType,
          timeframe: timeframe || null,
          initialBalance,
          totalCombinations,
          processedCombinations,
          validResults: normalizedResults.length,
          optimizeFor: objective.key,
          requestedOptimizeFor: objective.requestedKey,
          optimizeForLabel: objective.label,
          costModelUsed: costModel || null,
          minimumTrades: normalizedMinimumTrades,
          minimumTradesWarning: Boolean(minimumTradesWarningMessage),
          minimumTradesWarningMessage,
          recommendationSummary: buildRecommendationSummary(normalizedResults),
          stopped,
          status: stopped ? 'stopped' : 'completed',
          workerCount: 1,
          breakevenConfigUsed: normalizedResults[0]?.breakevenConfigUsed || breakevenConfig || null,
          bestResult: normalizedResults[0] || null,
          top10: normalizedResults.slice(0, 10),
          allResults: normalizedResults,
          completedAt: new Date().toISOString(),
        };

        this.lastResult = optimizerResult;
        return optimizerResult;
      }

      throw err;
    } finally {
      this.running = false;
      this.progress = null;
      this.stopRequested = false;
      this.activeWorkers = [];
      this.activeWorkerCount = 1;
    }
  }

  requestStop() {
    if (!this.running) {
      return {
        accepted: false,
        running: false,
        progress: this.progress,
        message: 'Optimizer is not running',
      };
    }

    this.stopRequested = true;
    if (this.progress) {
      this.progress = {
        ...this.progress,
        stopRequested: true,
      };
    }

    for (const worker of this.activeWorkers) {
      try {
        worker.postMessage({ type: 'stop' });
      } catch (err) {
        // Ignore stop races against worker teardown.
      }
    }

    return {
      accepted: true,
      running: true,
      progress: this.progress,
      message: 'Stop requested. Optimizer will halt after the in-flight combination(s) finish.',
    };
  }

  getProgress() {
    return {
      running: this.running,
      progress: this.progress,
      stopRequested: this.stopRequested,
      workerCount: this.activeWorkerCount,
    };
  }

  getLastResult() {
    return this.lastResult;
  }

  getDefaultRanges(strategyType) {
    return getOptimizerParameterRanges(strategyType);
  }
}

const optimizerService = new OptimizerService();
optimizerService.MAX_OPTIMIZER_COMBINATIONS = MAX_OPTIMIZER_COMBINATIONS;
optimizerService.OPTIMIZER_OBJECTIVES = OPTIMIZER_OBJECTIVES;
optimizerService.DEFAULT_OPTIMIZER_MINIMUM_TRADES = DEFAULT_OPTIMIZER_MINIMUM_TRADES;

module.exports = optimizerService;
