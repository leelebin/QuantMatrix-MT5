(function initSymbolCustomManagerUtils(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SymbolCustomManagerUtils = factory();
  }
}(typeof self !== 'undefined' ? self : this, function createSymbolCustomManagerUtils() {
  const PLACEHOLDER_SYMBOL_CUSTOM = 'PLACEHOLDER_SYMBOL_CUSTOM';
  const PHASE_1_LIVE_WARNING = 'SymbolCustom live execution is not supported in Phase 1. This field is saved for future use only.';

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

  return {
    PLACEHOLDER_SYMBOL_CUSTOM,
    PHASE_1_LIVE_WARNING,
    JSON_FIELD_DEFAULTS,
    DEFAULT_PARAMETER_SCHEMA,
    parseJsonField,
    serializeJsonForEditor,
    serializeEditorPayload,
    shouldShowLiveWarning,
    buildSymbolCustomSymbolSummaries,
    flattenSymbolCustomReportRow,
    buildSymbolCustomReportCsv,
  };
}));
