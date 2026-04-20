/**
 * VolumeFlowHybridStrategy
 *
 * A hybrid, volume / order-flow primary strategy with two internal
 * modules:
 *
 *   A) BREAKOUT_CONTINUATION — high relative-volume expansion aligned
 *      with structure breakout + directional pressure.
 *   B) EXHAUSTION_REVERSAL — extreme volume spike + failed expansion +
 *      VWAP/structure reclaim.
 *
 * Designed to be more active than the slower H1 strategies while still
 * rejecting obvious noise. Tuned first for metals (XAU/XAG) and oil
 * (XTI/XBR), but symbol-agnostic.
 *
 * Signal format aligns with the rest of the QuantMatrix engine:
 *   - `signal`: 'BUY' | 'SELL' | 'NONE'
 *   - `confidence`: 0..1
 *   - `sl` / `tp`: absolute price levels
 *   - `reason`: human-readable string
 *   - `indicatorsSnapshot`: structured bag consumed by the UI / logs
 *   - module-specific fields on `indicatorsSnapshot`:
 *       module, rvol, vwapDistance, cumulativeDelta, atrAtSignal
 *
 * This strategy is completely independent — existing strategies are
 * untouched. It's only registered alongside them via the existing
 * STRATEGY_TYPES registry.
 */

const BaseStrategy = require('./BaseStrategy');
const indicatorService = require('../services/indicatorService');
const volumeFeatures = require('../services/volumeFeatureService');

const MODULE_BREAKOUT = 'BREAKOUT_CONTINUATION';
const MODULE_REVERSAL = 'EXHAUSTION_REVERSAL';

class VolumeFlowHybridStrategy extends BaseStrategy {
  constructor() {
    super(
      'VolumeFlowHybrid',
      'Volume/order-flow hybrid: breakout continuation + exhaustion reversal (metals + oil)'
    );
  }

  buildExitPlan(instrument, signal, indicators, context = {}) {
    // Both modules target modest R multiples to match their short
    // intraday horizon. Partial at 1x ATR bank + modest trail for
    // winners. Context.module lets callers fine-tune later.
    const isReversal = context?.module === MODULE_REVERSAL;
    return {
      breakeven: {
        enabled: true,
        triggerAtrMultiple: isReversal ? 0.6 : 0.8,
        includeSpreadCompensation: true,
        extraBufferPips: 0,
      },
      trailing: {
        enabled: true,
        startAtrMultiple: isReversal ? 1.0 : 1.2,
        distanceAtrMultiple: isReversal ? 0.7 : 0.9,
        mode: 'atr',
      },
      partials: [
        { atProfitAtr: isReversal ? 0.7 : 0.9, closeFraction: 0.4, label: 'vfh_tp1' },
      ],
      timeExit: null,
      adaptiveEvaluator: 'VolumeFlowHybrid',
    };
  }

