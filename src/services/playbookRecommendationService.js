const { SYMBOL_PLAYBOOKS, getSymbolPlaybook } = require('../config/symbolPlaybooks');
const { getBreakevenAnalysisReport } = require('./breakevenAnalysisReportService');
const { getSymbolPlaybookReport } = require('./symbolPlaybookReportService');

const DEFAULT_RECOMMENDATION_SINCE = '2026-04-27';
const DEFAULT_SCOPE = 'paper';
const SUGGESTED_ACTIONS = [
  'KEEP_CURRENT',
  'OBSERVE_MORE',
  'REDUCE_RISK',
  'PAPER_ONLY_RECOMMENDED',
  'DISABLE_RECOMMENDED',
  'CONSIDER_ENTRY_REFINEMENT',
  'CONSIDER_BE_LOOSENING',
];

const LOOSER_BE_STYLE = {
  tight: 'medium_tight',
  medium_tight: 'medium',
  medium: 'medium_loose',
  medium_loose: 'loose',
  loose: 'loose',
  default: 'medium',
};

function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundNumber(value, digits = 4) {
  const number = toFiniteNumber(value);
  return number == null ? null : parseFloat(number.toFixed(digits));
}

function getComparableProfitFactor(symbolSummary = {}) {
  if (symbolSummary.profitFactorLabel === 'INF') return Infinity;
  return toFiniteNumber(symbolSummary.profitFactor);
}

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function indexBySymbol(rows = []) {
  return rows.reduce((index, row) => {
    const symbol = normalizeSymbol(row.symbol);
    if (symbol) index.set(symbol, row);
    return index;
  }, new Map());
}

function sumMetric(rows, field, countField) {
  const hasSamples = rows.some((row) => {
    const count = row.availableMetrics ? toFiniteNumber(row.availableMetrics[countField]) : null;
    return count != null ? count > 0 : toFiniteNumber(row[field]) != null;
  });
  if (!hasSamples) return null;

  return roundNumber(rows.reduce((sum, row) => {
    const value = toFiniteNumber(row[field]);
    return value != null ? sum + value : sum;
  }, 0), 2);
}

function chooseBeRecommendation(groups = []) {
  if (groups.some((group) => group.recommendation === 'CONSIDER_LOOSEN_BE')) {
    return 'CONSIDER_LOOSEN_BE';
  }
  if (groups.some((group) => group.recommendation === 'KEEP_TIGHT_BE')) {
    return 'KEEP_TIGHT_BE';
  }
  if (groups.some((group) => group.recommendation === 'NEUTRAL')) {
    return 'NEUTRAL';
  }
  return 'NEED_MORE_DATA';
}

function summarizeBeGroups(groups = []) {
  const totalTrades = groups.reduce((sum, group) => sum + (toFiniteNumber(group.totalTrades) || 0), 0);
  const beExitCount = groups.reduce((sum, group) => sum + (toFiniteNumber(group.beExitCount) || 0), 0);
  const realizedSamples = groups.reduce((sum, group) => {
    const count = group.availableMetrics ? toFiniteNumber(group.availableMetrics.realizedRCount) : null;
    return sum + (count || 0);
  }, 0);
  const realizedTotal = groups.reduce((sum, group) => {
    const count = group.availableMetrics ? toFiniteNumber(group.availableMetrics.realizedRCount) : null;
    const avg = toFiniteNumber(group.avgRealizedR);
    return count != null && avg != null ? sum + (avg * count) : sum;
  }, 0);

  return {
    groups: groups.length,
    totalTrades,
    beExitCount,
    beExitRate: totalTrades > 0 ? roundNumber(beExitCount / totalTrades, 4) : null,
    protectedLossEstimate: sumMetric(groups, 'protectedLossEstimate', 'protectedLossEstimateCount'),
    missedProfitAfterBEEstimate: sumMetric(
      groups,
      'missedProfitAfterBEEstimate',
      'missedProfitAfterBEEstimateCount'
    ),
    avgRealizedR: realizedSamples > 0 ? roundNumber(realizedTotal / realizedSamples, 4) : null,
    recommendation: groups.length > 0 ? chooseBeRecommendation(groups) : 'NEED_MORE_DATA',
  };
}

function groupBeReportBySymbol(beReport = {}) {
  const groups = Array.isArray(beReport.groups) ? beReport.groups : [];
  return groups.reduce((index, group) => {
    const symbol = normalizeSymbol(group.symbol);
    if (!symbol) return index;
    if (!index.has(symbol)) index.set(symbol, []);
    index.get(symbol).push(group);
    return index;
  }, new Map());
}

function getLooserBeStyle(currentStyle) {
  const normalized = String(currentStyle || 'default').trim();
  return LOOSER_BE_STYLE[normalized] || normalized || 'default';
}

function getReducedRiskWeight(currentRiskWeight) {
  const number = toFiniteNumber(currentRiskWeight) ?? 0;
  return roundNumber(Math.max(0, number * 0.5), 4);
}

function shouldConsiderEntryRefinement(symbolSummary = {}) {
  const trades = toFiniteNumber(symbolSummary.trades) || 0;
  if (trades < 5) return false;

  const netPnl = toFiniteNumber(symbolSummary.netPnl);
  const profitFactor = getComparableProfitFactor(symbolSummary);
  const avgR = toFiniteNumber(symbolSummary.avgR);

  if (netPnl != null && netPnl > 0 && profitFactor != null && profitFactor < 1.1) {
    return true;
  }
  return avgR != null && avgR > 0 && avgR < 0.1;
}

