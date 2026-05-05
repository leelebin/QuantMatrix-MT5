/**
 * Trend Following Strategy v2 — medium-frequency continuation.
 *
 * Profile: 8-15 trades/month/symbol; WR target 55-65%; RR 1:1.5.
 * Designed for $500 minLot-bound accounts where high-frequency stacking
 * is needed to compound past the per-trade dollar floor.
 *
 * Setup TF (H1):
 *   1. Trend bias: EMA50 vs EMA200 + price on trend side of EMA200.
 *   2. ATR floor: currentATR ≥ 0.5 × avgATR(20) (skip dead markets).
 *   3. Near EMA20: |close - EMA20| / ATR ≤ pullback_atr_max (pullback zone).
 *   4. Continuation trigger: close > prior `breakout_lookback`-bar high (BUY)
 *      or close < prior N-bar low (SELL).
 *   5. RSI confirmation: rsi_buy_min ≤ RSI ≤ 75 for BUY, mirrored SELL.
 *   6. Close on trend side of EMA20.
 *
 * Entry TF (M15):
 *   1. Price reclaims/loses EMA20 on the latest closed candle.
 *   2. RSI confirms the direction (>50 for BUY, <50 for SELL).
 *   3. Entry is rejected if price is too extended from EMA20.
 *
 * Exit framework:
 *   - SL = close ∓ slMultiplier × ATR.
 *   - TP = close ± tpMultiplier × ATR (asymmetric reward).
 *   - Breakeven trigger 1.0 × ATR; trailing starts 1.5 × ATR with 1.0 × ATR distance.
 *   - Adaptive evaluator tightens trail when trend breaks.
 */

const BaseStrategy = require('./BaseStrategy');

class TrendFollowingStrategy extends BaseStrategy {
  constructor() {
    super('TrendFollowing', 'Medium-frequency H1 trend continuation with EMA20 pullback + breakout trigger');
  }

