const Datastore = require('nedb-promises');
const path = require('path');
const fs = require('fs');

const IS_TEST_ENV = process.env.NODE_ENV === 'test'
  || typeof process.env.JEST_WORKER_ID !== 'undefined';

// Data directory for storing database files
const DATA_DIR = path.resolve(process.cwd(), 'data');

// Ensure data directory exists
if (!IS_TEST_ENV && !fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function createDatastore(filename) {
  if (IS_TEST_ENV) {
    return Datastore.create({ inMemoryOnly: true });
  }

  return Datastore.create({
    filename: path.join(DATA_DIR, filename),
    autoload: true,
  });
}

// Create database instances
const usersDb = createDatastore('users.db');
const strategiesDb = createDatastore('strategies.db');
const tradesDb = createDatastore('trades.db');
const positionsDb = createDatastore('positions.db');
const backtestsDb = createDatastore('backtests.db');
const tradeLogDb = createDatastore('trade_log.db');
const paperPositionsDb = createDatastore('paper_positions.db');
const riskStateDb = createDatastore('risk_state.db');
const riskProfilesDb = createDatastore('risk_profiles.db');
const executionAuditDb = createDatastore('execution_audit.db');
const batchBacktestJobsDb = createDatastore('batch_backtest_jobs.db');
const decisionAuditDb = createDatastore('decision_audit.db');
const optimizerRunsDb = createDatastore('optimizer_runs.db');
const strategyInstancesDb = createDatastore('strategyInstances.db');
const strategyDailyStopsDb = createDatastore('strategy_daily_stops.db');

// Ensure indexes
usersDb.ensureIndex({ fieldName: 'email', unique: true });
strategiesDb.ensureIndex({ fieldName: 'name', unique: true });
tradesDb.ensureIndex({ fieldName: 'symbol' });
tradesDb.ensureIndex({ fieldName: 'openedAt' });
tradesDb.ensureIndex({ fieldName: 'closedAt' });
tradesDb.ensureIndex({ fieldName: 'brokerSyncedAt' });
tradesDb.ensureIndex({ fieldName: 'mt5PositionId' });
tradesDb.ensureIndex({ fieldName: 'mt5OrderId' });
tradesDb.ensureIndex({ fieldName: 'mt5EntryDealId' });
tradesDb.ensureIndex({ fieldName: 'mt5CloseDealId' });
positionsDb.ensureIndex({ fieldName: 'symbol' });
tradeLogDb.ensureIndex({ fieldName: 'symbol' });
tradeLogDb.ensureIndex({ fieldName: 'closedAt' });
tradeLogDb.ensureIndex({ fieldName: 'openedAt' });
paperPositionsDb.ensureIndex({ fieldName: 'symbol' });
riskProfilesDb.ensureIndex({ fieldName: 'nameKey', unique: true });
riskProfilesDb.ensureIndex({ fieldName: 'isActive' });
executionAuditDb.ensureIndex({ fieldName: 'symbol' });
executionAuditDb.ensureIndex({ fieldName: 'scope' });
executionAuditDb.ensureIndex({ fieldName: 'stage' });
executionAuditDb.ensureIndex({ fieldName: 'status' });
executionAuditDb.ensureIndex({ fieldName: 'createdAt' });
batchBacktestJobsDb.ensureIndex({ fieldName: 'status' });
batchBacktestJobsDb.ensureIndex({ fieldName: 'createdAt' });
batchBacktestJobsDb.ensureIndex({ fieldName: 'completedAt' });
optimizerRunsDb.ensureIndex({ fieldName: 'symbol' });
optimizerRunsDb.ensureIndex({ fieldName: 'strategy' });
optimizerRunsDb.ensureIndex({ fieldName: 'completedAt' });
strategyInstancesDb.ensureIndex({ fieldName: 'strategyName' });
strategyInstancesDb.ensureIndex({ fieldName: 'symbol' });
strategyInstancesDb.ensureIndex({ fieldName: '_id', unique: true });
strategyDailyStopsDb.ensureIndex({ fieldName: 'key' });
strategyDailyStopsDb.ensureIndex({ fieldName: 'tradingDay' });
strategyDailyStopsDb.ensureIndex({ fieldName: 'stopped' });
decisionAuditDb.ensureIndex({ fieldName: 'symbol' });
decisionAuditDb.ensureIndex({ fieldName: 'strategy' });
decisionAuditDb.ensureIndex({ fieldName: 'stage' });
decisionAuditDb.ensureIndex({ fieldName: 'status' });
decisionAuditDb.ensureIndex({ fieldName: 'reasonCode' });
decisionAuditDb.ensureIndex({ fieldName: 'module' });
decisionAuditDb.ensureIndex({ fieldName: 'timestamp' });
decisionAuditDb.ensureIndex({ fieldName: 'createdAt' });

const connectDB = async () => {
  try {
    await usersDb.count({});
    await strategiesDb.count({});
    await tradesDb.count({});
    await positionsDb.count({});
    await backtestsDb.count({});
    await tradeLogDb.count({});
    await paperPositionsDb.count({});
    await riskStateDb.count({});
    await riskProfilesDb.count({});
    await executionAuditDb.count({});
    await batchBacktestJobsDb.count({});
    await optimizerRunsDb.count({});
    await strategyInstancesDb.count({});
    await strategyDailyStopsDb.count({});
    await decisionAuditDb.count({});
    if (IS_TEST_ENV) {
      console.log('Database Connected: NeDB (in-memory test storage)');
    } else {
      console.log('Database Connected: NeDB (local file storage)');
      console.log(`Data directory: ${DATA_DIR}`);
    }
  } catch (error) {
    console.error(`Database error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
module.exports.usersDb = usersDb;
module.exports.strategiesDb = strategiesDb;
module.exports.tradesDb = tradesDb;
module.exports.positionsDb = positionsDb;
module.exports.backtestsDb = backtestsDb;
module.exports.tradeLogDb = tradeLogDb;
module.exports.paperPositionsDb = paperPositionsDb;
module.exports.riskStateDb = riskStateDb;
module.exports.riskProfilesDb = riskProfilesDb;
module.exports.executionAuditDb = executionAuditDb;
module.exports.batchBacktestJobsDb = batchBacktestJobsDb;
module.exports.optimizerRunsDb = optimizerRunsDb;
module.exports.strategyInstancesDb = strategyInstancesDb;
module.exports.strategyDailyStopsDb = strategyDailyStopsDb;
module.exports.decisionAuditDb = decisionAuditDb;
