function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactSnapshotValue(value, depth = 0) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const compact = compactSnapshotValue(value[index], depth + 1);
      if (compact != null && !isPlainObject(compact)) {
        return compact;
      }
    }
    return null;
  }

  if (isPlainObject(value)) {
    if (depth >= 2) return null;
    const output = {};
    Object.entries(value).forEach(([key, nestedValue]) => {
      const compact = compactSnapshotValue(nestedValue, depth + 1);
      if (compact != null && !(isPlainObject(compact) && Object.keys(compact).length === 0)) {
        output[key] = compact;
      }
    });
    return Object.keys(output).length > 0 ? output : null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'boolean') return value;

  const stringValue = String(value).trim();
  return stringValue ? stringValue : null;
}

function compactSnapshotObject(value) {
  if (!isPlainObject(value)) return {};
  const compact = compactSnapshotValue(value);
  return isPlainObject(compact) ? compact : {};
}

function readAlias(sources, aliases) {
  for (const source of sources) {
    if (!isPlainObject(source)) continue;
    for (const alias of aliases) {
      if (Object.prototype.hasOwnProperty.call(source, alias)) {
        const compact = compactSnapshotValue(source[alias]);
        if (compact != null) return compact;
      }
    }
  }
  return null;
}

function setIfPresent(target, key, value) {
  const compact = compactSnapshotValue(value);
  if (compact != null) target[key] = compact;
}

function buildEntryIndicatorsSnapshot(signal = {}) {
  const rawSnapshot = isPlainObject(signal.indicatorsSnapshot) ? signal.indicatorsSnapshot : {};
  const snapshot = compactSnapshotObject(rawSnapshot);
  const sources = [rawSnapshot, signal];

  const aliasGroups = {
    atr: ['atr', 'atrAtEntry'],
    rsi: ['rsi', 'rsiValue'],
    ema_fast: ['ema_fast', 'emaFast', 'fastEma', 'emaFastValue'],
    ema_slow: ['ema_slow', 'emaSlow', 'slowEma', 'emaSlowValue'],
    ema_trend: ['ema_trend', 'emaTrend', 'trendEma', 'emaTrendValue'],
    higher_tf_trend: ['higher_tf_trend', 'higherTfTrend', 'higherTimeframeTrend', 'higherTfTrendSnapshot'],
    market_regime: ['market_regime', 'marketRegime', 'regime'],
    setup_timeframe: ['setup_timeframe', 'setupTimeframe', 'timeframe'],
    entry_timeframe: ['entry_timeframe', 'entryTimeframe'],
    setup_candle_time: ['setup_candle_time', 'setupCandleTime'],
    entry_candle_time: ['entry_candle_time', 'entryCandleTime'],
  };

  Object.entries(aliasGroups).forEach(([key, aliases]) => {
    if (snapshot[key] == null) {
      setIfPresent(snapshot, key, readAlias(sources, aliases));
    }
  });

  return snapshot;
}

function pickString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const stringValue = String(value).trim();
    if (stringValue) return stringValue;
  }
  return null;
}

function buildSignalReasonFields(signal = {}) {
  const setupReason = pickString(
    signal.setupReason,
    signal.setup_reason,
    signal.setup,
    signal.setupText
  );
  const triggerReason = pickString(
    signal.triggerReason,
    signal.trigger_reason,
    signal.trigger,
    signal.triggerText
  );
  const signalReason = pickString(
    signal.signalReason,
    signal.signal_reason,
    signal.reason,
    signal.filterReason,
    setupReason,
    triggerReason
  );
  const entryReason = pickString(
    signal.entryReason,
    signal.entry_reason,
    signal.entry,
    signalReason,
    setupReason,
    triggerReason
  );

  return {
    entryReason,
    setupReason,
    triggerReason,
    signalReason,
  };
}

