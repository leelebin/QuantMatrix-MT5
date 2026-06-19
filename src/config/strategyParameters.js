const STRATEGY_PARAMETER_REGISTRY = {
  TrendFollowing: {
    ema_fast: {
      label: 'Fast EMA (pullback anchor)',
      inputType: 'number',
      defaultValue: 20,
      optimize: { enabled: false },
    },
    ema_slow: {
      label: 'Slow EMA (trend body)',
      inputType: 'number',
      defaultValue: 50,
      optimize: { enabled: false },
    },
    ema_trend: {
      label: 'Trend EMA (regime)',
      inputType: 'number',
      defaultValue: 200,
      optimize: { enabled: false },
    },
    rsi_period: {
      label: 'RSI Period',
      inputType: 'number',
      defaultValue: 14,
      optimize: { enabled: false },
    },
    atr_period: {
      label: 'ATR Period',
      inputType: 'number',
      defaultValue: 14,
      optimize: { enabled: false },
    },
    breakout_lookback: {
      label: 'H1 breakout lookback (bars)',
      inputType: 'number',
      defaultValue: 3,
      optimize: { enabled: true, min: 2, max: 4, step: 1 },
    },
    pullback_atr_max: {
      label: 'Max distance from EMA20 (xATR)',
      inputType: 'number',
      defaultValue: 1.0,
      optimize: { enabled: true, min: 0.7, max: 1.4, step: 0.35 },
    },
    rsi_buy_min: {
      label: 'RSI floor for BUY (mirrored for SELL)',
      inputType: 'number',
      defaultValue: 52,
      optimize: { enabled: true, min: 50, max: 56, step: 3 },
    },
    slMultiplier: {
      label: 'SL Multiplier (ATR)',
      inputType: 'number',
      defaultValue: 1.5,
      optimize: { enabled: true, min: 1.0, max: 2.0, step: 0.5 },
    },
    tpMultiplier: {
      label: 'TP Multiplier (ATR)',
      inputType: 'number',
      defaultValue: 2.0,
      optimize: { enabled: true, min: 1.5, max: 3.0, step: 0.5 },
    },
    riskPercent: {
      label: 'Risk Percent',
      inputType: 'number',
      defaultValue: 0.02,
      optimize: { enabled: false },
    },
  },
  MeanReversion: {
    bb_period: {
      label: 'BB Period',
      inputType: 'number',
      defaultValue: 20,
      optimize: { enabled: false },
    },
    bb_stddev: {
      label: 'BB StdDev',
      inputType: 'number',
      defaultValue: 2,
      optimize: { enabled: true, min: 1.8, max: 2.4, step: 0.3 },
    },
    rsi_period: {
      label: 'RSI Period',
      inputType: 'number',
      defaultValue: 14,
      optimize: { enabled: false },
    },
    rsi_oversold: {
      label: 'RSI Oversold',
      inputType: 'number',
      defaultValue: 30,
      optimize: { enabled: true, min: 25, max: 35, step: 5 },
    },
    rsi_overbought: {
      label: 'RSI Overbought',
      inputType: 'number',
      defaultValue: 70,
      optimize: { enabled: true, min: 65, max: 75, step: 5 },
    },
    atr_period: {
      label: 'ATR Period',
      inputType: 'number',
      defaultValue: 14,
      optimize: { enabled: false },
    },
    slMultiplier: {
      label: 'SL Multiplier',
      inputType: 'number',
      defaultValue: 1.5,
      optimize: { enabled: true, min: 1.5, max: 2.5, step: 0.5 },
    },
    tpMultiplier: {
      label: 'TP Multiplier',
      inputType: 'number',
      defaultValue: 2,
      optimize: { enabled: true, min: 1.5, max: 3.0, step: 0.5 },
    },
    riskPercent: {
      label: 'Risk Percent',
      inputType: 'number',
      defaultValue: 0.02,
      optimize: { enabled: false },
    },
  },
  Momentum: {
    ema_period: {
      label: 'EMA Period',
      inputType: 'number',
      defaultValue: 50,
      optimize: { enabled: true, min: 30, max: 70, step: 20 },
    },
    rsi_period: {
      label: 'RSI Period',
      inputType: 'number',
      defaultValue: 14,
      optimize: { enabled: true, min: 10, max: 18, step: 4 },
    },
    atr_period: {
      label: 'ATR Period',
      inputType: 'number',
      defaultValue: 14,
      optimize: { enabled: false },
    },
    macd_fast: {
      label: 'MACD Fast',
      inputType: 'number',
      defaultValue: 12,
      optimize: { enabled: false },
    },
    macd_slow: {
      label: 'MACD Slow',
      inputType: 'number',
      defaultValue: 26,
      optimize: { enabled: false },
    },
    macd_signal: {
      label: 'MACD Signal',
      inputType: 'number',
      defaultValue: 9,
      optimize: { enabled: false },
    },
    slMultiplier: {
      label: 'SL Multiplier',
      inputType: 'number',
      defaultValue: 1.5,
      optimize: { enabled: true, min: 1.5, max: 2.5, step: 0.5 },
    },
    tpMultiplier: {
      label: 'TP Multiplier',
      inputType: 'number',
      defaultValue: 3,
      optimize: { enabled: true, min: 2.0, max: 4.0, step: 1.0 },
    },
    riskPercent: {
      label: 'Risk Percent',
      inputType: 'number',
      defaultValue: 0.02,
      optimize: { enabled: false },
    },
  },
  Breakout: {
    lookback_period: {
      label: 'Lookback Period',
      inputType: 'number',
      defaultValue: 20,
      optimize: { enabled: true, min: 15, max: 25, step: 5 },
    },
    body_multiplier: {
      label: 'Body Multiplier',
      inputType: 'number',
      defaultValue: 1.2,
      optimize: { enabled: true, min: 1.0, max: 2.0, step: 0.5 },
    },
    rsi_period: {
      label: 'RSI Period',
      inputType: 'number',
      defaultValue: 14,
      optimize: { enabled: false },
    },
    atr_period: {
      label: 'ATR Period',
      inputType: 'number',
      defaultValue: 14,
      optimize: { enabled: false },
    },
    slMultiplier: {
      label: 'SL Multiplier',
      inputType: 'number',
      defaultValue: 2,
      optimize: { enabled: true, min: 1.5, max: 2.5, step: 0.5 },
    },
    tpMultiplier: {
      label: 'TP Multiplier',
      inputType: 'number',
      defaultValue: 4,
      optimize: { enabled: true, min: 3.0, max: 5.0, step: 1.0 },
    },
    riskPercent: {
      label: 'Risk Percent',
      inputType: 'number',
      defaultValue: 0.02,
      optimize: { enabled: false },
    },
  },
  VolumeFlowHybrid: {
    // Module / direction gates preserve current behavior unless a research
    // preset explicitly changes them.
    enable_breakout_module: {
      label: 'Enable Breakout Module (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    enable_reversal_module: {
      label: 'Enable Reversal Module (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    allow_buy: {
      label: 'Allow BUY Signals (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    allow_sell: {
      label: 'Allow SELL Signals (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    // ─── Core volume-flow thresholds ───
    rvol_continuation: {
      label: 'RVOL Continuation (x avg)',
      inputType: 'number',
      defaultValue: 1.8,
      optimize: { enabled: true, min: 1.6, max: 2.0, step: 0.2 },
    },
    rvol_reversal: {
      label: 'RVOL Reversal (x avg)',
      inputType: 'number',
      defaultValue: 2.2,
      optimize: { enabled: true, min: 2.0, max: 2.4, step: 0.2 },
    },
    volume_avg_period: {
      label: 'Volume MA Period',
      inputType: 'number',
      defaultValue: 20,
      optimize: { enabled: true, min: 20, max: 20, step: 10 },
    },
    breakout_lookback: {
      label: 'Breakout Lookback Bars',
      inputType: 'number',
      defaultValue: 12,
      optimize: { enabled: true, min: 10, max: 14, step: 2 },
    },
    body_atr_threshold: {
      label: 'Body vs ATR (continuation)',
      inputType: 'number',
      defaultValue: 0.6,
      optimize: { enabled: true, min: 0.5, max: 0.7, step: 0.1 },
    },
    wick_ratio_threshold: {
      label: 'Wick/Body Ratio (reversal)',
      inputType: 'number',
      defaultValue: 1.8,
      optimize: { enabled: true, min: 1.6, max: 2.0, step: 0.2 },
    },
    vwap_reclaim_tolerance_atr: {
      label: 'VWAP Reclaim Tolerance (ATR)',
      inputType: 'number',
      defaultValue: 0.35,
      optimize: { enabled: true, min: 0.25, max: 0.45, step: 0.1 },
    },
    cumulative_delta_smoothing: {
      label: 'Cumulative Delta Smoothing',
      inputType: 'number',
      defaultValue: 8,
      optimize: { enabled: false },
    },
    ema_fast: {
      label: 'Fast Trend EMA',
      inputType: 'number',
      defaultValue: 20,
      optimize: { enabled: false },
    },
    ema_slow: {
      label: 'Slow Trend EMA',
      inputType: 'number',
      defaultValue: 50,
      optimize: { enabled: false },
    },
    atr_period: {
      label: 'ATR Period',
      inputType: 'number',
      defaultValue: 14,
      optimize: { enabled: false },
    },
    slMultiplier: {
      label: 'SL Multiplier (ATR)',
      inputType: 'number',
      defaultValue: 1.2,
      optimize: { enabled: true, min: 1.0, max: 1.4, step: 0.2 },
    },
    tpMultiplier: {
      label: 'TP Multiplier (ATR)',
      inputType: 'number',
      defaultValue: 2.0,
      optimize: { enabled: true, min: 1.6, max: 2.4, step: 0.4 },
    },
    reversal_sl_atr: {
      label: 'Reversal SL (ATR)',
      inputType: 'number',
      defaultValue: 1.0,
      optimize: { enabled: true, min: 1.0, max: 1.0, step: 0.1 },
    },
    reversal_tp_atr: {
      label: 'Reversal TP (ATR)',
      inputType: 'number',
      defaultValue: 1.5,
      optimize: { enabled: true, min: 1.5, max: 1.5, step: 0.1 },
    },
    min_confidence: {
      label: 'Min Confidence',
      inputType: 'number',
      defaultValue: 0.55,
      optimize: { enabled: false },
    },
    riskPercent: {
      label: 'Risk Percent',
      inputType: 'number',
      defaultValue: 0.0075,
      optimize: { enabled: false },
    },
    small_account_profile: {
      label: 'Small-Account Profile (0/1)',
      inputType: 'number',
      defaultValue: 0,
      optimize: { enabled: false },
    },
    wick_body_floor_atr: {
      label: 'Wick Body Floor (ATR)',
      inputType: 'number',
      defaultValue: 0.05,
      optimize: { enabled: false },
    },
    min_body_to_range_ratio: {
      label: 'Min Body/Range Ratio',
      inputType: 'number',
      defaultValue: 0.05,
      optimize: { enabled: false },
    },
    delta_divergence_lookback: {
      label: 'Delta Divergence Lookback',
      inputType: 'number',
      defaultValue: 8,
      optimize: { enabled: false },
    },
    require_delta_slope_for_breakout: {
      label: 'Require Delta Slope For Breakout (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    require_delta_divergence_for_reversal: {
      label: 'Require Delta Divergence For Reversal (0/1)',
      inputType: 'number',
      defaultValue: 0,
      optimize: { enabled: false },
    },
    use_higher_tf_regime: {
      label: 'Use Higher TF Regime (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    htf_trend_strength_threshold: {
      label: 'HTF Trend Strength Threshold',
      inputType: 'number',
      defaultValue: 0.8,
      optimize: { enabled: false },
    },
    htf_against_trend_confidence_penalty: {
      label: 'HTF Against-Trend Confidence Penalty',
      inputType: 'number',
      defaultValue: 0.1,
      optimize: { enabled: false },
    },
    htf_strong_trend_breakout_first: {
      label: 'HTF Strong Trend Breakout First (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    use_spread_filter: {
      label: 'Use Spread/ATR Filter (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    max_spread_atr_xau: {
      label: 'Max Spread/ATR XAU',
      inputType: 'number',
      defaultValue: 0.08,
      optimize: { enabled: false },
    },
    max_spread_atr_xag: {
      label: 'Max Spread/ATR XAG',
      inputType: 'number',
      defaultValue: 0.1,
      optimize: { enabled: false },
    },
    max_spread_atr_oil: {
      label: 'Max Spread/ATR Oil',
      inputType: 'number',
      defaultValue: 0.12,
      optimize: { enabled: false },
    },
    max_spread_atr_index: {
      label: 'Max Spread/ATR Index',
      inputType: 'number',
      defaultValue: 0.1,
      optimize: { enabled: false },
    },
    max_spread_atr_default: {
      label: 'Max Spread/ATR Default',
      inputType: 'number',
      defaultValue: 0.1,
      optimize: { enabled: false },
    },
    reject_if_spread_unavailable: {
      label: 'Reject If Spread Unavailable (0/1)',
      inputType: 'number',
      defaultValue: 0,
      optimize: { enabled: false },
    },
    use_entry_confirmation: {
      label: 'Use Entry TF Confirmation (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    entry_confirm_require_structure_hold: {
      label: 'Entry Confirm Structure Hold (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    entry_confirm_reject_strong_opposite_wick: {
      label: 'Entry Confirm Reject Opposite Wick (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    entry_opposite_wick_ratio: {
      label: 'Entry Opposite Wick Ratio',
      inputType: 'number',
      defaultValue: 1.5,
      optimize: { enabled: false },
    },
    entry_confirm_use_ema_slope: {
      label: 'Entry Confirm EMA Slope (0/1)',
      inputType: 'number',
      defaultValue: 0,
      optimize: { enabled: false },
    },
    use_symbol_profile: {
      label: 'Use Commodity Symbol Profile (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    use_session_filter: {
      label: 'Use Session Filter (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    allow_asia_reversal: {
      label: 'Allow Asia Reversal (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    allow_asia_breakout: {
      label: 'Allow Asia Breakout (0/1)',
      inputType: 'number',
      defaultValue: 0,
      optimize: { enabled: false },
    },
    allow_london: {
      label: 'Allow London (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    allow_newyork: {
      label: 'Allow New York (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    allow_unknown_session: {
      label: 'Allow Unknown Session (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    block_rollover_minutes: {
      label: 'Block Rollover Minutes',
      inputType: 'number',
      defaultValue: 30,
      optimize: { enabled: false },
    },
    use_news_filter: {
      label: 'Use News Filter (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    news_blackout_before_minutes: {
      label: 'News Blackout Before Minutes',
      inputType: 'number',
      defaultValue: 45,
      optimize: { enabled: false },
    },
    news_blackout_after_minutes: {
      label: 'News Blackout After Minutes',
      inputType: 'number',
      defaultValue: 30,
      optimize: { enabled: false },
    },
    use_max_holding_time: {
      label: 'Use Max Holding Time (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    reversal_max_holding_minutes: {
      label: 'Reversal Max Holding Minutes',
      inputType: 'number',
      defaultValue: 45,
      optimize: { enabled: false },
    },
    breakout_max_holding_minutes: {
      label: 'Breakout Max Holding Minutes',
      inputType: 'number',
      defaultValue: 120,
      optimize: { enabled: false },
    },
    reversal_no_progress_exit_minutes: {
      label: 'Reversal No Progress Exit Minutes',
      inputType: 'number',
      defaultValue: 30,
      optimize: { enabled: false },
    },
    reversal_min_progress_atr: {
      label: 'Reversal Min Progress ATR',
      inputType: 'number',
      defaultValue: 0.4,
      optimize: { enabled: false },
    },
    reversal_breakeven_trigger_atr: {
      label: 'Reversal BE Trigger ATR',
      inputType: 'number',
      defaultValue: 0.8,
      optimize: { enabled: false },
    },
    reversal_trailing_start_atr: {
      label: 'Reversal Trail Start ATR',
      inputType: 'number',
      defaultValue: 1.2,
      optimize: { enabled: false },
    },
    reversal_trailing_distance_atr: {
      label: 'Reversal Trail Distance ATR',
      inputType: 'number',
      defaultValue: 0.8,
      optimize: { enabled: false },
    },
    reversal_partial_close_percent: {
      label: 'Reversal Partial Close Percent',
      inputType: 'number',
      defaultValue: 0.4,
      optimize: { enabled: false },
    },
    reversal_partial_close_trigger_atr: {
      label: 'Reversal Partial Close Trigger ATR',
      inputType: 'number',
      defaultValue: 0.8,
      optimize: { enabled: false },
    },
    breakout_breakeven_trigger_atr: {
      label: 'Breakout BE Trigger ATR',
      inputType: 'number',
      defaultValue: 0.9,
      optimize: { enabled: false },
    },
    breakout_trailing_start_atr: {
      label: 'Breakout Trail Start ATR',
      inputType: 'number',
      defaultValue: 1.3,
      optimize: { enabled: false },
    },
    breakout_trailing_distance_atr: {
      label: 'Breakout Trail Distance ATR',
      inputType: 'number',
      defaultValue: 0.9,
      optimize: { enabled: false },
    },
    breakout_partial_close_percent: {
      label: 'Breakout Partial Close Percent',
      inputType: 'number',
      defaultValue: 0.4,
      optimize: { enabled: false },
    },
    breakout_partial_close_trigger_atr: {
      label: 'Breakout Partial Close Trigger ATR',
      inputType: 'number',
      defaultValue: 1.0,
      optimize: { enabled: false },
    },
    use_correlation_exposure_filter: {
      label: 'Use Correlation Exposure Filter (0/1)',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    max_same_group_same_direction_positions: {
      label: 'Max Same Group Direction Positions',
      inputType: 'number',
      defaultValue: 1,
      optimize: { enabled: false },
    },
    max_commodity_group_risk_percent: {
      label: 'Max Commodity Group Risk Percent',
      inputType: 'number',
      defaultValue: 0.01,
      optimize: { enabled: false },
    },
  },
  MultiTimeframe: {
    ema_trend: {
      label: 'Trend EMA',
      inputType: 'number',
      defaultValue: 200,
      optimize: { enabled: false },
    },
    atr_period: {
      label: 'ATR Period',
      inputType: 'number',
      defaultValue: 14,
      optimize: { enabled: false },
    },
    macd_fast: {
      label: 'MACD Fast',
      inputType: 'number',
      defaultValue: 12,
      optimize: { enabled: false },
    },
    macd_slow: {
      label: 'MACD Slow',
      inputType: 'number',
      defaultValue: 26,
      optimize: { enabled: false },
    },
    macd_signal: {
      label: 'MACD Signal',
      inputType: 'number',
      defaultValue: 9,
      optimize: { enabled: false },
    },
    stoch_period: {
      label: 'Stochastic Period',
      inputType: 'number',
      defaultValue: 14,
      optimize: { enabled: true, min: 12, max: 16, step: 4 },
    },
    stoch_signal: {
      label: 'Stochastic Signal',
      inputType: 'number',
      defaultValue: 3,
      optimize: { enabled: false },
    },
    slMultiplier: {
      label: 'SL Multiplier',
      inputType: 'number',
      defaultValue: 2,
      optimize: { enabled: true, min: 1.5, max: 2.5, step: 0.5 },
    },
    tpMultiplier: {
      label: 'TP Multiplier',
      inputType: 'number',
      defaultValue: 4,
      optimize: { enabled: true, min: 3.0, max: 5.0, step: 1.0 },
    },
    riskPercent: {
      label: 'Risk Percent',
      inputType: 'number',
      defaultValue: 0.015,
      optimize: { enabled: false },
    },
  },
};

function getStrategyParameterRegistry(strategyType) {
  return STRATEGY_PARAMETER_REGISTRY[strategyType] || null;
}

function getStrategyParameterDefinitions(strategyType) {
  const registry = getStrategyParameterRegistry(strategyType);
  if (!registry) return [];

  return Object.entries(registry).map(([key, config]) => ({
    key,
    strategyType,
    label: config.label,
    inputType: config.inputType || 'number',
    defaultValue: config.defaultValue,
    optimize: config.optimize || { enabled: false },
  }));
}

function getDefaultStrategyParameters(strategyType) {
  const registry = getStrategyParameterRegistry(strategyType);
  if (!registry) return {};

  return Object.fromEntries(
    Object.entries(registry).map(([key, config]) => [key, config.defaultValue])
  );
}

function getOptimizerParameterRanges(strategyType) {
  const registry = getStrategyParameterRegistry(strategyType);
  if (!registry) return null;

  return Object.fromEntries(
    Object.entries(registry)
      .filter(([, config]) => config.optimize && config.optimize.enabled)
      .map(([key, config]) => [key, {
        min: config.optimize.min,
        max: config.optimize.max,
        step: config.optimize.step,
      }])
  );
}

function normalizeParameterValues(values = {}) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => {
        const numberValue = Number(value);
        return [key, Number.isFinite(numberValue) ? numberValue : value];
      })
  );
}

function resolveStrategyParameters({ strategyType, instrument = null, storedParameters = null, overrides = null } = {}) {
  const defaults = getDefaultStrategyParameters(strategyType);
  const instrumentRiskParams = instrument && instrument.riskParams
    ? normalizeParameterValues(instrument.riskParams)
    : {};
  const persisted = normalizeParameterValues(storedParameters || {});
  const runtimeOverrides = normalizeParameterValues(overrides || {});

  return {
    ...defaults,
    ...instrumentRiskParams,
    ...persisted,
    ...runtimeOverrides,
  };
}

module.exports = {
  STRATEGY_PARAMETER_REGISTRY,
  getDefaultStrategyParameters,
  getOptimizerParameterRanges,
  getStrategyParameterDefinitions,
  getStrategyParameterRegistry,
  normalizeParameterValues,
  resolveStrategyParameters,
};
