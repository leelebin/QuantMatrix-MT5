const { positionsDb } = require('../config/db');

const Position = {
  async findAll() {
    return await positionsDb.find({}).sort({ openedAt: -1 });
  },

  async findById(id) {
    return await positionsDb.findOne({ _id: id });
  },

  async findBySymbol(symbol) {
    return await positionsDb.find({ symbol });
  },

  async count(query = {}) {
    return await positionsDb.count(query);
  },
};

module.exports = Position;
