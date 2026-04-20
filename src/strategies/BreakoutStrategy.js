/**
 * Breakout Strategy
 * For Energy: XTIUSD, XBRUSD
 *
 * Entry logic:
 *   1. Price breaks above/below the recent 20-candle structure
 *   2. ATR expands with the move
 *   3. RSI confirms the direction
 *   4. Breakout candle body is meaningfully strong
 *
 * Quality filter:
 *   1. Break distance must clear the structure by enough ATR
 *   2. Body conviction must stay above the baseline
 *   3. Candle range must expand versus the recent average
 *   4. Short-term close slope must align with the break direction
 *
 * SL: 2 x ATR | TP: 5 x ATR (1:2.5 RR)
 */

const BaseStrategy = require('./BaseStrategy');

class BreakoutStrategy extends BaseStrategy {
  constructor() {
    super('Breakout', 'ATR channel breakout strategy for energy');
    this.marketQualityThreshold = 2;
    this.marketQualityMaxScore = 3;
  }

  buildExitPlan(/* instrument, signal, indicators, context */) {
    // Breakouts target 5x ATR TP — let winners run. Wider trail + partial TP1
    // at 1x ATR to bank some profit before the trail engages.
    return {
      breakeven: {
        enabled: true,
        triggerAtrMultiple: 1.0,
        includeSpreadCompensation: true,
        extraBufferPips: 0,
      },
      trailing: {
        enabled: true,
        startAtrMultiple: 2.5,
        distanceAtrMultiple: 1.5,
        mode: 'chandelier',
      },
      partials: [
        { atProfitAtr: 1.5, closeFraction: 0.4, label: 'breakout_tp1' },
      ],
      timeExit: null,
      adaptiveEvaluator: 'Breakout',
    };
  }

  /**
   * Adaptive exit for breakouts.
   *   ① ATR compression vs entry (<= 0.7x) — breakout is losing steam,
   *      tighten trailing to protect profit.
   *   ② Price snapped back through the structure level (tracked in
   *      position.structureAnchor) — force aggressive trail.
   */
  evaluateExit(position, context = {}) {
    const { indicators, candles } = context;
    if (!indicators || !candles) return null;
    const currentAtr = this.latest(indicators.atr);
    const atrAtEntry = Number(position?.atrAtEntry);
    const price = this.latestCandle(candles)?.close;
    if (!currentAtr || !Number.isFinite(atrAtEntry) || atrAtEntry <= 0 || !Number.isFinite(price)) {
      return null;
    }

    if (currentAtr <= atrAtEntry * 0.7) {
      return {
        trailing: {
          enabled: true,
          startAtrMultiple: 1.5,
          distanceAtrMultiple: 1.0,
          mode: 'atr',
        },
      };
    }

    const structureAnchor = Number(position?.structureAnchor);
    if (Number.isFinite(structureAnchor) && structureAnchor > 0) {
      const direction = position?.type;
      const snappedBack = direction === 'BUY'
        ? price < structureAnchor
        : price > structureAnchor;
      if (snappedBack) {
        return {
          breakeven: { triggerAtrMultiple: 0.5 },
          trailing: {
            enabled: true,
            startAtrMultiple: 0.8,
            distanceAtrMultiple: 0.6,
            mode: 'atr',
          },
        };
      }
    }

    return null;
  }