  analyze(setupCandles, setupIndicators, instrument, context = {}) {
    const params = this.getStrategyParameters(context);
    const volumeAvgPeriod = Math.max(5, Math.round(Number(params.volume_avg_period) || 20));
    const breakoutLookback = Math.max(4, Math.round(Number(params.breakout_lookback) || 12));
    const rvolContinuation = Number(params.rvol_continuation) || 1.8;
    const rvolReversal = Number(params.rvol_reversal) || 2.2;
    const bodyAtrThreshold = Number(params.body_atr_threshold) || 0.6;
    const wickRatioThreshold = Number(params.wick_ratio_threshold) || 1.8;
    const vwapTolAtr = Number(params.vwap_reclaim_tolerance_atr) || 0.35;
    const deltaSmoothing = Math.max(2, Math.round(Number(params.cumulative_delta_smoothing) || 8));
    const minConfidence = Number(params.min_confidence) || 0.55;
    const smallAccountProfile = Number(params.small_account_profile) === 1;
    const slAtr = Number(params.slMultiplier) || 1.2;
    const tpAtr = Number(params.tpMultiplier) || 2.0;
    const reversalSlAtr = Number(params.reversal_sl_atr) || 1.0;
    const reversalTpAtr = Number(params.reversal_tp_atr) || 1.5;

    const baseResponse = {
      setupTimeframe: instrument.timeframe || '5m',
      entryTimeframe: instrument.entryTimeframe || null,
    };

    if (!Array.isArray(setupCandles) || setupCandles.length < (volumeAvgPeriod + breakoutLookback + 5)) {
      return this.noSignal({ ...baseResponse, status: 'NO_SETUP', reason: 'Insufficient setup bars' });
    }

    const { atr, ema20, ema50 } = setupIndicators || {};
    const currentAtr = this.latest(atr);
    const latest = this.latestCandle(setupCandles);
    if (!currentAtr || !latest) {
      return this.noSignal({ ...baseResponse, status: 'NO_SETUP', reason: 'Missing ATR' });
    }

    const features = volumeFeatures.computeLatestFeatures(setupCandles, {
      volumeAvgPeriod,
      deltaSmoothing,
    });
    if (!features) {
      return this.noSignal({ ...baseResponse, status: 'NO_SETUP', reason: 'Volume features unavailable' });
    }

    const lookback = setupCandles.slice(-(breakoutLookback + 1), -1);
    const structureHigh = Math.max(...lookback.map((c) => c.high));
    const structureLow = Math.min(...lookback.map((c) => c.low));

    const fastEma = this.latest(ema20);
    const slowEma = this.latest(ema50);
    const fastTrendBullish = fastEma != null && slowEma != null && fastEma > slowEma;
    const fastTrendBearish = fastEma != null && slowEma != null && fastEma < slowEma;

    const sharedSnapshot = {
      module: null,
      rvol: features.rvol,
      volumeSpikeClass: features.volumeSpikeClass,
      avgVolume: features.averageVolume,
      barVolume: features.volume,
      cumulativeDelta: features.cumulativeDelta,
      cumulativeDeltaSmoothed: features.cumulativeDeltaSmoothed,
      cumulativeDeltaDelta: features.cumulativeDelta - features.cumulativeDeltaPrev,
      sessionVwap: features.sessionVwap,
      vwapDistance: features.vwapDistance,
      vwapDistanceAtr: currentAtr > 0 ? features.vwapDistance / currentAtr : 0,
      wickUpperRatio: features.wickUpperRatio,
      wickLowerRatio: features.wickLowerRatio,
      spreadEfficiency: features.spreadEfficiency,
      structureHigh,
      structureLow,
      fastEma,
      slowEma,
      fastTrendBullish,
      fastTrendBearish,
      atr: currentAtr,
      price: latest.close,
      setupTimeframe: instrument.timeframe || '5m',
      entryTimeframe: instrument.entryTimeframe || null,
      smallAccountProfile,
    };

    // Evaluate modules in priority order: EXHAUSTION_REVERSAL first when
    // an extreme spike + failed breakout is obvious, otherwise fall back
    // to BREAKOUT_CONTINUATION. This prevents spam from both modules
    // firing on the same candle.
    const reversal = this._evaluateReversal({
      candles: setupCandles,
      features,
      structureHigh,
      structureLow,
      currentAtr,
      rvolReversal,
      wickRatioThreshold,
      vwapTolAtr,
      sharedSnapshot,
      reversalSlAtr,
      reversalTpAtr,
      minConfidence,
      instrument,
    });
    if (reversal && reversal.signal !== 'NONE') {
      return this._confirmWithEntryTimeframe(reversal, context, instrument, MODULE_REVERSAL);
    }

    const breakout = this._evaluateBreakout({
      candles: setupCandles,
      features,
      structureHigh,
      structureLow,
      currentAtr,
      rvolContinuation,
      bodyAtrThreshold,
      vwapTolAtr,
      fastTrendBullish,
      fastTrendBearish,
      sharedSnapshot,
      slAtr,
      tpAtr,
      minConfidence,
      instrument,
    });
    if (breakout && breakout.signal !== 'NONE') {
      return this._confirmWithEntryTimeframe(breakout, context, instrument, MODULE_BREAKOUT);
    }

    const filterReason = (reversal && reversal.filterReason)
      || (breakout && breakout.filterReason)
      || '';

    return this.noSignal({
      ...baseResponse,
      indicatorsSnapshot: sharedSnapshot,
      status: filterReason ? 'FILTERED' : 'NO_SETUP',
      reason: filterReason,
      filterReason,
    });
  }

