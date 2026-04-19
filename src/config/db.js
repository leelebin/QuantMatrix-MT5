const Datastore = require('nedb-promises');
const path = require('path');
const fs = require('fs');
const isTestEnv = process.env.NODE_ENV === 'test';

// Data directory for storing database files
const DATA_DIR = path.resolve(process.cwd(), 'data');

// Ensure data directory exists
if (!isTestEnv && !fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function createStore(filename) {
  if (isTestEnv) {
    return Datastore.create({
      inMemoryOnly: true,
      autoload: true,
    });
  }

  return Datastore.create({
    filename: path.join(DATA_DIR, filename),
    autoload: true,
  });
}

// Create database instances
const usersDb = createStore('users.db');

const strategiesDb = createStore('strategies.db');

const strategyInstancesDb = createStore('strategyInstances.db');

const tradesDb = createStore('trades.db');

const positionsDb = createStore('positions.db');

const backtestsDb = createStore('backtests.db');

const tradeLogDb = createStore('trade_log.db');

const paperPositionsDb = createStore('paper_positions.db');

const riskStateDb = createStore('risk_state.db');

const riskProfilesDb = createStore('risk_profiles.db');

const executionAuditDb = createStore('execution_audit.db');

const batchBacktestJobsDb = createStore('batch_backtest_jobs.db');

const decisionAuditDb = createStore('decision_audit.db');

// Ensure indexes
usersDb.ensureIndex({ fieldName: 'email', unique: true });
strategiesDb.ensureIndex({ fieldName: 'name', unique: true });
strategyInstancesDb.ensureIndex({ fieldName: 'strategyName' });
strategyInstancesDb.ensureIndex({ fieldName: 'symbol' });
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
    await strategyInstancesDb.count({});
    await tradesDb.count({});
    await positionsDb.count({});
    await backtestsDb.count({});
    await tradeLogDb.count({});
    await paperPositionsDb.count({});
    await riskStateDb.count({});
    await riskProfilesDb.count({});
    await executionAuditDb.count({});
    await batchBacktestJobsDb.count({});
    await decisionAuditDb.count({});
    console.log('Database Connected: NeDB (local file storage)');
    console.log(`Data directory: ${DATA_DIR}`);
  } catch (error) {
    console.error(`Database error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
module.exports.usersDb = usersDb;
module.exports.strategiesDb = strategiesDb;
module.exports.strategyInstancesDb = strategyInstancesDb;
module.exports.tradesDb = tradesDb;
module.exports.positionsDb = positionsDb;
module.exports.backtestsDb = backtestsDb;
module.exports.tradeLogDb = tradeLogDb;
module.exports.paperPositionsDb = paperPositionsDb;
module.exports.riskStateDb = riskStateDb;
module.exports.riskProfilesDb = riskProfilesDb;
module.exports.executionAuditDb = executionAuditDb;
module.exports.batchBacktestJobsDb = batchBacktestJobsDb;
module.exports.decisionAuditDb = decisionAuditDb;
