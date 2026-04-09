/**
 * Breakout Strategy
 * For Energy: USOIL, UKOIL
 *
 * Entry (BUY):
 *   1. Price breaks above highest high of last 20 candles
 *   2. ATR > average ATR (volatility expansion confirms breakout)
 *   3. RSI > 50 (direction confirmation)
 *   4. Breakout candle body > 1.5× average body of last 5 candles
 *
 * Entry (SELL): Mirror conditions (breaks below lowest low)
 * SL: 2 × ATR | TP: 5 × ATR (1:2.5 RR)
 */

const BaseStrategy = require('./BaseStrategy');

class BreakoutStrategy extends BaseStrategy {
  constructor() {
    super('Breakout', 'ATR channel breakout strategy for energy');
  }

  analyze(candles, indicators, instrument) {
    const { rsi, atr } = indicators;

    if (!rsi || !atr || candles.length < 25 || atr.length < 20) {
      return this.noSignal();
    }

    const currentCandle = this.latestCandle(candles);
    const currentPrice = currentCandle.close;
    const currentRsi = this.latest(rsi);
    const currentAtr = this.latest(atr);
    const avgAtr = this.average(atr, 20);

    if (!currentRsi || !currentAtr || !avgAtr) {
      return this.noSignal();
    }

    // Calculate 20-period high/low (excluding current candle)
    const lookbackCandles = candles.slice(-21, -1);
    const highest = Math.max(...lookbackCandles.map((c) => c.high));
    const lowest = Math.min(...lookbackCandles.map((c) => c.low));

    // Average candle body of last 5 candles (excluding current)
    const lastFive = candles.slice(-6, -1);
    const avgBody = lastFive.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / 5;
    const currentBody = Math.abs(currentCandle.close - currentCandle.open);

    const snapshot = {
      rsi: currentRsi,
      atr: currentAtr,
      avgAtr,
      highest20: highest,
      lowest20: lowest,
      currentBody,
      avgBody,
      price: currentPrice,
    };

    const { slMultiplier, tpMultiplier } = instrument.riskParams;

    // ─── BUY Signal (upside breakout) ───
    const brokeAbove = currentCandle.high > highest && currentPrice > highest;
    const volatilityExpansion = currentAtr > avgAtr * 0.85;
    const rsiConfirmsBuy = currentRsi > 50;
    const strongBreakout = currentBody > avgBody * 1.2;

    if (brokeAbove && volatilityExpansion && rsiConfirmsBuy && strongBreakout) {
      const sl = currentPrice - slMultiplier * currentAtr;
      const tp = currentPrice + tpMultiplier * currentAtr;
      return {
        signal: 'BUY',
        confidence: this._calcConfidence(currentAtr, avgAtr, currentBody, avgBody, currentRsi),
        sl: parseFloat(sl.toFixed(2)),
        tp: parseFloat(tp.toFixed(2)),
        reason: `Broke above 20-period high ${highest.toFixed(2)} | ATR expansion (${(currentAtr / avgAtr).toFixed(2)}x) | Strong candle body`,
        indicatorsSnapshot: snapshot,
      };
    }

    // ─── SELL Signal (downside breakout) ───
    const brokeBelow = currentCandle.low < lowest && currentPrice < lowest;
    const rsiConfirmsSell = currentRsi < 50;

    const volatilityExpansionSell = currentAtr > avgAtr * 0.85;
    const strongBreakoutSell = currentBody > avgBody * 1.2;
    if (brokeBelow && volatilityExpansionSell && rsiConfirmsSell && strongBreakoutSell) {
      const sl = currentPrice + slMultiplier * currentAtr;
      const tp = currentPrice - tpMultiplier * currentAtr;
      return {
        signal: 'SELL',
        confidence: this._calcConfidence(currentAtr, avgAtr, currentBody, avgBody, currentRsi),
        sl: parseFloat(sl.toFixed(2)),
        tp: parseFloat(tp.toFixed(2)),
        reason: `Broke below 20-period low ${lowest.toFixed(2)} | ATR expansion (${(currentAtr / avgAtr).toFixed(2)}x) | Strong candle body`,
        indicatorsSnapshot: snapshot,
      };
    }

    return this.noSignal();
  }

  _calcConfidence(atr, avgAtr, body, avgBody, rsi) {
    let confidence = 0.5;
    if (atr > avgAtr * 1.5) confidence += 0.15;
    if (body > avgBody * 2) confidence += 0.1;
    if (rsi > 60 || rsi < 40) confidence += 0.1;
    return Math.min(confidence, 0.95);
  }
}

module.exports = BreakoutStrategy;
