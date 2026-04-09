const Strategy = require('../models/Strategy');
const strategyEngine = require('../services/strategyEngine');

// @desc    Get all strategies
// @route   GET /api/strategies
exports.getStrategies = async (req, res) => {
  try {
    // Ensure defaults exist
    await Strategy.initDefaults(strategyEngine.getStrategiesInfo());
    const strategies = await Strategy.findAll();
    res.json({ success: true, data: strategies });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get single strategy
// @route   GET /api/strategies/:id
exports.getStrategy = async (req, res) => {
  try {
    const strategy = await Strategy.findById(req.params.id);
    if (!strategy) {
      return res.status(404).json({ success: false, message: 'Strategy not found' });
    }
    res.json({ success: true, data: strategy });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Update strategy parameters
// @route   PUT /api/strategies/:id
exports.updateStrategy = async (req, res) => {
  try {
    const { symbols, enabled, parameters } = req.body;
    const updateFields = {};
    if (symbols !== undefined) updateFields.symbols = symbols;
    if (enabled !== undefined) updateFields.enabled = enabled;
    if (parameters !== undefined) updateFields.parameters = parameters;

    const strategy = await Strategy.update(req.params.id, updateFields);
    if (!strategy) {
      return res.status(404).json({ success: false, message: 'Strategy not found' });
    }
    res.json({ success: true, data: strategy });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Toggle strategy enabled/disabled
// @route   PUT /api/strategies/:id/toggle
exports.toggleStrategy = async (req, res) => {
  try {
    const strategy = await Strategy.toggleEnabled(req.params.id);
    if (!strategy) {
      return res.status(404).json({ success: false, message: 'Strategy not found' });
    }
    res.json({
      success: true,
      message: `Strategy ${strategy.enabled ? 'enabled' : 'disabled'}`,
      data: strategy,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get recent signals for a strategy
// @route   GET /api/strategies/:id/signals
exports.getSignals = async (req, res) => {
  try {
    const strategy = await Strategy.findById(req.params.id);
    if (!strategy) {
      return res.status(404).json({ success: false, message: 'Strategy not found' });
    }

    const limit = parseInt(req.query.limit) || 50;
    // Filter signals by strategy symbols
    const allSignals = strategyEngine.getRecentSignals(null, 200);
    const signals = allSignals
      .filter((s) => s.strategy === strategy.name)
      .slice(0, limit);

    res.json({ success: true, data: signals, count: signals.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
