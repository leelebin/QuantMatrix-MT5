/**
 * Momentum Strategy
 * For Indices: US30, SPX500, NAS100
 *
 * Entry logic:
 *   1. RSI stays in a directional momentum zone
 *   2. MACD remains aligned with the direction and keeps expanding
 *   3. Price trades on the correct side of EMA50
 *   4. At least 2 of the last 3 candles support the direction
 *
 * Quality filter:
 *   1. ATR regime must not be too compressed
 *   2. EMA50 slope must be strong enough
 *   3. Directional candle bodies must show conviction
 *   4. MACD histogram must persist in the same direction
 *
 * SL: 1.5 x ATR | TP: 3 x ATR (1:2 RR)
 */

const BaseStrategy = require('./BaseStrategy');

class MomentumStrategy extends BaseStrategy {
  constructor() {
    super('Momentum', 'RSI + MACD momentum strategy for indices');
    this.marketQualityThreshold = 2;
    this.marketQualityMaxScore = 3;
  }

  buildExitPlan(/* instrument, signal, indicators, context */) {
    return {
      breakeven: {
        enabled: true,
        triggerAtrMultiple: 0.8,
        includeSpreadCompensation: true,
        extraBufferPips: 0,
      },
      trailing: {
        enabled: true,
        startAtrMultiple: 1.5,
        distanceAtrMultiple: 1.0,
        mode: 'atr',
      },
      partials: [],
      timeExit: null,
      adaptiveEvaluator: 'Momentum',
    };
  }

  /**
   * Adaptive exit for momentum.
   *   ① MACD histogram flipped against the position — momentum is dying.
   *      Tighten BE and engage an aggressive trail so we exit gracefully.
   */
  evaluateExit(position, context = {}) {
    const { indicators } = context;
    if (!indicators) return null;

    const currentMacd = this.latest(indicators.macd);
    if (!currentMacd || typeof currentMacd.histogram !== 'number') return null;

    const direction = position?.type;
    const histAgainst = direction === 'BUY'
      ? currentMacd.histogram <= 0
      : currentMacd.histogram >= 0;
    if (histAgainst) {
      return {
        breakeven: { triggerAtrMultiple: 0.4 },
        trailing: {
          enabled: true,
          startAtrMultiple: 0.6,
          distanceAtrMultiple: 0.6,
          mode: 'atr',
        },
      };
    }

    return null;
  }

  analyze(candles, indicators, instrument) {
    const { ema50, rsi, macd, atr } = indicators;

    if (!ema50 || !rsi || !macd || !atr || macd.length < 3 || atr.length < 20 || candles.length < 12) {
      return this.noSignal();
    }

    const currentPrice = this.latestCandle(candles).close;
    const currentEma50 = this.latest(ema50);
    const ema50FiveAgo = this.latest(ema50, 4);
    const currentRsi = this.latest(rsi);
    const currentMacd = this.latest(macd);
    const prevMacd = this.latest(macd, 1);
    const prevPrevMacd = this.latest(macd, 2);
    const currentAtr = this.latest(atr);
    const avgAtr = this.average(atr, 20);

    if ([currentEma50, ema50FiveAgo, currentRsi, currentMacd, prevMacd, prevPrevMacd, currentAtr, avgAtr].some((value) => value === null || value === undefined)) {
      return this.noSignal();
    }

    const lastThree = candles.slice(-4, -1);
    const bullishCount = lastThree.filter((c) => c.close > c.open).length;
    const bearishCount = lastThree.filter((c) => c.close < c.open).length;
    const rsiRisingMomentum = currentRsi > 45 && currentRsi < 75;
    const macdAboveSignal = currentMacd.MACD > currentMacd.signal;
    const histogramIncreasing = currentMacd.histogram > prevMacd.histogram;
    const priceAboveEma = currentPrice > currentEma50;
    const bullishMomentum = bullishCount >= 2;
    const rsiFallingMomentum = currentRsi > 25 && currentRsi < 55;
    const macdBelowSignal = currentMacd.MACD < currentMacd.signal;
    const histogramDecreasing = currentMacd.histogram < prevMacd.histogram;
    const priceBelowEma = currentPrice < currentEma50;
    const bearishMomentum = bearishCount >= 2;

    let direction = null;
    if (rsiRisingMomentum && macdAboveSignal && histogramIncreasing && priceAboveEma && bullishMomentum) {
      direction = 'BUY';
    } else if (rsiFallingMomentum && macdBelowSignal && histogramDecreasing && priceBelowEma && bearishMomentum) {
      direction = 'SELL';
    } else {
      return this.noSignal();
    }

    const atrRegimeOk = currentAtr >= avgAtr * 0.75;
    const quality = this._calculateMarketQuality(candles, indicators, direction, {
      currentAtr,
      currentEma50,
      ema50FiveAgo,
      currentMacd,
      prevMacd,
      prevPrevMacd,
      bullishCount,
      bearishCount,
    });

    const snapshot = {
      ema50: currentEma50,
      rsi: currentRsi,
      macdLine: currentMacd.MACD,
      macdSignal: currentMacd.signal,
      macdHistogram: currentMacd.histogram,
      atr: currentAtr,
      avgAtr,
      price: currentPrice,
      bullishCandles: bullishCount,
      bearishCandles: bearishCount,
      marketQualityScore: quality.score,
      marketQualityThreshold: this.marketQualityThreshold,
      marketQualityDetails: {
        ...quality.details,
        atrRegimeOk,
      },
    };

    if (!atrRegimeOk) {
      return this.noSignal({
        reason: 'Momentum filtered: ATR regime below threshold',
        filterReason: 'Momentum filtered: ATR regime below threshold',
        status: 'FILTERED',
        setupDirection: direction,
        marketQualityScore: quality.score,
        marketQualityThreshold: this.marketQualityThreshold,
        marketQualityDetails: {
          ...quality.details,
          atrRegimeOk,
        },
        indicatorsSnapshot: snapshot,
      });
    }

    if (quality.score < this.marketQualityThreshold) {
      const filterReason = `Momentum filtered: ${quality.primaryFailure}`;
      return this.noSignal({
        reason: filterReason,
        filterReason,
        status: 'FILTERED',
        setupDirection: direction,
        marketQualityScore: quality.score,
        marketQualityThreshold: this.marketQualityThreshold,
        marketQualityDetails: {
          ...quality.details,
          atrRegimeOk,
        },
        indicatorsSnapshot: snapshot,
      });
    }

    const { slMultiplier, tpMultiplier } = instrument.riskParams;
    const sl = direction === 'BUY'
      ? currentPrice - slMultiplier * currentAtr
      : currentPrice + slMultiplier * currentAtr;
    const tp = direction === 'BUY'
      ? currentPrice + tpMultiplier * currentAtr
      : currentPrice - tpMultiplier * currentAtr;

    return {
      signal: direction,
      confidence: this._calcConfidence(currentRsi, currentMacd, prevMacd, direction === 'BUY' ? bullishCount : bearishCount, direction),
      sl: parseFloat(sl.toFixed(2)),
      tp: parseFloat(tp.toFixed(2)),
      reason: `${direction === 'BUY' ? 'BUY' : 'SELL'} momentum confirmed | quality ${quality.score}/${this.marketQualityMaxScore} | threshold ${this.marketQualityThreshold} | RSI=${currentRsi.toFixed(1)}`,
      filterReason: '',
      marketQualityScore: quality.score,
      marketQualityThreshold: this.marketQualityThreshold,
      marketQualityDetails: {
        ...quality.details,
        atrRegimeOk,
      },
      indicatorsSnapshot: snapshot,
      exitPlan: this.buildExitPlan(instrument, direction, indicators),
    };
  }

