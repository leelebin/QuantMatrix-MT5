/**
 * Multi-Timeframe Strategy
 * For Metals: XAUUSD (Gold), XAGUSD (Silver)
 *
 * Higher TF (H4) confirms trend direction via 200 EMA:
 *   - Price above 200 EMA → only BUY
 *   - Price below 200 EMA → only SELL
 *
 * Entry TF (H1) signals:
 *   1. MACD histogram turns positive (BUY) / negative (SELL)
 *   2. Stochastic K crosses D from oversold <20 (BUY) / overbought >80 (SELL)
 *   3. Both signals confirm same direction
 *
 * Gold SL: 2 × ATR | TP: 5 × ATR (1:2.5 RR)
 * Silver SL: 2.5 × ATR | TP: 5 × ATR (1:2 RR)
 */

const BaseStrategy = require('./BaseStrategy');

class MultiTimeframeStrategy extends BaseStrategy {
  constructor() {
    super('MultiTimeframe', 'Multi-timeframe MACD + Stochastic for metals');
    this.higherTfTrend = null; // Set externally by engine
  }

  /**
   * Set higher timeframe trend direction
   * @param {'BULLISH'|'BEARISH'|'NEUTRAL'} trend
   * @param {object} data - { ema200, price }
   */
  setHigherTimeframeTrend(trend, data) {
    this.higherTfTrend = { trend, ...data };
  }

  analyze(candles, indicators, instrument) {
    const { ema200, macd, stochastic, atr } = indicators;

    if (!macd || !stochastic || !atr || macd.length < 2 || stochastic.length < 2) {
      return this.noSignal();
    }

    const currentPrice = this.latestCandle(candles).close;
    const currentMacd = this.latest(macd);
    const prevMacd = this.latest(macd, 1);
    const currentStoch = this.latest(stochastic);
    const prevStoch = this.latest(stochastic, 1);
    const currentAtr = this.latest(atr);
    const currentEma200 = this.latest(ema200);

    if (!currentMacd || !prevMacd || !currentStoch || !prevStoch || !currentAtr) {
      return this.noSignal();
    }

    // Determine trend from higher TF or from EMA200
    let trendDirection = 'NEUTRAL';
    if (this.higherTfTrend) {
      trendDirection = this.higherTfTrend.trend;
    } else if (currentEma200) {
      trendDirection = currentPrice > currentEma200 ? 'BULLISH' : 'BEARISH';
    }

    const snapshot = {
      ema200: currentEma200,
      macdLine: currentMacd.MACD,
      macdSignal: currentMacd.signal,
      macdHistogram: currentMacd.histogram,
      stochK: currentStoch.k,
      stochD: currentStoch.d,
      atr: currentAtr,
      price: currentPrice,
      higherTfTrend: trendDirection,
    };

    const { slMultiplier, tpMultiplier } = instrument.riskParams;

    // ─── BUY Signal ───
    if (trendDirection === 'BULLISH') {
      const macdTurnedPositive = prevMacd.histogram <= 0 && currentMacd.histogram > 0;
      const stochBuySignal = prevStoch.k <= prevStoch.d && currentStoch.k > currentStoch.d && currentStoch.k < 50;

      if (macdTurnedPositive && stochBuySignal) {
        const sl = currentPrice - slMultiplier * currentAtr;
        const tp = currentPrice + tpMultiplier * currentAtr;
        return {
          signal: 'BUY',
          confidence: this._calcConfidence(currentStoch, currentMacd, trendDirection),
          sl: parseFloat(sl.toFixed(instrument.pipSize < 0.001 ? 5 : 3)),
          tp: parseFloat(tp.toFixed(instrument.pipSize < 0.001 ? 5 : 3)),
          reason: `Bullish trend + MACD histogram turned positive + Stoch K crossed D from oversold (${currentStoch.k.toFixed(1)})`,
          indicatorsSnapshot: snapshot,
        };
      }
    }

    // ─── SELL Signal ───
    if (trendDirection === 'BEARISH') {
      const macdTurnedNegative = prevMacd.histogram >= 0 && currentMacd.histogram < 0;
      const stochSellSignal = prevStoch.k >= prevStoch.d && currentStoch.k < currentStoch.d && currentStoch.k > 50;

      if (macdTurnedNegative && stochSellSignal) {
        const sl = currentPrice + slMultiplier * currentAtr;
        const tp = currentPrice - tpMultiplier * currentAtr;
        return {
          signal: 'SELL',
          confidence: this._calcConfidence(currentStoch, currentMacd, trendDirection),
          sl: parseFloat(sl.toFixed(instrument.pipSize < 0.001 ? 5 : 3)),
          tp: parseFloat(tp.toFixed(instrument.pipSize < 0.001 ? 5 : 3)),
          reason: `Bearish trend + MACD histogram turned negative + Stoch K crossed D from overbought (${currentStoch.k.toFixed(1)})`,
          indicatorsSnapshot: snapshot,
        };
      }
    }

    return this.noSignal();
  }

  _calcConfidence(stoch, macd, trend) {
    let confidence = 0.5;
    if (trend !== 'NEUTRAL') confidence += 0.1;
    if (stoch.k < 20 || stoch.k > 80) confidence += 0.15;
    if (Math.abs(macd.histogram) > Math.abs(macd.signal) * 0.5) confidence += 0.1;
    return Math.min(confidence, 0.95);
  }
}

module.exports = MultiTimeframeStrategy;
