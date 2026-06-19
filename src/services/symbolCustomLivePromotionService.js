const fs = require('fs');
const path = require('path');

const SymbolCustom = require('../models/SymbolCustom');
const {
  XAUUSD_EMA50_PULLBACK_TREND_V1,
} = require('../symbolCustom/logics/XauusdEma50PullbackTrendV1');

const LIVE_PROMOTION_ALLOWED_LOGICS = Object.freeze([
  XAUUSD_EMA50_PULLBACK_TREND_V1,
]);

const DEFAULT_LIVE_PROMOTION_THRESHOLDS = Object.freeze({
  full_window: Object.freeze({
    minTrades: 200,
    minNetPnl: 0,
    minProfitFactor: 1.5,
    maxDrawdown: 20,
    maxConsecutiveLosses: 4,
  }),
  recent_window: Object.freeze({
    minTrades: 40,
    minNetPnl: 0,
    minProfitFactor: 1.3,
    maxDrawdown: 15,
    maxConsecutiveLosses: 4,
  }),
});

const LIVE_READY_PATCH = Object.freeze({
  status: 'live_ready',
  allowLive: true,
  isPrimaryLive: true,
});

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeLogicName(symbolCustom = {}) {
  return String(
    symbolCustom.logicName
      || symbolCustom.registryLogicName
      || symbolCustom.symbolCustomName
      || ''
  ).trim();
}

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildCheck(name, passed, message, details = {}) {
  return {
    name,
    status: passed ? 'PASS' : 'FAIL',
    message,
    ...cloneValue(details),
  };
}

function summarizeChecks(checks = []) {
  return checks.reduce((summary, check) => {
    const key = String(check.status || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(summary, key)) {
      summary[key] += 1;
    }
    return summary;
  }, { pass: 0, fail: 0 });
}

function getFlags(symbolCustom = {}) {
  return {
    paperEnabled: symbolCustom.paperEnabled === true,
    liveEnabled: symbolCustom.liveEnabled === true,
    allowLive: symbolCustom.allowLive === true,
    isPrimaryLive: symbolCustom.isPrimaryLive === true,
    status: symbolCustom.status || null,
  };
}

