const Strategy = require('../models/Strategy');
const StrategyInstance = require('../models/StrategyInstance');
const { getStrategyInstance } = require('../services/strategyInstanceService');

function buildEffectiveInstancePayload(instanceRecord, effectiveInstance, strategyName, symbol) {
  return {
    _id: instanceRecord?._id || null,
    strategyName,
    symbol,
    parameters: effectiveInstance.parameters,
    enabled: effectiveInstance.enabled,
    source: effectiveInstance.source,
    createdAt: instanceRecord?.createdAt || null,
    updatedAt: instanceRecord?.updatedAt || null,
  };
}

async function ensureStrategyExists(strategyName) {
  const strategy = await Strategy.findByName(strategyName);
  if (!strategy) {
    const error = new Error(`Strategy definition not found for ${strategyName}`);
    error.statusCode = 404;
    throw error;
  }

  return strategy;
}

exports.getStrategyInstances = async (req, res) => {
  try {
    const instances = await StrategyInstance.findAll();
    res.json({ success: true, data: instances });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

exports.getStrategyInstancesByStrategyName = async (req, res) => {
  try {
    await ensureStrategyExists(req.params.strategyName);
    const instances = await StrategyInstance.findByStrategyName(req.params.strategyName);
    res.json({ success: true, data: instances });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

exports.getStrategyInstanceByKey = async (req, res) => {
  try {
    const { strategyName, symbol } = req.params;
    const effectiveInstance = await getStrategyInstance(symbol, strategyName);
    const storedInstance = await StrategyInstance.findByKey(strategyName, symbol);
    res.json({
      success: true,
      data: buildEffectiveInstancePayload(storedInstance, effectiveInstance, strategyName, symbol),
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

exports.upsertStrategyInstance = async (req, res) => {
  try {
    const { strategyName, symbol } = req.params;
    const patch = {};

    if (req.body.parameters !== undefined) {
      patch.parameters = req.body.parameters;
    }
    if (req.body.enabled !== undefined) {
      patch.enabled = req.body.enabled;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Request must include parameters or enabled',
      });
    }

    await ensureStrategyExists(strategyName);
    const instance = await StrategyInstance.upsert(strategyName, symbol, patch);
    res.json({ success: true, data: instance });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};
