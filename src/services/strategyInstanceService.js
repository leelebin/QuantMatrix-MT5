const Strategy = require('../models/Strategy');
const StrategyInstance = require('../models/StrategyInstance');

function cloneParameters(parameters) {
  if (parameters === undefined) {
    return {};
  }

  return JSON.parse(JSON.stringify(parameters));
}

async function getStrategyInstance(symbol, strategyName) {
  const strategy = await Strategy.findByName(strategyName);
  if (!strategy) {
    const error = new Error(`Strategy definition not found for ${strategyName}`);
    error.statusCode = 404;
    throw error;
  }

  const instance = await StrategyInstance.findByKey(strategyName, symbol);
  if (instance) {
    return {
      parameters: cloneParameters(instance.parameters),
      enabled: instance.enabled !== undefined ? instance.enabled : true,
      source: 'instance',
    };
  }

  console.warn(`[StrategyInstance] falling back to legacy global parameters for ${symbol}/${strategyName}`);
  return {
    parameters: cloneParameters(strategy.parameters),
    enabled: strategy.enabled !== undefined ? strategy.enabled : true,
    source: 'legacy',
  };
}

module.exports = {
  getStrategyInstance,
};
