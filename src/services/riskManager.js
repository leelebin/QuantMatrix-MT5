/**
 * Risk Manager
 * Controls position sizing, validates trades against risk rules
 */

const { getInstrument, INSTRUMENT_CATEGORIES } = require('../config/instruments');
const { positionsDb, tradesDb } = require('../config/db');

class RiskManager {
  constructor() {
    this.dailyLossTracker = {};  // { 'YYYY-MM-DD': totalLoss }
    this.peakBalance = 0;
  }

  /**
   * Check all risk rules before placing a trade
   * @param {object} signal - { symbol, signal, sl, tp }
   * @param {object} accountInfo - { balance, equity }
   * @returns {{ allowed: boolean, reason: string, lotSize: number }}
   */
  async validateTrade(signal, accountInfo) {
    const instrument = getInstrument(signal.symbol);
    if (!instrument) {
      return { allowed: false, reason: `Unknown instrument: ${signal.symbol}`, lotSize: 0 };
    }

    const { balance, equity } = accountInfo;

    // Track peak balance for drawdown calculation
    if (balance > this.peakBalance) {
      this.peakBalance = balance;
    }

    // 1. Check if trading is enabled
    if (process.env.TRADING_ENABLED !== 'true') {
      return { allowed: false, reason: 'Trading is disabled (TRADING_ENABLED=false)', lotSize: 0 };
    }

    // 2. Check daily loss limit
    const maxDailyLoss = parseFloat(process.env.MAX_DAILY_LOSS || 0.05);
    const todayLoss = this._getTodayLoss();
    if (todayLoss >= balance * maxDailyLoss) {
      return { allowed: false, reason: `Daily loss limit reached: ${todayLoss.toFixed(2)} >= ${(balance * maxDailyLoss).toFixed(2)}`, lotSize: 0 };
    }

    // 3. Check max drawdown
    const maxDrawdown = parseFloat(process.env.MAX_DRAWDOWN || 0.10);
    const currentDrawdown = this.peakBalance > 0 ? (this.peakBalance - equity) / this.peakBalance : 0;
    if (currentDrawdown >= maxDrawdown) {
      return { allowed: false, reason: `Max drawdown reached: ${(currentDrawdown * 100).toFixed(1)}% >= ${(maxDrawdown * 100).toFixed(1)}%`, lotSize: 0 };
    }

    // 4. Check concurrent position limit
    const maxPositions = parseInt(process.env.MAX_CONCURRENT_POSITIONS || 5);
    const openPositions = await positionsDb.count({});
    if (openPositions >= maxPositions) {
      return { allowed: false, reason: `Max positions reached: ${openPositions} >= ${maxPositions}`, lotSize: 0 };
    }

    // 5. Check per-symbol position limit
    const maxPerSymbol = parseInt(process.env.MAX_POSITIONS_PER_SYMBOL || 2);
    const symbolPositions = await positionsDb.count({ symbol: signal.symbol });
    if (symbolPositions >= maxPerSymbol) {
      return { allowed: false, reason: `Max positions for ${signal.symbol} reached: ${symbolPositions} >= ${maxPerSymbol}`, lotSize: 0 };
    }

    // 6. Check category correlation limit (max 3 positions in same category)
    const categoryPositions = await this._getCategoryPositionCount(instrument.category);
    if (categoryPositions >= 3) {
      return { allowed: false, reason: `Max correlated positions for ${instrument.category}: ${categoryPositions} >= 3`, lotSize: 0 };
    }

    // 7. Calculate position size
    const lotSize = this.calculateLotSize(signal, instrument, balance);
    if (lotSize < instrument.minLot) {
      return { allowed: false, reason: `Calculated lot size ${lotSize} below minimum ${instrument.minLot}`, lotSize: 0 };
    }

    // 8. Validate SL/TP distance
    const entryPrice = signal.entryPrice || 0;
    if (entryPrice > 0 && signal.sl > 0) {
      const slDistance = Math.abs(entryPrice - signal.sl);
      const minSlDistance = instrument.spread * instrument.pipSize * 3; // At least 3x spread
      if (slDistance < minSlDistance) {
        return { allowed: false, reason: `SL too close: ${slDistance.toFixed(5)} < ${minSlDistance.toFixed(5)} (3x spread)`, lotSize: 0 };
      }
    }

    return { allowed: true, reason: 'All risk checks passed', lotSize };
  }

  /**
   * Calculate position size based on risk parameters
   * lotSize = (balance × riskPercent) / (slDistance / pipSize × pipValue)
   */
  calculateLotSize(signal, instrument, balance) {
    const riskPercent = instrument.riskParams.riskPercent;
    const riskAmount = balance * riskPercent;
    const currentPrice = signal.entryPrice || signal.tp; // approximate

    // Calculate SL distance in pips
    const slDistance = Math.abs(currentPrice - signal.sl);
    const slPips = slDistance / instrument.pipSize;

    if (slPips <= 0) return instrument.minLot;

    // Risk per pip per lot
    const riskPerPipPerLot = instrument.pipValue;

    // Lot size calculation
    let lotSize = riskAmount / (slPips * riskPerPipPerLot);

    // Round to lot step
    lotSize = Math.floor(lotSize / instrument.lotStep) * instrument.lotStep;

    // Clamp to min lot
    lotSize = Math.max(lotSize, instrument.minLot);

    // Max 5 lots as safety cap
    lotSize = Math.min(lotSize, 5.0);

    return parseFloat(lotSize.toFixed(2));
  }

  /**
   * Record a loss for daily tracking
   */
  recordLoss(amount) {
    const today = new Date().toISOString().split('T')[0];
    if (!this.dailyLossTracker[today]) {
      this.dailyLossTracker[today] = 0;
    }
    this.dailyLossTracker[today] += Math.abs(amount);
  }

  /**
   * Get today's total loss
   */
  _getTodayLoss() {
    const today = new Date().toISOString().split('T')[0];
    return this.dailyLossTracker[today] || 0;
  }

  /**
   * Count positions in the same instrument category
   */
  async _getCategoryPositionCount(category) {
    const allPositions = await positionsDb.find({});
    return allPositions.filter((p) => {
      const inst = getInstrument(p.symbol);
      return inst && inst.category === category;
    }).length;
  }

  /**
   * Get current risk status
   */
  async getRiskStatus(accountInfo) {
    const { balance, equity } = accountInfo;
    const maxDailyLoss = parseFloat(process.env.MAX_DAILY_LOSS || 0.05);
    const maxDrawdown = parseFloat(process.env.MAX_DRAWDOWN || 0.10);
    const todayLoss = this._getTodayLoss();
    const currentDrawdown = this.peakBalance > 0 ? (this.peakBalance - equity) / this.peakBalance : 0;
    const openPositions = await positionsDb.count({});

    return {
      balance,
      equity,
      peakBalance: this.peakBalance,
      todayLoss,
      dailyLossLimit: balance * maxDailyLoss,
      dailyLossPercent: balance > 0 ? (todayLoss / balance) * 100 : 0,
      currentDrawdown: currentDrawdown * 100,
      maxDrawdownLimit: maxDrawdown * 100,
      openPositions,
      maxPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || 5),
      tradingEnabled: process.env.TRADING_ENABLED === 'true',
      dailyLossReached: todayLoss >= balance * maxDailyLoss,
      drawdownReached: currentDrawdown >= maxDrawdown,
    };
  }
}

const riskManager = new RiskManager();

module.exports = riskManager;
