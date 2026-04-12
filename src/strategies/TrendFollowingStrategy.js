/**
 * Trend Following Strategy
 * For Forex Majors: EURUSD, GBPUSD, USDJPY, AUDUSD, USDCHF, USDCAD, NZDUSD
 *
 * Setup TF (H1):
 *   1. EMA20/EMA50 crossover happened within the last 3 closed candles
 *   2. Price remains on the correct side of EMA50
 *   3. RSI still supports the direction
 *   4. ATR remains above the minimum volatility threshold
 *
 * Entry TF (M15):
 *   1. Price reclaims/loses EMA20 on the latest closed candle
 *   2. RSI confirms the direction (>50 for BUY, <50 for SELL)
 *   3. Entry is rejected if price is too extended from EMA20
 *
 * SL/TP remain based on the H1 ATR framework.
 */

const BaseStrategy = require('./BaseStrategy');

class TrendFollowingStrategy extends BaseStrategy {
  constructor() {
    super('TrendFollowing', 'EMA crossover trend following for Forex majors');
  }

  analyze(candles, indicators, instrument, context = {}) {
    const setup = this._buildSetup(candles, indicators, instrument);
    if (!setup) {
      return this.noSignal({
        setupTimeframe: instrument.timeframe || '1h',
        entryTimeframe: instrument.entryTimeframe || null,
      });
    }

    const snapshot = {
      ema20: setup.currentEma20,
      ema50: setup.currentEma50,
      rsi: setup.currentRsi,
      atr: setup.currentAtr,
      price: setup.currentPrice,
    };

    if (!instrument.entryTimeframe) {
      return this._buildTriggeredSignal(setup, instrument, snapshot);
    }

    const trigger = this._buildEntryTrigger(
      context.entryCandles || [],
      context.entryIndicators || {},
      setup.direction
    );

    const baseResponse = {
      setupTimeframe: instrument.timeframe || '1h',
      entryTimeframe: instrument.entryTimeframe,
      setupActive: true,
      setupDirection: setup.direction,
      setupCandleTime: setup.setupCandleTime,
      reason: setup.reason,
      indicatorsSnapshot: {
        ...snapshot,
        entryTimeframe: instrument.entryTimeframe,
      },
    };

    if (!trigger.triggered) {
      return this.noSignal({
        ...baseResponse,
        status: 'SETUP_ACTIVE',
        triggerReason: trigger.reason,
      });
    }

    return this._buildTriggeredSignal(setup, instrument, {
      ...snapshot,
      entryEma20: trigger.currentEma20,
      entryRsi: trigger.currentRsi,
      entryAtr: trigger.currentAtr,
      entryPrice: trigger.currentPrice,
      entryTimeframe: instrument.entryTimeframe,
    }, {
      triggerReason: trigger.reason,
      entryCandleTime: trigger.entryCandleTime,
    });
  }

  _buildSetup(candles, indicators, instrument) {
    const { ema20, ema50, rsi, atr } = indicators;

    if (!ema20 || !ema50 || !rsi || !atr || atr.length < 20) {
      return null;
    }

    const currentPrice = this.latestCandle(candles).close;
    const currentEma20 = this.latest(ema20);
    const currentEma50 = this.latest(ema50);
    const currentRsi = this.latest(rsi);
    const currentAtr = this.latest(atr);
    const avgAtr = this.average(atr, 20);

    if ([currentEma20, currentEma50, currentRsi, currentAtr, avgAtr].some((value) => value === null || value === undefined)) {
      return null;
    }

    if (currentAtr <= avgAtr * 0.5) {
      return null;
    }

    const recentCross = this._findRecentCross(ema20, ema50);
    if (!recentCross) {
      return null;
    }

    if (recentCross.direction === 'BUY') {
      if (!(currentPrice > currentEma50 && currentRsi > 25 && currentRsi < 72)) {
        return null;
      }
    } else if (!(currentPrice < currentEma50 && currentRsi < 75 && currentRsi > 28)) {
      return null;
    }

    const sl = recentCross.direction === 'BUY'
      ? currentPrice - (instrument.riskParams.slMultiplier * currentAtr)
      : currentPrice + (instrument.riskParams.slMultiplier * currentAtr);
    const tp = recentCross.direction === 'BUY'
      ? currentPrice + (instrument.riskParams.tpMultiplier * currentAtr)
      : currentPrice - (instrument.riskParams.tpMultiplier * currentAtr);

    return {
      direction: recentCross.direction,
      confidence: this._calcConfidence(currentRsi, currentAtr, avgAtr, recentCross.direction),
      sl,
      tp,
      currentPrice,
      currentEma20,
      currentEma50,
      currentRsi,
      currentAtr,
      setupCandleTime: candles[candles.length - 1 - recentCross.offset]?.time || this.latestCandle(candles).time,
      reason: recentCross.direction === 'BUY'
        ? `1h BUY setup: EMA20 crossed above EMA50 | RSI=${currentRsi.toFixed(1)} | ATR=${currentAtr.toFixed(5)}`
        : `1h SELL setup: EMA20 crossed below EMA50 | RSI=${currentRsi.toFixed(1)} | ATR=${currentAtr.toFixed(5)}`,
    };
  }