function buildOpenTradeCapture(signal = {}, managedPositionState = {}) {
  const reasonFields = buildSignalReasonFields(signal);
  const indicatorsSnapshot = buildEntryIndicatorsSnapshot({
    ...signal,
    setupTimeframe: signal.setupTimeframe ?? managedPositionState.setupTimeframe,
    entryTimeframe: signal.entryTimeframe ?? managedPositionState.entryTimeframe,
    setupCandleTime: signal.setupCandleTime ?? managedPositionState.setupCandleTime,
    entryCandleTime: signal.entryCandleTime ?? managedPositionState.entryCandleTime,
  });
  const initialSl = normalizeNumber(signal.initialSl ?? signal.initialSL ?? signal.sl);
  const initialTp = normalizeNumber(signal.initialTp ?? signal.initialTP ?? signal.tp);

  return {
    reason: reasonFields.signalReason,
    signalReason: reasonFields.signalReason,
    entryReason: reasonFields.entryReason,
    setupReason: reasonFields.setupReason,
    triggerReason: reasonFields.triggerReason,
    initialSl,
    initialTp,
    finalSl: initialSl,
    finalTp: initialTp,
    setupTimeframe: signal.setupTimeframe ?? managedPositionState.setupTimeframe ?? null,
    entryTimeframe: signal.entryTimeframe ?? managedPositionState.entryTimeframe ?? null,
    setupCandleTime: signal.setupCandleTime ?? managedPositionState.setupCandleTime ?? null,
    entryCandleTime: signal.entryCandleTime ?? managedPositionState.entryCandleTime ?? null,
    indicatorsSnapshot,
  };
}

function buildPositionExportSnapshot(position = {}) {
  return {
    positionDbId: position._id || position.positionDbId || null,
    symbol: position.symbol || null,
    type: position.type || null,
    entryPrice: position.entryPrice ?? null,
    currentSl: position.currentSl ?? position.sl ?? null,
    currentTp: position.currentTp ?? position.tp ?? null,
    initialSl: position.initialSl ?? position.initialSL ?? position.sl ?? null,
    initialTp: position.initialTp ?? position.initialTP ?? position.tp ?? null,
    finalSl: position.currentSl ?? position.finalSl ?? position.sl ?? null,
    finalTp: position.currentTp ?? position.finalTp ?? position.tp ?? null,
    lotSize: position.lotSize ?? null,
    strategy: position.strategy || null,
    confidence: position.confidence ?? null,
    rawConfidence: position.rawConfidence ?? null,
    reason: position.reason || position.signalReason || null,
    entryReason: position.entryReason || null,
    setupReason: position.setupReason || null,
    triggerReason: position.triggerReason || null,
    executionScore: position.executionScore ?? null,
    executionScoreDetails: position.executionScoreDetails || null,
    plannedRiskAmount: position.plannedRiskAmount ?? null,
    targetRMultiple: position.targetRMultiple ?? null,
    indicatorsSnapshot: position.indicatorsSnapshot || null,
    managementEvents: Array.isArray(position.managementEvents) ? position.managementEvents : [],
    setupTimeframe: position.setupTimeframe || null,
    entryTimeframe: position.entryTimeframe || null,
    setupCandleTime: position.setupCandleTime || null,
    entryCandleTime: position.entryCandleTime || null,
    maxFavourablePrice: position.maxFavourablePrice ?? null,
    maxAdversePrice: position.maxAdversePrice ?? null,
    protectiveStopState: position.protectiveStopState || null,
    spreadAtEntry: position.spreadAtEntry ?? null,
    slippageEstimate: position.slippageEstimate ?? null,
    brokerRetcodeOpen: position.brokerRetcodeOpen ?? null,
    brokerRetcodeModify: position.brokerRetcodeModify ?? null,
    openedAt: position.openedAt || null,
  };
}

module.exports = {
  buildEntryIndicatorsSnapshot,
  buildOpenTradeCapture,
  buildPositionExportSnapshot,
  buildSignalReasonFields,
  compactSnapshotObject,
  compactSnapshotValue,
  isPlainObject,
};
