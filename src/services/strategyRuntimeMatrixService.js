const Strategy = require('../models/Strategy');
const StrategyInstance = require('../models/StrategyInstance');
const { getAllSymbols } = require('../config/instruments');

function normalizeScope(scope) {
  return String(scope || 'paper').toLowerCase() === 'live' ? 'live' : 'paper';
}

function buildBadRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function buildInstanceKey(strategyName, symbol) {
  return `${strategyName}:${symbol}`;
}

function normalizeStrategyList(strategies = []) {
  return strategies.map((strategy) => ({
    id: strategy._id,
    name: strategy.name,
    displayName: strategy.displayName || strategy.name,
    enabled: strategy.enabled,
  }));
}

function isEnabledForScope(instance, scope) {
  if (!instance) {
    return false;
  }

  if (scope === 'live') {
    return instance.liveEnabled === true;
  }

  if (instance.paperEnabled !== undefined) {
    return instance.paperEnabled !== false;
  }

  return instance.enabled !== false;
}

function buildEmptyEnabledBySymbol(symbols = []) {
  return Object.fromEntries(symbols.map((symbol) => [symbol, []]));
}

function buildEnabledByStrategy(strategies = [], enabledBySymbol = {}) {
  const enabledByStrategy = Object.fromEntries(strategies.map((strategy) => [strategy.name, []]));

  for (const [symbol, strategyNames] of Object.entries(enabledBySymbol || {})) {
    for (const strategyName of strategyNames || []) {
      if (!enabledByStrategy[strategyName]) {
        continue;
      }
      enabledByStrategy[strategyName].push(symbol);
    }
  }

  return enabledByStrategy;
}

function buildInstanceMap(instances = []) {
  return new Map(
    instances
      .filter((instance) => instance && instance.strategyName && instance.symbol)
      .map((instance) => [buildInstanceKey(instance.strategyName, instance.symbol), instance])
  );
}

function buildConfiguredSymbolSets(strategies = []) {
  return new Map(
    strategies.map((strategy) => [
      strategy.name,
      new Set(Array.isArray(strategy.symbols) ? strategy.symbols : []),
    ])
  );
}

function buildRuntimeMatrixPayload({
  scope,
  symbols,
  strategies,
  instanceMap,
  changes = [],
  summary = null,
}) {
  const enabledBySymbol = buildEmptyEnabledBySymbol(symbols);
  const validSymbolSet = new Set(symbols);

  for (const strategy of strategies) {
    for (const symbol of symbols) {
      const instance = instanceMap.get(buildInstanceKey(strategy.name, symbol));
      if (!isEnabledForScope(instance, scope)) {
        continue;
      }
      if (!validSymbolSet.has(symbol)) {
        continue;
      }
      enabledBySymbol[symbol].push(strategy.name);
    }
  }

  return {
    scope,
    symbols,
    strategies: normalizeStrategyList(strategies),
    enabledBySymbol,
    enabledByStrategy: buildEnabledByStrategy(strategies, enabledBySymbol),
    changes,
    summary: summary || {
      scope,
      changedCount: changes.length,
      enabledCount: changes.filter((change) => change.after === true).length,
      disabledCount: changes.filter((change) => change.after === false).length,
      createdConfigurationCount: changes.filter((change) => change.createdConfiguration === true).length,
    },
  };
}

function normalizeEnabledBySymbol(enabledBySymbol, { symbols, strategies }) {
  if (!enabledBySymbol || typeof enabledBySymbol !== 'object' || Array.isArray(enabledBySymbol)) {
    throw buildBadRequest('enabledBySymbol must be an object keyed by symbol');
  }

  const validSymbolSet = new Set(symbols);
  const validStrategySet = new Set(strategies.map((strategy) => strategy.name));
  const normalized = buildEmptyEnabledBySymbol(symbols);

  for (const [symbol, strategyNames] of Object.entries(enabledBySymbol)) {
    if (!validSymbolSet.has(symbol)) {
      throw buildBadRequest(`Invalid symbol: ${symbol}`);
    }
    if (!Array.isArray(strategyNames)) {
      throw buildBadRequest(`Runtime matrix entries for ${symbol} must be an array`);
    }

    normalized[symbol] = [...new Set(strategyNames)].map((strategyName) => {
      if (!validStrategySet.has(strategyName)) {
        throw buildBadRequest(`Invalid strategy: ${strategyName}`);
      }
      return strategyName;
    });
  }

  return normalized;
}