function buildDataSummary(symbolSummary, beSummary, scope) {
  return {
    scope,
    trades: symbolSummary ? symbolSummary.trades : 0,
    netPnl: symbolSummary ? symbolSummary.netPnl : null,
    profitFactor: symbolSummary ? symbolSummary.profitFactor : null,
    profitFactorLabel: symbolSummary ? symbolSummary.profitFactorLabel : null,
    winRate: symbolSummary ? symbolSummary.winRate : null,
    avgR: symbolSummary ? symbolSummary.avgR : null,
    bestSetupType: symbolSummary ? symbolSummary.bestSetupType : null,
    worstSetupType: symbolSummary ? symbolSummary.worstSetupType : null,
    playbookReportRecommendation: symbolSummary ? symbolSummary.recommendation : 'NO_DATA',
    be: beSummary,
  };
}

function buildSuggestion({ playbook, symbolSummary, beSummary }) {
  const currentRiskWeight = toFiniteNumber(playbook.riskWeight) ?? 0;
  const currentBeStyle = playbook.beStyle || 'default';
  const currentEntryStyle = playbook.preferredEntryStyle || 'none';
  const trades = toFiniteNumber(symbolSummary && symbolSummary.trades) || 0;
  const performanceRecommendation = symbolSummary ? symbolSummary.recommendation : 'NO_DATA';

  const suggestion = {
    suggestedAction: 'KEEP_CURRENT',
    suggestedRiskWeight: currentRiskWeight,
    suggestedBeStyle: currentBeStyle,
    suggestedEntryStyle: currentEntryStyle,
    reason: 'Playbook and recent report do not require a configuration change suggestion.',
  };

  if (trades < 5) {
    return {
      ...suggestion,
      suggestedAction: 'OBSERVE_MORE',
      reason: 'Fewer than 5 closed trades are available for this symbol since the report start date.',
    };
  }

  if (performanceRecommendation === 'DISABLE_SUGGESTED') {
    return {
      ...suggestion,
      suggestedAction: 'DISABLE_RECOMMENDED',
      suggestedRiskWeight: 0,
      reason: 'Symbol report shows enough clearly negative data to recommend disabling before more live exposure.',
    };
  }

  if (performanceRecommendation === 'PAPER_ONLY') {
    return {
      ...suggestion,
      suggestedAction: 'PAPER_ONLY_RECOMMENDED',
      suggestedRiskWeight: getReducedRiskWeight(currentRiskWeight),
      reason: 'Symbol report is non-positive with enough samples, so paper-only observation is recommended.',
    };
  }

  if (beSummary.recommendation === 'CONSIDER_LOOSEN_BE') {
    return {
      ...suggestion,
      suggestedAction: 'CONSIDER_BE_LOOSENING',
      suggestedBeStyle: getLooserBeStyle(currentBeStyle),
      reason: 'BE report shows missed profit after BE materially above the protected loss estimate.',
    };
  }

  if (performanceRecommendation === 'KEEP_SMALL' && currentRiskWeight > 0.5) {
    return {
      ...suggestion,
      suggestedAction: 'REDUCE_RISK',
      suggestedRiskWeight: getReducedRiskWeight(currentRiskWeight),
      reason: 'Symbol report is positive but not strong enough for current high risk weight.',
    };
  }

  if (shouldConsiderEntryRefinement(symbolSummary)) {
    return {
      ...suggestion,
      suggestedAction: 'CONSIDER_ENTRY_REFINEMENT',
      reason: 'Recent edge is thin; entry refinement should be reviewed before increasing exposure.',
    };
  }

  return suggestion;
}

function buildPlaybookRecommendationsFromReports(symbolReport = {}, beReport = {}) {
  const scope = symbolReport.scope || beReport.scope || DEFAULT_SCOPE;
  const since = symbolReport.since || beReport.since || new Date(DEFAULT_RECOMMENDATION_SINCE).toISOString();
  const symbolSummaries = indexBySymbol(symbolReport.symbols || []);
  const beGroupsBySymbol = groupBeReportBySymbol(beReport);
  const symbols = new Set([
    ...Object.keys(SYMBOL_PLAYBOOKS),
    ...symbolSummaries.keys(),
    ...beGroupsBySymbol.keys(),
  ]);

  const recommendations = Array.from(symbols)
    .sort()
    .map((symbol) => {
      const playbook = getSymbolPlaybook(symbol);
      const symbolSummary = symbolSummaries.get(symbol) || null;
      const beSummary = summarizeBeGroups(beGroupsBySymbol.get(symbol) || []);
      const suggestion = buildSuggestion({ playbook, symbolSummary, beSummary });

      return {
        symbol,
        currentRole: playbook.role,
        currentLiveBias: playbook.liveBias,
        dataSummary: buildDataSummary(symbolSummary, beSummary, scope),
        ...suggestion,
      };
    });

  return {
    scope,
    since,
    count: recommendations.length,
    recommendations,
  };
}

async function getPlaybookRecommendations(options = {}) {
  const since = options.since || DEFAULT_RECOMMENDATION_SINCE;
  const scope = options.scope || DEFAULT_SCOPE;
  const [symbolReport, beReport] = await Promise.all([
    getSymbolPlaybookReport({ since, scope }),
    getBreakevenAnalysisReport({ since, scope }),
  ]);

  return buildPlaybookRecommendationsFromReports(symbolReport, beReport);
}

module.exports = {
  DEFAULT_RECOMMENDATION_SINCE,
  SUGGESTED_ACTIONS,
  buildPlaybookRecommendationsFromReports,
  getLooserBeStyle,
  getPlaybookRecommendations,
  shouldConsiderEntryRefinement,
};
