describe('optimizer parallel minimumTrades handling', () => {
  afterEach(() => {
    jest.dontMock('worker_threads');
    jest.dontMock('../src/config/db');
    jest.resetModules();
  });

  test('parallel worker path forwards and applies minimumTrades', async () => {
    const workerRuns = [];

    jest.resetModules();
    jest.doMock('../src/config/db', () => ({
      backtestsDb: {
        insert: jest.fn(),
        find: jest.fn(() => ({
          sort: jest.fn(() => ({
            limit: jest.fn().mockResolvedValue([]),
          })),
        })),
        findOne: jest.fn(),
        remove: jest.fn(),
      },
    }));
    jest.doMock('worker_threads', () => ({
      Worker: class FakeOptimizerWorker {
        constructor(script, options) {
          this.workerData = options.workerData;
          this.listeners = new Map();
          workerRuns.push(this.workerData);
          setImmediate(() => this.finish());
        }

        on(event, handler) {
          if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
          }
          this.listeners.get(event).push(handler);
          return this;
        }

        removeAllListeners() {
          this.listeners.clear();
        }

        postMessage() {}

        terminate() {
          return Promise.resolve();
        }

        emit(event, payload) {
          for (const handler of this.listeners.get(event) || []) {
            handler(payload);
          }
        }

        finish() {
          const {
            startIndex,
            endIndex,
            minimumTrades,
          } = this.workerData;
          const results = [];

          for (let comboIndex = startIndex; comboIndex < endIndex; comboIndex++) {
            const totalTrades = comboIndex % 2 === 0 ? minimumTrades - 1 : minimumTrades;
            if (totalTrades >= minimumTrades) {
              results.push({
                combinationIndex: comboIndex,
                parameters: { comboIndex },
                parameterSource: 'fake-worker',
                summary: {
                  totalTrades,
                  profitFactor: comboIndex,
                  robustScore: 50,
                  returnToDrawdown: 1,
                },
              });
            }
          }

          this.emit('message', {
            type: 'done',
            processed: endIndex - startIndex,
            results,
          });
        }
      },
    }));

    const optimizerService = require('../src/services/optimizerService');
    const costModel = {
      commissionPerLot: 7,
      commissionPerSide: true,
    };
    const result = await optimizerService.run({
      symbol: 'EURUSD',
      strategyType: 'TrendFollowing',
      timeframe: '1h',
      candles: [{ time: '2026-01-01T00:00:00.000Z', open: 1, high: 1, low: 1, close: 1 }],
      costModel,
      paramRanges: {
        comboIndex: { min: 1, max: 60, step: 1 },
      },
      minimumTrades: 30,
      parallelWorkers: 2,
    });

    expect(result.workerCount).toBe(2);
    expect(result.costModelUsed).toBe(costModel);
    expect(workerRuns).toHaveLength(2);
    expect(workerRuns.every((workerData) => workerData.minimumTrades === 30)).toBe(true);
    expect(workerRuns.every((workerData) => workerData.sharedRunParams.costModel === costModel)).toBe(true);
    expect(result.processedCombinations).toBe(60);
    expect(result.validResults).toBe(30);
    expect(result.allResults.every((row) => row.summary.totalTrades >= 30)).toBe(true);
  });
});
