const SymbolCustom = require('../models/SymbolCustom');
const { getStrategyExecutionConfig } = require('../config/strategyExecution');
const { resolveDirectionControlConfig } = require('./directionControlConfig');
const { evaluateDirectionControl } = require('./directionControlEvaluator');

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function getBarTime(bar = {}) {
  return bar.time || bar.timestamp || bar.date || null;
}

function toEpoch(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isSymbolCustomPosition(position = {}) {
  return String(position.source || '').toLowerCase() === 'symbolcustom'
    || Boolean(position.symbolCustomId)
    || Boolean(position.symbolCustomName);
}

async function resolveSymbolCustomForPosition(position = {}, customResolver = null) {
  if (typeof customResolver === 'function') {
    const resolved = await customResolver(position);
    if (resolved) return resolved;
  }
  if (position.symbolCustomId) {
    const byId = await SymbolCustom.findById(position.symbolCustomId).catch(() => null);
    if (byId) return byId;
  }
  if (position.symbol && position.symbolCustomName) {
    return SymbolCustom.findByName(position.symbol, position.symbolCustomName).catch(() => null);
  }
  return null;
}

function resolveTimeframe({ position = {}, strategyInstance = null, symbolCustom = null }) {
  if (position.entryTimeframe) return position.entryTimeframe;
  if (position.setupTimeframe) return position.setupTimeframe;
  if (position.timeframe) return position.timeframe;
  if (symbolCustom?.timeframes?.entryTimeframe) return symbolCustom.timeframes.entryTimeframe;
  if (symbolCustom?.timeframes?.setupTimeframe) return symbolCustom.timeframes.setupTimeframe;
  const executionConfig = position.strategy
    ? getStrategyExecutionConfig(position.symbol, position.strategy)
    : null;
  return strategyInstance?.timeframe
    || executionConfig?.entryTimeframe
    || executionConfig?.timeframe
    || 'H1';
}

function resolveEntryIndex(position = {}, candles = []) {
  const explicit = toNumber(position.entryIndex, toNumber(position.entryBarIndex, null));
  if (Number.isFinite(explicit)) return explicit;

  const entryMs = toEpoch(position.entryCandleTime || position.entryTime || position.openedAt || position.createdAt);
  if (!entryMs || !Array.isArray(candles) || candles.length === 0) return null;

  let candidate = null;
  for (let i = 0; i < candles.length; i += 1) {
    const barMs = toEpoch(getBarTime(candles[i]));
    if (!barMs) continue;
    if (barMs <= entryMs) candidate = i;
    if (barMs >= entryMs) return candidate == null ? i : candidate;
  }
  return candidate;
}

function resolveCurrentPrice(position = {}, priceData = null, currentBar = null) {
  const side = String(position.type || position.side || '').toUpperCase();
  if (priceData) {
    const bid = toNumber(priceData.bid, null);
    const ask = toNumber(priceData.ask, null);
    const last = toNumber(priceData.last, toNumber(priceData.price, null));
    if (side === 'BUY' && Number.isFinite(bid)) return bid;
    if (side === 'SELL' && Number.isFinite(ask)) return ask;
    if (Number.isFinite(last)) return last;
  }
  return toNumber(position.currentPrice, toNumber(currentBar?.close, null));
}

function buildRuntimePosition(position = {}, candles = [], currentPrice = null) {
  const entryIndex = resolveEntryIndex(position, candles);
  return {
    ...clone(position),
    id: position._id || position.id || position.mt5PositionId || null,
    side: position.side || position.type,
    type: position.type || position.side,
    sl: position.initialSl || position.sl || position.stopLoss || position.currentSl,
    tp: position.initialTp || position.tp || position.takeProfit || position.currentTp,
    entryIndex,
    currentPrice,
  };
}

async function evaluateRuntimeDirectionControl({
  positions = [],
  scope = 'live',
  getStrategyInstanceFn,
  getSymbolCustomFn = null,
  getPriceFn,
  getCandlesFn,
  updatePositionFn,
  now = new Date(),
} = {}) {
  if (!Array.isArray(positions) || positions.length === 0) return [];
  if (typeof getPriceFn !== 'function' || typeof getCandlesFn !== 'function' || typeof updatePositionFn !== 'function') {
    return [];
  }

  const updates = [];
  for (const position of positions) {
    try {
      const isCustom = isSymbolCustomPosition(position);
      const symbolCustom = isCustom
        ? await resolveSymbolCustomForPosition(position, getSymbolCustomFn)
        : null;
      const strategyInstance = !isCustom && typeof getStrategyInstanceFn === 'function'
        ? await getStrategyInstanceFn(position)
        : null;
      const config = isCustom
        ? resolveDirectionControlConfig({ symbolCustom, source: 'symbolCustom' })
        : resolveDirectionControlConfig({ strategyInstance });

      if (!config.enabled) continue;

      const timeframe = resolveTimeframe({ position, strategyInstance, symbolCustom });
      const [priceData, candles] = await Promise.all([
        Promise.resolve(getPriceFn(position.symbol)).catch(() => null),
        Promise.resolve(getCandlesFn(position.symbol, timeframe)).catch(() => null),
      ]);
      if (!Array.isArray(candles) || candles.length === 0) continue;

      const currentIndex = candles.length - 1;
      const currentBar = candles[currentIndex];
      const currentPrice = resolveCurrentPrice(position, priceData, currentBar);
      const runtimePosition = buildRuntimePosition(position, candles, currentPrice);
      const result = evaluateDirectionControl({
        config,
        position: runtimePosition,
        candles,
        currentBar,
        currentIndex,
        existingState: position.directionControl || null,
        strategyContext: {
          symbol: position.symbol,
          strategy: position.strategy || position.strategyName || null,
          strategyInstanceId: strategyInstance?._id || position.strategyInstanceId || null,
          symbolCustomId: symbolCustom?._id || position.symbolCustomId || null,
          symbolCustomName: symbolCustom?.symbolCustomName || position.symbolCustomName || null,
          atr: position.directionControlAtr || null,
          entryThesisLevels: position.entryThesisLevels || position.thesisLevels || null,
          currentPrice,
          currentBarClosed: true,
          scope,
        },
        serverTime: now,
      });

      if (!result?.event || !result.statePatch?.directionControl) continue;
      const managementEvents = [
        ...(Array.isArray(position.managementEvents) ? clone(position.managementEvents) : []),
        result.event,
      ];
      const patch = {
        managementEvents,
        directionControl: {
          ...(position.directionControl || {}),
          ...result.statePatch.directionControl,
        },
        lastDirectionControlAuditAt: now instanceof Date ? now.toISOString() : new Date(now).toISOString(),
      };
      await updatePositionFn(position._id || position.id || position.mt5PositionId, patch, position);
      updates.push({
        positionId: position._id || position.id || position.mt5PositionId || null,
        symbol: position.symbol,
        event: result.event,
        statePatch: result.statePatch,
      });
    } catch (err) {
      updates.push({
        positionId: position?._id || position?.id || position?.mt5PositionId || null,
        symbol: position?.symbol || null,
        error: err.message,
      });
    }
  }
  return updates;
}

module.exports = {
  evaluateRuntimeDirectionControl,
  isSymbolCustomPosition,
  resolveEntryIndex,
};
