const { strategiesDb } = require('../config/db');

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

  async initDefaults(strategiesInfo) {
    for (const info of strategiesInfo) {
      const existing = await strategiesDb.findOne({ name: info.type });
      if (!existing) {
        await this.create({
          name: info.type,
          displayName: info.name,
          description: info.description,
          symbols: info.symbols,
          enabled: true,
        });
      }
    }
  },
};

module.exports = Strategy;
