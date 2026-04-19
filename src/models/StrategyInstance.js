const { strategyInstancesDb } = require('../config/db');
const Strategy = require('./Strategy');

function buildCompositeId(strategyName, symbol) {
  return `${strategyName}:${symbol}`;
}

function cloneValue(value) {
  if (value === undefined) {
    return {};
  }

  return JSON.parse(JSON.stringify(value));
}

function buildNotFoundError(strategyName) {
  const error = new Error(`Strategy definition not found for ${strategyName}`);
  error.statusCode = 404;
  return error;
}

const StrategyInstance = {
  async create({ strategyName, symbol, parameters, enabled }) {
    const now = new Date();
    return await strategyInstancesDb.insert({
      _id: buildCompositeId(strategyName, symbol),
      strategyName,
      symbol,
      parameters: cloneValue(parameters),
      enabled: enabled !== undefined ? enabled : true,
      createdAt: now,
      updatedAt: now,
    });
  },

  async findByKey(strategyName, symbol) {
    return await strategyInstancesDb.findOne({ strategyName, symbol });
  },

  async findByStrategyName(strategyName) {
    return await strategyInstancesDb.find({ strategyName }).sort({ symbol: 1 });
  },

  async findAll() {
    return await strategyInstancesDb.find({}).sort({ strategyName: 1, symbol: 1 });
  },

  async upsert(strategyName, symbol, patch = {}) {
    const existing = await this.findByKey(strategyName, symbol);
    if (existing) {
      const updateFields = {};
      if (patch.parameters !== undefined) {
        updateFields.parameters = cloneValue(patch.parameters);
      }
      if (patch.enabled !== undefined) {
        updateFields.enabled = patch.enabled;
      }

      if (Object.keys(updateFields).length === 0) {
        return existing;
      }

      updateFields.updatedAt = new Date();
      await strategyInstancesDb.update({ _id: existing._id }, { $set: updateFields });
      return await this.findByKey(strategyName, symbol);
    }

    const strategy = await Strategy.findByName(strategyName);
    if (!strategy) {
      throw buildNotFoundError(strategyName);
    }

    return await this.create({
      strategyName,
      symbol,
      parameters: patch.parameters !== undefined
        ? patch.parameters
        : cloneValue(strategy.parameters),
      enabled: patch.enabled !== undefined ? patch.enabled : strategy.enabled,
    });
  },

  async remove(strategyName, symbol) {
    const existing = await this.findByKey(strategyName, symbol);
    if (!existing) return null;

    await strategyInstancesDb.remove({ _id: existing._id }, {});
    return existing;
  },

  async migrateFromLegacy() {
    const strategies = await Strategy.findAll();
    let migrated = 0;
    let skipped = 0;

    for (const strategy of strategies) {
      const symbols = Array.isArray(strategy.symbols) ? [...new Set(strategy.symbols)] : [];
      for (const symbol of symbols) {
        const existing = await this.findByKey(strategy.name, symbol);
        if (existing) {
          skipped += 1;
          continue;
        }

        await this.create({
          strategyName: strategy.name,
          symbol,
          parameters: cloneValue(strategy.parameters),
          enabled: strategy.enabled,
        });
        migrated += 1;
      }
    }

    console.log(`[StrategyInstance] migrateFromLegacy migrated=${migrated} skipped=${skipped}`);

    return { migrated, skipped };
  },
};

module.exports = StrategyInstance;