  _findRecentCross(ema20, ema50, maxAge = 3) {
    const maxOffset = Math.min(maxAge - 1, ema20.length - 2, ema50.length - 2);
    for (let offset = 0; offset <= maxOffset; offset++) {
      const prev20 = this.latest(ema20, offset + 1);
      const curr20 = this.latest(ema20, offset);
      const prev50 = this.latest(ema50, offset + 1);
      const curr50 = this.latest(ema50, offset);
      if ([prev20, curr20, prev50, curr50].some((value) => value === null || value === undefined)) {
        continue;
      }

      if (prev20 <= prev50 && curr20 > curr50) {
        return { direction: 'BUY', offset };
      }
      if (prev20 >= prev50 && curr20 < curr50) {
        return { direction: 'SELL', offset };
      }
    }
    return null;
  }

  _buildEntryTrigger(entryCandles, entryIndicators, direction) {
    const { ema20, rsi, atr } = entryIndicators;

    if (!entryCandles || entryCandles.length < 2 || !ema20 || !rsi || !atr) {
      return { triggered: false, reason: 'Waiting for 15m data' };
    }

    const currentCandle = this.latestCandle(entryCandles);
    const prevCandle = this.prevCandle(entryCandles);
    const currentEma20 = this.latest(ema20);
    const prevEma20 = this.latest(ema20, 1);
    const currentRsi = this.latest(rsi);
    const currentAtr = this.latest(atr);

    if ([currentEma20, prevEma20, currentRsi, currentAtr].some((value) => value === null || value === undefined)) {
      return { triggered: false, reason: 'Waiting for 15m indicators' };
    }

    const currentPrice = currentCandle.close;
    const extension = Math.abs(currentPrice - currentEma20);
    const extensionLimit = currentAtr * 0.5;

    if (direction === 'BUY') {
      const reclaimedEma = prevCandle.close <= prevEma20 && currentPrice > currentEma20;
      if (!reclaimedEma) {
        return { triggered: false, reason: '15m BUY trigger waiting for price to reclaim EMA20' };
      }
      if (currentRsi <= 50) {
        return { triggered: false, reason: '15m BUY trigger waiting for RSI > 50' };
      }
      if (extension > extensionLimit) {
        return { triggered: false, reason: '15m BUY trigger blocked: price too extended above EMA20' };
      }
      return {
        triggered: true,
        reason: '15m BUY trigger: price reclaimed EMA20 with RSI confirmation',
        currentEma20,
        currentRsi,
        currentAtr,
        currentPrice,
        entryCandleTime: currentCandle.time,
      };
    }

    const lostEma = prevCandle.close >= prevEma20 && currentPrice < currentEma20;
    if (!lostEma) {
      return { triggered: false, reason: '15m SELL trigger waiting for price to lose EMA20' };
    }
    if (currentRsi >= 50) {
      return { triggered: false, reason: '15m SELL trigger waiting for RSI < 50' };
    }
    if (extension > extensionLimit) {
      return { triggered: false, reason: '15m SELL trigger blocked: price too extended below EMA20' };
    }
    return {
      triggered: true,
      reason: '15m SELL trigger: price fell back below EMA20 with RSI confirmation',
      currentEma20,
      currentRsi,
      currentAtr,
      currentPrice,
      entryCandleTime: currentCandle.time,
    };
  }

  _buildTriggeredSignal(setup, instrument, snapshot, extra = {}) {
    return {
      signal: setup.direction,
      confidence: setup.confidence,
      sl: parseFloat(setup.sl.toFixed(instrument.pipSize < 0.001 ? 5 : 3)),
      tp: parseFloat(setup.tp.toFixed(instrument.pipSize < 0.001 ? 5 : 3)),
      reason: setup.reason,
      indicatorsSnapshot: snapshot,
      setupTimeframe: instrument.timeframe || '1h',
      entryTimeframe: instrument.entryTimeframe || null,
      triggerReason: extra.triggerReason || '',
      setupActive: true,
      setupDirection: setup.direction,
      status: 'TRIGGERED',
      setupCandleTime: setup.setupCandleTime,
      entryCandleTime: extra.entryCandleTime || null,
    };
  }

  _calcConfidence(rsi, atr, avgAtr, direction) {
    let confidence = 0.5;
    if (direction === 'BUY' && rsi >= 40 && rsi <= 55) confidence += 0.15;
    if (direction === 'SELL' && rsi >= 45 && rsi <= 60) confidence += 0.15;
    if (atr > avgAtr * 1.2) confidence += 0.1;
    if (atr > avgAtr * 1.5) confidence += 0.1;
    return Math.min(confidence, 0.95);
  }
}

module.exports = TrendFollowingStrategy;
