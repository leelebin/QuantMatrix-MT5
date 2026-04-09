/**
 * Mean Reversion Strategy
 * For Forex Crosses: EURJPY, GBPJPY, EURGBP, AUDNZD
 *
 * Entry (BUY):
 *   1. Price touched or fell below lower Bollinger Band
 *   2. RSI < 30 (oversold)
 *   3. Current candle closes back inside the band (bounce confirmation)
 *
 * Entry (SELL):
 *   1. Price touched or rose above upper Bollinger Band
 *   2. RSI > 70 (overbought)
 *   3. Current candle closes back inside the band
 *
 * SL: Beyond the band + 0.5 × ATR
 * TP: Bollinger middle band (mean reversion target)
 */

const BaseStrategy = require('./BaseStrategy');

class MeanReversionStrategy extends BaseStrategy {
  constructor() {
    super('MeanReversion', 'Bollinger Band mean reversion for Forex crosses');
  }

  analyze(candles, indicators, instrument) {
    const { bollingerBands, rsi, atr } = indicators;

    if (!bollingerBands || !rsi || !atr || bollingerBands.length < 2) {
      return this.noSignal();
    }

    const currentCandle = this.latestCandle(candles);
    const prevCandle = this.prevCandle(candles);
    const currentBB = this.latest(bollingerBands);
    const prevBB = this.latest(bollingerBands, 1);
    const currentRsi = this.latest(rsi);
    const currentAtr = this.latest(atr);

    if (!currentBB || !prevBB || !currentRsi || !currentAtr) {
      return this.noSignal();
    }

    const snapshot = {
      bbUpper: currentBB.upper,
      bbMiddle: currentBB.middle,
      bbLower: currentBB.lower,
      rsi: currentRsi,
      atr: currentAtr,
      price: currentCandle.close,
    };

    // ─── BUY Signal (oversold bounce) ───
    const touchedLower = prevCandle.low <= prevBB.lower || prevCandle.close <= prevBB.lower;
    const closedInsideLower = currentCandle.close > currentBB.lower;
    const isOversold = currentRsi < 35;

    if (touchedLower && closedInsideLower && isOversold) {
      const sl = currentBB.lower - 0.5 * currentAtr;
      const tp = currentBB.middle;
      return {
        signal: 'BUY',
        confidence: this._calcConfidence(currentRsi, currentCandle, currentBB, 'BUY'),
        sl: parseFloat(sl.toFixed(instrument.pipSize < 0.001 ? 5 : 3)),
        tp: parseFloat(tp.toFixed(instrument.pipSize < 0.001 ? 5 : 3)),
        reason: `Price bounced from lower BB | RSI=${currentRsi.toFixed(1)} (oversold)`,
        indicatorsSnapshot: snapshot,
      };
    }

    // ─── SELL Signal (overbought reversal) ───
    const touchedUpper = prevCandle.high >= prevBB.upper || prevCandle.close >= prevBB.upper;
    const closedInsideUpper = currentCandle.close < currentBB.upper;
    const isOverbought = currentRsi > 65;

    if (touchedUpper && closedInsideUpper && isOverbought) {
      const sl = currentBB.upper + 0.5 * currentAtr;
      const tp = currentBB.middle;
      return {
        signal: 'SELL',
        confidence: this._calcConfidence(currentRsi, currentCandle, currentBB, 'SELL'),
        sl: parseFloat(sl.toFixed(instrument.pipSize < 0.001 ? 5 : 3)),
        tp: parseFloat(tp.toFixed(instrument.pipSize < 0.001 ? 5 : 3)),
        reason: `Price bounced from upper BB | RSI=${currentRsi.toFixed(1)} (overbought)`,
        indicatorsSnapshot: snapshot,
      };
    }

    return this.noSignal();
  }

  _calcConfidence(rsi, candle, bb, direction) {
    let confidence = 0.5;
    if (direction === 'BUY') {
      if (rsi < 20) confidence += 0.15;       // Deeply oversold
      const bandWidth = bb.upper - bb.lower;
      const distFromLower = candle.close - bb.lower;
      if (distFromLower / bandWidth < 0.15) confidence += 0.1; // Close to lower band
    } else {
      if (rsi > 80) confidence += 0.15;
      const bandWidth = bb.upper - bb.lower;
      const distFromUpper = bb.upper - candle.close;
      if (distFromUpper / bandWidth < 0.15) confidence += 0.1;
    }
    return Math.min(confidence, 0.95);
  }
}

module.exports = MeanReversionStrategy;
