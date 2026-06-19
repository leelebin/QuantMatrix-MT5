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

const SYMBOL_PROFILES = Object.freeze({
  XAUUSD: {
    rvol_continuation: 1.8,
    rvol_reversal: 2.3,
    wick_ratio_threshold: 2.0,
    min_confidence: 0.58,
    riskPercent: 0.005,
  },
  XAGUSD: {
    rvol_continuation: 2.0,
    rvol_reversal: 2.5,
    wick_ratio_threshold: 2.3,
    min_confidence: 0.62,
    riskPercent: 0.0035,
  },
  XTIUSD: {
    rvol_continuation: 1.8,
    rvol_reversal: 2.6,
    wick_ratio_threshold: 2.2,
    min_confidence: 0.60,
    riskPercent: 0.004,
  },
  USOIL: {
    rvol_continuation: 1.8,
    rvol_reversal: 2.6,
    wick_ratio_threshold: 2.2,
    min_confidence: 0.60,
    riskPercent: 0.004,
  },
  XBRUSD: {
    rvol_continuation: 1.8,
    rvol_reversal: 2.6,
    wick_ratio_threshold: 2.2,
    min_confidence: 0.60,
    riskPercent: 0.004,
  },
  UKOIL: {
    rvol_continuation: 1.8,
    rvol_reversal: 2.6,
    wick_ratio_threshold: 2.2,
    min_confidence: 0.60,
    riskPercent: 0.004,
  },
  US30: {
    enabled: 0,
    min_confidence: 0.65,
    riskPercent: 0.0025,
  },
  NAS100: {
    enabled: 0,
    min_confidence: 0.65,
    riskPercent: 0.0025,
  },
  SPX500: {
    enabled: 0,
    min_confidence: 0.65,
    riskPercent: 0.0025,
  },
});

const COMMODITY_GROUPS = Object.freeze({
  metals: new Set(['XAUUSD', 'XAGUSD']),
  oil: new Set(['XTIUSD', 'USOIL', 'XBRUSD', 'UKOIL']),
  indices: new Set(['US30', 'NAS100', 'SPX500']),
});

const PROFILE_REPLACED_DEFAULTS = Object.freeze({
  rvol_continuation: 1.8,
  rvol_reversal: 2.2,
  wick_ratio_threshold: 1.8,
  min_confidence: 0.55,
  riskPercent: 0.0075,
});

function clamp(value, min = 0, max = 0.95) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

class VolumeFlowHybridStrategy extends BaseStrategy {
  constructor() {
    super(
      'VolumeFlowHybrid',
      'Volume/order-flow hybrid: breakout continuation + exhaustion reversal (metals + oil)'
    );
  }

  buildExitPlan(instrument, signal, indicators, context = {}) {
    const params = context?.params || {};
    const isReversal = context?.module === MODULE_REVERSAL;
    const beTrigger = this._numParam(
      params,
      isReversal ? 'reversal_breakeven_trigger_atr' : 'breakout_breakeven_trigger_atr',
      isReversal ? 0.8 : 0.9
    );
    const trailStart = this._numParam(
      params,
      isReversal ? 'reversal_trailing_start_atr' : 'breakout_trailing_start_atr',
      isReversal ? 1.2 : 1.3
    );
    const trailDistance = this._numParam(
      params,
      isReversal ? 'reversal_trailing_distance_atr' : 'breakout_trailing_distance_atr',
      isReversal ? 0.8 : 0.9
    );
    const partialPercent = this._numParam(
      params,
      isReversal ? 'reversal_partial_close_percent' : 'breakout_partial_close_percent',
      0.4
    );
    const partialTrigger = this._numParam(
      params,
      isReversal ? 'reversal_partial_close_trigger_atr' : 'breakout_partial_close_trigger_atr',
      isReversal ? 0.8 : 1.0
    );
    const useMaxHolding = this._boolParam(params, 'use_max_holding_time', true);
    const maxHoldMinutes = this._numParam(
      params,
      isReversal ? 'reversal_max_holding_minutes' : 'breakout_max_holding_minutes',
      isReversal ? 45 : 120
    );

    return {
      breakeven: {
        enabled: true,
        triggerAtrMultiple: beTrigger,
        includeSpreadCompensation: true,
        extraBufferPips: 0,
      },
      trailing: {
        enabled: true,
        startAtrMultiple: trailStart,
        distanceAtrMultiple: trailDistance,
        mode: 'atr',
      },
      partials: [
        { atProfitAtr: partialTrigger, closeFraction: partialPercent, label: 'vfh_tp1' },
      ],
      timeExit: useMaxHolding && maxHoldMinutes > 0
        ? {
            maxHoldMinutes,
            reason: isReversal ? 'VFH_REVERSAL_MAX_HOLD' : 'VFH_BREAKOUT_MAX_HOLD',
          }
        : null,
      adaptiveEvaluator: 'VolumeFlowHybrid',
      noProgressExitMinutes: isReversal
        ? this._numParam(params, 'reversal_no_progress_exit_minutes', 30)
        : null,
      minProgressAtr: isReversal
        ? this._numParam(params, 'reversal_min_progress_atr', 0.4)
        : null,
      invalidateIfCloseBackInsideStructure: !isReversal,
    };
  }

