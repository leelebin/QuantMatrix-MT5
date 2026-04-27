const {
  DEFAULT_TRADE_MANAGEMENT_POLICY,
  getDefaultTradeManagementPolicy,
  normalizeTradeManagementPolicy,
  resolveTradeManagementPolicy,
} = require('../src/services/tradeManagementConfig');

describe('tradeManagementConfig', () => {
  test('all enable* flags default to false (conservative)', () => {
    const def = getDefaultTradeManagementPolicy();
    expect(def.enableEarlyAdverseExit).toBe(false);
    expect(def.allowMoveToBreakeven).toBe(false);
    expect(def.allowPartialTakeProfit).toBe(false);
    expect(def.enableExitOnInvalidation).toBe(false);
    expect(def.enableNewsProtectiveBreakeven).toBe(false);
  });

  test('caller mutations on returned default never leak back to the source', () => {
    const def = getDefaultTradeManagementPolicy();
    def.allowMoveToBreakeven = true;
    expect(getDefaultTradeManagementPolicy().allowMoveToBreakeven).toBe(false);
    expect(Object.isFrozen(DEFAULT_TRADE_MANAGEMENT_POLICY)).toBe(true);
  });

  test('normalize returns base when input is empty/garbage', () => {
    expect(normalizeTradeManagementPolicy(null)).toEqual(DEFAULT_TRADE_MANAGEMENT_POLICY);
    expect(normalizeTradeManagementPolicy(123)).toEqual(DEFAULT_TRADE_MANAGEMENT_POLICY);
    expect(normalizeTradeManagementPolicy({})).toEqual(DEFAULT_TRADE_MANAGEMENT_POLICY);
  });

  test('normalize merges valid numeric and boolean fields', () => {
    const merged = normalizeTradeManagementPolicy({
      moveToBreakevenR: 1.2,
      partialCloseRatio: 0.4,
      allowMoveToBreakeven: true,
    });
    expect(merged.moveToBreakevenR).toBe(1.2);
    expect(merged.partialCloseRatio).toBe(0.4);
    expect(merged.allowMoveToBreakeven).toBe(true);
    expect(merged.allowPartialTakeProfit).toBe(false);
  });

  test('normalize ignores unknown fields and bad numerics', () => {
    const merged = normalizeTradeManagementPolicy({
      moveToBreakevenR: 'not-a-number',
      junkField: 'ignore me',
      enableEarlyAdverseExit: 'truthy-but-not-bool',
    });
    expect(merged.moveToBreakevenR).toBe(DEFAULT_TRADE_MANAGEMENT_POLICY.moveToBreakevenR);
    expect(merged).not.toHaveProperty('junkField');
    expect(merged.enableEarlyAdverseExit).toBe(false);
  });

  test('partialCloseRatio outside (0,1) falls back to base value', () => {
    const merged = normalizeTradeManagementPolicy({ partialCloseRatio: 5 });
    expect(merged.partialCloseRatio).toBe(DEFAULT_TRADE_MANAGEMENT_POLICY.partialCloseRatio);
  });

  test('resolveTradeManagementPolicy: profile overrides defaults', () => {
    const resolved = resolveTradeManagementPolicy({
      activeProfile: {
        tradeManagement: { policy: { allowMoveToBreakeven: true, moveToBreakevenR: 0.7 } },
      },
    });
    expect(resolved.allowMoveToBreakeven).toBe(true);
    expect(resolved.moveToBreakevenR).toBe(0.7);
  });

  test('resolveTradeManagementPolicy: strategyInstance overrides profile', () => {
    const resolved = resolveTradeManagementPolicy({
      activeProfile: {
        tradeManagement: { policy: { moveToBreakevenR: 0.7, allowMoveToBreakeven: true } },
      },
      strategyInstance: {
        effectiveTradeManagement: { policy: { moveToBreakevenR: 1.3 } },
      },
    });
    expect(resolved.moveToBreakevenR).toBe(1.3);
    expect(resolved.allowMoveToBreakeven).toBe(true); // inherited from profile
  });

  test('resolveTradeManagementPolicy: empty inputs return defaults', () => {
    const resolved = resolveTradeManagementPolicy({});
    expect(resolved).toEqual(DEFAULT_TRADE_MANAGEMENT_POLICY);
  });
});
