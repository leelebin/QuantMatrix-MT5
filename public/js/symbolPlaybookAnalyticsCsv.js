(function initSymbolPlaybookAnalyticsCsv(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SymbolPlaybookAnalyticsCsv = factory();
  }
}(typeof self !== 'undefined' ? self : this, function createSymbolPlaybookAnalyticsCsv() {
  const OVERVIEW_FIELDS = [
    'scope',
    'since',
    'symbol',
    'role',
    'category',
    'liveBias',
    'trades',
    'netPnl',
    'grossWin',
    'grossLoss',
    'profitFactor',
    'profitFactorLabel',
    'winRate',
    'avgR',
    'maxSingleLoss',
    'bestSetupType',
    'worstSetupType',
    'recommendation',
    'recordedCount',
    'legacyInferredCount',
    'unknownLegacyCount',
  ];

  const SETUP_FIELDS = [
    'scope',
    'since',
    'symbol',
    'setupType',
    'trades',
    'netPnl',
    'profitFactor',
    'profitFactorLabel',
    'winRate',
    'avgR',
    'maxSingleLoss',
    'recordedCount',
    'legacyInferredCount',
    'unknownLegacyCount',
  ];

  const BE_FIELDS = [
    'scope',
    'since',
    'symbol',
    'strategy',
    'setupType',
    'beStyle',
    'totalTrades',
    'beExitCount',
    'beExitRate',
    'protectedLossEstimate',
    'missedProfitAfterBEEstimate',
    'avgRealizedR',
    'recommendation',
  ];

  const RECOMMENDATION_FIELDS = [
    'scope',
    'since',
    'symbol',
    'currentRole',
    'currentLiveBias',
    'trades',
    'netPnl',
    'profitFactor',
    'winRate',
    'avgR',
    'bestSetupType',
    'worstSetupType',
    'beRecommendation',
    'suggestedAction',
    'suggestedRiskWeight',
    'suggestedBeStyle',
    'suggestedEntryStyle',
    'reason',
  ];

  function cleanText(value) {
    return value == null ? '' : String(value);
  }

  function escapeCsvValue(value) {
    const text = cleanText(value);
    if (/[",\r\n]/.test(text)) {
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  function rowsToCsv(rows, fields) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const header = fields.join(',');
    const body = safeRows.map((row) => (
      fields.map((field) => escapeCsvValue(row[field])).join(',')
    ));
    return [header, ...body].join('\n');
  }

  function sourceBreakdownCounts(breakdown = {}) {
    return {
      recordedCount: breakdown.recorded || 0,
      legacyInferredCount: breakdown.legacy_inferred || 0,
      unknownLegacyCount: breakdown.unknown_legacy || 0,
    };
  }

  function normalizeSince(value) {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
    return date.toISOString().slice(0, 10);
  }

  function playbookBySymbol(playbooks) {
    return (Array.isArray(playbooks) ? playbooks : []).reduce((index, playbook) => {
      const symbol = String(playbook.symbol || '').trim().toUpperCase();
      if (symbol) index.set(symbol, playbook);
      return index;
    }, new Map());
  }

  function flattenOverviewRows({ playbooks = [], report = {} } = {}) {
    const scope = report.scope || 'paper';
    const since = normalizeSince(report.since);
    const reportRows = Array.isArray(report.symbols) ? report.symbols : [];
    const metadataBySymbol = playbookBySymbol(playbooks);
    const symbols = new Set([
      ...Array.from(metadataBySymbol.keys()),
      ...reportRows.map((row) => String(row.symbol || '').trim().toUpperCase()).filter(Boolean),
    ]);
    const reportBySymbol = new Map(reportRows.map((row) => [
      String(row.symbol || '').trim().toUpperCase(),
      row,
    ]));

    return Array.from(symbols).sort().map((symbol) => {
      const playbook = metadataBySymbol.get(symbol) || {};
      const summary = reportBySymbol.get(symbol) || {};
      return {
        scope,
        since,
        symbol,
        role: playbook.role || '',
        category: playbook.category || '',
        liveBias: playbook.liveBias || '',
        trades: summary.trades || 0,
        netPnl: summary.netPnl,
        grossWin: summary.grossWin,
        grossLoss: summary.grossLoss,
        profitFactor: summary.profitFactor,
        profitFactorLabel: summary.profitFactorLabel,
        winRate: summary.winRate,
        avgR: summary.avgR,
        maxSingleLoss: summary.maxSingleLoss,
        bestSetupType: summary.bestSetupType,
        worstSetupType: summary.worstSetupType,
        recommendation: summary.recommendation || 'NEED_MORE_DATA',
        ...sourceBreakdownCounts(summary.setupTypeSourceBreakdown),
      };
    });
  }

  function flattenSetupRows({ report = {} } = {}) {
    const scope = report.scope || 'paper';
    const since = normalizeSince(report.since);
    const symbols = Array.isArray(report.symbols) ? report.symbols : [];
    return symbols.flatMap((symbolRow) => {
      const symbol = String(symbolRow.symbol || 'UNKNOWN').trim().toUpperCase() || 'UNKNOWN';
      const setups = Array.isArray(symbolRow.setups) ? symbolRow.setups : [];
      return setups.map((setup) => ({
        scope,
        since,
        symbol,
        setupType: setup.setupType || 'unknown_legacy',
        trades: setup.trades || 0,
        netPnl: setup.netPnl,
        profitFactor: setup.profitFactor,
        profitFactorLabel: setup.profitFactorLabel,
        winRate: setup.winRate,
        avgR: setup.avgR,
        maxSingleLoss: setup.maxSingleLoss,
        ...sourceBreakdownCounts(setup.setupTypeSourceBreakdown),
      }));
    });
  }

  function flattenBeRows({ beReport = {} } = {}) {
    const scope = beReport.scope || 'paper';
    const since = normalizeSince(beReport.since);
    const groups = Array.isArray(beReport.groups) ? beReport.groups : [];
    return groups.map((group) => ({
      scope,
      since,
      symbol: group.symbol || 'UNKNOWN',
      strategy: group.strategy || 'Unknown',
      setupType: group.setupType || 'unknown_legacy',
      beStyle: group.beStyle || 'unknown_legacy',
      totalTrades: group.totalTrades || 0,
      beExitCount: group.beExitCount || 0,
      beExitRate: group.beExitRate,
      protectedLossEstimate: group.protectedLossEstimate,
      missedProfitAfterBEEstimate: group.missedProfitAfterBEEstimate,
      avgRealizedR: group.avgRealizedR,
      recommendation: group.recommendation || 'NEED_MORE_DATA',
    }));
  }

  function flattenRecommendationRows({ recommendationsReport = {} } = {}) {
    const scope = recommendationsReport.scope || 'paper';
    const since = normalizeSince(recommendationsReport.since);
    const recommendations = Array.isArray(recommendationsReport.recommendations)
      ? recommendationsReport.recommendations
      : [];

    return recommendations.map((row) => {
      const summary = row.dataSummary || {};
      const be = summary.be || {};
      return {
        scope,
        since,
        symbol: row.symbol || 'UNKNOWN',
        currentRole: row.currentRole || '',
        currentLiveBias: row.currentLiveBias || '',
        trades: summary.trades || 0,
        netPnl: summary.netPnl,
        profitFactor: summary.profitFactor,
        winRate: summary.winRate,
        avgR: summary.avgR,
        bestSetupType: summary.bestSetupType,
        worstSetupType: summary.worstSetupType,
        beRecommendation: be.recommendation || 'NEED_MORE_DATA',
        suggestedAction: row.suggestedAction || '',
        suggestedRiskWeight: row.suggestedRiskWeight,
        suggestedBeStyle: row.suggestedBeStyle || '',
        suggestedEntryStyle: row.suggestedEntryStyle || '',
        reason: row.reason || '',
      };
    });
  }

  function buildCsv(type, data) {
    if (type === 'overview') return rowsToCsv(flattenOverviewRows(data), OVERVIEW_FIELDS);
    if (type === 'setup') return rowsToCsv(flattenSetupRows(data), SETUP_FIELDS);
    if (type === 'be') return rowsToCsv(flattenBeRows(data), BE_FIELDS);
    if (type === 'recommendations') {
      return rowsToCsv(flattenRecommendationRows(data), RECOMMENDATION_FIELDS);
    }
    throw new Error('Unsupported symbol playbook CSV type: ' + type);
  }

  return {
    BE_FIELDS,
    OVERVIEW_FIELDS,
    RECOMMENDATION_FIELDS,
    SETUP_FIELDS,
    buildCsv,
    escapeCsvValue,
    flattenBeRows,
    flattenOverviewRows,
    flattenRecommendationRows,
    flattenSetupRows,
    rowsToCsv,
    sourceBreakdownCounts,
  };
}));
