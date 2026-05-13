const Datastore = require('nedb-promises');
const path = require('path');
const fs = require('fs');

const IS_TEST_ENV = process.env.NODE_ENV === 'test'
  || typeof process.env.JEST_WORKER_ID !== 'undefined';

// Data directory for storing database files
const DATA_DIR = path.resolve(process.cwd(), 'data');
const DATA_GROUP_DIRS = Object.freeze({
  config: path.join(DATA_DIR, 'config'),
  trading: path.join(DATA_DIR, 'trading'),
  history: path.join(DATA_DIR, 'history'),
});

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getDataFilePath(filename, group = 'config') {
  const groupDir = DATA_GROUP_DIRS[group] || DATA_DIR;
  return path.join(groupDir, filename);
}

function migrateLegacyDataFile(filename, targetPath) {
  const legacyPath = path.join(DATA_DIR, filename);
  if (legacyPath === targetPath || !fs.existsSync(legacyPath) || fs.existsSync(targetPath)) {
    return;
  }

  fs.renameSync(legacyPath, targetPath);
  console.log(`[DB] Moved legacy data file ${filename} -> ${path.relative(DATA_DIR, targetPath)}`);
}

// Ensure data directories exist
if (!IS_TEST_ENV) {
  ensureDir(DATA_DIR);
  Object.values(DATA_GROUP_DIRS).forEach(ensureDir);
}

function createDatastore(filename, group = 'config') {
  if (IS_TEST_ENV) {
    return Datastore.create({ inMemoryOnly: true });
  }

  const datastorePath = getDataFilePath(filename, group);
  migrateLegacyDataFile(filename, datastorePath);

  return Datastore.create({
    filename: datastorePath,
    autoload: true,
  });
}

// Create database instances
const usersDb = createDatastore('users.db', 'config');
const strategiesDb = createDatastore('strategies.db', 'config');
const tradesDb = createDatastore('trades.db', 'trading');
const positionsDb = createDatastore('positions.db', 'trading');
const backtestsDb = createDatastore('backtests.db', 'history');
const tradeLogDb = createDatastore('trade_log.db', 'trading');
const paperPositionsDb = createDatastore('paper_positions.db', 'trading');
const riskStateDb = createDatastore('risk_state.db', 'config');
const riskProfilesDb = createDatastore('risk_profiles.db', 'config');
const executionAuditDb = createDatastore('execution_audit.db', 'history');
const batchBacktestJobsDb = createDatastore('batch_backtest_jobs.db', 'history');
const decisionAuditDb = createDatastore('decision_audit.db', 'history');
const optimizerRunsDb = createDatastore('optimizer_runs.db', 'history');
const strategyInstancesDb = createDatastore('strategyInstances.db', 'config');
const strategyDailyStopsDb = createDatastore('strategy_daily_stops.db', 'trading');
const symbolCustomsDb = createDatastore('symbol_customs.db', 'trading');
const symbolCustomBacktestsDb = createDatastore('symbol_custom_backtests.db', 'trading');
const symbolCustomOptimizerRunsDb = createDatastore('symbol_custom_optimizer_runs.db', 'trading');

function dbEntry(group, filename, db) {
  return {
    group,
    filename,
    path: getDataFilePath(filename, group),
    db,
  };
}

const DATABASES = Object.freeze({
  users: dbEntry('config', 'users.db', usersDb),
  strategies: dbEntry('config', 'strategies.db', strategiesDb),
  trades: dbEntry('trading', 'trades.db', tradesDb),
  positions: dbEntry('trading', 'positions.db', positionsDb),
  backtests: dbEntry('history', 'backtests.db', backtestsDb),
  tradeLog: dbEntry('trading', 'trade_log.db', tradeLogDb),
  paperPositions: dbEntry('trading', 'paper_positions.db', paperPositionsDb),
  riskState: dbEntry('config', 'risk_state.db', riskStateDb),
  riskProfiles: dbEntry('config', 'risk_profiles.db', riskProfilesDb),
  executionAudit: dbEntry('history', 'execution_audit.db', executionAuditDb),
  batchBacktestJobs: dbEntry('history', 'batch_backtest_jobs.db', batchBacktestJobsDb),
  decisionAudit: dbEntry('history', 'decision_audit.db', decisionAuditDb),
  optimizerRuns: dbEntry('history', 'optimizer_runs.db', optimizerRunsDb),
  strategyInstances: dbEntry('config', 'strategyInstances.db', strategyInstancesDb),
  strategyDailyStops: dbEntry('trading', 'strategy_daily_stops.db', strategyDailyStopsDb),
  symbolCustoms: dbEntry('trading', 'symbol_customs.db', symbolCustomsDb),
  symbolCustomBacktests: dbEntry('trading', 'symbol_custom_backtests.db', symbolCustomBacktestsDb),
  symbolCustomOptimizerRuns: dbEntry('trading', 'symbol_custom_optimizer_runs.db', symbolCustomOptimizerRunsDb),
});

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
symbolCustomsDb.ensureIndex({ fieldName: 'symbol' });
symbolCustomsDb.ensureIndex({ fieldName: 'symbolCustomName' });
symbolCustomsDb.ensureIndex({ fieldName: 'status' });
symbolCustomsDb.ensureIndex({ fieldName: 'updatedAt' });
symbolCustomBacktestsDb.ensureIndex({ fieldName: 'symbol' });
symbolCustomBacktestsDb.ensureIndex({ fieldName: 'symbolCustomId' });
symbolCustomBacktestsDb.ensureIndex({ fieldName: 'createdAt' });
symbolCustomOptimizerRunsDb.ensureIndex({ fieldName: 'symbol' });
symbolCustomOptimizerRunsDb.ensureIndex({ fieldName: 'symbolCustomId' });
symbolCustomOptimizerRunsDb.ensureIndex({ fieldName: 'completedAt' });
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
    await symbolCustomsDb.count({});
    await symbolCustomBacktestsDb.count({});
    await symbolCustomOptimizerRunsDb.count({});
    await decisionAuditDb.count({});
    if (IS_TEST_ENV) {
      console.log('Database Connected: NeDB (in-memory test storage)');
    } else {
      console.log('Database Connected: NeDB (local file storage)');
      console.log(`Data directory: ${DATA_DIR}`);
      console.log(`Config data: ${DATA_GROUP_DIRS.config}`);
      console.log(`Trading data: ${DATA_GROUP_DIRS.trading}`);
      console.log(`History data: ${DATA_GROUP_DIRS.history}`);
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
module.exports.symbolCustomsDb = symbolCustomsDb;
module.exports.symbolCustomBacktestsDb = symbolCustomBacktestsDb;
module.exports.symbolCustomOptimizerRunsDb = symbolCustomOptimizerRunsDb;
module.exports.decisionAuditDb = decisionAuditDb;
module.exports.DATA_DIR = DATA_DIR;
module.exports.DATA_GROUP_DIRS = DATA_GROUP_DIRS;
module.exports.DATABASES = DATABASES;
