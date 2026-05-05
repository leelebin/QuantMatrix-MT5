const path = require('path');

const { DATA_DIR, DATA_GROUP_DIRS, DATABASES } = require('../src/config/db');

describe('database layout', () => {
  test('keeps important config data separate from disposable history data', () => {
    expect(DATA_GROUP_DIRS).toEqual({
      config: path.join(DATA_DIR, 'config'),
      trading: path.join(DATA_DIR, 'trading'),
      history: path.join(DATA_DIR, 'history'),
    });

    expect(DATABASES.strategies).toMatchObject({
      group: 'config',
      filename: 'strategies.db',
      path: path.join(DATA_GROUP_DIRS.config, 'strategies.db'),
    });
    expect(DATABASES.strategyInstances).toMatchObject({
      group: 'config',
      filename: 'strategyInstances.db',
      path: path.join(DATA_GROUP_DIRS.config, 'strategyInstances.db'),
    });
    expect(DATABASES.trades).toMatchObject({
      group: 'trading',
      filename: 'trades.db',
      path: path.join(DATA_GROUP_DIRS.trading, 'trades.db'),
    });
    expect(DATABASES.backtests).toMatchObject({
      group: 'history',
      filename: 'backtests.db',
      path: path.join(DATA_GROUP_DIRS.history, 'backtests.db'),
    });
    expect(DATABASES.optimizerRuns).toMatchObject({
      group: 'history',
      filename: 'optimizer_runs.db',
      path: path.join(DATA_GROUP_DIRS.history, 'optimizer_runs.db'),
    });
  });
});
