const path = require('path');
const { parentPort, workerData } = require('worker_threads');

const dbModulePath = path.resolve(__dirname, '../config/db.js');
require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: {
    backtestsDb: {
      insert: async (doc) => ({ _id: null, ...doc }),
      find: () => ({
        sort: () => ({
          limit: async () => [],
        }),
      }),
      findOne: async () => null,
      remove: async () => 0,
    },
  },
};

const backtestEngine = require('../services/backtestEngine');
const { combinationAt } = require('../services/optimizerGrid');

let stopRequested = false;

if (parentPort) {
  parentPort.on('message', (message) => {
    if (message && message.type === 'stop') {
      stopRequested = true;
    }
  });
}

async function run() {
  const {
    startIndex,
    endIndex,
    paramSpecs,
    sharedRunParams,
    minimumTrades,
    progressEvery,
  } = workerData;

  const results = [];
  let processed = 0;

  for (let comboIndex = startIndex; comboIndex < endIndex; comboIndex++) {
    if (stopRequested) {
      break;
    }

    const combo = combinationAt(paramSpecs, comboIndex);

    try {
      const simulation = await backtestEngine.simulate({
        ...sharedRunParams,
        strategyParams: combo,
      });

      if (simulation.summary.totalTrades >= minimumTrades) {
        results.push({
          combinationIndex: comboIndex,
          parameters: simulation.parameters,
          parameterSource: simulation.parameterSource,
          breakevenConfigUsed: simulation.breakevenConfigUsed || sharedRunParams.breakevenConfig || null,
          summary: simulation.summary,
        });
      }
    } catch (err) {
      // Skip failed combinations but continue the search.
    }

    processed += 1;

    if (
      processed === 1
      || processed % progressEvery === 0
      || comboIndex === endIndex - 1
      || stopRequested
    ) {
      parentPort.postMessage({
        type: 'progress',
        processed,
        lastIndex: comboIndex + 1,
        currentParams: combo,
        stopped: stopRequested,
      });
    }
  }

  parentPort.postMessage({
    type: 'done',
    processed,
    results,
    stopped: stopRequested,
  });
}

run()
  .catch((err) => {
    parentPort.postMessage({
      type: 'error',
      error: {
        message: err.message,
        stack: err.stack,
      },
    });
  })
  .finally(() => {
    if (parentPort) {
      parentPort.close();
    }
  });
