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
 * Entry TF: not used — H1 setup IS the trigger (each H1 close = decision).
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

    return this._buildTriggeredSignal(setup, instrument, snapshot);
  }

  _buildSetup(candles, indicators, instrument, params) {
    const { ema20, ema50, ema200, rsi, atr } = indicators;

    if (!ema20 || !ema50 || !ema200 || !rsi || !atr) return null;
    if (candles.length < 50) return null;
    if (atr.length < 20) return null;

    const breakoutLookback = Math.max(2, Math.round(Number(params.breakout_lookback) || 3));
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

    if ([currentEma20, currentEma50, currentEma200, currentRsi, currentAtr, avgAtr]
      .some((v) => v === null || v === undefined)) {
      return null;
    }

    if (currentAtr < avgAtr * 0.5) return null;

    let direction = null;
    if (currentEma50 > currentEma200 && currentPrice > currentEma200) {
      direction = 'BUY';
    } else if (currentEma50 < currentEma200 && currentPrice < currentEma200) {
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

  _buildTriggeredSignal(setup, instrument, snapshot) {
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
      triggerReason: '',
      setupActive: true,
      setupDirection: setup.direction,
      status: 'TRIGGERED',
      setupCandleTime: setup.setupCandleTime,
      entryCandleTime: null,
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
