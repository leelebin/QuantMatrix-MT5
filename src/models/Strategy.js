const { strategiesDb } = require('../config/db');
const { DEFAULT_STRATEGY_SYMBOL_ASSIGNMENTS } = require('../config/defaultAssignments');

const Strategy = {
  async create(data) {
    const now = new Date();
    return await strategiesDb.insert({
      ...data,
      enabled: data.enabled !== undefined ? data.enabled : true,
      createdAt: now,
      updatedAt: now,
    });
  },

  async findAll() {
    return await strategiesDb.find({}).sort({ name: 1 });
  },

  async findById(id) {
    return await strategiesDb.findOne({ _id: id });
  },

  async findByName(name) {
    return await strategiesDb.findOne({ name });
  },

  async update(id, fields) {
    fields.updatedAt = new Date();
    await strategiesDb.update({ _id: id }, { $set: fields });
    return await strategiesDb.findOne({ _id: id });
  },

  async toggleEnabled(id) {
    const strategy = await strategiesDb.findOne({ _id: id });
    if (!strategy) return null;
    const enabled = !strategy.enabled;
    await strategiesDb.update({ _id: id }, { $set: { enabled, updatedAt: new Date() } });
    return await strategiesDb.findOne({ _id: id });
  },

  // Called on every startup — only creates records that do not yet exist.
  // Uses DEFAULT_STRATEGY_SYMBOL_ASSIGNMENTS as the symbol source so that
  // first-time initialization reflects the intended default matrix rather than
  // the implicit per-strategy instrument groupings in instruments.js.
  async initDefaults(strategiesInfo) {
    for (const info of strategiesInfo) {
      const existing = await strategiesDb.findOne({ name: info.type });
      if (!existing) {
        const symbols = DEFAULT_STRATEGY_SYMBOL_ASSIGNMENTS[info.type] ?? [];
        await this.create({
          name: info.type,
          displayName: info.name,
          description: info.description,
          symbols,
          enabled: true,
        });
      }
    }
  },

  // Resets only the symbols array of every existing strategy record to the
  // values defined in DEFAULT_STRATEGY_SYMBOL_ASSIGNMENTS.  All other fields
  // (enabled, parameters, tradeManagement, etc.) are preserved.
  // Called only from the explicit reset endpoint — never on normal startup.
  async resetToDefaults() {
    const strategies = await strategiesDb.find({});
    const now = new Date();
    await Promise.all(
      strategies.map((strategy) => {
        const symbols = DEFAULT_STRATEGY_SYMBOL_ASSIGNMENTS[strategy.name] ?? [];
        return strategiesDb.update(
          { _id: strategy._id },
          { $set: { symbols, updatedAt: now } }
        );
      })
    );
  },
};

module.exports = Strategy;
