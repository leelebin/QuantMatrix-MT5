const { normalizeDirectionControlConfig } = require('./directionControlConfig');

const EVENT_TYPE = 'POST_ENTRY_DIRECTION_CONTROL';
const AUDIT_ACTION = 'AUDIT_ONLY';
const DEFAULT_ATR_PERIOD = 14;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function round(value, digits = 4) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return parseFloat(num.toFixed(digits));
}

function normalizeSide(side) {
  const value = String(side || '').toUpperCase();
  if (value === 'BUY' || value === 'LONG') return 'BUY';
  if (value === 'SELL' || value === 'SHORT') return 'SELL';
  return null;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function getTimeValue(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function getPositionId(position = {}) {
  return position.positionId
    || position.id
    || position._id
    || position.mt5PositionId
    || position.ticket
    || null;
}

function getTradeId(position = {}, trade = null) {
  return trade?.tradeId
    || trade?.id
    || position.tradeId
    || null;
}

function getEntryIndex(position = {}, fallbackIndex = null) {
  return toNumber(position.entryIndex, toNumber(position.entryBarIndex, fallbackIndex));
}

function getEntryPrice(position = {}) {
  return toNumber(position.entryPrice, toNumber(position.openPrice, null));
}

function getStopLoss(position = {}) {
  return toNumber(
    position.initialSl,
    toNumber(position.sl, toNumber(position.stopLoss, toNumber(position.currentSl, null)))
  );
}

function getCurrentStopLoss(position = {}) {
  return toNumber(position.currentSl, toNumber(position.stopLoss, toNumber(position.sl, null)));
}

function getTakeProfit(position = {}) {
  return toNumber(position.tp, toNumber(position.takeProfit, toNumber(position.currentTp, null)));
}

function getBarTime(bar = {}) {
  return bar.time || bar.timestamp || bar.date || null;
}

function getClosePrice(bar = {}) {
  return toNumber(bar.close, toNumber(bar.bid, toNumber(bar.ask, null)));
}

function getHighPrice(bar = {}) {
  return toNumber(bar.high, getClosePrice(bar));
}

function getLowPrice(bar = {}) {
  return toNumber(bar.low, getClosePrice(bar));
}

function calculateSimpleAtr(candles, currentIndex, period = DEFAULT_ATR_PERIOD) {
  if (!Array.isArray(candles) || currentIndex <= 0) return null;
  const start = Math.max(1, currentIndex - period + 1);
  const ranges = [];
  for (let i = start; i <= currentIndex; i += 1) {
    const bar = candles[i];
    const prev = candles[i - 1];
    if (!bar || !prev) continue;
    const high = getHighPrice(bar);
    const low = getLowPrice(bar);
    const prevClose = getClosePrice(prev);
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(prevClose)) continue;
    ranges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (ranges.length === 0) return null;
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

function resolveAtr({ strategyContext = {}, candles, currentIndex, currentBar }) {
  const explicit = toNumber(strategyContext.atr, null);
  if (Number.isFinite(explicit) && explicit > 0) {
    return { value: explicit, source: 'strategyContext.atr' };
  }

  const barAtr = toNumber(currentBar?.atr, toNumber(currentBar?.ATR, null));
  if (Number.isFinite(barAtr) && barAtr > 0) {
    return { value: barAtr, source: 'candle.atr' };
  }

  const calculated = calculateSimpleAtr(candles, currentIndex);
  if (Number.isFinite(calculated) && calculated > 0) {
    return { value: calculated, source: 'candle_stream_calculated' };
  }

  return { value: null, source: 'unavailable' };
}

function calculateR(side, entryPrice, riskDistance, currentPrice) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(riskDistance) || riskDistance <= 0) return null;
  if (!Number.isFinite(currentPrice)) return null;
  return side === 'BUY'
    ? (currentPrice - entryPrice) / riskDistance
    : (entryPrice - currentPrice) / riskDistance;
}

function calculateExcursionR({ side, candles, entryIndex, currentIndex, entryPrice, riskDistance }) {
  let mfeR = 0;
  let maeR = 0;
  if (!Array.isArray(candles) || !Number.isFinite(entryIndex) || !Number.isFinite(currentIndex)) {
    return { mfeR: null, maeR: null };
  }

  const start = Math.max(0, Math.floor(entryIndex));
  const end = Math.min(candles.length - 1, Math.floor(currentIndex));
  for (let i = start; i <= end; i += 1) {
    const bar = candles[i];
    if (!bar) continue;
    const high = getHighPrice(bar);
    const low = getLowPrice(bar);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    const favourable = side === 'BUY'
      ? (high - entryPrice) / riskDistance
      : (entryPrice - low) / riskDistance;
    const adverse = side === 'BUY'
      ? (low - entryPrice) / riskDistance
      : (entryPrice - high) / riskDistance;

    if (Number.isFinite(favourable)) mfeR = Math.max(mfeR, favourable);
    if (Number.isFinite(adverse)) maeR = Math.min(maeR, adverse);
  }

  return { mfeR, maeR };
}

function getCheckBase(check = {}) {
  return {
    enabled: Boolean(check.enabled),
    triggered: false,
    score: Number(check.score) || 0,
    critical: Boolean(check.critical),
    category: check.category || null,
  };
}

function evaluateAdverseR(check, currentR) {
  const thresholdR = toNumber(check.thresholdR, -0.6);
  const triggered = Number.isFinite(currentR) && currentR <= thresholdR;
  return {
    ...getCheckBase(check),
    triggered,
    value: round(currentR),
    thresholdR,
  };
}

function evaluateFailedFollowThrough(check, currentR, mfeR) {
  const minFavourableR = toNumber(check.minFavourableR, 0.25);
  const currentRThreshold = toNumber(check.currentRThreshold, -0.35);
  const triggered = Number.isFinite(mfeR)
    && Number.isFinite(currentR)
    && mfeR >= minFavourableR
    && currentR <= currentRThreshold;
  return {
    ...getCheckBase(check),
    triggered,
    mfeR: round(mfeR),
    minFavourableR,
    currentR: round(currentR),
    currentRThreshold,
  };
}

function resolveSignalDirection(signal) {
  if (!signal) return null;
  if (typeof signal === 'string') return normalizeSide(signal);
  return normalizeSide(signal.direction || signal.signal || signal.side || signal.type);
}

function resolveOpposingSignal(strategyContext = {}) {
  const signal = strategyContext.opposingSignalDetails
    || strategyContext.opposingSignal
    || strategyContext.signal
    || null;
  if (!signal) return null;
  if (signal === true) {
    return {
      signalName: 'opposing_signal',
      signalDirection: null,
      signalTime: null,
      repaintSafe: Boolean(strategyContext.opposingSignalRepaintSafe),
      barIndex: strategyContext.opposingSignalBarIndex,
    };
  }
  if (typeof signal === 'string') {
    return {
      signalName: signal,
      signalDirection: resolveSignalDirection(signal),
      signalTime: null,
      repaintSafe: Boolean(strategyContext.opposingSignalRepaintSafe),
      barIndex: strategyContext.opposingSignalBarIndex,
    };
  }
  if (!isPlainObject(signal)) return null;
  return {
    signalName: signal.name || signal.signalName || signal.reasonCode || signal.reason || 'opposing_signal',
    signalDirection: resolveSignalDirection(signal),
    signalTime: signal.time || signal.signalTime || signal.candleTime || null,
    repaintSafe: signal.repaintSafe === true || strategyContext.opposingSignalRepaintSafe === true,
    barIndex: toNumber(signal.barIndex, toNumber(signal.index, strategyContext.opposingSignalBarIndex)),
  };
}

function evaluateOpposingSignal(check, side, currentIndex, strategyContext = {}) {
  const base = getCheckBase(check);
  const signal = resolveOpposingSignal(strategyContext);
  const useClosedBarOnly = check.useClosedBarOnly !== false;
  const allowRepaintSignal = check.allowRepaintSignal === true;
  const maxSignalAgeBars = toNumber(check.maxSignalAgeBars, 2);

  const result = {
    ...base,
    signalName: signal?.signalName || null,
    signalDirection: signal?.signalDirection || null,
    signalTime: signal?.signalTime ? getTimeValue(signal.signalTime) : null,
    useClosedBarOnly,
    repaintSafe: Boolean(signal?.repaintSafe),
    maxSignalAgeBars,
  };

  if (!signal) {
    return { ...result, reason: 'no_opposing_signal_context' };
  }

  if (!allowRepaintSignal && signal.repaintSafe !== true) {
    return { ...result, reason: 'opposing_signal_repaint_safety_unconfirmed' };
  }

  if (useClosedBarOnly && strategyContext.currentBarClosed === false) {
    return { ...result, reason: 'current_bar_not_closed' };
  }

  if (Number.isFinite(signal.barIndex) && Number.isFinite(currentIndex)) {
    const age = Math.abs(currentIndex - signal.barIndex);
    if (age > maxSignalAgeBars) {
      return { ...result, reason: 'opposing_signal_too_old', signalAgeBars: age };
    }
    result.signalAgeBars = age;
  }

  if (!signal.signalDirection || signal.signalDirection === side) {
    return { ...result, reason: 'signal_not_opposing' };
  }

  return { ...result, triggered: true };
}

function extractNumericLevel(value, side) {
  if (Number.isFinite(Number(value))) return Number(value);
  if (!isPlainObject(value)) return null;

  const sideSpecific = side === 'BUY'
    ? (value.lower ?? value.low ?? value.bottom ?? value.support)
    : (value.upper ?? value.high ?? value.top ?? value.resistance);
  if (Number.isFinite(Number(sideSpecific))) return Number(sideSpecific);

  const generic = value.level ?? value.price ?? value.value ?? value.anchor;
  return Number.isFinite(Number(generic)) ? Number(generic) : null;
}

function resolveEntryThesisLevels(position = {}, strategyContext = {}) {
  const levels = {
    ...(isPlainObject(position.entryThesisLevels) ? position.entryThesisLevels : {}),
    ...(isPlainObject(position.thesisLevels) ? position.thesisLevels : {}),
    ...(isPlainObject(strategyContext.entryThesisLevels) ? strategyContext.entryThesisLevels : {}),
    ...(isPlainObject(strategyContext.thesisLevels) ? strategyContext.thesisLevels : {}),
  };

  const zoneBoundary = position.zoneBoundary
    ?? position.zone_boundary
    ?? strategyContext.zoneBoundary
    ?? strategyContext.zone_boundary;
  if (zoneBoundary !== undefined && levels.zone_boundary === undefined) levels.zone_boundary = zoneBoundary;

  const pinbarExtreme = position.pinbarExtreme
    ?? position.pinbar_extreme
    ?? strategyContext.pinbarExtreme
    ?? strategyContext.pinbar_extreme;
  if (pinbarExtreme !== undefined && levels.pinbar_extreme === undefined) levels.pinbar_extreme = pinbarExtreme;

  const entrySwing = position.entrySwing
    ?? position.entry_swing
    ?? position.structureAnchor
    ?? strategyContext.entrySwing
    ?? strategyContext.entry_swing
    ?? strategyContext.structureAnchor;
  if (entrySwing !== undefined && levels.entry_swing === undefined) levels.entry_swing = entrySwing;

  return levels;
}

function resolveRecentSwingLevel({ side, candles, currentIndex, lookbackBars }) {
  if (!Array.isArray(candles) || !Number.isFinite(currentIndex)) return null;
  const end = Math.max(0, Math.floor(currentIndex));
  const start = Math.max(0, end - Math.max(1, lookbackBars) + 1);
  let level = null;
  for (let i = start; i <= end; i += 1) {
    const bar = candles[i];
    if (!bar) continue;
    if (side === 'BUY') {
      const low = getLowPrice(bar);
      if (Number.isFinite(low)) level = level == null ? low : Math.min(level, low);
    } else {
      const high = getHighPrice(bar);
      if (Number.isFinite(high)) level = level == null ? high : Math.max(level, high);
    }
  }
  return level;
}

function resolveStructureLevel({ check, side, position, strategyContext, candles, currentIndex }) {
  const levels = resolveEntryThesisLevels(position, strategyContext);
  const priority = Array.isArray(check.levels) && check.levels.length > 0
    ? check.levels
    : ['zone_boundary', 'pinbar_extreme', 'entry_swing'];

  for (const levelType of priority) {
    const level = extractNumericLevel(levels[levelType], side);
    if (Number.isFinite(level)) {
      return { levelType, level, fallback: false };
    }
  }

  const fallbackLevel = resolveRecentSwingLevel({
    side,
    candles,
    currentIndex,
    lookbackBars: toNumber(check.lookbackBars, 8),
  });
  if (Number.isFinite(fallbackLevel)) {
    return { levelType: 'recent_swing', level: fallbackLevel, fallback: true };
  }

  return { levelType: null, level: null, fallback: true };
}

function evaluateStructureBreak({
  check,
  side,
  position,
  strategyContext,
  candles,
  currentIndex,
  currentBar,
  atr,
}) {
  const base = getCheckBase(check);
  const levelInfo = resolveStructureLevel({
    check,
    side,
    position,
    strategyContext,
    candles,
    currentIndex,
  });
  const close = getClosePrice(currentBar);
  const bufferAtr = toNumber(check.bufferAtr, 0.1);
  const confirmByClose = check.confirmByClose !== false;

  const result = {
    ...base,
    levelType: levelInfo.levelType,
    level: round(levelInfo.level, 6),
    close: round(close, 6),
    bufferAtr,
    confirmByClose,
    atr: round(atr, 6),
    fallback: Boolean(levelInfo.fallback),
  };

  if (!Number.isFinite(atr) || atr <= 0) {
    return { ...result, reason: 'atr_unavailable' };
  }
  if (!Number.isFinite(levelInfo.level)) {
    return { ...result, reason: 'structure_level_unavailable' };
  }
  if (!Number.isFinite(close)) {
    return { ...result, reason: 'close_unavailable' };
  }

  const buffer = bufferAtr * atr;
  const triggered = side === 'BUY'
    ? close < levelInfo.level - buffer
    : close > levelInfo.level + buffer;
  return {
    ...result,
    triggered,
    threshold: round(side === 'BUY' ? levelInfo.level - buffer : levelInfo.level + buffer, 6),
  };
}

function evaluateEmaInvalidation(check, side, currentBar, strategyContext = {}) {
  const base = getCheckBase(check);
  const period = toNumber(check.period, 50);
  const key = `ema${period}`;
  const emaValue = toNumber(
    strategyContext[key],
    toNumber(strategyContext.ema, toNumber(currentBar?.[key], null))
  );
  const close = getClosePrice(currentBar);
  const result = {
    ...base,
    period,
    confirmByClose: check.confirmByClose !== false,
    value: round(close, 6),
    ema: round(emaValue, 6),
  };
  if (!Number.isFinite(emaValue) || !Number.isFinite(close)) {
    return { ...result, reason: 'ema_unavailable' };
  }
  return {
    ...result,
    triggered: side === 'BUY' ? close < emaValue : close > emaValue,
  };
}

function evaluateHigherTrendFlip(check, side, strategyContext = {}) {
  const base = getCheckBase(check);
  const higherSide = normalizeSide(
    strategyContext.higherTrendSide
      || strategyContext.higherTrendDirection
      || strategyContext.higherTrend
  );
  const explicitFlip = strategyContext.higherTrendFlip === true
    || strategyContext.higherTrendChanged === true;
  const triggered = explicitFlip || (higherSide && higherSide !== side);
  return {
    ...base,
    triggered: Boolean(triggered),
    higherTrendSide: higherSide,
    confirmByClose: check.confirmByClose !== false,
    reason: triggered ? null : 'higher_trend_flip_not_detected',
  };
}

function buildInitialCheckResults(config) {
  const checks = {};
  for (const [name, check] of Object.entries(config.checks || {})) {
    checks[name] = getCheckBase(check);
  }
  return checks;
}

function skippedResult(reason, config, extraCheckResults = null) {
  const normalized = normalizeDirectionControlConfig(config);
  const checkResults = extraCheckResults || buildInitialCheckResults(normalized);
  checkResults.skippedReason = reason;
  return {
    skipped: true,
    triggered: false,
    event: null,
    statePatch: null,
    checkResults,
    summaryInput: null,
  };
}

function nonTriggeredResult(reason, checkResults, summaryInput = null) {
  const results = checkResults || {};
  if (reason) results.reason = reason;
  return {
    skipped: false,
    triggered: false,
    event: null,
    statePatch: null,
    checkResults: results,
    summaryInput,
  };
}

function collectTriggeredChecks(checkResults) {
  return Object.entries(checkResults)
    .filter(([, result]) => isPlainObject(result) && result.enabled && result.triggered);
}

function shouldTrigger({ config, checkResults }) {
  const triggeredChecks = collectTriggeredChecks(checkResults);
  const criticalTriggered = triggeredChecks.some(([, result]) => result.critical === true);
  const score = triggeredChecks.reduce((sum, [, result]) => sum + (Number(result.score) || 0), 0);
  const categories = new Set(
    triggeredChecks
      .map(([, result]) => result.category)
      .filter(Boolean)
  );
  const triggerScore = toNumber(config.triggerScore, 2);
  const requiredCategories = toNumber(config.requiredCategories, 0);
  const reasons = triggeredChecks.map(([name, result]) => ({
    check: name,
    category: result.category || null,
    score: Number(result.score) || 0,
    critical: Boolean(result.critical),
    reason: result.reason || null,
  }));

  if (criticalTriggered) {
    return {
      triggered: true,
      score,
      categoryCount: categories.size,
      criticalTriggered,
      reasons,
    };
  }

  if (
    triggeredChecks.length === 1
    && triggeredChecks[0][0] === 'adverseR'
    && triggeredChecks[0][1].critical !== true
  ) {
    reasons.push({ check: 'adverseR', reason: 'adverseR_alone_not_enough' });
    return {
      triggered: false,
      score,
      categoryCount: categories.size,
      criticalTriggered,
      reasons,
    };
  }

  const categoryPass = !Number.isFinite(requiredCategories) || requiredCategories <= 0
    ? true
    : categories.size >= requiredCategories;
  return {
    triggered: score >= triggerScore && categoryPass,
    score,
    categoryCount: categories.size,
    criticalTriggered,
    reasons: categoryPass
      ? reasons
      : reasons.concat({ reason: 'required_categories_not_met', requiredCategories }),
  };
}

function isCoolingDown({ config, state, currentIndex }) {
  if (!state || config.firstTriggerOnly) return false;
  const lastBar = toNumber(state.lastTriggeredBarIndex, null);
  const cooldownBars = toNumber(config.cooldownBars, 0);
  if (!Number.isFinite(lastBar) || cooldownBars <= 0 || !Number.isFinite(currentIndex)) return false;
  return currentIndex - lastBar < cooldownBars;
}

function buildEventKey({ position, trade, config, currentIndex, state }) {
  const positionId = getPositionId(position) || getTradeId(position, trade) || position.entryTime || 'unknown_position';
  if (config.firstTriggerOnly) {
    return `${positionId}:directionControl:v${config.schemaVersion}:FIRST_TRIGGER`;
  }
  const cooldown = Math.max(1, toNumber(config.cooldownBars, 1));
  const bucket = Number.isFinite(currentIndex)
    ? Math.floor(currentIndex / cooldown)
    : (toNumber(state?.triggerCount, 0) + 1);
  return `${positionId}:directionControl:v${config.schemaVersion}:BUCKET_${bucket}`;
}

function buildStatePatch({ config, state, currentTime, currentIndex, eventKey }) {
  const existingCount = toNumber(state?.triggerCount, 0) || 0;
  return {
    directionControl: {
      schemaVersion: 1,
      firstTriggered: true,
      firstTriggeredTime: state?.firstTriggeredTime || currentTime,
      firstTriggeredBarIndex: Number.isFinite(toNumber(state?.firstTriggeredBarIndex, null))
        ? Number(state.firstTriggeredBarIndex)
        : currentIndex,
      lastTriggeredTime: currentTime,
      lastTriggeredBarIndex: currentIndex,
      lastEventKey: eventKey,
      triggerCount: existingCount + 1,
      configSchemaVersion: config.schemaVersion,
    },
  };
}

function evaluateDirectionControl({
  config,
  position,
  trade = null,
  candles,
  currentBar,
  currentIndex,
  strategyContext = {},
  serverTime = null,
  existingState = null,
} = {}) {
  const normalizedConfig = normalizeDirectionControlConfig(config);
  if (!normalizedConfig.enabled) {
    return skippedResult('direction_control_disabled', normalizedConfig);
  }
  if (!position || !isPlainObject(position)) {
    return skippedResult('position_missing', normalizedConfig);
  }
  if (!Array.isArray(candles) || candles.length === 0) {
    return skippedResult('candles_missing', normalizedConfig);
  }
  const barIndex = toNumber(currentIndex, null);
  if (!Number.isFinite(barIndex) || !currentBar) {
    return skippedResult('current_bar_missing', normalizedConfig);
  }

  const side = normalizeSide(position.side || position.type || position.direction);
  if (!side) return skippedResult('side_missing_or_unsupported', normalizedConfig);

  const entryPrice = getEntryPrice(position);
  const stopLoss = getStopLoss(position);
  const currentPrice = toNumber(strategyContext.currentPrice, getClosePrice(currentBar));
  if (!Number.isFinite(entryPrice) || !Number.isFinite(stopLoss) || !Number.isFinite(currentPrice)) {
    return skippedResult('entry_stop_or_current_price_missing', normalizedConfig);
  }

  const riskDistance = Math.abs(entryPrice - stopLoss);
  if (!Number.isFinite(riskDistance) || riskDistance <= 0) {
    return skippedResult('risk_distance_unavailable', normalizedConfig);
  }

  const entryIndex = getEntryIndex(position, barIndex);
  const barsHeld = Number.isFinite(entryIndex) ? Math.max(0, Math.floor(barIndex - entryIndex)) : 0;
  const currentTime = getTimeValue(getBarTime(currentBar)) || getTimeValue(serverTime) || null;

  if (barsHeld < normalizedConfig.minBarsAfterEntry) {
    return nonTriggeredResult('min_bars_after_entry_not_met', buildInitialCheckResults(normalizedConfig), {
      side,
      barsHeld,
      currentTime,
    });
  }

  const state = existingState || position.directionControl || {};
  if (normalizedConfig.firstTriggerOnly && state.firstTriggered === true) {
    return nonTriggeredResult('first_trigger_already_recorded', buildInitialCheckResults(normalizedConfig), {
      side,
      barsHeld,
      currentTime,
    });
  }

  if (isCoolingDown({ config: normalizedConfig, state, currentIndex: barIndex })) {
    return nonTriggeredResult('cooldown_bars_not_elapsed', buildInitialCheckResults(normalizedConfig), {
      side,
      barsHeld,
      currentTime,
    });
  }

  const currentR = calculateR(side, entryPrice, riskDistance, currentPrice);
  if (!Number.isFinite(currentR)) {
    return skippedResult('unrealized_r_unavailable', normalizedConfig);
  }

  const { mfeR, maeR } = calculateExcursionR({
    side,
    candles,
    entryIndex,
    currentIndex: barIndex,
    entryPrice,
    riskDistance,
  });
  if (!Number.isFinite(mfeR) || !Number.isFinite(maeR)) {
    return skippedResult('mfe_mae_unavailable', normalizedConfig);
  }

  const checkResults = {};
  const checks = normalizedConfig.checks || {};
  const structureEnabled = checks.structureBreak?.enabled === true;
  const atrInfo = structureEnabled
    ? resolveAtr({ strategyContext, candles, currentIndex: barIndex, currentBar })
    : { value: null, source: null };

  if (structureEnabled && (!Number.isFinite(atrInfo.value) || atrInfo.value <= 0)) {
    const partial = buildInitialCheckResults(normalizedConfig);
    partial.structureBreak = {
      ...partial.structureBreak,
      reason: 'atr_unavailable',
      atrSource: atrInfo.source,
    };
    return skippedResult('atr_unavailable', normalizedConfig, partial);
  }

  if (checks.adverseR?.enabled) {
    checkResults.adverseR = evaluateAdverseR(checks.adverseR, currentR);
  } else {
    checkResults.adverseR = getCheckBase(checks.adverseR || {});
  }

  if (checks.failedFollowThrough?.enabled) {
    checkResults.failedFollowThrough = evaluateFailedFollowThrough(
      checks.failedFollowThrough,
      currentR,
      mfeR
    );
  } else {
    checkResults.failedFollowThrough = getCheckBase(checks.failedFollowThrough || {});
  }

  if (checks.opposingSignal?.enabled) {
    checkResults.opposingSignal = evaluateOpposingSignal(
      checks.opposingSignal,
      side,
      barIndex,
      strategyContext
    );
  } else {
    checkResults.opposingSignal = getCheckBase(checks.opposingSignal || {});
  }

  if (structureEnabled) {
    checkResults.structureBreak = evaluateStructureBreak({
      check: checks.structureBreak,
      side,
      position,
      strategyContext,
      candles,
      currentIndex: barIndex,
      currentBar,
      atr: atrInfo.value,
    });
    checkResults.structureBreak.atrSource = atrInfo.source;
  } else {
    checkResults.structureBreak = getCheckBase(checks.structureBreak || {});
  }

  if (checks.emaInvalidation?.enabled) {
    checkResults.emaInvalidation = evaluateEmaInvalidation(
      checks.emaInvalidation,
      side,
      currentBar,
      strategyContext
    );
  } else {
    checkResults.emaInvalidation = getCheckBase(checks.emaInvalidation || {});
  }

  if (checks.higherTrendFlip?.enabled) {
    checkResults.higherTrendFlip = evaluateHigherTrendFlip(
      checks.higherTrendFlip,
      side,
      strategyContext
    );
  } else {
    checkResults.higherTrendFlip = getCheckBase(checks.higherTrendFlip || {});
  }

  const triggerDecision = shouldTrigger({ config: normalizedConfig, checkResults });
  const summaryInput = {
    triggered: triggerDecision.triggered,
    side,
    unrealizedR: round(currentR),
    mfeR: round(mfeR),
    maeR: round(maeR),
    barsHeld,
    currentTime,
    score: round(triggerDecision.score),
    reasons: clone(triggerDecision.reasons),
  };

  if (!triggerDecision.triggered) {
    return nonTriggeredResult('trigger_conditions_not_met', checkResults, summaryInput);
  }

  const eventKey = buildEventKey({
    position,
    trade,
    config: normalizedConfig,
    currentIndex: barIndex,
    state,
  });
  if (state.lastEventKey === eventKey) {
    return nonTriggeredResult('event_key_already_recorded', checkResults, summaryInput);
  }

  const positionId = getPositionId(position);
  const tradeId = getTradeId(position, trade);
  const statePatch = buildStatePatch({
    config: normalizedConfig,
    state,
    currentTime,
    currentIndex: barIndex,
    eventKey,
  });
  const takeProfit = getTakeProfit(position);
  const currentStopLoss = getCurrentStopLoss(position);
  const event = {
    type: EVENT_TYPE,
    schemaVersion: 1,
    action: AUDIT_ACTION,
    mode: 'audit',
    eventId: `${EVENT_TYPE}:${eventKey}`,
    eventKey,
    positionId,
    tradeId,
    entrySignalId: position.entrySignalId || position.signalId || null,
    strategy: position.strategy || position.strategyName || strategyContext.strategy || null,
    strategyInstanceId: position.strategyInstanceId || strategyContext.strategyInstanceId || null,
    symbol: position.symbol || strategyContext.symbol || null,
    symbolCustomId: position.symbolCustomId || strategyContext.symbolCustomId || null,
    symbolCustomName: position.symbolCustomName || strategyContext.symbolCustomName || null,
    side,
    score: round(triggerDecision.score),
    triggerScore: normalizedConfig.triggerScore,
    triggerMode: normalizedConfig.triggerMode,
    triggered: true,
    reasons: clone(triggerDecision.reasons),
    unrealizedR: round(currentR),
    mfeR: round(mfeR),
    maeR: round(maeR),
    barsHeld,
    entryPrice: round(entryPrice, 6),
    currentPrice: round(currentPrice, 6),
    stopLoss: round(currentStopLoss, 6),
    takeProfit: round(takeProfit, 6),
    candleTime: currentTime,
    serverTime: getTimeValue(serverTime) || currentTime,
    checkResults: clone(checkResults),
    beAlreadyApplied: Boolean(position.breakevenActivated || position.protectiveStopState?.breakevenApplied),
    trailingAlreadyApplied: Boolean(position.trailingActivated || position.protectiveStopState?.trailingApplied),
    slBeforeDirectionControl: round(currentStopLoss, 6),
    tpBeforeDirectionControl: round(takeProfit, 6),
    wouldHaveAction: normalizedConfig.wouldHaveAction,
  };

  return {
    skipped: false,
    triggered: true,
    event,
    statePatch,
    checkResults,
    summaryInput: {
      ...summaryInput,
      eventKey,
      firstTriggerR: round(currentR),
      firstTriggerTime: currentTime,
      firstTriggerBarIndex: barIndex,
    },
  };
}

module.exports = {
  EVENT_TYPE,
  AUDIT_ACTION,
  normalizeSide,
  evaluateDirectionControl,
};
