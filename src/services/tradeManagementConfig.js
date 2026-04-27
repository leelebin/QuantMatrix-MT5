/**
 * Trade Management Policy
 *
 * Holds the conservative-by-default thresholds + opt-in switches consumed by
 * tradeManagementService. The policy is layered:
 *
 *   strategyInstance.effectiveTradeManagement.policy   (highest)
 *   activeProfile.tradeManagement.policy
 *   default policy                                    (lowest)
 *
 * Important: every "enable*" switch defaults to FALSE. Without explicit
 * configuration, tradeManagementService only records audit events — it never
 * modifies SL, takes partial profits, or closes positions.
 */

const DEFAULT_TRADE_MANAGEMENT_POLICY = Object.freeze({
  // Early protection window after entry
  earlyProtectionMinutes: 5,
  earlyAdverseR: -0.5,
  enableEarlyAdverseExit: false,

  // R-multiple based management
  breakevenSuggestR: 0.8,
  moveToBreakevenR: 1.0,
  allowMoveToBreakeven: false,
  partialTakeProfitR: 1.5,
  allowPartialTakeProfit: false,
  partialCloseRatio: 0.5,

  // Setup invalidation
  enableExitOnInvalidation: false,

  // News protective
  enableNewsProtectiveBreakeven: false,
});

const NUMERIC_FIELDS = [
  'earlyProtectionMinutes',
  'earlyAdverseR',
  'breakevenSuggestR',
  'moveToBreakevenR',
  'partialTakeProfitR',
  'partialCloseRatio',
];

const BOOLEAN_FIELDS = [
  'enableEarlyAdverseExit',
  'allowMoveToBreakeven',
  'allowPartialTakeProfit',
  'enableExitOnInvalidation',
  'enableNewsProtectiveBreakeven',
];

function _num(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function _bool(value) {
  if (typeof value === 'boolean') return value;
  return null;
}

/**
 * Tolerant merge: any unknown field is ignored, malformed numeric/boolean
 * values fall through to baseConfig. This is intentional — we never want a
 * bad policy entry to crash the monitor loop.
 */
function normalizeTradeManagementPolicy(input, baseConfig = DEFAULT_TRADE_MANAGEMENT_POLICY) {
  const merged = { ...baseConfig };
  if (!input || typeof input !== 'object') {
    return merged;
  }

  for (const field of NUMERIC_FIELDS) {
    const picked = _num(input[field]);
    if (picked !== null) merged[field] = picked;
  }

  for (const field of BOOLEAN_FIELDS) {
    const picked = _bool(input[field]);
    if (picked !== null) merged[field] = picked;
  }

  // Sanity: partialCloseRatio must be (0, 1)
  if (!(merged.partialCloseRatio > 0 && merged.partialCloseRatio < 1)) {
    merged.partialCloseRatio = baseConfig.partialCloseRatio;
  }

  return merged;
}

/**
 * Resolve effective policy by layering profile → strategyInstance over the
 * default config.
 *
 * @param {object} options
 * @param {object|null} options.activeProfile - the active RiskProfile
 * @param {object|null} options.strategyInstance - effectiveInstance from
 *   strategyInstanceService.getStrategyInstance()
 */
function resolveTradeManagementPolicy({ activeProfile = null, strategyInstance = null } = {}) {
  const profileLayer = normalizeTradeManagementPolicy(
    activeProfile?.tradeManagement?.policy,
    DEFAULT_TRADE_MANAGEMENT_POLICY
  );
  const strategyLayer = normalizeTradeManagementPolicy(
    strategyInstance?.effectiveTradeManagement?.policy
      || strategyInstance?.tradeManagement?.policy,
    profileLayer
  );
  return strategyLayer;
}

function getDefaultTradeManagementPolicy() {
  return { ...DEFAULT_TRADE_MANAGEMENT_POLICY };
}

module.exports = {
  DEFAULT_TRADE_MANAGEMENT_POLICY,
  getDefaultTradeManagementPolicy,
  normalizeTradeManagementPolicy,
  resolveTradeManagementPolicy,
};
