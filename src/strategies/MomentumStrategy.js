/**
 * Momentum Strategy
 * For Indices: US30, US500, NAS100
 *
 * Entry (BUY):
 *   1. RSI between 50-70 (rising momentum, not overbought)
 *   2. MACD line above signal line AND histogram increasing
 *   3. Price above EMA50
 *   4. At least 2 of last 3 candles are bullish (momentum confirmation)
 *
 * Entry (SELL): Mirror conditions
 * SL: 1.5 × ATR | TP: 3 × ATR (1:2 RR)
 */

const BaseStrategy = require('./BaseStrategy');

class MomentumStrategy extends BaseStrategy {
  constructor() {
    super('Momentum', 'RSI + MACD momentum strategy for indices');
  }

  analyze(candles, indicators, instrument) {
    const { ema50, rsi, macd, atr } = indicators;

    if (!ema50 || !rsi || !macd || !atr || macd.length < 3) {
      return this.noSignal();
    }

    const currentPrice = this.latestCandle(candles).close;
    const currentEma50 = this.latest(ema50);
    const currentRsi = this.latest(rsi);
    const currentMacd = this.latest(macd);
    const prevMacd = this.latest(macd, 1);
    const prevPrevMacd = this.latest(macd, 2);
    const currentAtr = this.latest(atr);

    if (!currentEma50 || !currentRsi || !currentMacd || !prevMacd || !currentAtr) {
      return this.noSignal();
    }

    // Count bullish/bearish candles in last 3
    const lastThree = candles.slice(-4, -1); // 3 candles before the current one
    const bullishCount = lastThree.filter((c) => c.close > c.open).length;
    const bearishCount = lastThree.filter((c) => c.close < c.open).length;

    const snapshot = {
      ema50: currentEma50,
      rsi: currentRsi,
      macdLine: currentMacd.MACD,
      macdSignal: currentMacd.signal,
      macdHistogram: currentMacd.histogram,
      atr: currentAtr,
      price: currentPrice,
      bullishCandles: bullishCount,
    };

    const { slMultiplier, tpMultiplier } = instrument.riskParams;

    // ─── BUY Signal ───
    const rsiRisingMomentum = currentRsi > 45 && currentRsi < 75;
    const macdAboveSignal = currentMacd.MACD > currentMacd.signal;
    const histogramIncreasing = currentMacd.histogram > prevMacd.histogram;
    const priceAboveEma = currentPrice > currentEma50;
    const bullishMomentum = bullishCount >= 2;

    if (rsiRisingMomentum && macdAboveSignal && histogramIncreasing && priceAboveEma && bullishMomentum) {
      const sl = currentPrice - slMultiplier * currentAtr;
      const tp = currentPrice + tpMultiplier * currentAtr;
      return {
        signal: 'BUY',
        confidence: this._calcConfidence(currentRsi, currentMacd, prevMacd, bullishCount, 'BUY'),
        sl: parseFloat(sl.toFixed(2)),
        tp: parseFloat(tp.toFixed(2)),
        reason: `RSI=${currentRsi.toFixed(1)} rising momentum | MACD histogram increasing | ${bullishCount}/3 bullish candles`,
        indicatorsSnapshot: snapshot,
      };
    }

    // ─── SELL Signal ───
    const rsiFallingMomentum = currentRsi > 25 && currentRsi < 55;
    const macdBelowSignal = currentMacd.MACD < currentMacd.signal;
    const histogramDecreasing = currentMacd.histogram < prevMacd.histogram;
    const priceBelowEma = currentPrice < currentEma50;
    const bearishMomentum = bearishCount >= 2;

    if (rsiFallingMomentum && macdBelowSignal && histogramDecreasing && priceBelowEma && bearishMomentum) {
      const sl = currentPrice + slMultiplier * currentAtr;
      const tp = currentPrice - tpMultiplier * currentAtr;
      return {
        signal: 'SELL',
        confidence: this._calcConfidence(currentRsi, currentMacd, prevMacd, bearishCount, 'SELL'),
        sl: parseFloat(sl.toFixed(2)),
        tp: parseFloat(tp.toFixed(2)),
        reason: `RSI=${currentRsi.toFixed(1)} falling momentum | MACD histogram decreasing | ${bearishCount}/3 bearish candles`,
        indicatorsSnapshot: snapshot,
      };
    }

    return this.noSignal();
  }

  _calcConfidence(rsi, macd, prevMacd, candleCount, direction) {
    let confidence = 0.5;
    if (candleCount === 3) confidence += 0.1;
    const histAccel = Math.abs(macd.histogram) - Math.abs(prevMacd.histogram);
    if (histAccel > 0) confidence += 0.1;
    if (direction === 'BUY' && rsi > 55 && rsi < 65) confidence += 0.1;
    if (direction === 'SELL' && rsi > 35 && rsi < 45) confidence += 0.1;
    return Math.min(confidence, 0.95);
  }
}

module.exports = MomentumStrategy;