  _calculateMarketQuality(candles, indicators, direction, metrics) {
    const { ema50 } = indicators;
    const { currentAtr, currentEma50, ema50FiveAgo, currentMacd, prevMacd, prevPrevMacd } = metrics;
    const recentBodies = candles.slice(-4, -1).map((c) => ({
      direction: c.close > c.open ? 'BUY' : c.close < c.open ? 'SELL' : 'FLAT',
      body: Math.abs(c.close - c.open),
    }));
    const directionalBodies = recentBodies
      .filter((item) => item.direction === direction)
      .map((item) => item.body);
    const avgDirectionalBody = directionalBodies.length > 0
      ? directionalBodies.reduce((sum, value) => sum + value, 0) / directionalBodies.length
      : 0;
    const avgBody10 = candles
      .slice(-11, -1)
      .reduce((sum, candle) => sum + Math.abs(candle.close - candle.open), 0) / 10;

    const slopeDelta = currentEma50 - ema50FiveAgo;
    const slopeScore = direction === 'BUY'
      ? slopeDelta >= currentAtr * 0.35
      : slopeDelta <= -(currentAtr * 0.35);
    const bodyScore = avgDirectionalBody >= (avgBody10 * 0.9);
    const persistenceScore = direction === 'BUY'
      ? currentMacd.histogram > prevMacd.histogram && prevMacd.histogram > prevPrevMacd.histogram
      : currentMacd.histogram < prevMacd.histogram && prevMacd.histogram < prevPrevMacd.histogram;

    const score = [slopeScore, bodyScore, persistenceScore].filter(Boolean).length;
    let primaryFailure = '';
    if (!slopeScore) {
      primaryFailure = 'weak EMA50 slope';
    } else if (!bodyScore) {
      primaryFailure = 'weak directional candle bodies';
    } else if (!persistenceScore) {
      primaryFailure = 'weak MACD persistence';
    }

    return {
      score,
      primaryFailure,
      details: {
        ema50SlopeScore: slopeScore ? 1 : 0,
        directionalBodyScore: bodyScore ? 1 : 0,
        momentumPersistenceScore: persistenceScore ? 1 : 0,
        ema50SlopeDelta: Number(slopeDelta.toFixed(5)),
        ema50SlopeThreshold: Number((currentAtr * 0.35).toFixed(5)),
        avgDirectionalBody: Number(avgDirectionalBody.toFixed(5)),
        avgBody10: Number(avgBody10.toFixed(5)),
        currentEma50: Number(currentEma50.toFixed(5)),
      },
    };
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