  _evaluateBreakout({
    candles,
    features,
    structureHigh,
    structureLow,
    currentAtr,
    rvolContinuation,
    bodyAtrThreshold,
    vwapTolAtr,
    fastTrendBullish,
    fastTrendBearish,
    sharedSnapshot,
    slAtr,
    tpAtr,
    minConfidence,
    instrument,
  }) {
    const latest = candles[candles.length - 1];
    const close = latest.close;
    const body = Math.abs(latest.close - latest.open);
    const bodyAtr = currentAtr > 0 ? body / currentAtr : 0;
    const rvol = features.rvol || 0;
    const deltaRising = features.cumulativeDelta >= features.cumulativeDeltaPrev;
    const vwapSupport = features.sessionVwap != null
      && close >= (features.sessionVwap - vwapTolAtr * currentAtr);
    const vwapResistance = features.sessionVwap != null
      && close <= (features.sessionVwap + vwapTolAtr * currentAtr);

    // Long breakout
    if (
      close > structureHigh
      && rvol >= rvolContinuation
      && bodyAtr >= bodyAtrThreshold
      && deltaRising
      && fastTrendBullish
      && vwapSupport
    ) {
      return this._finalizeSignal({
        direction: 'BUY',
        module: MODULE_BREAKOUT,
        latest,
        currentAtr,
        slAtr,
        tpAtr,
        minConfidence,
        rvol,
        extraConfidence: this._breakoutConfidence(rvol, bodyAtr, features),
        sharedSnapshot,
        instrument,
        reason: `BUY continuation: breakout of ${structureHigh.toFixed(2)} | RVOL ${rvol.toFixed(2)} | bodyATR ${bodyAtr.toFixed(2)} | delta rising`,
      });
    }

    // Short breakout
    if (
      close < structureLow
      && rvol >= rvolContinuation
      && bodyAtr >= bodyAtrThreshold
      && !deltaRising
      && fastTrendBearish
      && vwapResistance
    ) {
      return this._finalizeSignal({
        direction: 'SELL',
        module: MODULE_BREAKOUT,
        latest,
        currentAtr,
        slAtr,
        tpAtr,
        minConfidence,
        rvol,
        extraConfidence: this._breakoutConfidence(rvol, bodyAtr, features),
        sharedSnapshot,
        instrument,
        reason: `SELL continuation: breakdown of ${structureLow.toFixed(2)} | RVOL ${rvol.toFixed(2)} | bodyATR ${bodyAtr.toFixed(2)} | delta falling`,
      });
    }

    const filters = [];
    if (!(close > structureHigh) && !(close < structureLow)) filters.push('no structural break');
    if (rvol < rvolContinuation) filters.push(`RVOL ${rvol.toFixed(2)} < ${rvolContinuation}`);
    if (bodyAtr < bodyAtrThreshold) filters.push(`bodyATR ${bodyAtr.toFixed(2)} < ${bodyAtrThreshold}`);
    if (!fastTrendBullish && !fastTrendBearish) filters.push('EMA trend flat');
    if (!vwapSupport && !vwapResistance) filters.push('price too far from VWAP');

    return {
      signal: 'NONE',
      filterReason: filters.length ? `continuation filtered: ${filters.join(', ')}` : '',
    };
  }

