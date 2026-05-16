(function initBacktestPageUtils(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BacktestPageUtils = factory();
  }
}(typeof self !== 'undefined' ? self : this, function createBacktestPageUtils() {
  const BACKTEST_MODE_STANDARD = 'standard';
  const BACKTEST_MODE_SYMBOL_CUSTOM = 'symbolCustom';
  const HISTORY_MODE_STANDARD = 'STANDARD';
  const HISTORY_MODE_SYMBOL_CUSTOM = 'SYMBOLCUSTOM';
  const PLACEHOLDER_SYMBOL_CUSTOM = 'PLACEHOLDER_SYMBOL_CUSTOM';

  const SYMBOL_CUSTOM_ERROR_MESSAGES = Object.freeze({
    SYMBOL_CUSTOM_BACKTEST_CANDLES_REQUIRED: 'No candles provided. Enable historical candle provider or provide candle data.',
    SYMBOL_CUSTOM_BACKTEST_CANDLES_NOT_FOUND: 'No historical candles found for selected symbol/timeframes/date range.',
    SYMBOL_CUSTOM_BACKTEST_DATE_RANGE_REQUIRED: 'Start Date and End Date are required.',
    SYMBOL_CUSTOM_MT5_NOT_CONNECTED: 'MT5 is not connected. Please connect MT5 first before running historical SymbolCustom backtest.',
    PLACEHOLDER_SYMBOL_CUSTOM: 'This SymbolCustom is placeholder-only and has no active backtest logic.',
  });

  function toNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function parseInitialBalance(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function getLogicName(record = {}) {
    return record.logicName || record.registryLogicName || record.symbolCustomName || '';
  }

  function isPlaceholderSymbolCustom(record = {}) {
    return getLogicName(record) === PLACEHOLDER_SYMBOL_CUSTOM;
  }

  function buildStandardBacktestPayload(values = {}) {
    const payload = {
      symbol: values.symbol,
      strategyType: values.strategyType,
      timeframe: values.timeframe || undefined,
      startDate: values.startDate,
      endDate: values.endDate,
      initialBalance: parseInitialBalance(values.initialBalance, 10000),
      parameterPreset: values.parameterPreset || 'default',
      strategyParams: values.strategyParams || null,
    };

    return payload;
  }

  function buildStandardAllStrategiesPayload(values = {}) {
    return {
      symbol: values.symbol,
      timeframe: values.timeframe || undefined,
      startDate: values.startDate,
      endDate: values.endDate,
      initialBalance: parseInitialBalance(values.initialBalance, 10000),
    };
  }

  function buildSymbolCustomBacktestRequest(symbolCustom = {}, values = {}) {
    return {
      endpoint: '/api/symbol-customs/' + encodeURIComponent(symbolCustom._id || '') + '/backtest',
      payload: {
        startDate: values.startDate,
        endDate: values.endDate,
        initialBalance: parseInitialBalance(values.initialBalance, 500),
        parameters: symbolCustom.parameters || {},
        costModel: {
          spread: 0,
          commissionPerTrade: 0,
          slippage: 0,
        },
        options: {
          useHistoricalCandles: true,
        },
      },
    };
  }

  function buildSymbolCustomPresetComparisonRequest(symbolCustom = {}, values = {}) {
    return {
      endpoint: '/api/symbol-customs/' + encodeURIComponent(symbolCustom._id || '') + '/preset-comparison',
      payload: {
        startDate: values.startDate,
        endDate: values.endDate,
        initialBalance: parseInitialBalance(values.initialBalance, 500),
        costModel: values.costModel || {
          spread: 0,
          commissionPerTrade: 0,
          slippage: 0,
        },
      },
    };
  }

  function buildSymbolCustomCandidateValidationRequest(symbolCustom = {}, values = {}) {
    return {
      endpoint: '/api/symbol-customs/' + encodeURIComponent(symbolCustom._id || '') + '/candidate-validation',
      payload: {
        candidateName: values.candidateName || 'buy_session_conservative',
        candidateParameters: values.candidateParameters || {},
        windows: values.windows || [
          { label: '2M', startDate: '2026-03-15', endDate: '2026-05-15' },
          { label: '4M', startDate: '2026-01-15', endDate: '2026-05-15' },
          { label: '8M', startDate: '2025-09-15', endDate: '2026-05-15' },
          { label: '12M', startDate: '2025-05-15', endDate: '2026-05-15' },
        ],
        initialBalance: parseInitialBalance(values.initialBalance, 500),
        costModel: values.costModel || {
          spread: 0,
          commissionPerTrade: 0,
          slippage: 0,
        },
      },
    };
  }

  function getSymbolCustomSelectionState(records = [], selectedId = null) {
    const rows = Array.isArray(records) ? records : [];
    if (rows.length === 0) {
      return {
        rows,
        selectedRecord: null,
        runEnabled: false,
        warning: 'No SymbolCustom found for this symbol.',
      };
    }

    const selectedRecord = rows.find((record) => record._id === selectedId)
      || rows.find((record) => !isPlaceholderSymbolCustom(record))
      || rows[0];
    const placeholderOnly = rows.every((record) => isPlaceholderSymbolCustom(record));

    return {
      rows,
      selectedRecord,
      runEnabled: Boolean(selectedRecord && !isPlaceholderSymbolCustom(selectedRecord)),
      warning: placeholderOnly
        ? 'Placeholder only. No active backtest logic.'
        : (isPlaceholderSymbolCustom(selectedRecord) ? 'This SymbolCustom is placeholder-only and has no active backtest logic.' : ''),
    };
  }

  function normalizeBacktestError(response, fallbackMessage) {
    const source = response || {};
    const nested = Array.isArray(source.errors) && source.errors.length ? source.errors[0] : {};
    const rawMessage = source.message || (source.error && source.error.message) || fallbackMessage || 'Backtest failed';
    const reasonCode = source.reasonCode || nested.reasonCode || null;
    const rawText = String(rawMessage || '');

    if (
      reasonCode === 'SYMBOL_CUSTOM_MT5_NOT_CONNECTED'
      || /MT5 not connected/i.test(rawText)
      || /MT5 is not connected/i.test(rawText)
    ) {
      return {
        message: SYMBOL_CUSTOM_ERROR_MESSAGES.SYMBOL_CUSTOM_MT5_NOT_CONNECTED,
        reasonCode: 'SYMBOL_CUSTOM_MT5_NOT_CONNECTED',
        hint: source.hint || nested.hint || 'Go to Dashboard/Diagnostics and connect MT5, then retry.',
      };
    }

    const mapped = SYMBOL_CUSTOM_ERROR_MESSAGES[reasonCode] || SYMBOL_CUSTOM_ERROR_MESSAGES[rawText];
    if (mapped) {
      return {
        message: mapped,
        reasonCode: reasonCode || rawText,
        hint: source.hint || nested.hint || null,
      };
    }

    return {
      message: rawText,
      reasonCode,
      hint: source.hint || nested.hint || null,
    };
  }

  function normalizeSymbolCustomTrade(trade = {}, index = 0, fallbackModule = null) {
    return {
      ...trade,
      tradeId: trade.tradeId != null ? trade.tradeId : (trade.id != null ? trade.id : index + 1),
      direction: trade.direction || trade.type || trade.side || '--',
      entryReason: trade.entryReason || trade.reason || '',
      setupReason: trade.setupReason || trade.reason || '',
      exitReason: trade.exitReasonText || trade.exitReason || '',
      profitLoss: trade.profitLoss != null ? trade.profitLoss : trade.pnl,
      profitPips: trade.profitPips != null ? trade.profitPips : null,
      module: trade.module || trade.logicName || fallbackModule || 'SymbolCustom',
    };
  }

  function buildSymbolCustomChartData(result = {}) {
    if (result.chartData) {
      const chartData = { ...result.chartData };
      if ((!Array.isArray(chartData.panels) || chartData.panels.length === 0) && Array.isArray(chartData.candles)) {
        chartData.panels = [{ kind: 'price', title: 'Price', series: [], referenceLines: [] }];
      }
      return chartData;
    }

    const candles = Array.isArray(result.candles)
      ? result.candles
      : (result.candles && Array.isArray(result.candles.entry) ? result.candles.entry : []);
    if (!candles.length) return null;

    return {
      source: 'symbolCustom',
      symbol: result.symbol,
      strategy: result.symbolCustomName || result.strategy || 'SymbolCustom',
      effectiveTimeframe: result.timeframes && result.timeframes.entryTimeframe ? result.timeframes.entryTimeframe : '--',
      period: {
        start: result.startDate,
        end: result.endDate,
      },
      candles,
      panels: [{ kind: 'price', title: 'Price', series: [], referenceLines: [] }],
      tradeEvents: (result.trades || []).map((trade, index) => normalizeSymbolCustomTrade(trade, index, result.logicName)),
    };
  }

  function normalizeSymbolCustomSummary(result = {}) {
    const summary = result.summary || {};
    const initialBalance = toNumber(result.initialBalance, 0);
    const netPnl = toNumber(summary.netPnl, 0);
    const returnPercent = initialBalance > 0 ? (netPnl / initialBalance) * 100 : 0;
    const maxDrawdown = toNumber(summary.maxDrawdown, 0);
    const maxDrawdownPercent = initialBalance > 0 ? (maxDrawdown / initialBalance) * 100 : 0;

    return {
      ...summary,
      totalTrades: summary.totalTrades != null ? summary.totalTrades : (summary.trades || 0),
      winRate: summary.winRate != null ? summary.winRate : 0,
      neutralTrades: summary.neutralTrades != null ? summary.neutralTrades : 0,
      neutralRate: summary.neutralRate != null ? summary.neutralRate : 0,
      profitFactor: summary.profitFactor != null ? summary.profitFactor : 0,
      returnPercent,
      netProfitMoney: netPnl,
      maxDrawdownPercent,
      sharpeRatio: summary.sharpeRatio != null ? summary.sharpeRatio : '--',
      averageWinPips: summary.averageWinPips != null ? summary.averageWinPips : '--',
      averageLossPips: summary.averageLossPips != null ? summary.averageLossPips : '--',
      maxConsecutiveWins: summary.maxConsecutiveWins != null ? summary.maxConsecutiveWins : '--',
      maxConsecutiveLosses: summary.maxConsecutiveLosses != null ? summary.maxConsecutiveLosses : '--',
    };
  }

  function normalizeBacktestResult(result, mode = BACKTEST_MODE_STANDARD) {
    if (mode !== BACKTEST_MODE_SYMBOL_CUSTOM) return result;
    const source = result || {};
    return {
      ...source,
      mode: HISTORY_MODE_SYMBOL_CUSTOM,
      source: 'symbolCustom',
      strategy: source.symbolCustomName || source.strategy || 'SymbolCustom',
      summary: normalizeSymbolCustomSummary(source),
      trades: (source.trades || []).map((trade, index) => normalizeSymbolCustomTrade(trade, index, source.logicName)),
      chartData: buildSymbolCustomChartData(source),
      parameterPreset: 'symbolCustom',
      parameterSource: {
        hasStoredParameters: Boolean(source.parameters),
        hasRuntimeOverrides: false,
      },
    };
  }

  function normalizeBacktestHistoryRow(record = {}, mode = BACKTEST_MODE_STANDARD) {
    if (mode === BACKTEST_MODE_SYMBOL_CUSTOM) {
      const normalized = normalizeBacktestResult(record, BACKTEST_MODE_SYMBOL_CUSTOM);
      return {
        id: record._id,
        mode: HISTORY_MODE_SYMBOL_CUSTOM,
        source: 'symbolCustom',
        createdAt: record.createdAt,
        symbol: record.symbol,
        label: record.symbolCustomName || '--',
        logicName: record.logicName || '--',
        summary: normalized.summary || {},
      };
    }

    return {
      id: record._id,
      mode: HISTORY_MODE_STANDARD,
      source: 'six_strategy',
      createdAt: record.createdAt,
      symbol: record.symbol,
      label: record.strategy || '--',
      logicName: record.strategy || '--',
      summary: record.summary || {},
    };
  }

  function firstPresent(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  }

  function normalizeExportTrade(trade = {}, index = 0, selectedTradeId = null) {
    const tradeId = firstPresent(trade.tradeId, trade.id, index + 1);
    const pnl = firstPresent(trade.profitLoss, trade.pnl, trade.netPnl, trade.profit);
    return {
      tradeId,
      side: firstPresent(trade.direction, trade.type, trade.side, '--'),
      entryTime: firstPresent(trade.entryTime, trade.openTime, trade.time),
      exitTime: firstPresent(trade.exitTime, trade.closeTime),
      entryPrice: firstPresent(trade.entryPrice, trade.openPrice),
      exitPrice: firstPresent(trade.exitPrice, trade.closePrice),
      entryReason: firstPresent(trade.entryReason, trade.reason, ''),
      setupReason: firstPresent(trade.setupReason, ''),
      triggerReason: firstPresent(trade.triggerReason, ''),
      exitReason: firstPresent(trade.exitReasonText, trade.exitReason, ''),
      pnl,
      profitPips: firstPresent(trade.profitPips, trade.pips),
      rMultiple: firstPresent(trade.rMultiple, trade.r),
      quantity: firstPresent(trade.quantity, trade.lotSize, trade.volume),
      module: firstPresent(trade.module, trade.logicName, trade.strategy, ''),
      selected: selectedTradeId !== null && String(tradeId) === String(selectedTradeId),
    };
  }

  function buildBacktestAiExportPayload({
    result = {},
    tradeEvents = [],
    formState = {},
    mode = BACKTEST_MODE_STANDARD,
    selectedTradeId = null,
    generatedAt = new Date().toISOString(),
  } = {}) {
    const source = result || {};
    const chartData = source.chartData || {};
    const summary = source.summary || {};
    const isSymbolCustom = mode === BACKTEST_MODE_SYMBOL_CUSTOM
      || source.mode === HISTORY_MODE_SYMBOL_CUSTOM
      || source.source === 'symbolCustom';
    const exportMode = source.mode || (isSymbolCustom ? HISTORY_MODE_SYMBOL_CUSTOM : HISTORY_MODE_STANDARD);
    const exportSource = source.source || (isSymbolCustom ? 'symbolCustom' : 'six_strategy');
    const rawTrades = Array.isArray(tradeEvents) && tradeEvents.length
      ? tradeEvents
      : (Array.isArray(source.trades) ? source.trades : []);
    const normalizedTrades = rawTrades.map((trade, index) => normalizeExportTrade(trade, index, selectedTradeId));
    const initialBalance = firstPresent(source.initialBalance, formState.initialBalance, formState.balance);
    const netPnl = firstPresent(summary.netPnl, summary.netProfitMoney);
    const finalBalance = firstPresent(
      source.finalBalance,
      initialBalance !== null && netPnl !== null ? toNumber(initialBalance, 0) + toNumber(netPnl, 0) : null
    );

    return {
      exportType: 'quantmatrix_backtest_trade_events_ai_review',
      generatedAt,
      mode: exportMode,
      source: exportSource,
      symbol: firstPresent(source.symbol, chartData.symbol, formState.symbol),
      strategy: firstPresent(source.strategy, source.strategyType, formState.strategyType),
      symbolCustomName: firstPresent(source.symbolCustomName, isSymbolCustom ? source.strategy : null),
      logicName: firstPresent(source.logicName, source.strategyType, source.strategy),
      timeframe: firstPresent(source.timeframe, chartData.effectiveTimeframe, formState.timeframe),
      period: {
        startDate: firstPresent(source.startDate, chartData.period && chartData.period.start, formState.startDate),
        endDate: firstPresent(source.endDate, chartData.period && chartData.period.end, formState.endDate),
      },
      balances: {
        initialBalance,
        finalBalance,
      },
      parameterPreset: firstPresent(source.parameterPreset, formState.parameterPreset),
      parameters: firstPresent(source.parameters, source.strategyParams, formState.strategyParams, {}),
      riskConfig: firstPresent(source.riskConfig, null),
      costModelUsed: firstPresent(source.costModelUsed, source.costModel, null),
      summary,
      tradeCount: normalizedTrades.length,
      trades: normalizedTrades,
      notes: [
        'This export is for research and optimization analysis only.',
        'Do not treat this export as permission to change live trading settings.',
        'Focus on entry reasons, exit reasons, clusters of losses, market regime, and parameter robustness.',
      ],
      aiInstructions: 'Analyze this QuantMatrix backtest trade event export. Identify recurring loss patterns, weak entry or exit conditions, parameter risks, and concrete optimization ideas. Separate data-backed observations from hypotheses.',
    };
  }

  function escapeMarkdownCell(value) {
    if (value === undefined || value === null) return '';
    return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  }

  function buildBacktestAiMarkdown(payload = {}) {
    const lines = [];
    lines.push('# QuantMatrix Backtest Trade Events AI Review');
    lines.push('');
    lines.push(payload.aiInstructions || 'Analyze this QuantMatrix backtest export and suggest improvements.');
    lines.push('');
    lines.push('## Context');
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('| --- | --- |');
    lines.push('| Generated At | ' + escapeMarkdownCell(payload.generatedAt) + ' |');
    lines.push('| Mode | ' + escapeMarkdownCell(payload.mode) + ' |');
    lines.push('| Source | ' + escapeMarkdownCell(payload.source) + ' |');
    lines.push('| Symbol | ' + escapeMarkdownCell(payload.symbol) + ' |');
    lines.push('| Strategy | ' + escapeMarkdownCell(payload.strategy || payload.symbolCustomName) + ' |');
    lines.push('| Logic | ' + escapeMarkdownCell(payload.logicName) + ' |');
    lines.push('| Timeframe | ' + escapeMarkdownCell(payload.timeframe) + ' |');
    lines.push('| Period | ' + escapeMarkdownCell((payload.period && payload.period.startDate) || '') + ' to ' + escapeMarkdownCell((payload.period && payload.period.endDate) || '') + ' |');
    lines.push('| Trades | ' + escapeMarkdownCell(payload.tradeCount) + ' |');
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(payload.summary || {}, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('## Parameters');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(payload.parameters || {}, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('## Trade Events');
    lines.push('');

    if (!Array.isArray(payload.trades) || payload.trades.length === 0) {
      lines.push('No trade events were recorded for this backtest.');
    } else {
      lines.push('| # | Side | Entry | Exit | Entry Px | Exit Px | P/L | Pips | R | Exit | Entry Reason |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      payload.trades.forEach((trade, index) => {
        lines.push([
          index + 1,
          escapeMarkdownCell(trade.side),
          escapeMarkdownCell(trade.entryTime),
          escapeMarkdownCell(trade.exitTime),
          escapeMarkdownCell(trade.entryPrice),
          escapeMarkdownCell(trade.exitPrice),
          escapeMarkdownCell(trade.pnl),
          escapeMarkdownCell(trade.profitPips),
          escapeMarkdownCell(trade.rMultiple),
          escapeMarkdownCell(trade.exitReason),
          escapeMarkdownCell(trade.entryReason || trade.setupReason || trade.triggerReason),
        ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
      });
    }

    lines.push('');
    lines.push('## Suggested Review Checklist');
    lines.push('');
    lines.push('- Which entry reasons are associated with repeated losses?');
    lines.push('- Are SL exits clustered by session, direction, or price regime?');
    lines.push('- Are TP exits leaving too much or too little room relative to risk?');
    lines.push('- Which parameters should be tested first, and what ranges are reasonable?');
    lines.push('- What additional filters would reduce false positives without curve fitting?');

    return lines.join('\n');
  }

  function escapeCsvValue(value) {
    if (value === undefined || value === null) return '';
    const text = String(value);
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function buildBacktestTradeEventsCsv(payload = {}) {
    const columns = [
      'tradeId',
      'side',
      'entryTime',
      'exitTime',
      'entryPrice',
      'exitPrice',
      'entryReason',
      'setupReason',
      'triggerReason',
      'exitReason',
      'pnl',
      'profitPips',
      'rMultiple',
      'quantity',
      'module',
      'selected',
    ];
    const rows = [columns.join(',')];
    (payload.trades || []).forEach((trade) => {
      rows.push(columns.map((column) => escapeCsvValue(trade[column])).join(','));
    });
    return rows.join('\n');
  }

  function safeFilenamePart(value) {
    const text = value === undefined || value === null ? '' : String(value);
    const safe = text.trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '');
    return safe || null;
  }

  function buildBacktestTradeEventsExport(args = {}) {
    const payload = buildBacktestAiExportPayload(args);
    const format = String(args.format || 'md').toLowerCase();
    const stamp = String(payload.generatedAt || new Date().toISOString()).slice(0, 10);
    const filenameBase = [
      'quantmatrix',
      'backtest',
      safeFilenamePart(payload.mode),
      safeFilenamePart(payload.symbol),
      safeFilenamePart(payload.symbolCustomName || payload.strategy || payload.logicName),
      stamp,
    ].filter(Boolean).join('-');

    if (format === 'json') {
      return {
        payload,
        filename: filenameBase + '.json',
        mimeType: 'application/json;charset=utf-8',
        content: JSON.stringify(payload, null, 2),
      };
    }

    if (format === 'csv') {
      return {
        payload,
        filename: filenameBase + '.csv',
        mimeType: 'text/csv;charset=utf-8',
        content: buildBacktestTradeEventsCsv(payload),
      };
    }

    return {
      payload,
      filename: filenameBase + '.md',
      mimeType: 'text/markdown;charset=utf-8',
      content: buildBacktestAiMarkdown(payload),
    };
  }

  return {
    BACKTEST_MODE_STANDARD,
    BACKTEST_MODE_SYMBOL_CUSTOM,
    HISTORY_MODE_STANDARD,
    HISTORY_MODE_SYMBOL_CUSTOM,
    PLACEHOLDER_SYMBOL_CUSTOM,
    SYMBOL_CUSTOM_ERROR_MESSAGES,
    buildStandardBacktestPayload,
    buildStandardAllStrategiesPayload,
    buildSymbolCustomBacktestRequest,
    buildSymbolCustomPresetComparisonRequest,
    buildSymbolCustomCandidateValidationRequest,
    getSymbolCustomSelectionState,
    isPlaceholderSymbolCustom,
    normalizeBacktestError,
    normalizeBacktestResult,
    normalizeBacktestHistoryRow,
    buildBacktestAiExportPayload,
    buildBacktestAiMarkdown,
    buildBacktestTradeEventsCsv,
    buildBacktestTradeEventsExport,
  };
}));
