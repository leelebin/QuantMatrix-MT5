(function initSymbolCustomManagerUtils(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SymbolCustomManagerUtils = factory();
  }
}(typeof self !== 'undefined' ? self : this, function createSymbolCustomManagerUtils() {
  const PLACEHOLDER_SYMBOL_CUSTOM = 'PLACEHOLDER_SYMBOL_CUSTOM';
  const PHASE_1_LIVE_WARNING = 'SymbolCustom live execution is not supported in Phase 1. This field is saved for future use only.';
  const SYMBOL_CUSTOM_MT5_NOT_CONNECTED = 'SYMBOL_CUSTOM_MT5_NOT_CONNECTED';
  const SYMBOL_CUSTOM_MT5_NOT_CONNECTED_MESSAGE = 'MT5 is not connected. Please connect MT5 first before running historical SymbolCustom backtest.';
  const SYMBOL_CUSTOM_MT5_NOT_CONNECTED_HINT = 'Go to Dashboard/Diagnostics and connect MT5, then retry.';

  const JSON_FIELD_DEFAULTS = Object.freeze({
    parameterSchema: [],
    parameters: {},
    riskConfig: {},
    sessionFilter: {},
    newsFilter: {},
    beConfig: {},
    entryConfig: {},
    exitConfig: {},
  });

  const DEFAULT_PARAMETER_SCHEMA = Object.freeze([
    { key: 'lookbackBars', label: 'Lookback Bars', type: 'number', defaultValue: 50, min: 1, step: 1 },
    { key: 'slAtrMultiplier', label: 'SL ATR Multiplier', type: 'number', defaultValue: 1.5, min: 0.1, step: 0.1 },
    { key: 'tpAtrMultiplier', label: 'TP ATR Multiplier', type: 'number', defaultValue: 2, min: 0.1, step: 0.1 },
    { key: 'beTriggerR', label: 'BE Trigger R', type: 'number', defaultValue: 1, min: 0, step: 0.1 },
    { key: 'maxConsecutiveLosses', label: 'Max Consecutive Losses', type: 'number', defaultValue: 3, min: 1, step: 1 },
  ]);

  function cloneValue(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeString(value) {
    return String(value == null ? '' : value).trim();
  }

  function parseJsonField(rawValue, fieldName, fallbackValue) {
    const raw = String(rawValue == null ? '' : rawValue).trim();
    if (!raw) {
      return { valid: true, value: cloneValue(fallbackValue), error: null };
    }

    try {
      return { valid: true, value: JSON.parse(raw), error: null };
    } catch (error) {
      return {
        valid: false,
        value: undefined,
        error: `${fieldName} must be valid JSON: ${error.message}`,
      };
    }
  }

  function serializeJsonForEditor(value, fallbackValue) {
    const source = value === undefined ? fallbackValue : value;
    return JSON.stringify(source, null, 2);
  }

  function shouldShowLiveWarning(value) {
    if (typeof value === 'boolean') return value === true;
    return Boolean(value && value.liveEnabled === true);
  }

  function getSchemaFieldKey(field) {
    return normalizeString(field && (field.key || field.name));
  }

  function findMissingParameterSchemaFields(record = {}, logicParameterSchema = null) {
    const syncStatus = record && record.schemaSyncStatus;
    if (syncStatus && Array.isArray(syncStatus.missingSchemaFields)) {
      return syncStatus.missingSchemaFields.slice();
    }

    const expectedSchema = Array.isArray(logicParameterSchema) ? logicParameterSchema : [];
    const existingSchema = Array.isArray(record && record.parameterSchema) ? record.parameterSchema : [];
    const existingKeys = new Set(existingSchema.map(getSchemaFieldKey).filter(Boolean));
    return expectedSchema
      .map(getSchemaFieldKey)
      .filter((key) => key && !existingKeys.has(key));
  }

  function findMissingParameterKeys(record = {}, logicDefaultParameters = null) {
    const syncStatus = record && record.schemaSyncStatus;
    if (syncStatus && Array.isArray(syncStatus.missingParameters)) {
      return syncStatus.missingParameters.slice();
    }

    const defaults = logicDefaultParameters && typeof logicDefaultParameters === 'object' && !Array.isArray(logicDefaultParameters)
      ? logicDefaultParameters
      : {};
    const existing = record && record.parameters && typeof record.parameters === 'object' && !Array.isArray(record.parameters)
      ? record.parameters
      : {};
    return Object.keys(defaults).filter((key) => !Object.prototype.hasOwnProperty.call(existing, key));
  }

  function hasMissingLogicSchema(record = {}, logicParameterSchema = null, logicDefaultParameters = null) {
    const syncStatus = record && record.schemaSyncStatus;
    if (syncStatus && syncStatus.hasMissing === true) return true;
    return findMissingParameterSchemaFields(record, logicParameterSchema).length > 0
      || findMissingParameterKeys(record, logicDefaultParameters).length > 0;
  }

  function buildSchemaSyncWarning(record = {}, logicParameterSchema = null, logicDefaultParameters = null) {
    if (!hasMissingLogicSchema(record, logicParameterSchema, logicDefaultParameters)) return '';
    return 'This SymbolCustom is missing parameters from its registered logic. Run Sync Parameters From Logic.';
  }

  function buildSymbolCustomSymbolSummaries(records) {
    const grouped = new Map();
    (Array.isArray(records) ? records : []).forEach((record) => {
      const symbol = normalizeString(record.symbol).toUpperCase() || 'UNKNOWN';
      const summary = grouped.get(symbol) || {
        symbol,
        customCount: 0,
        paperEnabledCount: 0,
        liveEnabledCount: 0,
        primaryLiveName: null,
        statusSummary: {},
      };

      summary.customCount += 1;
      if (record.paperEnabled === true) summary.paperEnabledCount += 1;
      if (record.liveEnabled === true) summary.liveEnabledCount += 1;
      if (record.isPrimaryLive === true) summary.primaryLiveName = record.symbolCustomName || record.displayName || null;

      const status = normalizeString(record.status) || 'unknown';
      summary.statusSummary[status] = (summary.statusSummary[status] || 0) + 1;
      grouped.set(symbol, summary);
    });

    return Array.from(grouped.values()).sort((left, right) => left.symbol.localeCompare(right.symbol));
  }

  function formatCsvValue(value) {
    if (Array.isArray(value)) {
      return value.join('|');
    }
    if (value == null) {
      return '';
    }
    return String(value);
  }

  function escapeCsvCell(value) {
    const text = formatCsvValue(value);
    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  function flattenSymbolCustomReportRow(row) {
    const source = row || {};
    const latestBacktest = source.latestBacktest || {};
    return {
      symbol: source.symbol || '',
      symbolCustomName: source.symbolCustomName || '',
      displayName: source.displayName || '',
      status: source.status || '',
      paperEnabled: source.paperEnabled === true,
      liveEnabled: source.liveEnabled === true,
      isPrimaryLive: source.isPrimaryLive === true,
      allowLive: source.allowLive === true,
      logicName: source.logicName || '',
      latestBacktestStatus: latestBacktest.status || '',
      latestBacktestTrades: latestBacktest.trades == null ? '' : latestBacktest.trades,
      latestBacktestNetPnl: latestBacktest.netPnl == null ? '' : latestBacktest.netPnl,
      latestBacktestProfitFactor: latestBacktest.profitFactor == null ? '' : latestBacktest.profitFactor,
      recommendation: source.recommendation || '',
      warnings: Array.isArray(source.warnings) ? source.warnings.join('|') : '',
    };
  }

  function buildSymbolCustomReportCsv(rows) {
    const headers = [
      'symbol',
      'symbolCustomName',
      'displayName',
      'status',
      'paperEnabled',
      'liveEnabled',
      'isPrimaryLive',
      'allowLive',
      'logicName',
      'latestBacktestStatus',
      'latestBacktestTrades',
      'latestBacktestNetPnl',
      'latestBacktestProfitFactor',
      'recommendation',
      'warnings',
    ];
    const lines = [headers.join(',')];
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const flattened = flattenSymbolCustomReportRow(row);
      lines.push(headers.map((header) => escapeCsvCell(flattened[header])).join(','));
    });
    return lines.join('\n');
  }

  function serializeEditorPayload(values) {
    const source = values || {};
    const errors = [];
    const payload = {
      symbol: normalizeString(source.symbol).toUpperCase(),
      symbolCustomName: normalizeString(source.symbolCustomName),
      displayName: normalizeString(source.displayName),
      description: normalizeString(source.description),
      hypothesis: normalizeString(source.hypothesis),
      status: normalizeString(source.status) || 'draft',
      paperEnabled: source.paperEnabled === true,
      liveEnabled: source.liveEnabled === true,
      isPrimaryLive: source.isPrimaryLive === true,
      timeframes: {
        setupTimeframe: normalizeString(source.setupTimeframe),
        entryTimeframe: normalizeString(source.entryTimeframe),
        higherTimeframe: normalizeString(source.higherTimeframe),
      },
      designNotes: normalizeString(source.designNotes),
      aiResearchSummary: normalizeString(source.aiResearchSummary),
    };

    if (source.logicName !== undefined) {
      payload.logicName = normalizeString(source.logicName) || PLACEHOLDER_SYMBOL_CUSTOM;
    }

    Object.entries(JSON_FIELD_DEFAULTS).forEach(([fieldName, fallbackValue]) => {
      const rawValue = source[`${fieldName}Json`] !== undefined ? source[`${fieldName}Json`] : source[fieldName];
      const parsed = parseJsonField(rawValue, fieldName, fallbackValue);
      if (!parsed.valid) {
        errors.push(parsed.error);
        return;
      }
      payload[fieldName] = parsed.value;
    });

    if (!payload.symbol) errors.push('symbol is required');
    if (!payload.symbolCustomName) errors.push('symbolCustomName is required');

    return {
      valid: errors.length === 0,
      errors,
      payload: errors.length === 0 ? payload : null,
    };
  }

  function serializeBacktestPayload(values) {
    const source = values || {};
    const errors = [];
    const record = source.record || {};
    const initialBalance = Number(source.initialBalance == null || source.initialBalance === ''
      ? 500
      : source.initialBalance);

    const payload = {
      startDate: normalizeString(source.startDate),
      endDate: normalizeString(source.endDate),
      initialBalance,
      parameters: source.parameters || record.parameters || {},
      costModel: source.costModel || { spread: 0, commissionPerTrade: 0, slippage: 0 },
      options: {
        ...(source.options || {}),
        useHistoricalCandles: source.useHistoricalCandles !== false,
      },
    };

    if (!payload.startDate) errors.push('startDate is required');
    if (!payload.endDate) errors.push('endDate is required');
    if (!Number.isFinite(initialBalance) || initialBalance <= 0) {
      errors.push('initialBalance must be a positive number');
    }

    return {
      valid: errors.length === 0,
      errors,
      payload: errors.length === 0 ? payload : null,
    };
  }

  function normalizeBacktestError(response, fallbackMessage) {
    const source = response || {};
    const rawMessage = source.message || (source.error && source.error.message) || fallbackMessage || 'Failed to run SymbolCustom backtest';
    const reasonCode = source.reasonCode
      || (Array.isArray(source.errors) && source.errors[0] ? source.errors[0].reasonCode : null)
      || null;

    const isMt5NotConnected = reasonCode === SYMBOL_CUSTOM_MT5_NOT_CONNECTED
      || /MT5 not connected/i.test(rawMessage)
      || /MT5 is not connected/i.test(rawMessage);

    if (isMt5NotConnected) {
      return {
        message: SYMBOL_CUSTOM_MT5_NOT_CONNECTED_MESSAGE,
        hint: source.hint
          || (Array.isArray(source.errors) && source.errors[0] ? source.errors[0].hint : null)
          || SYMBOL_CUSTOM_MT5_NOT_CONNECTED_HINT,
        reasonCode: SYMBOL_CUSTOM_MT5_NOT_CONNECTED,
      };
    }

    if (rawMessage === 'SYMBOL_CUSTOM_BACKTEST_CANDLES_NOT_FOUND') {
      return {
        message: 'No historical candles found for selected symbol/timeframes/date range.',
        hint: null,
        reasonCode: rawMessage,
      };
    }

    return {
      message: rawMessage,
      hint: source.hint || null,
      reasonCode,
    };
  }

  return {
    PLACEHOLDER_SYMBOL_CUSTOM,
    PHASE_1_LIVE_WARNING,
    SYMBOL_CUSTOM_MT5_NOT_CONNECTED,
    SYMBOL_CUSTOM_MT5_NOT_CONNECTED_MESSAGE,
    SYMBOL_CUSTOM_MT5_NOT_CONNECTED_HINT,
    JSON_FIELD_DEFAULTS,
    DEFAULT_PARAMETER_SCHEMA,
    parseJsonField,
    serializeJsonForEditor,
    serializeEditorPayload,
    serializeBacktestPayload,
    normalizeBacktestError,
    shouldShowLiveWarning,
    findMissingParameterSchemaFields,
    findMissingParameterKeys,
    hasMissingLogicSchema,
    buildSchemaSyncWarning,
    buildSymbolCustomSymbolSummaries,
    flattenSymbolCustomReportRow,
    buildSymbolCustomReportCsv,
  };
}));