  analyze(candles, indicators, instrument, context = {}) {
    const { rsi, atr } = indicators;
    const strategyParams = this.getStrategyParameters(context);
    const lookbackPeriod = Math.max(5, Math.round(Number(strategyParams.lookback_period) || 20));
    const bodyMultiplier = Number(strategyParams.body_multiplier) || 1.2;

    if (!rsi || !atr || candles.length < (lookbackPeriod + 5) || atr.length < 20) {
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

    const lookbackCandles = candles.slice(-(lookbackPeriod + 1), -1);
    const highest = Math.max(...lookbackCandles.map((c) => c.high));
    const lowest = Math.min(...lookbackCandles.map((c) => c.low));
    const structureMidpoint = (highest + lowest) / 2;
    const lastFive = candles.slice(-6, -1);
    const avgBody = lastFive.reduce((sum, c) => sum + Math.abs(c.close - c.open), 0) / 5;
    const currentBody = Math.abs(currentCandle.close - currentCandle.open);
    const previousTenCandles = candles.slice(-11, -1);
    const avgRange10 = previousTenCandles
      .reduce((sum, candle) => sum + (candle.high - candle.low), 0) / 10;
    const currentRange = currentCandle.high - currentCandle.low;
    const shortTermSlope = previousTenCandles[previousTenCandles.length - 1].close - previousTenCandles[0].close;

    let direction = null;
    let breakDistance = 0;
    let structureLevel = null;

    if (currentCandle.high > highest && currentPrice > highest && currentRsi > 50 && currentAtr > avgAtr * 0.85) {
      direction = 'BUY';
      structureLevel = highest;
      breakDistance = currentPrice - highest;
    } else if (currentCandle.low < lowest && currentPrice < lowest && currentRsi < 50 && currentAtr > avgAtr * 0.85) {
      direction = 'SELL';
      structureLevel = lowest;
      breakDistance = lowest - currentPrice;
    } else {
      return this.noSignal();
    }

    const breakDistanceThreshold = currentAtr * 0.15;
    const slopeAligned = direction === 'BUY' ? shortTermSlope > 0 : shortTermSlope < 0;
    const quality = this._calculateMarketQuality({
      direction,
      breakDistance,
      breakDistanceThreshold,
      bodyMultiplier,
      currentBody,
      avgBody,
      currentRange,
      avgRange10,
    });

    const snapshot = {
      rsi: currentRsi,
      atr: currentAtr,
      avgAtr,
      highestLookback: highest,
      lowestLookback: lowest,
      lookbackPeriod,
      structureMidpoint: Number(structureMidpoint.toFixed(2)),
      structureLevel: Number(structureLevel.toFixed(2)),
      breakDistance: Number(breakDistance.toFixed(2)),
      breakDistanceThreshold: Number(breakDistanceThreshold.toFixed(2)),
      bodyMultiplier,
      currentBody,
      avgBody,
      currentRange: Number(currentRange.toFixed(2)),
      avgRange10: Number(avgRange10.toFixed(2)),
      price: currentPrice,
      shortTermSlope: Number(shortTermSlope.toFixed(2)),
      marketQualityScore: quality.score,
      marketQualityThreshold: this.marketQualityThreshold,
      marketQualityDetails: {
        ...quality.details,
        slopeAligned,
      },
    };

    if (!slopeAligned) {
      return this.noSignal({
        reason: 'Breakout filtered: short-term slope opposes breakout direction',
        filterReason: 'Breakout filtered: short-term slope opposes breakout direction',
        status: 'FILTERED',
        setupDirection: direction,
        marketQualityScore: quality.score,
        marketQualityThreshold: this.marketQualityThreshold,
        marketQualityDetails: {
          ...quality.details,
          slopeAligned,
        },
        indicatorsSnapshot: snapshot,
      });
    }

    if (breakDistance < breakDistanceThreshold) {
      return this.noSignal({
        reason: 'Breakout filtered: break distance below quality threshold',
        filterReason: 'Breakout filtered: break distance below quality threshold',
        status: 'FILTERED',
        setupDirection: direction,
        marketQualityScore: quality.score,
        marketQualityThreshold: this.marketQualityThreshold,
        marketQualityDetails: {
          ...quality.details,
          slopeAligned,
        },
        indicatorsSnapshot: snapshot,
      });
    }

    if (quality.score < this.marketQualityThreshold) {
      const filterReason = `Breakout filtered: ${quality.primaryFailure}`;
      return this.noSignal({
        reason: filterReason,
        filterReason,
        status: 'FILTERED',
        setupDirection: direction,
        marketQualityScore: quality.score,
        marketQualityThreshold: this.marketQualityThreshold,
        marketQualityDetails: {
          ...quality.details,
          slopeAligned,
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
      confidence: this._calcConfidence(currentAtr, avgAtr, currentBody, avgBody, currentRsi),
      sl: parseFloat(sl.toFixed(2)),
      tp: parseFloat(tp.toFixed(2)),
      reason: `${direction === 'BUY' ? 'BUY' : 'SELL'} breakout confirmed | quality ${quality.score}/${this.marketQualityMaxScore} | threshold ${this.marketQualityThreshold} | lookback ${lookbackPeriod} | body x${bodyMultiplier} | break ${breakDistance.toFixed(2)}`,
      filterReason: '',
      marketQualityScore: quality.score,
      marketQualityThreshold: this.marketQualityThreshold,
      marketQualityDetails: {
        ...quality.details,
        slopeAligned,
      },
      indicatorsSnapshot: snapshot,
      exitPlan: this.buildExitPlan(instrument, direction, indicators, {
        structureLevel,
      }),
    };
  }

  _calculateMarketQuality(metrics) {
    const {
      breakDistance,
      breakDistanceThreshold,
      bodyMultiplier,
      currentBody,
      avgBody,
      currentRange,
      avgRange10,
    } = metrics;

    const breakDistanceScore = breakDistance >= breakDistanceThreshold;
    const bodyConvictionScore = currentBody >= (avgBody * bodyMultiplier);
    const rangeExpansionScore = currentRange >= (avgRange10 * 1.05);
    const score = [breakDistanceScore, bodyConvictionScore, rangeExpansionScore].filter(Boolean).length;

    let primaryFailure = '';
    if (!breakDistanceScore) {
      primaryFailure = 'break distance below quality threshold';
    } else if (!bodyConvictionScore) {
      primaryFailure = 'weak breakout body conviction';
    } else if (!rangeExpansionScore) {
      primaryFailure = 'range expansion too weak';
    }

    return {
      score,
      primaryFailure,
      details: {
        breakDistanceScore: breakDistanceScore ? 1 : 0,
        bodyConvictionScore: bodyConvictionScore ? 1 : 0,
        rangeExpansionScore: rangeExpansionScore ? 1 : 0,
        breakDistance: Number(breakDistance.toFixed(2)),
        breakDistanceThreshold: Number(breakDistanceThreshold.toFixed(2)),
        bodyMultiplier: Number(bodyMultiplier.toFixed(2)),
        currentBody: Number(currentBody.toFixed(2)),
        avgBody: Number(avgBody.toFixed(2)),
        currentRange: Number(currentRange.toFixed(2)),
        avgRange10: Number(avgRange10.toFixed(2)),
      },
    };
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
