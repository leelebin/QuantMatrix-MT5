/**
 * Trend Following Strategy
 * For Forex Majors: EURUSD, GBPUSD, USDJPY, AUDUSD, USDCHF, USDCAD, NZDUSD
 *
 * Entry (BUY):
 *   1. EMA20 crosses above EMA50 (trend confirmation)
 *   2. Price above EMA50 (trend direction)
 *   3. RSI between 30-65 (not overbought)
 *   4. ATR > 0.7x average ATR(20) (sufficient volatility)
 *
 * Entry (SELL): Mirror conditions
 * SL: 1.5 × ATR | TP: 3 × ATR (1:2 RR)
 */

const BaseStrategy = require('./BaseStrategy');
const indicatorService = require('../services/indicatorService');

class TrendFollowingStrategy extends BaseStrategy {
  constructor() {
    super('TrendFollowing', 'EMA crossover trend following for Forex majors');
  }

  analyze(candles, indicators, instrument) {
    const { ema20, ema50, rsi, atr } = indicators;

    if (!ema20 || !ema50 || !rsi || !atr || atr.length < 20) {
      return this.noSignal();
    }

    const currentPrice = this.latestCandle(candles).close;
    const currentEma20 = this.latest(ema20);
    const currentEma50 = this.latest(ema50);
    const prevEma20 = this.latest(ema20, 1);
    const prevEma50 = this.latest(ema50, 1);
    const currentRsi = this.latest(rsi);
    const currentAtr = this.latest(atr);
    const avgAtr = this.average(atr, 20);

    if (!currentEma20 || !currentEma50 || !currentRsi || !currentAtr || !avgAtr) {
      return this.noSignal();
    }

    const snapshot = {
      ema20: currentEma20,
      ema50: currentEma50,
      rsi: currentRsi,
      atr: currentAtr,
      price: currentPrice,
    };

    const { slMultiplier, tpMultiplier } = instrument.riskParams;
    const volatilityOk = currentAtr > avgAtr * 0.5;

    // Check for EMA crossover within recent 3 candles (not just current)
    let recentCrossUp = prevEma20 <= prevEma50 && currentEma20 > currentEma50;
    let recentCrossDown = prevEma20 >= prevEma50 && currentEma20 < currentEma50;
    if (!recentCrossUp && !recentCrossDown && ema20.length >= 4 && ema50.length >= 4) {
      for (let i = 2; i <= 3; i++) {
        const a20 = this.latest(ema20, i);
        const b20 = this.latest(ema20, i - 1);
        const a50 = this.latest(ema50, i);
        const b50 = this.latest(ema50, i - 1);
        if (a20 && b20 && a50 && b50) {
          if (a20 <= a50 && b20 > b50) recentCrossUp = true;
          if (a20 >= a50 && b20 < b50) recentCrossDown = true;
        }
      }
    }

    // ─── BUY Signal ───
    const priceAboveEma50 = currentPrice > currentEma50;
    const rsiNotOverbought = currentRsi > 25 && currentRsi < 72;

    if (recentCrossUp && priceAboveEma50 && rsiNotOverbought && volatilityOk) {
      const sl = currentPrice - slMultiplier * currentAtr;
      const tp = currentPrice + tpMultiplier * currentAtr;
      return {
        signal: 'BUY',
        confidence: this._calcConfidence(currentRsi, currentAtr, avgAtr, 'BUY'),
        sl: parseFloat(sl.toFixed(instrument.pipSize < 0.001 ? 5 : 3)),
        tp: parseFloat(tp.toFixed(instrument.pipSize < 0.001 ? 5 : 3)),
        reason: `EMA20 crossed above EMA50 | RSI=${currentRsi.toFixed(1)} | ATR=${currentAtr.toFixed(5)}`,
        indicatorsSnapshot: snapshot,
      };
    }

    // ─── SELL Signal ───
    const priceBelowEma50 = currentPrice < currentEma50;
    const rsiNotOversold = currentRsi < 75 && currentRsi > 28;

    if (recentCrossDown && priceBelowEma50 && rsiNotOversold && volatilityOk) {
      const sl = currentPrice + slMultiplier * currentAtr;
      const tp = currentPrice - tpMultiplier * currentAtr;
      return {
        signal: 'SELL',
        confidence: this._calcConfidence(currentRsi, currentAtr, avgAtr, 'SELL'),
        sl: parseFloat(sl.toFixed(instrument.pipSize < 0.001 ? 5 : 3)),
        tp: parseFloat(tp.toFixed(instrument.pipSize < 0.001 ? 5 : 3)),
        reason: `EMA20 crossed below EMA50 | RSI=${currentRsi.toFixed(1)} | ATR=${currentAtr.toFixed(5)}`,
        indicatorsSnapshot: snapshot,
      };
    }

    return this.noSignal();
  }

  _calcConfidence(rsi, atr, avgAtr, direction) {
    let confidence = 0.5;
    // RSI strength bonus
    if (direction === 'BUY' && rsi >= 40 && rsi <= 55) confidence += 0.15;
    if (direction === 'SELL' && rsi >= 45 && rsi <= 60) confidence += 0.15;
    // Volatility bonus
    if (atr > avgAtr * 1.2) confidence += 0.1;
    if (atr > avgAtr * 1.5) confidence += 0.1;
    return Math.min(confidence, 0.95);
  }
}

module.exports = TrendFollowingStrategy;