  analyze(setupCandles, setupIndicators, instrument, context = {}) {
    const rawParams = this.getStrategyParameters(context);
    const params = this._resolveSymbolProfileParams(rawParams, instrument);
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
    const deltaDivergenceLookback = Math.max(3, Math.round(Number(params.delta_divergence_lookback) || 8));

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

    if (Number(params.enabled) === 0) {
      return this.noSignal({
        ...baseResponse,
        status: 'FILTERED',
        reason: 'Symbol profile disabled for VolumeFlowHybrid',
        filterReason: 'Symbol profile disabled for VolumeFlowHybrid',
        indicatorsSnapshot: {
          module: null,
          symbol: instrument.symbol,
          profileEnabled: false,
          atr: currentAtr,
          price: latest.close,
        },
      });
    }

    const features = context?.volumeFeatureSnapshot || volumeFeatures.computeLatestFeatures(setupCandles, {
      volumeAvgPeriod,
      deltaSmoothing,
    });
    if (!features) {
      return this.noSignal({ ...baseResponse, status: 'NO_SETUP', reason: 'Volume features unavailable' });
    }

    const { structureHigh, structureLow } = this._computeStructureBounds(
      setupCandles,
      breakoutLookback
    );

    const fastEma = this.latest(ema20);
    const slowEma = this.latest(ema50);
    const fastTrendBullish = fastEma != null && slowEma != null && fastEma > slowEma;
    const fastTrendBearish = fastEma != null && slowEma != null && fastEma < slowEma;
    const previous = setupCandles[setupCandles.length - 2] || null;
    const bodyStats = this._computeBodyStats(latest, currentAtr, params);
    const deltaContext = this._buildDeltaContext(setupCandles, features, deltaDivergenceLookback);
    const htfRegime = this._buildHigherTimeframeRegime(context?.higherTfCandles, latest.time, params);
    const spreadInfo = this._resolveSpreadInfo(context, latest, instrument, currentAtr, params);
    const exposureInfo = this._resolveExposureInfo(context, instrument, null, params);
    const newsInfo = this._resolveNewsInfo(context, params);

    const sharedSnapshot = {
      module: null,
      symbol: instrument.symbol,
      profileEnabled: true,
      rvol: features.rvol,
      volumeSpikeClass: features.volumeSpikeClass,
      avgVolume: features.averageVolume,
      barVolume: features.volume,
      cumulativeDelta: features.cumulativeDelta,
      cumulativeDeltaSmoothed: features.cumulativeDeltaSmoothed,
      cumulativeDeltaDelta: deltaContext.cumulativeDeltaDelta,
      cumulativeDeltaSlope: deltaContext.cumulativeDeltaSlope,
      sessionVwap: features.sessionVwap,
      vwapDistance: features.vwapDistance,
      vwapDistanceAtr: currentAtr > 0 ? features.vwapDistance / currentAtr : 0,
      wickUpperRatio: bodyStats.upperWickRatio,
      wickLowerRatio: bodyStats.lowerWickRatio,
      bodyRaw: bodyStats.bodyRaw,
      bodySafe: bodyStats.bodySafe,
      bodyToRangeRatio: bodyStats.bodyToRangeRatio,
      tinyBody: bodyStats.isTinyBody,
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
      ...spreadInfo.snapshot,
      ...htfRegime,
      ...newsInfo.snapshot,
      exposureFilterAvailable: exposureInfo.exposureFilterAvailable,
      correlationGroup: exposureInfo.correlationGroup,
      sameGroupSameDirectionPositions: exposureInfo.sameGroupSameDirectionPositions,
    };

    if (spreadInfo.blocked) {
      return this.noSignal({
        ...baseResponse,
        status: 'FILTERED',
        reason: spreadInfo.reason,
        filterReason: spreadInfo.reason,
        indicatorsSnapshot: sharedSnapshot,
      });
    }

    if (newsInfo.blocked) {
      return this.noSignal({
        ...baseResponse,
        status: 'FILTERED',
        reason: newsInfo.reason,
        filterReason: newsInfo.reason,
        indicatorsSnapshot: sharedSnapshot,
      });
    }

    const evaluationPayload = {
      candles: setupCandles,
      features,
      previous,
      structureHigh,
      structureLow,
      currentAtr,
      rvolContinuation,
      rvolReversal,
      bodyAtrThreshold,
      wickRatioThreshold,
      vwapTolAtr,
      fastTrendBullish,
      fastTrendBearish,
      sharedSnapshot,
      slAtr,
      tpAtr,
      reversalSlAtr,
      reversalTpAtr,
      minConfidence,
      instrument,
      params,
      bodyStats,
      deltaContext,
      htfRegime,
      context,
    };

    const breakoutFirst = this._boolParam(params, 'use_higher_tf_regime', true)
      && this._boolParam(params, 'htf_strong_trend_breakout_first', true)
      && htfRegime.htfTrendStrength >= this._numParam(params, 'htf_trend_strength_threshold', 0.8);
    const moduleOrder = breakoutFirst ? [MODULE_BREAKOUT, MODULE_REVERSAL] : [MODULE_REVERSAL, MODULE_BREAKOUT];
    let reversal = null;
    let breakout = null;

    for (const moduleName of moduleOrder) {
      const sessionInfo = this._resolveSessionInfo(latest.time, params, moduleName);
      const moduleSnapshot = {
        ...sharedSnapshot,
        sessionName: sessionInfo.sessionName,
        sessionAllowed: sessionInfo.sessionAllowed,
        sessionFilterReason: sessionInfo.sessionFilterReason,
      };
      if (!this._isModuleEnabled(moduleName, params)) {
        const filtered = this._filteredModuleResult(
          moduleName,
          `${moduleName} module disabled`,
          moduleSnapshot
        );
        if (moduleName === MODULE_REVERSAL) reversal = filtered;
        else breakout = filtered;
        continue;
      }
      if (!sessionInfo.sessionAllowed) {
        const filtered = {
          signal: 'NONE',
          status: 'FILTERED',
          filterReason: sessionInfo.sessionFilterReason,
          indicatorsSnapshot: moduleSnapshot,
        };
        if (moduleName === MODULE_REVERSAL) reversal = filtered;
        else breakout = filtered;
        continue;
      }

      const result = moduleName === MODULE_REVERSAL
        ? this._evaluateReversal({ ...evaluationPayload, sharedSnapshot: moduleSnapshot })
        : this._evaluateBreakout({ ...evaluationPayload, sharedSnapshot: moduleSnapshot });
      if (moduleName === MODULE_REVERSAL) reversal = result;
      else breakout = result;
      if (result && result.signal !== 'NONE') {
        return this._confirmWithEntryTimeframe(result, context, instrument, moduleName);
      }
    }

    const filterReason = (reversal && reversal.filterReason)
      || (breakout && breakout.filterReason)
      || '';

    return this.noSignal({
      ...baseResponse,
      indicatorsSnapshot: (reversal && reversal.indicatorsSnapshot)
        || (breakout && breakout.indicatorsSnapshot)
        || sharedSnapshot,
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
    params,
    bodyStats,
    deltaContext,
    htfRegime,
    context,
  }) {
    const latest = candles[candles.length - 1];
    const close = latest.close;
    const body = Math.abs(latest.close - latest.open);
    const bodyAtr = currentAtr > 0 ? body / currentAtr : 0;
    const rvol = features.rvol || 0;
    const deltaRising = deltaContext.cumulativeDeltaDelta > 0 || deltaContext.cumulativeDeltaSlope > 0;
    const deltaFalling = deltaContext.cumulativeDeltaDelta < 0 || deltaContext.cumulativeDeltaSlope < 0;
    const requireDeltaSlope = this._boolParam(params, 'require_delta_slope_for_breakout', true);
    const vwapSupport = features.sessionVwap != null
      && close >= (features.sessionVwap - vwapTolAtr * currentAtr);
    const vwapResistance = features.sessionVwap != null
      && close <= (features.sessionVwap + vwapTolAtr * currentAtr);
    const bullishDeltaOk = requireDeltaSlope ? deltaContext.cumulativeDeltaSlope > 0 : deltaRising;
    const bearishDeltaOk = requireDeltaSlope ? deltaContext.cumulativeDeltaSlope < 0 : deltaFalling;

    // Long breakout
    if (
      close > structureHigh
      && rvol >= rvolContinuation
      && bodyAtr >= bodyAtrThreshold
      && bullishDeltaOk
      && fastTrendBullish
      && vwapSupport
    ) {
      const exposureInfo = this._resolveExposureInfo(context, instrument, 'BUY', params);
      if (exposureInfo.blocked) {
        return this._filteredModuleResult(MODULE_BREAKOUT, exposureInfo.reason, sharedSnapshot);
      }
      const confidenceModel = this._buildBreakoutConfidence({
        direction: 'BUY',
        rvol,
        bodyAtr,
        features,
        sharedSnapshot,
        htfRegime,
        params,
        bodyStats,
        structureBreakScore: 0.08,
        deltaOk: bullishDeltaOk,
        vwapAligned: vwapSupport,
      });
      return this._finalizeSignal({
        direction: 'BUY',
        module: MODULE_BREAKOUT,
        latest,
        currentAtr,
        slAtr,
        tpAtr,
        minConfidence,
        rvol,
        confidenceModel,
        sharedSnapshot,
        instrument,
        params,
        reason: `BUY continuation: breakout of ${structureHigh.toFixed(2)} | RVOL ${rvol.toFixed(2)} | bodyATR ${bodyAtr.toFixed(2)} | delta rising`,
      });
    }

    // Short breakout
    if (
      close < structureLow
      && rvol >= rvolContinuation
      && bodyAtr >= bodyAtrThreshold
      && bearishDeltaOk
      && fastTrendBearish
      && vwapResistance
    ) {
      const exposureInfo = this._resolveExposureInfo(context, instrument, 'SELL', params);
      if (exposureInfo.blocked) {
        return this._filteredModuleResult(MODULE_BREAKOUT, exposureInfo.reason, sharedSnapshot);
      }
      const confidenceModel = this._buildBreakoutConfidence({
        direction: 'SELL',
        rvol,
        bodyAtr,
        features,
        sharedSnapshot,
        htfRegime,
        params,
        bodyStats,
        structureBreakScore: 0.08,
        deltaOk: bearishDeltaOk,
        vwapAligned: vwapResistance,
      });
      return this._finalizeSignal({
        direction: 'SELL',
        module: MODULE_BREAKOUT,
        latest,
        currentAtr,
        slAtr,
        tpAtr,
        minConfidence,
        rvol,
        confidenceModel,
        sharedSnapshot,
        instrument,
        params,
        reason: `SELL continuation: breakdown of ${structureLow.toFixed(2)} | RVOL ${rvol.toFixed(2)} | bodyATR ${bodyAtr.toFixed(2)} | delta falling`,
      });
    }

    const filters = [];
    if (!(close > structureHigh) && !(close < structureLow)) filters.push('no structural break');
    if (rvol < rvolContinuation) filters.push(`RVOL ${rvol.toFixed(2)} < ${rvolContinuation}`);
    if (bodyAtr < bodyAtrThreshold) filters.push(`bodyATR ${bodyAtr.toFixed(2)} < ${bodyAtrThreshold}`);
    if (close > structureHigh && !bullishDeltaOk) filters.push('delta expansion missing for BUY breakout');
    if (close < structureLow && !bearishDeltaOk) filters.push('delta expansion missing for SELL breakout');
    if (!fastTrendBullish && !fastTrendBearish) filters.push('EMA trend flat');
    if (!vwapSupport && !vwapResistance) filters.push('price too far from VWAP');

    return {
      signal: 'NONE',
      status: filters.length ? 'FILTERED' : 'NO_SETUP',
      filterReason: filters.length ? `continuation filtered: ${filters.join(', ')}` : '',
      indicatorsSnapshot: { ...sharedSnapshot, module: MODULE_BREAKOUT },
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
    params,
    bodyStats,
    deltaContext,
    htfRegime,
    previous,
    context,
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
    const vwapDistanceAtr = vwap != null && currentAtr > 0
      ? Math.abs(close - vwap) / currentAtr
      : Infinity;
    const vwapReclaimBuy = vwap != null && (
      close >= vwap
      || vwapDistanceAtr <= vwapTolAtr
      || (previous && close > previous.high)
    );
    const vwapReclaimSell = vwap != null && (
      close <= vwap
      || vwapDistanceAtr <= vwapTolAtr
      || (previous && close < previous.low)
    );
    const dojiOverrideBuy = bodyStats.isTinyBody
      && rvol >= 3.0
      && vwapReclaimBuy
      && previous
      && close > previous.high;
    const dojiOverrideSell = bodyStats.isTinyBody
      && rvol >= 3.0
      && vwapReclaimSell
      && previous
      && close < previous.low;
    const requireDeltaDivergence = this._boolParam(params, 'require_delta_divergence_for_reversal', false);

    // Long reversal: swept structure low, closed back above it, rejection wick down
    const reclaimedStructure = latest.low < structureLow && close > structureLow;
    const rejectionFromLow = bodyStats.lowerWickRatio >= wickRatioThreshold;
    const deltaImproving = deltaContext.cumulativeDeltaDelta >= 0
      || deltaContext.cumulativeDeltaSlope > 0
      || deltaContext.buyDivergence;
    const buyDeltaOk = requireDeltaDivergence ? deltaContext.buyDivergence : deltaImproving;
    if (
      reclaimedStructure
      && rejectionFromLow
      && buyDeltaOk
      && vwapReclaimBuy
      && (!bodyStats.isTinyBody || dojiOverrideBuy)
    ) {
      const exposureInfo = this._resolveExposureInfo(context, instrument, 'BUY', params);
      if (exposureInfo.blocked) {
        return this._filteredModuleResult(MODULE_REVERSAL, exposureInfo.reason, sharedSnapshot);
      }
      const confidenceModel = this._buildReversalConfidence({
        direction: 'BUY',
        rvol,
        wickRatio: bodyStats.lowerWickRatio,
        features,
        sharedSnapshot,
        htfRegime,
        params,
        bodyStats,
        reclaimed: true,
        deltaOk: buyDeltaOk,
        vwapOk: vwapReclaimBuy,
      });
      return this._finalizeSignal({
        direction: 'BUY',
        module: MODULE_REVERSAL,
        latest,
        currentAtr,
        slAtr: reversalSlAtr,
        tpAtr: reversalTpAtr,
        minConfidence,
        rvol,
        confidenceModel,
        sharedSnapshot,
        instrument,
        params,
        reason: `BUY reversal: sweep of ${structureLow.toFixed(2)} reclaimed | RVOL ${rvol.toFixed(2)} | wick ${bodyStats.lowerWickRatio.toFixed(2)} | delta stabilizing`,
      });
    }

    const rejectedStructure = latest.high > structureHigh && close < structureHigh;
    const rejectionFromHigh = bodyStats.upperWickRatio >= wickRatioThreshold;
    const deltaWeakening = deltaContext.cumulativeDeltaDelta <= 0
      || deltaContext.cumulativeDeltaSlope < 0
      || deltaContext.sellDivergence;
    const sellDeltaOk = requireDeltaDivergence ? deltaContext.sellDivergence : deltaWeakening;
    if (
      rejectedStructure
      && rejectionFromHigh
      && sellDeltaOk
      && vwapReclaimSell
      && (!bodyStats.isTinyBody || dojiOverrideSell)
    ) {
      const exposureInfo = this._resolveExposureInfo(context, instrument, 'SELL', params);
      if (exposureInfo.blocked) {
        return this._filteredModuleResult(MODULE_REVERSAL, exposureInfo.reason, sharedSnapshot);
      }
      const confidenceModel = this._buildReversalConfidence({
        direction: 'SELL',
        rvol,
        wickRatio: bodyStats.upperWickRatio,
        features,
        sharedSnapshot,
        htfRegime,
        params,
        bodyStats,
        reclaimed: true,
        deltaOk: sellDeltaOk,
        vwapOk: vwapReclaimSell,
      });
      return this._finalizeSignal({
        direction: 'SELL',
        module: MODULE_REVERSAL,
        latest,
        currentAtr,
        slAtr: reversalSlAtr,
        tpAtr: reversalTpAtr,
        minConfidence,
        rvol,
        confidenceModel,
        sharedSnapshot,
        instrument,
        params,
        reason: `SELL reversal: sweep of ${structureHigh.toFixed(2)} rejected | RVOL ${rvol.toFixed(2)} | wick ${bodyStats.upperWickRatio.toFixed(2)} | delta stabilizing`,
      });
    }

    const filters = [];
    if (!reclaimedStructure && !rejectedStructure) filters.push('no structural sweep/reclaim');
    if (!rejectionFromLow && !rejectionFromHigh) filters.push(`wick ratio below ${wickRatioThreshold}`);
    if (bodyStats.isTinyBody && !dojiOverrideBuy && !dojiOverrideSell) filters.push('doji body below minimum ratio');
    if ((reclaimedStructure && !vwapReclaimBuy) || (rejectedStructure && !vwapReclaimSell)) filters.push('VWAP reclaim/reject missing');
    if ((reclaimedStructure && !buyDeltaOk) || (rejectedStructure && !sellDeltaOk)) filters.push('delta divergence/stabilization missing');
    return {
      signal: 'NONE',
      status: filters.length ? 'FILTERED' : 'NO_SETUP',
      filterReason: filters.length ? `reversal filtered: ${filters.join(', ')}` : '',
      indicatorsSnapshot: { ...sharedSnapshot, module: MODULE_REVERSAL },
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
    confidenceModel,
    sharedSnapshot,
    instrument,
    params,
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

    const confidence = clamp(confidenceModel?.confidence ?? 0);
    const stopDistance = Math.abs(price - sl);
    const rewardDistance = Math.abs(tp - price);
    const rawRR = stopDistance > 0 ? rewardDistance / stopDistance : 0;
    const partial = module === MODULE_REVERSAL
      ? this._numParam(params, 'reversal_partial_close_percent', 0.4)
      : this._numParam(params, 'breakout_partial_close_percent', 0.4);
    const partialTrigger = module === MODULE_REVERSAL
      ? this._numParam(params, 'reversal_partial_close_trigger_atr', 0.8)
      : this._numParam(params, 'breakout_partial_close_trigger_atr', 1.0);
    const effectiveRRWithPartial = stopDistance > 0
      ? ((partial * partialTrigger * currentAtr) + ((1 - partial) * rewardDistance)) / stopDistance
      : rawRR;
    const snapshot = {
      ...sharedSnapshot,
      module,
      signalDirection: direction,
      params,
      rvol,
      entryPrice: price,
      atrAtSignal: currentAtr,
      stopDistance,
      rewardDistance,
      slMultiple: slAtr,
      tpMultiple: tpAtr,
      confidenceBreakdown: confidenceModel?.breakdown || {},
      confidenceBeforePenalty: confidenceModel?.confidenceBeforePenalty ?? confidence,
      confidenceAfterPenalty: confidenceModel?.confidenceAfterPenalty ?? confidence,
      rawRR: parseFloat(rawRR.toFixed(4)),
      effectiveRRWithPartial: parseFloat(effectiveRRWithPartial.toFixed(4)),
    };
    const directionAllowed = this._isDirectionAllowed(direction, params);
    const confidencePassed = confidence >= minConfidence;
    const signalAllowed = directionAllowed && confidencePassed;
    const filterReason = !directionAllowed
      ? `${module} suppressed: ${direction} direction disabled`
      : (confidencePassed ? '' : `${module} suppressed: confidence ${confidence.toFixed(2)} < ${minConfidence}`);

    const baseSignal = {
      signal: signalAllowed ? direction : 'NONE',
      confidence,
      sl: roundedSl,
      tp: roundedTp,
      reason,
      filterReason,
      marketQualityScore: Math.round(confidence * 100),
      marketQualityThreshold: Math.round(minConfidence * 100),
      marketQualityDetails: {
        module,
        rvol: Number(rvol.toFixed(2)),
        vwapDistanceAtr: sharedSnapshot.vwapDistanceAtr,
        confidenceBreakdown: snapshot.confidenceBreakdown,
      },
      indicatorsSnapshot: snapshot,
      setupTimeframe: sharedSnapshot.setupTimeframe,
      entryTimeframe: sharedSnapshot.entryTimeframe,
      triggerReason: '',
      setupActive: true,
      setupDirection: direction,
      status: signalAllowed ? 'TRIGGERED' : 'FILTERED',
      setupCandleTime: latest.time,
      exitPlan: this.buildExitPlan(instrument, direction, null, { module, params }),
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
    const params = signal.indicatorsSnapshot?.params || this._resolveSymbolProfileParams(this.getStrategyParameters(context), instrument);
    if (!this._boolParam(params, 'use_entry_confirmation', true)) {
      return {
        ...signal,
        triggerReason: 'Entry TF confirmation disabled',
        entryCandleTime: null,
      };
    }
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
    const snapshot = signal.indicatorsSnapshot || {};
    const atr = Number(snapshot.atrAtSignal || snapshot.atr || 0);
    const structureHigh = Number(snapshot.structureHigh);
    const structureLow = Number(snapshot.structureLow);
    const entryRange = Math.max(1e-9, Number(entryLatest.high) - Number(entryLatest.low));
    const entryBody = Math.max(1e-9, Math.abs(Number(entryLatest.close) - Number(entryLatest.open)));
    const entryUpperWick = Math.max(0, Number(entryLatest.high) - Math.max(Number(entryLatest.close), Number(entryLatest.open)));
    const entryLowerWick = Math.max(0, Math.min(Number(entryLatest.close), Number(entryLatest.open)) - Number(entryLatest.low));
    const entryUpperWickRatio = entryUpperWick / entryBody;
    const entryLowerWickRatio = entryLowerWick / entryBody;

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

    if (this._boolParam(params, 'entry_confirm_require_structure_hold', true)) {
      const tolerance = 0.1 * atr;
      const structureFailed = entryDirection === 'BUY'
        ? (module === MODULE_BREAKOUT
            ? entryLatest.close < structureHigh - tolerance
            : entryLatest.close <= structureLow)
        : (module === MODULE_BREAKOUT
            ? entryLatest.close > structureLow + tolerance
            : entryLatest.close >= structureHigh);
      if (structureFailed) {
        return {
          ...signal,
          signal: 'NONE',
          status: 'FILTERED',
          reason: signal.reason,
          filterReason: `${module} filtered on entry TF: structure hold failed`,
          triggerReason: `Entry TF structure hold failed on ${entryLatest.time}`,
        };
      }
    }

    if (this._boolParam(params, 'entry_confirm_reject_strong_opposite_wick', true)) {
      const wickThreshold = this._numParam(params, 'entry_opposite_wick_ratio', 1.5);
      const oppositeWick = entryDirection === 'BUY'
        ? (entryUpperWickRatio >= wickThreshold && entryLatest.close < entryLatest.high - 0.4 * entryRange)
        : (entryLowerWickRatio >= wickThreshold && entryLatest.close > entryLatest.low + 0.4 * entryRange);
      if (oppositeWick) {
        return {
          ...signal,
          signal: 'NONE',
          status: 'FILTERED',
          reason: signal.reason,
          filterReason: `${module} filtered on entry TF: opposite wick rejection`,
          triggerReason: `Entry TF opposite wick rejection on ${entryLatest.time}`,
        };
      }
    }

    return {
      ...signal,
      triggerReason: `Entry TF confirmed on ${entryLatest.time}`,
      entryCandleTime: entryLatest.time,
    };
  }

  _numParam(params, key, fallback) {
    const value = Number(params?.[key]);
    return Number.isFinite(value) ? value : fallback;
  }

  _boolParam(params, key, fallback) {
    const value = params?.[key];
    if (value === undefined || value === null || value === '') return Boolean(fallback);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return Number(value) === 1;
  }

  _isModuleEnabled(moduleName, params) {
    if (moduleName === MODULE_BREAKOUT) {
      return this._boolParam(params, 'enable_breakout_module', true);
    }
    if (moduleName === MODULE_REVERSAL) {
      return this._boolParam(params, 'enable_reversal_module', true);
    }
    return true;
  }

  _isDirectionAllowed(direction, params) {
    if (direction === 'BUY') return this._boolParam(params, 'allow_buy', true);
    if (direction === 'SELL') return this._boolParam(params, 'allow_sell', true);
    return true;
  }

  _resolveSymbolProfileParams(rawParams = {}, instrument = {}) {
    const symbol = this._canonicalSymbol(instrument);
    const useProfile = rawParams.use_symbol_profile === undefined
      ? true
      : this._boolParam(rawParams, 'use_symbol_profile', true);
    const profile = useProfile ? (SYMBOL_PROFILES[symbol] || {}) : {};
    const merged = { ...rawParams };
    for (const [key, value] of Object.entries(profile)) {
      const current = rawParams[key];
      const registryDefault = PROFILE_REPLACED_DEFAULTS[key];
      const instrumentDefault = instrument?.riskParams ? instrument.riskParams[key] : undefined;
      const shouldApplyProfile = current === undefined
        || current === null
        || (registryDefault !== undefined && Number(current) === Number(registryDefault))
        || (instrumentDefault !== undefined && Number(current) === Number(instrumentDefault));
      if (shouldApplyProfile) {
        merged[key] = value;
      }
    }
    merged.use_symbol_profile = useProfile ? 1 : 0;
    return merged;
  }

  _canonicalSymbol(instrument = {}) {
    return String(instrument.symbol || instrument.name || '').toUpperCase();
  }

  _computeBodyStats(candle, atr, params) {
    const range = Math.max(1e-9, Number(candle.high) - Number(candle.low));
    const bodyRaw = Math.abs(Number(candle.close) - Number(candle.open));
    const bodySafe = Math.max(bodyRaw, atr * this._numParam(params, 'wick_body_floor_atr', 0.05), 1e-9);
    const upperWick = Math.max(0, Number(candle.high) - Math.max(Number(candle.close), Number(candle.open)));
    const lowerWick = Math.max(0, Math.min(Number(candle.close), Number(candle.open)) - Number(candle.low));
    const bodyToRangeRatio = bodyRaw / range;
    return {
      range,
      bodyRaw,
      bodySafe,
      upperWick,
      lowerWick,
      upperWickRatio: upperWick / bodySafe,
      lowerWickRatio: lowerWick / bodySafe,
      bodyToRangeRatio,
      isTinyBody: bodyToRangeRatio < this._numParam(params, 'min_body_to_range_ratio', 0.05),
    };
  }

  _buildDeltaContext(candles, features, lookback) {
    const cumulativeDelta = Number(features?.cumulativeDelta) || 0;
    const cumulativeDeltaPrev = Number(features?.cumulativeDeltaPrev) || 0;
    const cumulativeDeltaDelta = Number.isFinite(Number(features?.cumulativeDeltaDelta))
      ? Number(features.cumulativeDeltaDelta)
      : cumulativeDelta - cumulativeDeltaPrev;
    const cumulativeDeltaSlope = Number.isFinite(Number(features?.cumulativeDeltaSlope))
      ? Number(features.cumulativeDeltaSlope)
      : 0;
    const deltas = volumeFeatures.cumulativeDeltaSeries(candles.slice(-Math.max(2, lookback + 1)));
    const previousDeltas = deltas.slice(0, -1);
    const recentMin = previousDeltas.length ? Math.min(...previousDeltas) : cumulativeDelta;
    const recentMax = previousDeltas.length ? Math.max(...previousDeltas) : cumulativeDelta;
    return {
      cumulativeDelta,
      cumulativeDeltaPrev,
      cumulativeDeltaDelta,
      cumulativeDeltaSlope,
      buyDivergence: cumulativeDelta > recentMin,
      sellDivergence: cumulativeDelta < recentMax,
      recentDeltaMin: recentMin,
      recentDeltaMax: recentMax,
    };
  }

  _buildHigherTimeframeRegime(higherTfCandles, currentTime, params) {
    const base = {
      htfEmaFast: null,
      htfEmaSlow: null,
      htfTrendStrength: 0,
      htfBullish: false,
      htfBearish: false,
      htfRegime: 'UNKNOWN',
    };
    if (!this._boolParam(params, 'use_higher_tf_regime', true)) {
      return { ...base, htfRegime: 'DISABLED' };
    }
    if (!Array.isArray(higherTfCandles) || higherTfCandles.length < 60) {
      return base;
    }
    const currentMs = currentTime ? new Date(currentTime).getTime() : null;
    const candles = Number.isFinite(currentMs)
      ? higherTfCandles.filter((candle) => new Date(candle.time).getTime() <= currentMs)
      : higherTfCandles;
    if (candles.length < 60) return base;
    const closes = candles.map((candle) => Number(candle.close));
    const emaFastSeries = indicatorService.ema(closes, 20);
    const emaSlowSeries = indicatorService.ema(closes, 50);
    const atrSeries = indicatorService.atr(candles, 14);
    const htfEmaFast = this.latest(emaFastSeries);
    const htfEmaSlow = this.latest(emaSlowSeries);
    const htfAtr = this.latest(atrSeries);
    if (!Number.isFinite(htfEmaFast) || !Number.isFinite(htfEmaSlow) || !Number.isFinite(htfAtr) || htfAtr <= 0) {
      return base;
    }
    const htfTrendStrength = Math.abs(htfEmaFast - htfEmaSlow) / htfAtr;
    const threshold = this._numParam(params, 'htf_trend_strength_threshold', 0.8);
    const htfBullish = htfEmaFast > htfEmaSlow;
    const htfBearish = htfEmaFast < htfEmaSlow;
    const htfRegime = htfTrendStrength >= threshold
      ? (htfBullish ? 'BULL_TREND' : htfBearish ? 'BEAR_TREND' : 'RANGE')
      : 'RANGE';
    return {
      htfEmaFast,
      htfEmaSlow,
      htfTrendStrength,
      htfBullish,
      htfBearish,
      htfRegime,
    };
  }

  _resolveSpreadInfo(context, latest, instrument, atr, params) {
    const snapshot = {
      spread: null,
      spreadAtr: null,
      maxAllowedSpreadAtr: this._maxAllowedSpreadAtr(instrument, params),
      spreadFilterAvailable: false,
      spreadUnavailable: true,
    };
    if (!this._boolParam(params, 'use_spread_filter', true)) {
      return { blocked: false, reason: '', snapshot: { ...snapshot, spreadFilterAvailable: false } };
    }
    const spreadInput = this._resolveSpreadInput(context, latest);
    if (spreadInput.rawSpread === null || spreadInput.rawSpread === undefined || spreadInput.rawSpread === '') {
      const blocked = this._boolParam(params, 'reject_if_spread_unavailable', false);
      const reason = 'Spread unavailable';
      return {
        blocked,
        reason: blocked ? reason : '',
        snapshot,
      };
    }
    const rawSpread = Number(spreadInput.rawSpread);
    const spread = this._normalizeSpreadToPrice(rawSpread, spreadInput.source, instrument);
    if (!Number.isFinite(spread) || spread < 0) {
      const blocked = this._boolParam(params, 'reject_if_spread_unavailable', false);
      const reason = 'Spread unavailable';
      return {
        blocked,
        reason: blocked ? reason : '',
        snapshot,
      };
    }
    const spreadAtr = atr > 0 ? spread / atr : Infinity;
    const blocked = spreadAtr > snapshot.maxAllowedSpreadAtr;
    return {
      blocked,
      reason: blocked ? 'Spread too high relative to ATR' : '',
      snapshot: {
        ...snapshot,
        spread,
        spreadRaw: rawSpread,
        spreadSource: spreadInput.source,
        spreadUnit: spreadInput.isPriceUnit ? 'price' : 'pips',
        spreadAtr,
        spreadFilterAvailable: true,
        spreadUnavailable: false,
      },
    };
  }

  _resolveSpreadInput(context = {}, latest = {}) {
    const candidates = [
      { rawSpread: context?.spreadPrice, source: 'context.spreadPrice', isPriceUnit: true },
      { rawSpread: context?.currentSpreadPrice, source: 'context.currentSpreadPrice', isPriceUnit: true },
      { rawSpread: latest?.spreadPrice, source: 'candle.spreadPrice', isPriceUnit: true },
      { rawSpread: context?.spread, source: 'context.spread', isPriceUnit: false },
      { rawSpread: context?.currentSpread, source: 'context.currentSpread', isPriceUnit: false },
      { rawSpread: latest?.spread, source: 'candle.spread', isPriceUnit: false },
    ];

    return candidates.find((candidate) => (
      candidate.rawSpread !== null
      && candidate.rawSpread !== undefined
      && candidate.rawSpread !== ''
    )) || { rawSpread: null, source: null, isPriceUnit: false };
  }

  _normalizeSpreadToPrice(rawSpread, source, instrument = {}) {
    const spread = Number(rawSpread);
    if (!Number.isFinite(spread) || spread < 0) return NaN;
    if (source && String(source).toLowerCase().includes('spreadprice')) {
      return spread;
    }

    const pipSize = Number(instrument?.pipSize);
    if (!Number.isFinite(pipSize) || pipSize <= 0) {
      return spread;
    }
    return spread * pipSize;
  }

  _maxAllowedSpreadAtr(instrument, params) {
    const symbol = this._canonicalSymbol(instrument);
    if (symbol.startsWith('XAU')) return this._numParam(params, 'max_spread_atr_xau', 0.08);
    if (symbol.startsWith('XAG')) return this._numParam(params, 'max_spread_atr_xag', 0.10);
    if (['XTIUSD', 'USOIL', 'XBRUSD', 'UKOIL'].includes(symbol)) return this._numParam(params, 'max_spread_atr_oil', 0.12);
    if (['US30', 'NAS100', 'SPX500'].includes(symbol)) return this._numParam(params, 'max_spread_atr_index', 0.10);
    return this._numParam(params, 'max_spread_atr_default', 0.10);
  }

  _resolveSessionInfo(time, params, module) {
    const session = this._classifyUtcSession(time, this._numParam(params, 'block_rollover_minutes', 30));
    if (!this._boolParam(params, 'use_session_filter', true)) {
      return { ...session, sessionAllowed: true, sessionFilterReason: '' };
    }
    let allowed = true;
    let reason = '';
    if (session.sessionName === 'ROLLOVER') {
      allowed = false;
      reason = 'Rollover window blocked';
    } else if (session.sessionName === 'ASIA') {
      allowed = module === MODULE_REVERSAL
        ? this._boolParam(params, 'allow_asia_reversal', true)
        : this._boolParam(params, 'allow_asia_breakout', false);
      reason = allowed ? '' : `${module} not allowed in Asia session`;
    } else if (session.sessionName === 'LONDON') {
      allowed = this._boolParam(params, 'allow_london', true);
      reason = allowed ? '' : 'London session disabled';
    } else if (session.sessionName === 'NEWYORK') {
      allowed = this._boolParam(params, 'allow_newyork', true);
      reason = allowed ? '' : 'New York session disabled';
    } else if (session.sessionName === 'UNKNOWN') {
      allowed = this._boolParam(params, 'allow_unknown_session', true);
      reason = allowed ? '' : 'Unknown session disabled';
    }
    return {
      ...session,
      sessionAllowed: allowed,
      sessionFilterReason: reason,
    };
  }

  _classifyUtcSession(time, blockRolloverMinutes) {
    const date = time ? new Date(time) : null;
    if (!date || Number.isNaN(date.getTime())) {
      return { sessionName: 'UNKNOWN' };
    }
    const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
    if (blockRolloverMinutes > 0 && (minutes < blockRolloverMinutes || minutes >= 1440 - blockRolloverMinutes)) {
      return { sessionName: 'ROLLOVER' };
    }
    if (minutes >= 0 && minutes < 7 * 60) return { sessionName: 'ASIA' };
    if (minutes >= 7 * 60 && minutes < 13 * 60) return { sessionName: 'LONDON' };
    if (minutes >= 13 * 60 && minutes < 22 * 60) return { sessionName: 'NEWYORK' };
    return { sessionName: 'UNKNOWN' };
  }

  _resolveNewsInfo(context, params) {
    const available = Object.prototype.hasOwnProperty.call(context || {}, 'isNewsBlackout');
    const isNewsBlackout = Boolean(context?.isNewsBlackout);
    const newsReason = context?.newsReason || '';
    const snapshot = {
      newsFilterAvailable: available,
      isNewsBlackout,
      newsReason,
      newsImpact: context?.newsImpact || null,
    };
    if (this._boolParam(params, 'use_news_filter', true) && isNewsBlackout) {
      return {
        blocked: true,
        reason: `News blackout: ${newsReason || 'high impact event'}`,
        snapshot,
      };
    }
    return { blocked: false, reason: '', snapshot };
  }

  _resolveExposureInfo(context, instrument, direction, params) {
    const symbol = this._canonicalSymbol(instrument);
    const correlationGroup = this._correlationGroup(symbol);
    const base = {
      exposureFilterAvailable: Array.isArray(context?.openPositions),
      correlationGroup,
      sameGroupSameDirectionPositions: 0,
      blocked: false,
      reason: '',
    };
    if (!this._boolParam(params, 'use_correlation_exposure_filter', true) || !direction || !base.exposureFilterAvailable) {
      return base;
    }
    const count = context.openPositions.filter((position) => {
      const posSymbol = this._canonicalSymbol(position);
      const posDirection = String(position.type || position.side || position.direction || position.signal || '').toUpperCase();
      return this._correlationGroup(posSymbol) === correlationGroup && posDirection === direction;
    }).length;
    const maxAllowed = Math.max(1, Math.round(this._numParam(params, 'max_same_group_same_direction_positions', 1)));
    return {
      ...base,
      sameGroupSameDirectionPositions: count,
      blocked: count >= maxAllowed,
      reason: count >= maxAllowed ? 'Correlation exposure limit reached' : '',
    };
  }

  _correlationGroup(symbol) {
    for (const [group, symbols] of Object.entries(COMMODITY_GROUPS)) {
      if (symbols.has(symbol)) return group;
    }
    return 'default';
  }

  _filteredModuleResult(module, reason, sharedSnapshot) {
    return {
      signal: 'NONE',
      status: 'FILTERED',
      filterReason: reason,
      indicatorsSnapshot: { ...sharedSnapshot, module },
    };
  }

  _buildBreakoutConfidence({ direction, rvol, bodyAtr, features, sharedSnapshot, htfRegime, params, bodyStats, structureBreakScore, deltaOk, vwapAligned }) {
    const breakdown = {
      base: 0.40,
      rvolScore: rvol >= 2.5 ? 0.16 : rvol >= 2.0 ? 0.12 : rvol >= 1.8 ? 0.08 : 0,
      bodyAtrScore: bodyAtr >= 1.0 ? 0.12 : bodyAtr >= 0.75 ? 0.08 : 0.04,
      deltaExpansionScore: deltaOk ? 0.08 : 0,
      htfTrendScore: htfRegime.htfRegime === (direction === 'BUY' ? 'BULL_TREND' : 'BEAR_TREND') ? 0.08 : 0,
      vwapAlignmentScore: vwapAligned ? 0.05 : 0,
      structureBreakScore,
      spreadEfficiencyScore: features.spreadEfficiency >= 0.7 ? 0.05 : features.spreadEfficiency >= 0.55 ? 0.03 : 0,
      spreadPenalty: sharedSnapshot.spreadAtr > sharedSnapshot.maxAllowedSpreadAtr * 0.8 ? 0.04 : 0,
      overextendedPenalty: bodyAtr > 2.2 ? 0.06 : 0,
      lowSessionQualityPenalty: sharedSnapshot.sessionName === 'UNKNOWN' ? 0.03 : 0,
      dojiPenalty: bodyStats.isTinyBody ? 0.05 : 0,
      htfAgainstTrendPenalty: this._htfAgainstTrendPenalty(direction, htfRegime, params),
    };
    return this._confidenceFromBreakdown(breakdown);
  }

  _buildReversalConfidence({ direction, rvol, wickRatio, features, sharedSnapshot, htfRegime, params, bodyStats, reclaimed, deltaOk, vwapOk }) {
    const breakdown = {
      base: 0.40,
      rvolScore: rvol >= 3.0 ? 0.16 : rvol >= 2.5 ? 0.12 : rvol >= 2.2 ? 0.08 : 0.04,
      wickScore: wickRatio >= 2.8 ? 0.12 : wickRatio >= 2.2 ? 0.08 : 0.04,
      reclaimScore: reclaimed ? 0.08 : 0,
      deltaScore: deltaOk ? 0.08 : 0,
      vwapScore: vwapOk ? 0.06 : 0,
      sessionScore: ['LONDON', 'NEWYORK'].includes(sharedSnapshot.sessionName) ? 0.04 : 0.02,
      htfAgainstTrendPenalty: this._htfAgainstTrendPenalty(direction, htfRegime, params),
      spreadPenalty: sharedSnapshot.spreadAtr > sharedSnapshot.maxAllowedSpreadAtr * 0.8 ? 0.04 : 0,
      dojiPenalty: bodyStats.isTinyBody ? 0.08 : 0,
      overextendedPenalty: Math.abs(sharedSnapshot.vwapDistanceAtr || 0) > 2.5 ? 0.04 : 0,
    };
    return this._confidenceFromBreakdown(breakdown);
  }

  _confidenceFromBreakdown(breakdown) {
    const additive = Object.entries(breakdown)
      .filter(([key]) => key === 'base' || key.endsWith('Score'))
      .reduce((sum, [, value]) => sum + (Number(value) || 0), 0);
    const penalties = Object.entries(breakdown)
      .filter(([key]) => key.endsWith('Penalty'))
      .reduce((sum, [, value]) => sum + (Number(value) || 0), 0);
    const confidenceBeforePenalty = clamp(additive, 0, 0.95);
    const confidenceAfterPenalty = clamp(additive - penalties, 0, 0.95);
    return {
      confidence: confidenceAfterPenalty,
      confidenceBeforePenalty,
      confidenceAfterPenalty,
      breakdown,
    };
  }

  _htfAgainstTrendPenalty(direction, htfRegime, params) {
    if (!this._boolParam(params, 'use_higher_tf_regime', true)) return 0;
    if (direction === 'BUY' && htfRegime.htfBearish) {
      return this._numParam(params, 'htf_against_trend_confidence_penalty', 0.10);
    }
    if (direction === 'SELL' && htfRegime.htfBullish) {
      return this._numParam(params, 'htf_against_trend_confidence_penalty', 0.10);
    }
    return 0;
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

  _computeStructureBounds(candles, breakoutLookback) {
    const start = Math.max(0, candles.length - breakoutLookback - 1);
    const end = candles.length - 1;
    let structureHigh = -Infinity;
    let structureLow = Infinity;

    for (let index = start; index < end; index++) {
      const candle = candles[index];
      if (candle.high > structureHigh) structureHigh = candle.high;
      if (candle.low < structureLow) structureLow = candle.low;
    }

    return { structureHigh, structureLow };
  }
}

VolumeFlowHybridStrategy.MODULE_BREAKOUT = MODULE_BREAKOUT;
VolumeFlowHybridStrategy.MODULE_REVERSAL = MODULE_REVERSAL;

module.exports = VolumeFlowHybridStrategy;
