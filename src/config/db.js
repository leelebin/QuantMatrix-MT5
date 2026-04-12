const Datastore = require('nedb-promises');
const path = require('path');
const fs = require('fs');

// Data directory for storing database files
const DATA_DIR = path.resolve(process.cwd(), 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Create database instances
const usersDb = Datastore.create({
  filename: path.join(DATA_DIR, 'users.db'),
  autoload: true,
});

const strategiesDb = Datastore.create({
  filename: path.join(DATA_DIR, 'strategies.db'),
  autoload: true,
});

const tradesDb = Datastore.create({
  filename: path.join(DATA_DIR, 'trades.db'),
  autoload: true,
});

const positionsDb = Datastore.create({
  filename: path.join(DATA_DIR, 'positions.db'),
  autoload: true,
});

const backtestsDb = Datastore.create({
  filename: path.join(DATA_DIR, 'backtests.db'),
  autoload: true,
});

const tradeLogDb = Datastore.create({
  filename: path.join(DATA_DIR, 'trade_log.db'),
  autoload: true,
});

const paperPositionsDb = Datastore.create({
  filename: path.join(DATA_DIR, 'paper_positions.db'),
  autoload: true,
});

const riskStateDb = Datastore.create({
  filename: path.join(DATA_DIR, 'risk_state.db'),
  autoload: true,
});

const riskProfilesDb = Datastore.create({
  filename: path.join(DATA_DIR, 'risk_profiles.db'),
  autoload: true,
});

const executionAuditDb = Datastore.create({
  filename: path.join(DATA_DIR, 'execution_audit.db'),
  autoload: true,
});

// Ensure indexes
usersDb.ensureIndex({ fieldName: 'email', unique: true });
strategiesDb.ensureIndex({ fieldName: 'name', unique: true });
tradesDb.ensureIndex({ fieldName: 'symbol' });
tradesDb.ensureIndex({ fieldName: 'closedAt' });
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
module.exports.tradesDb = tradesDb;
module.exports.positionsDb = positionsDb;
module.exports.backtestsDb = backtestsDb;
module.exports.tradeLogDb = tradeLogDb;
module.exports.paperPositionsDb = paperPositionsDb;
module.exports.riskStateDb = riskStateDb;
module.exports.riskProfilesDb = riskProfilesDb;
module.exports.executionAuditDb = executionAuditDb;
