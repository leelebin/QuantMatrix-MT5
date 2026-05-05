const valuation = require('../src/utils/instrumentValuation');
const { getInstrument } = require('../src/config/instruments');

const closeTo = (received, expected, tolerance = 1e-6) => {
  expect(Math.abs(received - expected)).toBeLessThanOrEqual(tolerance);
};

describe('instrumentValuation helper', () => {
  describe('lot size calculation', () => {
    test('EURUSD sizes 0.20 lot for $100 risk on 50-pip stop', () => {
      const instrument = getInstrument('EURUSD');
      const lot = valuation.calculateLotSize({
        entryPrice: 1.1000,
        slPrice: 1.0950,
        balance: 10000,
        riskPercent: 0.01,
        instrument,
      });
      expect(lot).toBeCloseTo(0.20, 5);
    });

    test('XAUUSD sizes 0.15 lot for $150 risk on $10 stop', () => {
      const instrument = getInstrument('XAUUSD');
      const lot = valuation.calculateLotSize({
        entryPrice: 2000,
        slPrice: 1990,
        balance: 10000,
        riskPercent: 0.015,
        instrument,
      });
      expect(lot).toBeCloseTo(0.15, 5);
    });

    test('BTCUSD on $500 balance + $2000 stop falls below minLot and aggressive-bumps to 0.01', () => {
      const instrument = getInstrument('BTCUSD');
      const lot = valuation.calculateLotSize({
        entryPrice: 50000,
        slPrice: 48000,
        balance: 500,
        riskPercent: 0.008,
        instrument,
        aggressiveMinLot: true,
      });
      expect(lot).toBe(0.01);
    });

    test('BTCUSD without aggressive-min returns 0 when raw size < minLot', () => {
      const instrument = getInstrument('BTCUSD');
      const lot = valuation.calculateLotSize({
        entryPrice: 50000,
        slPrice: 48000,
        balance: 500,
        riskPercent: 0.008,
        instrument,
        aggressiveMinLot: false,
      });
      expect(lot).toBe(0);
    });

    test('caps oversized lot at instrument max (5 lots default)', () => {
      const instrument = getInstrument('EURUSD');
      const lot = valuation.calculateLotSize({
        entryPrice: 1.1000,
        slPrice: 1.0999,
        balance: 1_000_000,
        riskPercent: 0.5,
        instrument,
      });
      expect(lot).toBe(5);
    });

    test('uses broker snapshot tickValue/volumeStep over static config', () => {
      const instrument = getInstrument('EURUSD');
      const snapshot = {
        tickSize: 0.00001,
        tickValue: 1,
        volumeMin: 0.10,
        volumeStep: 0.10,
      };
      // pipValue derived: tickValue * (pipSize/tickSize) = 1 * 10 = 10/lot
      // riskAmount = 100, slDistance 0.005 => slPips=50, riskPerLot=500 => raw 0.20 → snapped to 0.20
      const lot = valuation.calculateLotSize({
        entryPrice: 1.1000,
        slPrice: 1.0950,
        balance: 10000,
        riskPercent: 0.01,
        instrument,
        snapshot,
      });
      expect(lot).toBeCloseTo(0.20, 5);

      // Snapshot snaps to 0.10-step grid
      const smallerLot = valuation.calculateLotSize({
        entryPrice: 1.1000,
        slPrice: 1.0950,
        balance: 5000,
        riskPercent: 0.01,
        instrument,
        snapshot,
      });
      // raw 0.10 → snapped 0.10
      expect(smallerLot).toBeCloseTo(0.10, 5);
    });
  });

  describe('profit pips calculation', () => {
    test('EURUSD BUY 50 pips on 1.1000 → 1.1050', () => {
      const instrument = getInstrument('EURUSD');
      const pips = valuation.calculateProfitPips({
        type: 'BUY',
        entryPrice: 1.1000,
        exitPrice: 1.1050,
        instrument,
      });
      closeTo(pips, 50);
    });

    test('USDJPY SELL 30 pips on 150.00 → 149.70', () => {
      const instrument = getInstrument('USDJPY');
      const pips = valuation.calculateProfitPips({
        type: 'SELL',
        entryPrice: 150.00,
        exitPrice: 149.70,
        instrument,
      });
      closeTo(pips, 30);
    });

    test('XAUUSD BUY 1000 pips on 2000 → 2010', () => {
      const instrument = getInstrument('XAUUSD');
      const pips = valuation.calculateProfitPips({
        type: 'BUY',
        entryPrice: 2000,
        exitPrice: 2010,
        instrument,
      });
      closeTo(pips, 1000);
    });
  });

  describe('profit/loss calculation', () => {
    test('EURUSD BUY 0.20 lots, +50 pips → $100', () => {
      const instrument = getInstrument('EURUSD');
      const pl = valuation.calculateGrossProfitLoss({
        type: 'BUY',
        entryPrice: 1.1000,
        exitPrice: 1.1050,
        lotSize: 0.20,
        instrument,
      });
      closeTo(pl, 100);
    });

    test('EURUSD SELL 0.10 lots, +20 pips (price drop 1.1000→1.0980) → $20', () => {
      const instrument = getInstrument('EURUSD');
      const pl = valuation.calculateGrossProfitLoss({
        type: 'SELL',
        entryPrice: 1.1000,
        exitPrice: 1.0980,
        lotSize: 0.10,
        instrument,
      });
      closeTo(pl, 20);
    });

    test('XAUUSD BUY 0.15 lots, +$10 move → $150', () => {
      const instrument = getInstrument('XAUUSD');
      const pl = valuation.calculateGrossProfitLoss({
        type: 'BUY',
        entryPrice: 2000,
        exitPrice: 2010,
        lotSize: 0.15,
        instrument,
      });
      closeTo(pl, 150);
    });

    test('BTCUSD BUY 0.01 lots, +$1000 move → $10', () => {
      const instrument = getInstrument('BTCUSD');
      const pl = valuation.calculateGrossProfitLoss({
        type: 'BUY',
        entryPrice: 50000,
        exitPrice: 51000,
        lotSize: 0.01,
        instrument,
      });
      closeTo(pl, 10);
    });

    test('honours broker snapshot tickValue when supplied', () => {
      const instrument = getInstrument('EURUSD');
      const snapshot = { tickSize: 0.00001, tickValue: 1 }; // $1/tick @ 0.00001
      // priceDiff 0.0050 = 500 ticks * $1 * 0.20 lots = $100
      const pl = valuation.calculateGrossProfitLoss({
        type: 'BUY',
        entryPrice: 1.1000,
        exitPrice: 1.1050,
        lotSize: 0.20,
        instrument,
        snapshot,
      });
      closeTo(pl, 100);
    });
  });

  describe('lot normalization', () => {
    test('floors to nearest lotStep', () => {
      const instrument = getInstrument('EURUSD');
      expect(valuation.normalizeLotSize(0.0234, { instrument })).toBe(0.02);
      expect(valuation.normalizeLotSize(0.099, { instrument })).toBe(0.09);
    });

    test('aggressive-min bumps below-floor sizes to minLot', () => {
      const instrument = getInstrument('EURUSD');
      expect(valuation.normalizeLotSize(0.005, { instrument, aggressiveMinLot: true })).toBe(0.01);
    });

    test('non-aggressive-min returns 0 below floor', () => {
      const instrument = getInstrument('EURUSD');
      expect(valuation.normalizeLotSize(0.005, { instrument, aggressiveMinLot: false })).toBe(0);
    });

    test('caps at maxLot', () => {
      const instrument = getInstrument('EURUSD');
      expect(valuation.normalizeLotSize(8, { instrument, maxLot: 5 })).toBe(5);
    });

    test('respects broker volume grid from snapshot', () => {
      const instrument = getInstrument('XAUUSD');
      const snapshot = { volumeMin: 0.10, volumeStep: 0.10 };
      expect(valuation.normalizeLotSize(0.27, { instrument, snapshot })).toBe(0.20);
      expect(valuation.normalizeLotSize(0.05, { instrument, snapshot, aggressiveMinLot: true })).toBe(0.10);
    });
  });

  describe('planned risk + R multiple math', () => {
    test('EURUSD plannedRiskAmount equals raw money risked at SL', () => {
      const instrument = getInstrument('EURUSD');
      const planned = valuation.calculatePlannedRiskAmount({
        entryPrice: 1.1000,
        slPrice: 1.0950,
        lotSize: 0.20,
        instrument,
      });
      closeTo(planned, 100);
    });

    test('realized R multiple = profitLoss / plannedRiskAmount', () => {
      const instrument = getInstrument('EURUSD');
      const planned = valuation.calculatePlannedRiskAmount({
        entryPrice: 1.1000,
        slPrice: 1.0950,
        lotSize: 0.20,
        instrument,
      });
      const exitPL = valuation.calculateGrossProfitLoss({
        type: 'BUY',
        entryPrice: 1.1000,
        exitPrice: 1.1100,
        lotSize: 0.20,
        instrument,
      });
      const realizedR = exitPL / planned;
      closeTo(realizedR, 2);
    });
  });

  describe('valuation context bundle', () => {
    test('returns all expected fields with sensible defaults', () => {
      const instrument = getInstrument('EURUSD');
      const ctx = valuation.getValuationContext(instrument);
      expect(ctx).toMatchObject({
        pipSize: 0.0001,
        pipValue: 10,
        contractSize: 100000,
        minLot: 0.01,
        lotStep: 0.01,
        maxLot: 5,
        lotPrecision: 2,
      });
      expect(ctx.tickValue).toBeGreaterThan(0);
      expect(ctx.pricePrecision).toBeGreaterThanOrEqual(4);
    });

    test('snapshot fields override static config', () => {
      const instrument = getInstrument('EURUSD');
      const ctx = valuation.getValuationContext(instrument, {
        volumeMin: 0.10,
        volumeStep: 0.10,
        digits: 5,
      });
      expect(ctx.minLot).toBe(0.10);
      expect(ctx.lotStep).toBe(0.10);
      expect(ctx.pricePrecision).toBe(5);
    });

    test('accepts MT5 bridge symbolInfo aliases and converts point spread to pips', () => {
      const instrument = getInstrument('EURUSD');
      const ctx = valuation.getValuationContext(instrument, {
        tradeTickSize: 0.00001,
        tradeTickValueProfit: 1,
        tradeContractSize: 100000,
        volume_min: 0.10,
        volume_step: 0.10,
        volume_max: 3,
        point: 0.00001,
        spread: 12,
        digits: '5',
      });

      expect(ctx.tickSize).toBe(0.00001);
      expect(ctx.tickValue).toBe(1);
      expect(ctx.pipValue).toBe(10);
      expect(ctx.contractSize).toBe(100000);
      expect(ctx.minLot).toBe(0.10);
      expect(ctx.lotStep).toBe(0.10);
      expect(ctx.maxLot).toBe(3);
      expect(ctx.spreadPips).toBeCloseTo(1.2, 6);
      expect(ctx.pricePrecision).toBe(5);
    });
  });

  describe('net P&L = gross + costs', () => {
    test('subtracts commission/swap/fee from gross', () => {
      const net = valuation.calculateNetProfitLoss({
        grossProfitLoss: 100,
        commission: -3,
        swap: -1.5,
        fee: -0.5,
      });
      closeTo(net, 95);
    });

    test('defaults all costs to zero when omitted', () => {
      const net = valuation.calculateNetProfitLoss({ grossProfitLoss: 50 });
      closeTo(net, 50);
    });
  });
});
