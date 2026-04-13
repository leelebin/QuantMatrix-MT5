/**
 * Strategy Parameter Optimizer
 * Runs a grid search by reusing the formal backtest engine.
 */

const backtestEngine = require('./backtestEngine');
const {
  getOptimizerParameterRanges,
} = require('../config/strategyParameters');

class OptimizerService {
  constructor() {
    this.running = false;
    this.progress = null;
    this.lastResult = null;
  }

  _generateCombinations(paramRanges) {
    const paramNames = Object.keys(paramRanges);
    const paramValues = paramNames.map((name) => {
      const { min, max, step } = paramRanges[name];
      const values = [];
      for (let value = min; value <= max + step * 0.01; value += step) {
        values.push(parseFloat(value.toFixed(4)));
      }
      return values;
    });

    const combinations = [];
    const generate = (index, current) => {
      if (index === paramNames.length) {
        combinations.push({ ...current });
        return;
      }

      for (const value of paramValues[index]) {
        current[paramNames[index]] = value;
        generate(index + 1, current);
      }
    };

    generate(0, {});
    return combinations;
  }

  async run(params) {
    const {
      symbol,
      strategyType,
      timeframe,
      candles,
      higherTfCandles = null,
      lowerTfCandles = null,
      paramRanges = null,
      optimizeFor = 'profitFactor',
      tradeStartTime = null,
      tradeEndTime = null,
      storedStrategyParameters = null,
      breakevenConfig = null,
      onProgress = null,
      minimumTrades = 5,
    } = params;

    if (this.running) {
      throw new Error('Optimizer is already running');
    }

    const ranges = paramRanges || getOptimizerParameterRanges(strategyType);
    if (!ranges || Object.keys(ranges).length === 0) {
      throw new Error(`No optimizer ranges for strategy: ${strategyType}`);
    }

    this.running = true;
    this.lastResult = null;
    const combinations = this._generateCombinations(ranges);
    const totalCombinations = combinations.length;
    const results = [];

    console.log(`[Optimizer] Starting grid search: ${symbol} ${strategyType} | ${totalCombinations} combinations`);

    try {
      for (let index = 0; index < combinations.length; index++) {
        const combo = combinations[index];

        this.progress = {
          current: index + 1,
          total: totalCombinations,
          percent: parseFloat((((index + 1) / totalCombinations) * 100).toFixed(1)),
          currentParams: combo,
        };

        if (typeof onProgress === 'function') {
          onProgress(this.progress);
        }

        try {
          const simulation = await backtestEngine.simulate({
            symbol,
            strategyType,
            timeframe,
            candles,
            higherTfCandles,
            lowerTfCandles,
            tradeStartTime,
            tradeEndTime,
            strategyParams: combo,
            storedStrategyParameters,
            breakevenConfig,
          });

          if (simulation.summary.totalTrades >= minimumTrades) {
            results.push({
              parameters: simulation.parameters,
              parameterSource: simulation.parameterSource,
              breakevenConfigUsed: simulation.breakevenConfigUsed || breakevenConfig || null,
              summary: simulation.summary,
            });
          }
        } catch (err) {
          // Skip failed combinations but continue the search.
        }

        if (index % 10 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      results.sort((a, b) => {
        const valueA = a.summary[optimizeFor] || 0;
        const valueB = b.summary[optimizeFor] || 0;
        return valueB - valueA;
      });

      const optimizerResult = {
        symbol,
        strategy: strategyType,
        timeframe: timeframe || null,
        totalCombinations,
        validResults: results.length,
        optimizeFor,
        breakevenConfigUsed: results[0]?.breakevenConfigUsed || breakevenConfig || null,
        bestResult: results[0] || null,
        top10: results.slice(0, 10),
        allResults: results,
        completedAt: new Date().toISOString(),
      };

      this.lastResult = optimizerResult;

      console.log(
        `[Optimizer] Complete: ${results.length} valid results from ${totalCombinations} combinations`
        + (results[0] ? ` | Best ${optimizeFor}: ${results[0].summary[optimizeFor]}` : '')
      );

      return optimizerResult;
    } finally {
      this.running = false;
      this.progress = null;
    }
  }

  getProgress() {
    return {
      running: this.running,
      progress: this.progress,
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

module.exports = optimizerService;