  buildExitPlan() {
    return {
      breakeven: {
        enabled: true,
        triggerAtrMultiple: 1.0,
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
      adaptiveEvaluator: 'TrendFollowing',
    };
  }

  evaluateExit(position, context = {}) {
    const { indicators, candles } = context;
    if (!indicators || !candles) return null;

    const ema50 = this.latest(indicators.ema50);
    const currentAtr = this.latest(indicators.atr);
    const price = this.latestCandle(candles)?.close;
    const atrAtEntry = Number(position?.atrAtEntry);

    if (!ema50 || !currentAtr || !Number.isFinite(price) || !Number.isFinite(atrAtEntry) || atrAtEntry <= 0) {
      return null;
    }

    const direction = position?.type;
    const trendBroken = direction === 'BUY' ? price < ema50 : price > ema50;
    if (trendBroken) {
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

    return null;
  }

  analyze(candles, indicators, instrument, context = {}) {
    const params = this.getStrategyParameters(context);
    const setup = this._buildSetup(candles, indicators, instrument, params);
    if (!setup) {
      return this.noSignal({
        setupTimeframe: instrument.timeframe || '1h',
        entryTimeframe: instrument.entryTimeframe || null,
      });
    }

    const snapshot = {
      ema20: setup.currentEma20,
      ema50: setup.currentEma50,
      ema200: setup.currentEma200,
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

  _buildSetup(candles, indicators, instrument, params) {
    const { ema20, ema50, ema200, rsi, atr } = indicators;

    if (!ema20 || !ema50 || !rsi || !atr) return null;
    if (atr.length < 20) return null;

    const breakoutLookback = Math.max(2, Math.round(Number(params.breakout_lookback) || 3));
    if (candles.length < breakoutLookback + 1) return null;

    const pullbackAtrMax = Number(params.pullback_atr_max) || 1.0;
    const rsiBuyMin = Number(params.rsi_buy_min) || 52;
    const rsiSellMax = 100 - rsiBuyMin;
    const slMultiplier = Number(params.slMultiplier) || Number(instrument.riskParams?.slMultiplier) || 1.5;
    const tpMultiplier = Number(params.tpMultiplier) || Number(instrument.riskParams?.tpMultiplier) || 2.0;

    const currentCandle = this.latestCandle(candles);
    const currentPrice = currentCandle.close;
    const currentEma20 = this.latest(ema20);
    const currentEma50 = this.latest(ema50);
    const currentEma200 = this.latest(ema200);
    const currentRsi = this.latest(rsi);
    const currentAtr = this.latest(atr);
    const avgAtr = this.average(atr, 20);

    if ([currentEma20, currentEma50, currentRsi, currentAtr, avgAtr]
      .some((v) => v === null || v === undefined)) {
      return null;
    }

    if (currentAtr < avgAtr * 0.5) return null;

    let direction = null;
    if (currentEma200 !== null && currentEma200 !== undefined) {
      if (currentEma50 > currentEma200 && currentPrice > currentEma200) {
        direction = 'BUY';
      } else if (currentEma50 < currentEma200 && currentPrice < currentEma200) {
        direction = 'SELL';
      }
    } else if (currentPrice > currentEma50) {
      direction = 'BUY';
    } else if (currentPrice < currentEma50) {
      direction = 'SELL';
    }
    if (!direction) return null;

    const distanceAtr = Math.abs(currentPrice - currentEma20) / currentAtr;
    if (distanceAtr > pullbackAtrMax) return null;

    if (direction === 'BUY' && currentPrice <= currentEma20) return null;
    if (direction === 'SELL' && currentPrice >= currentEma20) return null;

    const prior = candles.slice(-breakoutLookback - 1, -1);
    if (prior.length < breakoutLookback) return null;
    const priorHigh = Math.max(...prior.map((c) => c.high));
    const priorLow = Math.min(...prior.map((c) => c.low));

    if (direction === 'BUY' && currentPrice <= priorHigh) return null;
    if (direction === 'SELL' && currentPrice >= priorLow) return null;

    if (direction === 'BUY' && (currentRsi < rsiBuyMin || currentRsi > 75)) return null;
    if (direction === 'SELL' && (currentRsi > rsiSellMax || currentRsi < 25)) return null;

    const sl = direction === 'BUY'
      ? currentPrice - slMultiplier * currentAtr
      : currentPrice + slMultiplier * currentAtr;
    const tp = direction === 'BUY'
      ? currentPrice + tpMultiplier * currentAtr
      : currentPrice - tpMultiplier * currentAtr;

    const reason = direction === 'BUY'
      ? `H1 BUY continuation: dist=${distanceAtr.toFixed(2)}ATR | RSI=${currentRsi.toFixed(1)} | brk>${breakoutLookback}-bar high`
      : `H1 SELL continuation: dist=${distanceAtr.toFixed(2)}ATR | RSI=${currentRsi.toFixed(1)} | brk<${breakoutLookback}-bar low`;

    return {
      direction,
      confidence: this._calcConfidence(currentRsi, currentAtr, avgAtr),
      sl,
      tp,
      currentPrice,
      currentEma20,
      currentEma50,
      currentEma200,
      currentRsi,
      currentAtr,
      setupCandleTime: currentCandle.time,
      reason,
    };
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
    const decimals = instrument.pipSize < 0.001 ? 5 : 3;
    return {
      signal: setup.direction,
      confidence: setup.confidence,
      sl: parseFloat(setup.sl.toFixed(decimals)),
      tp: parseFloat(setup.tp.toFixed(decimals)),
      reason: setup.reason,
      indicatorsSnapshot: snapshot,
      exitPlan: this.buildExitPlan(instrument, setup.direction, null),
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

  _calcConfidence(rsi, atr, avgAtr) {
    let confidence = 0.55;
    if (rsi >= 55 && rsi <= 68) confidence += 0.05;
    if (rsi >= 35 && rsi <= 45) confidence += 0.05;
    if (atr > avgAtr * 1.1) confidence += 0.05;
    if (atr > avgAtr * 1.4) confidence += 0.05;
    return Math.min(confidence, 0.85);
  }
}

module.exports = TrendFollowingStrategy;