function resolveValidationReport({ validationReport, validationReportPath } = {}) {
  if (validationReport) {
    return {
      report: cloneValue(validationReport),
      path: validationReportPath || null,
    };
  }

  if (!validationReportPath) {
    return { report: null, path: null };
  }

  const absolutePath = path.isAbsolute(validationReportPath)
    ? validationReportPath
    : path.resolve(process.cwd(), validationReportPath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  return {
    report: JSON.parse(raw),
    path: validationReportPath,
  };
}

function findValidationRange(validationReport = {}, label) {
  const results = Array.isArray(validationReport.results) ? validationReport.results : [];
  return results.find((result) => result.label === label || result.range?.label === label) || null;
}

function compareMinimum(summary = {}, field, expected, label) {
  const actual = toNumber(summary[field]);
  return buildCheck(
    `${label} ${field} >= ${expected}`,
    actual != null && actual >= expected,
    actual != null
      ? `${label} ${field} is ${actual}; required >= ${expected}.`
      : `${label} ${field} is missing.`,
    { actual, expected }
  );
}

function compareMaximum(summary = {}, field, expected, label) {
  const actual = toNumber(summary[field]);
  return buildCheck(
    `${label} ${field} <= ${expected}`,
    actual != null && actual <= expected,
    actual != null
      ? `${label} ${field} is ${actual}; required <= ${expected}.`
      : `${label} ${field} is missing.`,
    { actual, expected }
  );
}

function evaluateRangeChecks(validationReport, label, thresholds) {
  const result = findValidationRange(validationReport, label);
  if (!result) {
    return [buildCheck(
      `${label} validation exists`,
      false,
      `Validation report does not include ${label}.`
    )];
  }

  const summary = result.summary || {};
  return [
    buildCheck(`${label} validation exists`, true, `Validation report includes ${label}.`),
    compareMinimum(summary, 'trades', thresholds.minTrades, label),
    compareMinimum(summary, 'netPnl', thresholds.minNetPnl, label),
    compareMinimum(summary, 'profitFactor', thresholds.minProfitFactor, label),
    compareMaximum(summary, 'maxDrawdown', thresholds.maxDrawdown, label),
    compareMaximum(summary, 'maxConsecutiveLosses', thresholds.maxConsecutiveLosses, label),
    buildCheck(
      `${label} equity and balance curve fields present`,
      summary.equityCurveHasBalance === true && summary.equityCurveHasEquity === true,
      summary.equityCurveHasBalance === true && summary.equityCurveHasEquity === true
        ? `${label} evidence includes both balance and equity curve fields.`
        : `${label} evidence must include both balance and equity curve fields.`,
      {
        equityCurveHasBalance: summary.equityCurveHasBalance,
        equityCurveHasEquity: summary.equityCurveHasEquity,
      }
    ),
  ];
}

function evaluateValidationReportChecks(symbolCustom, validationReport, thresholds) {
  if (!validationReport) {
    return [buildCheck(
      'strict validation evidence supplied',
      false,
      'A strict validation report is required before live promotion.'
    )];
  }

  const logicName = normalizeLogicName(symbolCustom);
  const reportLogicName = String(validationReport.logicName || '').trim();
  const reportSymbol = normalizeSymbol(validationReport.symbol);
  const reportSymbolCustomId = validationReport.symbolCustomId || null;
  const checks = [
    buildCheck('strict validation evidence supplied', true, 'Strict validation report was supplied.'),
    buildCheck(
      'validation report matches SymbolCustom id',
      !reportSymbolCustomId || reportSymbolCustomId === symbolCustom._id,
      reportSymbolCustomId
        ? `Report id ${reportSymbolCustomId}; SymbolCustom id ${symbolCustom._id}.`
        : 'Report did not include an id; logic and symbol checks still apply.',
      { actual: reportSymbolCustomId, expected: symbolCustom._id }
    ),
    buildCheck(
      'validation report matches logic',
      reportLogicName === logicName,
      `Report logic ${reportLogicName || '(missing)'}; SymbolCustom logic ${logicName || '(missing)'}.`,
      { actual: reportLogicName, expected: logicName }
    ),
    buildCheck(
      'validation report matches symbol',
      reportSymbol === normalizeSymbol(symbolCustom.symbol),
      `Report symbol ${reportSymbol || '(missing)'}; SymbolCustom symbol ${normalizeSymbol(symbolCustom.symbol) || '(missing)'}.`,
      { actual: reportSymbol, expected: normalizeSymbol(symbolCustom.symbol) }
    ),
  ];

  for (const [label, rangeThresholds] of Object.entries(thresholds || {})) {
    checks.push(...evaluateRangeChecks(validationReport, label, rangeThresholds));
  }

  return checks;
}

async function resolveSymbolCustom(options = {}) {
  if (options.symbolCustom) {
    return cloneValue(options.symbolCustom);
  }

  if (!options.symbolCustomId) {
    return null;
  }

  return SymbolCustom.findById(options.symbolCustomId);
}

async function resolveAllSymbolCustoms(options = {}) {
  if (Array.isArray(options.symbolCustoms)) {
    return cloneValue(options.symbolCustoms);
  }
  return SymbolCustom.findAll({});
}

function evaluatePrimaryLiveConflict(symbolCustom, allSymbolCustoms = []) {
  const symbol = normalizeSymbol(symbolCustom.symbol);
  const conflicts = allSymbolCustoms.filter((record) => (
    record
      && record._id !== symbolCustom._id
      && normalizeSymbol(record.symbol) === symbol
      && record.isPrimaryLive === true
  ));

  return buildCheck(
    'no existing primary live conflict',
    conflicts.length === 0,
    conflicts.length === 0
      ? 'No other primary live SymbolCustom exists for this symbol.'
      : `Found ${conflicts.length} existing primary live SymbolCustom(s) for ${symbol}.`,
    {
      conflicts: conflicts.map((record) => ({
        symbolCustomId: record._id || null,
        symbolCustomName: record.symbolCustomName,
        logicName: normalizeLogicName(record),
      })),
    }
  );
}

function evaluateStaticPromotionChecks(symbolCustom, allSymbolCustoms) {
  if (!symbolCustom) {
    return [buildCheck('SymbolCustom record exists', false, 'SymbolCustom record was not found.')];
  }

  const logicName = normalizeLogicName(symbolCustom);
  const parameters = symbolCustom.parameters || {};
  const status = String(symbolCustom.status || '').trim();

  return [
    buildCheck('SymbolCustom record exists', true, 'SymbolCustom record was found.'),
    buildCheck(
      'logic is live promotion allowed',
      LIVE_PROMOTION_ALLOWED_LOGICS.includes(logicName),
      LIVE_PROMOTION_ALLOWED_LOGICS.includes(logicName)
        ? `${logicName} is allowed for audited live promotion.`
        : `${logicName || '(missing)'} is not allowed for live promotion.`,
      { actual: logicName, expected: LIVE_PROMOTION_ALLOWED_LOGICS }
    ),
    buildCheck(
      'paperEnabled remains enabled',
      symbolCustom.paperEnabled === true,
      'Live promotion requires paperEnabled=true and does not change it.',
      { actual: symbolCustom.paperEnabled, expected: true }
    ),
    buildCheck(
      'liveEnabled remains enabled',
      symbolCustom.liveEnabled === true,
      'Live promotion requires liveEnabled=true and does not change it.',
      { actual: symbolCustom.liveEnabled, expected: true }
    ),
    buildCheck(
      'parameters enabled',
      parameters.enabled !== false,
      'Live promotion requires parameters.enabled not false.',
      { actual: parameters.enabled, expected: 'not false' }
    ),
    buildCheck(
      'record is promotable status',
      !['disabled', 'archived'].includes(status),
      `Current status is ${status || '(missing)'}.`,
      { actual: status, rejectedStatuses: ['disabled', 'archived'] }
    ),
    evaluatePrimaryLiveConflict(symbolCustom, allSymbolCustoms),
  ];
}

async function evaluateSymbolCustomLivePromotion(options = {}) {
  const thresholds = {
    ...cloneValue(DEFAULT_LIVE_PROMOTION_THRESHOLDS),
    ...cloneValue(options.thresholds || {}),
  };
  const symbolCustom = await resolveSymbolCustom(options);
  const allSymbolCustoms = symbolCustom ? await resolveAllSymbolCustoms(options) : [];
  const { report: validationReport, path: validationReportPath } = resolveValidationReport(options);
  const checks = [
    ...evaluateStaticPromotionChecks(symbolCustom, allSymbolCustoms),
  ];

  if (symbolCustom) {
    checks.push(...evaluateValidationReportChecks(symbolCustom, validationReport, thresholds));
  }

  const summary = summarizeChecks(checks);
  const eligible = checks.every((check) => check.status === 'PASS');
  const flagsBefore = getFlags(symbolCustom || {});
  const plannedPatch = eligible ? cloneValue(LIVE_READY_PATCH) : null;

  return {
    success: true,
    mode: 'dry_run',
    eligible,
    decision: eligible ? 'PASS' : 'FAIL',
    generatedAt: (options.now || new Date()).toISOString(),
    symbolCustomId: symbolCustom?._id || options.symbolCustomId || null,
    symbolCustomName: symbolCustom?.symbolCustomName || null,
    logicName: symbolCustom ? normalizeLogicName(symbolCustom) : null,
    symbol: symbolCustom?.symbol || null,
    validationReportPath,
    thresholds,
    flagsBefore,
    plannedPatch,
    policy: {
      requiresStrictValidationEvidence: true,
      preservesPaperEnabled: true,
      preservesLiveEnabled: true,
      doesNotStartLiveRuntime: true,
      liveExecutionStillRequiresEnv: 'SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED=true',
    },
    summary,
    checks,
  };
}

async function promoteSymbolCustomToLiveReady(options = {}) {
  const evaluation = await evaluateSymbolCustomLivePromotion(options);
  if (!evaluation.eligible) {
    return {
      ...evaluation,
      mode: 'apply',
      applied: false,
      success: false,
      message: 'SymbolCustom did not pass live promotion checks.',
    };
  }

  const patch = cloneValue(LIVE_READY_PATCH);
  const updated = await SymbolCustom.update(evaluation.symbolCustomId, patch);
  const flagsAfter = getFlags(updated || {});

  return {
    ...evaluation,
    mode: 'apply',
    applied: true,
    success: true,
    message: 'SymbolCustom promoted to live_ready.',
    appliedPatch: patch,
    flagsAfter,
    updated: cloneValue(updated),
    policy: {
      ...evaluation.policy,
      paperEnabledPreserved: evaluation.flagsBefore.paperEnabled === flagsAfter.paperEnabled,
      liveEnabledPreserved: evaluation.flagsBefore.liveEnabled === flagsAfter.liveEnabled,
    },
  };
}

module.exports = {
  LIVE_PROMOTION_ALLOWED_LOGICS,
  DEFAULT_LIVE_PROMOTION_THRESHOLDS,
  LIVE_READY_PATCH,
  evaluateSymbolCustomLivePromotion,
  promoteSymbolCustomToLiveReady,
};