  _evaluateReversal({
    candles,
    features,
    structureHigh,
    structureLow,
    currentAtr,
    rvolReversal,
    wickRatioThreshold,
    vwapTolAtr,
    sharedSnapshot,
    reversalSlAtr,
    reversalTpAtr,
    minConfidence,
    instrument,
  }) {
    const latest = candles[candles.length - 1];
    const rvol = features.rvol || 0;
    if (rvol < rvolReversal) {
      return {
        signal: 'NONE',
        filterReason: `reversal filtered: RVOL ${rvol.toFixed(2)} < ${rvolReversal}`,
      };
    }

    const close = latest.close;
    const vwap = features.sessionVwap;
    const vwapReclaimBuy = vwap != null && close >= vwap && close <= vwap + vwapTolAtr * currentAtr * 2.5;
    const vwapReclaimSell = vwap != null && close <= vwap && close >= vwap - vwapTolAtr * currentAtr * 2.5;

    // Long reversal: swept structure low, closed back above it, rejection wick down
    const sweptLow = latest.low < structureLow && close > structureLow;
    const rejectionFromLow = features.wickLowerRatio >= wickRatioThreshold;
    const deltaImproving = features.cumulativeDelta >= features.cumulativeDeltaPrev;
    if (sweptLow && rejectionFromLow && deltaImproving && (vwapReclaimBuy || close >= structureLow)) {
      return this._finalizeSignal({
        direction: 'BUY',
        module: MODULE_REVERSAL,
        latest,
        currentAtr,
        slAtr: reversalSlAtr,
        tpAtr: reversalTpAtr,
        minConfidence,
        rvol,
        extraConfidence: this._reversalConfidence(rvol, features.wickLowerRatio, features),
        sharedSnapshot,
        instrument,
        reason: `BUY reversal: sweep of ${structureLow.toFixed(2)} reclaimed | RVOL ${rvol.toFixed(2)} | wick ${features.wickLowerRatio.toFixed(2)} | delta improving`,
      });
    }

    const sweptHigh = latest.high > structureHigh && close < structureHigh;
    const rejectionFromHigh = features.wickUpperRatio >= wickRatioThreshold;
    const deltaWeakening = features.cumulativeDelta <= features.cumulativeDeltaPrev;
    if (sweptHigh && rejectionFromHigh && deltaWeakening && (vwapReclaimSell || close <= structureHigh)) {
      return this._finalizeSignal({
        direction: 'SELL',
        module: MODULE_REVERSAL,
        latest,
        currentAtr,
        slAtr: reversalSlAtr,
        tpAtr: reversalTpAtr,
        minConfidence,
        rvol,
        extraConfidence: this._reversalConfidence(rvol, features.wickUpperRatio, features),
        sharedSnapshot,
        instrument,
        reason: `SELL reversal: sweep of ${structureHigh.toFixed(2)} rejected | RVOL ${rvol.toFixed(2)} | wick ${features.wickUpperRatio.toFixed(2)} | delta weakening`,
      });
    }

    const filters = [];
    if (!sweptLow && !sweptHigh) filters.push('no structural sweep');
    if (!rejectionFromLow && !rejectionFromHigh) filters.push(`wick ratio below ${wickRatioThreshold}`);
    return {
      signal: 'NONE',
      filterReason: filters.length ? `reversal filtered: ${filters.join(', ')}` : '',
    };
  }

  _finalizeSignal({
    direction,
    module,
    latest,
    currentAtr,
    slAtr,
    tpAtr,
    minConfidence,
    rvol,
    extraConfidence,
    sharedSnapshot,
    instrument,
    reason,
  }) {
    const price = latest.close;
    const sl = direction === 'BUY'
      ? price - currentAtr * slAtr
      : price + currentAtr * slAtr;
    const tp = direction === 'BUY'
      ? price + currentAtr * tpAtr
      : price - currentAtr * tpAtr;

    const pipDecimals = instrument.pipSize && instrument.pipSize < 0.001 ? 5 : 3;
    const roundedSl = parseFloat(sl.toFixed(pipDecimals));
    const roundedTp = parseFloat(tp.toFixed(pipDecimals));

    const confidence = Math.min(0.95, Math.max(0, 0.45 + extraConfidence));
    const snapshot = {
      ...sharedSnapshot,
      module,
      signalDirection: direction,
      rvol,
      entryPrice: price,
      atrAtSignal: currentAtr,
      stopDistance: Math.abs(price - sl),
      rewardDistance: Math.abs(tp - price),
      slMultiple: slAtr,
      tpMultiple: tpAtr,
    };

    const baseSignal = {
      signal: confidence >= minConfidence ? direction : 'NONE',
      confidence,
      sl: roundedSl,
      tp: roundedTp,
      reason,
      filterReason: confidence >= minConfidence ? '' : `${module} suppressed: confidence ${confidence.toFixed(2)} < ${minConfidence}`,
      marketQualityScore: Math.round(confidence * 100),
      marketQualityThreshold: Math.round(minConfidence * 100),
      marketQualityDetails: {
        module,
        rvol: Number(rvol.toFixed(2)),
        vwapDistanceAtr: sharedSnapshot.vwapDistanceAtr,
      },
      indicatorsSnapshot: snapshot,
      setupTimeframe: sharedSnapshot.setupTimeframe,
      entryTimeframe: sharedSnapshot.entryTimeframe,
      triggerReason: '',
      setupActive: true,
      setupDirection: direction,
      status: confidence >= minConfidence ? 'TRIGGERED' : 'FILTERED',
      setupCandleTime: latest.time,
      exitPlan: this.buildExitPlan(instrument, direction, null, { module }),
    };

    return baseSignal;
  }

