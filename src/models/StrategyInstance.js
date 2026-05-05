const { strategyInstancesDb } = require('../config/db');
const Strategy = require('./Strategy');
const {
  DEFAULT_NEWS_BLACKOUT_CONFIG,
  isLegacyNewsBlackoutConfig,
  normalizeNewsBlackoutConfig,
} = require('../config/newsBlackout');

function buildCompositeId(strategyName, symbol) {
  return `${strategyName}:${symbol}`;
}

function cloneValue(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

function buildNotFoundError(strategyName) {
  const error = new Error(`Strategy definition not found for ${strategyName}`);
  error.statusCode = 404;
  return error;
}

function resolvePaperEnabled(data = {}) {
  if (data.paperEnabled !== undefined) return data.paperEnabled !== false;
  if (data.enabled !== undefined) return data.enabled !== false;
  return true;
}

function resolveLiveEnabled(data = {}) {
  return data.liveEnabled === true;
}

async function buildSeedRecord(strategyName, symbol) {
  const strategy = await Strategy.findByName(strategyName);
  if (!strategy) {
    throw buildNotFoundError(strategyName);
  }

  const paperEnabled = strategy.enabled !== undefined ? strategy.enabled : true;
  return {
    strategyName,
    symbol,
    parameters: {},
    enabled: paperEnabled,
    paperEnabled,
    liveEnabled: false,
    newsBlackout: null,
    tradeManagement: null,
    executionPolicy: null,
  };
}

const StrategyInstance = {
  async create({
    strategyName,
    symbol,
    parameters,
    enabled,
    paperEnabled,
    liveEnabled,
    newsBlackout,
    tradeManagement,
    executionPolicy,
  }) {
    const now = new Date();
    const resolvedPaperEnabled = resolvePaperEnabled({ enabled, paperEnabled });
    return await strategyInstancesDb.insert({
      _id: buildCompositeId(strategyName, symbol),
      strategyName,
      symbol,
      parameters: cloneValue(parameters === undefined ? {} : parameters),
      enabled: resolvedPaperEnabled,
      paperEnabled: resolvedPaperEnabled,
      liveEnabled: resolveLiveEnabled({ liveEnabled }),
      newsBlackout: newsBlackout === undefined ? null : cloneValue(newsBlackout),
      tradeManagement: tradeManagement === undefined ? null : cloneValue(tradeManagement),
      executionPolicy: executionPolicy === undefined ? null : cloneValue(executionPolicy),
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
    if (existing && Object.keys(patch).length === 0) {
      return existing;
    }

    const seedRecord = existing
      ? null
      : await buildSeedRecord(strategyName, symbol);
    const isLiveOnlyCreate = !existing
      && patch.liveEnabled !== undefined
      && patch.paperEnabled === undefined
      && patch.enabled === undefined;
    const now = new Date();
    const updateFields = {
      strategyName,
      symbol,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    if (patch.parameters !== undefined) {
      updateFields.parameters = cloneValue(patch.parameters);
    } else if (!existing) {
      updateFields.parameters = cloneValue(seedRecord.parameters);
    }

    if (patch.paperEnabled !== undefined) {
      updateFields.paperEnabled = patch.paperEnabled !== false;
      updateFields.enabled = updateFields.paperEnabled;
    } else if (patch.enabled !== undefined) {
      updateFields.paperEnabled = patch.enabled !== false;
      updateFields.enabled = updateFields.paperEnabled;
    } else if (!existing) {
      updateFields.paperEnabled = isLiveOnlyCreate ? false : seedRecord.paperEnabled;
      updateFields.enabled = updateFields.paperEnabled;
    } else if (existing.paperEnabled === undefined) {
      updateFields.paperEnabled = resolvePaperEnabled(existing);
      updateFields.enabled = updateFields.paperEnabled;
    }

    if (patch.liveEnabled !== undefined) {
      updateFields.liveEnabled = patch.liveEnabled === true;
    } else if (!existing) {
      updateFields.liveEnabled = seedRecord.liveEnabled;
    } else if (existing.liveEnabled === undefined) {
      updateFields.liveEnabled = false;
    }

    if (patch.newsBlackout !== undefined) {
      updateFields.newsBlackout = patch.newsBlackout === null ? null : cloneValue(patch.newsBlackout);
    } else if (!existing) {
      updateFields.newsBlackout = cloneValue(seedRecord.newsBlackout);
    }

    if (patch.tradeManagement !== undefined) {
      updateFields.tradeManagement = patch.tradeManagement === null ? null : cloneValue(patch.tradeManagement);
    } else if (!existing) {
      updateFields.tradeManagement = cloneValue(seedRecord.tradeManagement);
    }

    if (patch.executionPolicy !== undefined) {
      updateFields.executionPolicy = patch.executionPolicy === null ? null : cloneValue(patch.executionPolicy);
    } else if (!existing) {
      updateFields.executionPolicy = cloneValue(seedRecord.executionPolicy);
    }

    await strategyInstancesDb.update(
      { _id: buildCompositeId(strategyName, symbol) },
      { $set: updateFields },
      { upsert: true }
    );

    return await this.findByKey(strategyName, symbol);
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
          parameters: {},
          enabled: strategy.enabled,
          paperEnabled: strategy.enabled,
          liveEnabled: false,
          newsBlackout: null,
          tradeManagement: null,
          executionPolicy: null,
        });
        migrated += 1;
      }
    }

    console.log(`[StrategyInstance] migrateFromLegacy migrated=${migrated} skipped=${skipped}`);

    return { migrated, skipped };
  },

  async migrateLegacyNewsBlackoutDefaults() {
    const instances = await strategyInstancesDb.find({});
    let migrated = 0;

    for (const instance of instances) {
      if (!isLegacyNewsBlackoutConfig(instance.newsBlackout)) {
        continue;
      }

      await strategyInstancesDb.update(
        { _id: instance._id },
        {
          $set: {
            newsBlackout: normalizeNewsBlackoutConfig(
              DEFAULT_NEWS_BLACKOUT_CONFIG,
              DEFAULT_NEWS_BLACKOUT_CONFIG
            ),
            updatedAt: new Date(),
          },
        }
      );
      migrated += 1;
    }

    if (migrated > 0) {
      console.log(`[StrategyInstance] migrateLegacyNewsBlackoutDefaults migrated=${migrated}`);
    }

    return {
      migrated,
      skipped: Math.max(0, instances.length - migrated),
    };
  },

  async migrateScopedEnabledDefaults() {
    const instances = await this.findAll();
    let migrated = 0;

    for (const instance of instances) {
      const updateFields = {};
      if (instance.paperEnabled === undefined) {
        updateFields.paperEnabled = resolvePaperEnabled(instance);
        updateFields.enabled = updateFields.paperEnabled;
      }
      if (instance.liveEnabled === undefined) {
        updateFields.liveEnabled = false;
      }

      if (Object.keys(updateFields).length === 0) {
        continue;
      }

      await strategyInstancesDb.update(
        { _id: instance._id },
        {
          $set: {
            ...updateFields,
            updatedAt: new Date(),
          },
        }
      );
      migrated += 1;
    }

    if (migrated > 0) {
      console.log(`[StrategyInstance] migrateScopedEnabledDefaults migrated=${migrated}`);
    }

    return {
      migrated,
      skipped: Math.max(0, instances.length - migrated),
    };
  },
};

module.exports = StrategyInstance;