function buildEnabledSet(enabledBySymbol = {}) {
  const enabledSet = new Set();
  for (const [symbol, strategyNames] of Object.entries(enabledBySymbol)) {
    for (const strategyName of strategyNames || []) {
      enabledSet.add(buildInstanceKey(strategyName, symbol));
    }
  }
  return enabledSet;
}

function buildChanges({ scope, strategies, symbols, beforeSet, afterSet, configuredSymbolSets }) {
  const changes = [];

  for (const strategy of strategies) {
    const configuredSymbols = configuredSymbolSets.get(strategy.name) || new Set();
    for (const symbol of symbols) {
      const key = buildInstanceKey(strategy.name, symbol);
      const before = beforeSet.has(key);
      const after = afterSet.has(key);
      if (before === after) {
        continue;
      }

      changes.push({
        scope,
        symbol,
        strategyName: strategy.name,
        strategyDisplayName: strategy.displayName || strategy.name,
        before,
        after,
        action: after ? 'enabled' : 'disabled',
        createdConfiguration: after && !configuredSymbols.has(symbol),
      });
    }
  }

  return changes;
}

async function ensureConfiguredSymbols({ strategies, symbols, enabledBySymbol }) {
  const symbolOrder = new Map(symbols.map((symbol, index) => [symbol, index]));

  for (const strategy of strategies) {
    const currentSymbols = new Set(Array.isArray(strategy.symbols) ? strategy.symbols : []);
    let changed = false;

    for (const [symbol, strategyNames] of Object.entries(enabledBySymbol)) {
      if (!strategyNames.includes(strategy.name) || currentSymbols.has(symbol)) {
        continue;
      }
      currentSymbols.add(symbol);
      changed = true;
    }

    if (!changed) {
      continue;
    }

    const nextSymbols = [...currentSymbols].sort((left, right) => (
      (symbolOrder.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (symbolOrder.get(right) ?? Number.MAX_SAFE_INTEGER)
    ));
    await Strategy.update(strategy._id, { symbols: nextSymbols });
  }
}

async function getRuntimeMatrix({ scope = 'paper' } = {}) {
  const normalizedScope = normalizeScope(scope);
  const [strategies, instances] = await Promise.all([
    Strategy.findAll(),
    StrategyInstance.findAll(),
  ]);
  const symbols = getAllSymbols();
  const instanceMap = buildInstanceMap(instances);

  return buildRuntimeMatrixPayload({
    scope: normalizedScope,
    symbols,
    strategies,
    instanceMap,
  });
}

async function updateRuntimeMatrix({ scope = 'paper', enabledBySymbol } = {}) {
  const normalizedScope = normalizeScope(scope);
  const [strategies, instances] = await Promise.all([
    Strategy.findAll(),
    StrategyInstance.findAll(),
  ]);
  const symbols = getAllSymbols();
  const instanceMap = buildInstanceMap(instances);
  const configuredSymbolSets = buildConfiguredSymbolSets(strategies);
  const beforePayload = buildRuntimeMatrixPayload({
    scope: normalizedScope,
    symbols,
    strategies,
    instanceMap,
  });
  const normalizedEnabledBySymbol = normalizeEnabledBySymbol(enabledBySymbol, {
    symbols,
    strategies,
  });
  const beforeSet = buildEnabledSet(beforePayload.enabledBySymbol);
  const afterSet = buildEnabledSet(normalizedEnabledBySymbol);
  const changes = buildChanges({
    scope: normalizedScope,
    strategies,
    symbols,
    beforeSet,
    afterSet,
    configuredSymbolSets,
  });

  await ensureConfiguredSymbols({
    strategies,
    symbols,
    enabledBySymbol: normalizedEnabledBySymbol,
  });

  for (const change of changes) {
    const patch = normalizedScope === 'live'
      ? { liveEnabled: change.after }
      : { paperEnabled: change.after };
    await StrategyInstance.upsert(change.strategyName, change.symbol, patch);
  }

  const updatedInstances = await StrategyInstance.findAll();
  const updatedStrategies = await Strategy.findAll();
  const updatedInstanceMap = buildInstanceMap(updatedInstances);
  const summary = {
    scope: normalizedScope,
    changedCount: changes.length,
    enabledCount: changes.filter((change) => change.after === true).length,
    disabledCount: changes.filter((change) => change.after === false).length,
    createdConfigurationCount: changes.filter((change) => change.createdConfiguration === true).length,
  };

  return buildRuntimeMatrixPayload({
    scope: normalizedScope,
    symbols,
    strategies: updatedStrategies,
    instanceMap: updatedInstanceMap,
    changes,
    summary,
  });
}

module.exports = {
  getRuntimeMatrix,
  normalizeScope,
  updateRuntimeMatrix,
};
