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

  buildExitPlan(/* instrument, signal, indicators, context */) {
    // Mean-reversion targets the BB middle band, usually < 1x ATR away. A
    // fixed trailing-stop makes no sense here — trailing is disabled by
    // default. BE is tight (0.5x ATR) to protect small profits, and a
    // 24-hour time stop forces the thesis to play out or be abandoned.
    // evaluateExit() below can flip trailing back on if volatility
    // regime-shifts mid-trade.
    return {
      breakeven: {
        enabled: true,
        triggerAtrMultiple: 0.5,
        includeSpreadCompensation: true,
        extraBufferPips: 0,
      },
      trailing: {
        enabled: false,
        startAtrMultiple: 1.5,
        distanceAtrMultiple: 1.0,
        mode: 'atr',
      },
      partials: [],
      timeExit: { maxHoldMinutes: 24 * 60, reason: 'MR_TIMEOUT' },
      adaptiveEvaluator: 'MeanReversion',
    };
  }

  /**
   * Adaptive exit for mean reversion. Returns a sparse override or null.
   *
   * Rules (evaluated in order, first-match wins):
   *   ① Volatility regime expansion (currentAtr >= 1.5 × atrAtEntry):
   *      the original reversion thesis is suspect — enable a wide trailing
   *      stop so we bank whatever profit exists if price keeps moving,
   *      and tighten BE to the current favourable price.
   *   ② RSI has normalised past neutral (crossed 50 against us from the
   *      extreme) but price hasn't reached the BB middle yet: the reversion
   *      has stalled — collapse TP to the current BB middle (handled in
   *      trailingStopService via planUsed.timeExit.reason='MR_STALLED')
   *      and shrink BE trigger.
   *   ③ Otherwise: no override.
   */
  evaluateExit(position, context = {}) {
    const { indicators, candles, instrument } = context;
    if (!indicators || !candles || !instrument) return null;

    const currentAtr = this.latest(indicators.atr);
    const currentRsi = this.latest(indicators.rsi);
    const currentBB = this.latest(indicators.bollingerBands);
    const atrAtEntry = Number(position?.atrAtEntry);

    if (!currentAtr || !currentRsi || !currentBB || !Number.isFinite(atrAtEntry) || atrAtEntry <= 0) {
      return null;
    }

    // ① Volatility expansion — regime shift, enable trailing
    if (currentAtr >= atrAtEntry * 1.5) {
      return {
        breakeven: { triggerAtrMultiple: 0.3 },
        trailing: {
          enabled: true,
          startAtrMultiple: 0.8,
          distanceAtrMultiple: 0.8,
          mode: 'atr',
        },
      };
    }

    // ② RSI reverted past neutral — reversion momentum exhausted
    const direction = position?.type;
    const rsiExhaustedBuy = direction === 'BUY' && currentRsi >= 55;
    const rsiExhaustedSell = direction === 'SELL' && currentRsi <= 45;
    if (rsiExhaustedBuy || rsiExhaustedSell) {
      return {
        breakeven: { triggerAtrMultiple: 0.3 },
        trailing: {
          enabled: true,
          startAtrMultiple: 0.5,
          distanceAtrMultiple: 0.6,
          mode: 'atr',
        },
        // Shorten the timeout once the thesis weakens
        timeExit: { maxHoldMinutes: 4 * 60, reason: 'MR_RSI_EXHAUSTED' },
      };
    }

    return null;
  }

  analyze(candles, indicators, instrument, context = {}) {
    const { bollingerBands, rsi, atr } = indicators;
    const strategyParams = this.getStrategyParameters(context);

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
    const oversoldThreshold = Number(strategyParams.rsi_oversold) || 35;
    const isOversold = currentRsi < oversoldThreshold;

    if (touchedLower && closedInsideLower && isOversold) {
      const sl = currentBB.lower - 0.5 * currentAtr;
      const tp = currentBB.middle;
      return {
        signal: 'BUY',
        confidence: this._calcConfidence(currentRsi, currentCandle, currentBB, 'BUY'),
        sl: parseFloat(sl.toFixed(instrument.pipSize < 0.001 ? 5 : 3)),
        tp: parseFloat(tp.toFixed(instrument.pipSize < 0.001 ? 5 : 3)),
        reason: `Price bounced from lower BB | RSI=${currentRsi.toFixed(1)} < ${oversoldThreshold}`,
        indicatorsSnapshot: snapshot,
        exitPlan: this.buildExitPlan(instrument, 'BUY', indicators),
      };
    }

    // ─── SELL Signal (overbought reversal) ───
    const touchedUpper = prevCandle.high >= prevBB.upper || prevCandle.close >= prevBB.upper;
    const closedInsideUpper = currentCandle.close < currentBB.upper;
    const overboughtThreshold = Number(strategyParams.rsi_overbought) || 65;
    const isOverbought = currentRsi > overboughtThreshold;

    if (touchedUpper && closedInsideUpper && isOverbought) {
      const sl = currentBB.upper + 0.5 * currentAtr;
      const tp = currentBB.middle;
      return {
        signal: 'SELL',
        confidence: this._calcConfidence(currentRsi, currentCandle, currentBB, 'SELL'),
        sl: parseFloat(sl.toFixed(instrument.pipSize < 0.001 ? 5 : 3)),
        tp: parseFloat(tp.toFixed(instrument.pipSize < 0.001 ? 5 : 3)),
        reason: `Price bounced from upper BB | RSI=${currentRsi.toFixed(1)} > ${overboughtThreshold}`,
        indicatorsSnapshot: snapshot,
        exitPlan: this.buildExitPlan(instrument, 'SELL', indicators),
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
