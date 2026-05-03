const { strategiesDb } = require('../config/db');
const { DEFAULT_STRATEGY_SYMBOL_ASSIGNMENTS } = require('../config/defaultAssignments');

const Strategy = {
  async create(data) {
    const now = new Date();
    const symbols = data.symbols ?? [];
    return await strategiesDb.insert({
      ...data,
      enabled: data.enabled !== undefined ? data.enabled : true,
      symbols,
      // Paper-trading-specific overrides. On first create they mirror the live
      // defaults so paper and live start with identical assignments. Users can
      // diverge them later via the paper-assignment endpoints without touching
      // the live config.
      paperEnabled: data.paperEnabled !== undefined ? data.paperEnabled : true,
      paperSymbols: Array.isArray(data.paperSymbols) ? data.paperSymbols : symbols.slice(),
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

  // Toggle the paper-trading-specific enabled flag without touching live `enabled`.
  async togglePaperEnabled(id) {
    const strategy = await strategiesDb.findOne({ _id: id });
    if (!strategy) return null;
    // Fall back to live `enabled` when the paper flag has never been set (old records).
    const current = strategy.paperEnabled !== undefined ? strategy.paperEnabled : strategy.enabled;
    const paperEnabled = !current;
    await strategiesDb.update({ _id: id }, { $set: { paperEnabled, updatedAt: new Date() } });
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
          // Paper mirrors live on first create.
          paperEnabled: true,
          paperSymbols: symbols.slice(),
        });
      } else if (existing.paperEnabled === undefined || existing.paperSymbols === undefined) {
        // Backfill paper fields on existing records that pre-date this change.
        const patch = {};
        if (existing.paperEnabled === undefined) patch.paperEnabled = existing.enabled;
        if (existing.paperSymbols === undefined) patch.paperSymbols = (existing.symbols || []).slice();
        if (Object.keys(patch).length > 0) {
          patch.updatedAt = new Date();
          await strategiesDb.update({ _id: existing._id }, { $set: patch });
        }
      }
    }
  },

  // Resets live symbols only (paper symbols are left intact).
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

  // Resets paper symbols to defaults without touching live config.
  async resetPaperToDefaults() {
    const strategies = await strategiesDb.find({});
    const now = new Date();
    await Promise.all(
      strategies.map((strategy) => {
        const paperSymbols = DEFAULT_STRATEGY_SYMBOL_ASSIGNMENTS[strategy.name] ?? [];
        return strategiesDb.update(
          { _id: strategy._id },
          { $set: { paperSymbols, paperEnabled: true, updatedAt: now } }
        );
      })
    );
  },
};

module.exports = Strategy;
