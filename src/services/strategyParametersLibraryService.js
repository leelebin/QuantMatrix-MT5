const Strategy = require('../models/Strategy');
const RiskProfile = require('../models/RiskProfile');
const { getStrategyInstance } = require('./strategyInstanceService');
const breakevenService = require('./breakevenService');
const { getInstrument } = require('../config/instruments');

function buildActiveRiskProfileSummary(activeProfile) {
  if (!activeProfile) {
    return null;
  }

  return {
    _id: activeProfile._id || null,
    name: activeProfile.name || null,
    maxRiskPerTradePct: Number(activeProfile.maxRiskPerTradePct) || 0,
    maxDailyLossPct: Number(activeProfile.maxDailyLossPct) || 0,
    maxDrawdownPct: Number(activeProfile.maxDrawdownPct) || 0,
    maxConcurrentPositions: Number(activeProfile.maxConcurrentPositions) || 0,
    maxPositionsPerSymbol: Number(activeProfile.maxPositionsPerSymbol) || 0,
    allowAggressiveMinLot: Boolean(activeProfile.allowAggressiveMinLot),
    breakeven: breakevenService.getProfileBreakeven(activeProfile),
  };
}

function buildRiskParameterSummary(resolvedParameters = {}) {
  const riskPercent = Number(resolvedParameters.riskPercent);
  const slMultiplier = Number(resolvedParameters.slMultiplier);
  const tpMultiplier = Number(resolvedParameters.tpMultiplier);

  return {
    riskPercent: Number.isFinite(riskPercent) ? riskPercent : null,
    riskPercentPct: Number.isFinite(riskPercent)
      ? parseFloat(((riskPercent <= 1 ? riskPercent * 100 : riskPercent)).toFixed(4))
      : null,
    slMultiplier: Number.isFinite(slMultiplier) ? slMultiplier : null,
    tpMultiplier: Number.isFinite(tpMultiplier) ? tpMultiplier : null,
  };
}

async function listAssignedStrategyRiskStatuses() {
  const [strategies, activeProfile] = await Promise.all([
    Strategy.findAll(),
    RiskProfile.getActive(),
  ]);

  const rows = [];

  for (const strategy of strategies || []) {
    const assignedSymbols = [...new Set(Array.isArray(strategy.symbols) ? strategy.symbols : [])];

    for (const symbol of assignedSymbols) {
      const strategyInstance = await getStrategyInstance(symbol, strategy.name, { activeProfile });
      const instrument = getInstrument(symbol);
      const effectiveParameters = strategyInstance.parameters || {};

      rows.push({
        key: `${strategy.name}:${symbol}`,
        symbol,
        strategyName: strategy.name,
        strategyDisplayName: strategy.displayName || strategy.name,
        strategyDescription: strategy.description || '',
        instanceEnabled: strategyInstance.enabled !== false,
        parameterSource: strategyInstance.source,
        instanceParameters: strategyInstance.storedParameters || {},
        effectiveParameters,
        riskParameters: buildRiskParameterSummary(effectiveParameters),
        effectiveBreakeven: strategyInstance.effectiveBreakeven,
        effectiveExitPlan: strategyInstance.effectiveExitPlan,
        effectiveTradeManagement: strategyInstance.effectiveTradeManagement,
        newsBlackout: strategyInstance.newsBlackout || null,
        executionPolicy: strategyInstance.executionPolicy || null,
        storedExecutionPolicy: strategyInstance.storedExecutionPolicy || null,
        storedTradeManagement: strategyInstance.storedTradeManagement || null,
        strategyDefaultParameters: strategyInstance.strategyDefaultParameters || {},
        instrument: instrument
          ? {
              category: instrument.category || null,
              timeframe: instrument.timeframe || null,
              higherTimeframe: instrument.higherTimeframe || null,
              entryTimeframe: instrument.entryTimeframe || null,
            }
          : null,
      });
    }
  }

  rows.sort((left, right) => {
    const symbolCompare = String(left.symbol).localeCompare(String(right.symbol));
    if (symbolCompare !== 0) return symbolCompare;
    return String(left.strategyDisplayName).localeCompare(String(right.strategyDisplayName));
  });

  return {
    activeRiskProfile: buildActiveRiskProfileSummary(activeProfile),
    count: rows.length,
    rows,
  };
}

module.exports = {
  listAssignedStrategyRiskStatuses,
};
