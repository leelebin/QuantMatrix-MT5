const cost = require('../src/utils/backtestCostModel');

const closeTo = (received, expected, tolerance = 1e-6) => {
  expect(Math.abs(received - expected)).toBeLessThanOrEqual(tolerance);
};

describe('backtestCostModel', () => {
  describe('resolveCostModel', () => {
    test('returns zero defaults when no sources provided', () => {
      const { costModel, sources } = cost.resolveCostModel({});
      expect(costModel.commissionPerLot).toBe(0);
      expect(costModel.commissionPerSide).toBe(false);
      expect(costModel.swapLongPerLotPerDay).toBe(0);
      expect(costModel.swapShortPerLotPerDay).toBe(0);
      expect(costModel.fixedFeePerTrade).toBe(0);
      expect(sources).toEqual(['default']);
    });

    test('instrument layer applied when only instrument provided', () => {
      const { costModel, sources } = cost.resolveCostModel({
        instrumentCostModel: { commissionPerLot: 7, swapLongPerLotPerDay: -2 },
      });
      expect(costModel.commissionPerLot).toBe(7);
      expect(costModel.swapLongPerLotPerDay).toBe(-2);
      expect(sources).toEqual(['instrument']);
    });

    test('strategy overrides instrument; request overrides strategy', () => {
      const { costModel, sources } = cost.resolveCostModel({
        instrumentCostModel: { commissionPerLot: 7, swapLongPerLotPerDay: -2 },
        strategyCostModel: { commissionPerLot: 5 },
        requestCostModel: { swapLongPerLotPerDay: -1, fixedFeePerTrade: -0.5 },
      });
      expect(costModel.commissionPerLot).toBe(5);          // from strategy
      expect(costModel.swapLongPerLotPerDay).toBe(-1);    // from request
      expect(costModel.fixedFeePerTrade).toBe(-0.5);      // from request
      expect(sources).toEqual(['instrument', 'strategy', 'request']);
    });

    test('commissionPerSide bool layer is honoured', () => {
      const { costModel } = cost.resolveCostModel({
        requestCostModel: { commissionPerSide: true },
      });
      expect(costModel.commissionPerSide).toBe(true);
    });
  });

  describe('calculateOvernightDays', () => {
    test('same UTC day returns 0', () => {
      const days = cost.calculateOvernightDays(
        '2026-01-15T08:00:00.000Z',
        '2026-01-15T22:00:00.000Z'
      );
      expect(days).toBe(0);
    });

    test('crosses one UTC midnight returns 1', () => {
      const days = cost.calculateOvernightDays(
        '2026-01-15T23:00:00.000Z',
        '2026-01-16T02:00:00.000Z'
      );
      expect(days).toBe(1);
    });

    test('multi-day hold counts each rollover', () => {
      const days = cost.calculateOvernightDays(
        '2026-01-10T12:00:00.000Z',
        '2026-01-15T12:00:00.000Z'
      );
      expect(days).toBe(5);
    });
  });

  describe('calculateTradeCosts', () => {
    test('zero cost model returns zeros', () => {
      const result = cost.calculateTradeCosts({
        costModel: null,
        lotSize: 1,
        type: 'BUY',
        entryTime: '2026-01-10T08:00:00.000Z',
        exitTime: '2026-01-12T08:00:00.000Z',
      });
      closeTo(result.commission, 0);
      closeTo(result.swap, 0);
      closeTo(result.fee, 0);
    });

    test('commissionPerLot reduces P&L (debit as negative)', () => {
      const { costModel } = cost.resolveCostModel({
        requestCostModel: { commissionPerLot: 7 },
      });
      const result = cost.calculateTradeCosts({
        costModel,
        lotSize: 0.5,
        type: 'BUY',
        entryTime: '2026-01-10T08:00:00.000Z',
        exitTime: '2026-01-10T22:00:00.000Z',
      });
      closeTo(result.commission, -3.5);
      expect(result.swap).toBe(0);
    });

    test('commissionPerSide doubles the charge (entry + exit)', () => {
      const { costModel } = cost.resolveCostModel({
        requestCostModel: { commissionPerLot: 7, commissionPerSide: true },
      });
      const result = cost.calculateTradeCosts({
        costModel,
        lotSize: 1,
        type: 'BUY',
        entryTime: '2026-01-10T08:00:00.000Z',
        exitTime: '2026-01-10T22:00:00.000Z',
      });
      closeTo(result.commission, -14);
    });

    test('BUY uses swapLongPerLotPerDay × overnightDays', () => {
      const { costModel } = cost.resolveCostModel({
        requestCostModel: { swapLongPerLotPerDay: -2, swapShortPerLotPerDay: 1 },
      });
      const result = cost.calculateTradeCosts({
        costModel,
        lotSize: 1,
        type: 'BUY',
        entryTime: '2026-01-10T12:00:00.000Z',
        exitTime: '2026-01-13T12:00:00.000Z',
      });
      expect(result.overnightDays).toBe(3);
      closeTo(result.swap, -6);
    });

    test('SELL uses swapShortPerLotPerDay × overnightDays', () => {
      const { costModel } = cost.resolveCostModel({
        requestCostModel: { swapLongPerLotPerDay: -2, swapShortPerLotPerDay: 1 },
      });
      const result = cost.calculateTradeCosts({
        costModel,
        lotSize: 0.5,
        type: 'SELL',
        entryTime: '2026-01-10T00:00:00.000Z',
        exitTime: '2026-01-14T00:00:00.000Z',
      });
      expect(result.overnightDays).toBe(4);
      closeTo(result.swap, 2);
    });

    test('fixedFeePerTrade applied once per trade as negative', () => {
      const { costModel } = cost.resolveCostModel({
        requestCostModel: { fixedFeePerTrade: 0.5 },
      });
      const result = cost.calculateTradeCosts({
        costModel,
        lotSize: 5,
        type: 'BUY',
        entryTime: '2026-01-10T08:00:00.000Z',
        exitTime: '2026-01-10T22:00:00.000Z',
      });
      closeTo(result.fee, -0.5);
    });
  });

  describe('summarizeCosts', () => {
    test('aggregates commission/swap/fees across trades', () => {
      const trades = [
        { commission: -3.5, swap: -2, fee: -0.5 },
        { commission: -7, swap: 0, fee: -0.5 },
        { commission: 0, swap: -1, fee: 0 },
      ];
      const result = cost.summarizeCosts(trades);
      closeTo(result.totalCommission, -10.5);
      closeTo(result.totalSwap, -3);
      closeTo(result.totalFees, -1);
      closeTo(result.totalTradingCosts, -14.5);
    });

    test('empty trade array returns zeros', () => {
      const result = cost.summarizeCosts([]);
      expect(result.totalCommission).toBe(0);
      expect(result.totalSwap).toBe(0);
      expect(result.totalFees).toBe(0);
      expect(result.totalTradingCosts).toBe(0);
    });
  });
});