  /**
   * Optional M1 entry-timeframe confirmation. When entryCandles exist
   * (they do by default per strategyExecution config), we require the
   * most recent M1 bar to not contradict the signal. If no entry TF
   * data is available, we pass through the setup-TF signal unchanged.
   *
   * The confirmation is intentionally light: the strategy's alpha is
   * on the setup TF. M1 only prevents obviously-exhausted entries.
   */
  _confirmWithEntryTimeframe(signal, context, instrument, module) {
    if (!signal || signal.signal === 'NONE') return signal;
    const entryCandles = Array.isArray(context?.entryCandles) ? context.entryCandles : [];
    if (entryCandles.length < 5) {
      return {
        ...signal,
        triggerReason: 'Entry TF confirmation skipped (no data)',
        entryCandleTime: null,
      };
    }

    const entryLatest = entryCandles[entryCandles.length - 1];
    const entryPrev = entryCandles[entryCandles.length - 2];
    const entryDirection = signal.signal;

    const contradict = entryDirection === 'BUY'
      ? (entryLatest.close < entryPrev.close && entryLatest.close < entryLatest.open)
      : (entryLatest.close > entryPrev.close && entryLatest.close > entryLatest.open);

    if (contradict) {
      return {
        ...signal,
        signal: 'NONE',
        status: 'FILTERED',
        reason: signal.reason,
        filterReason: `${module} filtered on entry TF: contradicting 1m bar`,
        triggerReason: `Entry TF contradiction on ${entryLatest.time}`,
      };
    }

    return {
      ...signal,
      triggerReason: `Entry TF confirmed on ${entryLatest.time}`,
      entryCandleTime: entryLatest.time,
    };
  }

  _breakoutConfidence(rvol, bodyAtr, features) {
    let bump = 0;
    if (rvol >= 2.5) bump += 0.18;
    else if (rvol >= 2.0) bump += 0.12;
    else if (rvol >= 1.8) bump += 0.08;
    if (bodyAtr >= 1.0) bump += 0.12;
    else if (bodyAtr >= 0.75) bump += 0.08;
    if (features.spreadEfficiency >= 0.7) bump += 0.05;
    return Math.min(bump, 0.4);
  }

  _reversalConfidence(rvol, wickRatio, features) {
    let bump = 0;
    if (rvol >= 3.0) bump += 0.18;
    else if (rvol >= 2.5) bump += 0.12;
    else if (rvol >= 2.2) bump += 0.08;
    if (wickRatio >= 2.5) bump += 0.12;
    else if (wickRatio >= 2.0) bump += 0.08;
    if (features.spreadEfficiency <= 0.35) bump += 0.05;
    return Math.min(bump, 0.4);
  }
}

VolumeFlowHybridStrategy.MODULE_BREAKOUT = MODULE_BREAKOUT;
VolumeFlowHybridStrategy.MODULE_REVERSAL = MODULE_REVERSAL;

module.exports = VolumeFlowHybridStrategy;
