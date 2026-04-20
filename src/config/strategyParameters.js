const STRATEGY_PARAMETER_REGISTRY = {
  TrendFollowing: {
    ema_fast: {
      label: 'Fast EMA',
      inputType: 'number',
      defaultValue: 20,
      optimize: { enabled: true, min: 10, max: 30, step: 5 },
    },
    ema_slow: {
      label: 'Slow EMA',
      inputType: 'number',
      defaultValue: 50,
      optimize: { enabled: true, min: 40, max: 80, step: 10 },
    },
    rsi_period: {
      label: 'RSI Period',
      inputType: 'number',
      defaultValue: 14,
      optimize: { enabled: true, min: 10, max: 20, step: 2 },
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
      optimize: { enabled: true, min: 1.0, max: 2.5, step: 0.5 },
    },
    tpMultiplier: {
      label: 'TP Multiplier',
      inputType: 'number',
      defaultValue: 3,
      optimize: { enabled: true, min: 2.0, max: 5.0, step: 0.5 },
    },
    riskPercent: {
      label: 'Risk Percent',
      inputType: 'number',
      defaultValue: 0.01,
      optimize: { enabled: false },
    },
  },
  MeanReversion: {
    bb_period: {
      label: 'BB Period',
      inputType: 'number',
      defaultValue: 20,
      optimize: { enabled: true, min: 15, max: 30, step: 5 },
    },
    bb_stddev: {
      label: 'BB StdDev',
      inputType: 'number',
      defaultValue: 2,
      optimize: { enabled: true, min: 1.5, max: 2.5, step: 0.5 },
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
      defaultValue: 35,
      optimize: { enabled: true, min: 20, max: 35, step: 5 },
    },
    rsi_overbought: {
      label: 'RSI Overbought',
      inputType: 'number',
      defaultValue: 65,
      optimize: { enabled: true, min: 65, max: 80, step: 5 },
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
      optimize: { enabled: true, min: 1.0, max: 2.5, step: 0.5 },
    },
    tpMultiplier: {
      label: 'TP Multiplier',
      inputType: 'number',
      defaultValue: 2,
      optimize: { enabled: true, min: 1.5, max: 4.0, step: 0.5 },
    },
    riskPercent: {
      label: 'Risk Percent',
      inputType: 'number',
      defaultValue: 0.01,
      optimize: { enabled: false },
    },
  },
  Momentum: {
    ema_period: {
      label: 'EMA Period',
      inputType: 'number',
      defaultValue: 50,
      optimize: { enabled: true, min: 30, max: 70, step: 10 },
    },
    rsi_period: {
      label: 'RSI Period',
      inputType: 'number',
      defaultValue: 14,
      optimize: { enabled: true, min: 10, max: 20, step: 2 },
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
      optimize: { enabled: true, min: 1.0, max: 2.5, step: 0.5 },
    },
    tpMultiplier: {
      label: 'TP Multiplier',
      inputType: 'number',
      defaultValue: 3,
      optimize: { enabled: true, min: 2.0, max: 5.0, step: 0.5 },
    },
    riskPercent: {
      label: 'Risk Percent',
      inputType: 'number',
      defaultValue: 0.01,
      optimize: { enabled: false },
    },
  },
  Breakout: {
    lookback_period: {
      label: 'Lookback Period',
      inputType: 'number',
      defaultValue: 20,
      optimize: { enabled: true, min: 15, max: 30, step: 5 },
    },
    body_multiplier: {
      label: 'Body Multiplier',
      inputType: 'number',
      defaultValue: 1.2,
      optimize: { enabled: true, min: 1.0, max: 2.5, step: 0.5 },
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
      optimize: { enabled: true, min: 1.5, max: 3.0, step: 0.5 },
    },
    tpMultiplier: {
      label: 'TP Multiplier',
      inputType: 'number',
      defaultValue: 5,
      optimize: { enabled: true, min: 3.0, max: 6.0, step: 0.5 },
    },
    riskPercent: {
      label: 'Risk Percent',
      inputType: 'number',
      defaultValue: 0.01,
      optimize: { enabled: false },
    },
  },
  VolumeFlowHybrid: {
    // ─── Core volume-flow thresholds ───
    rvol_continuation: {
      label: 'RVOL Continuation (x avg)',
      inputType: 'number',
      defaultValue: 1.8,
      optimize: { enabled: true, min: 1.4, max: 2.4, step: 0.2 },
    },
    rvol_reversal: {
      label: 'RVOL Reversal (x avg)',
      inputType: 'number',
      defaultValue: 2.2,
      optimize: { enabled: true, min: 1.8, max: 2.8, step: 0.2 },
    },
    volume_avg_period: {
      label: 'Volume MA Period',
      inputType: 'number',
      defaultValue: 20,
      optimize: { enabled: true, min: 10, max: 40, step: 10 },
    },
    breakout_lookback: {
      label: 'Breakout Lookback Bars',
      inputType: 'number',
      defaultValue: 12,
      optimize: { enabled: true, min: 8, max: 20, step: 2 },
    },
    body_atr_threshold: {
      label: 'Body vs ATR (continuation)',
      inputType: 'number',
      defaultValue: 0.6,
      optimize: { enabled: true, min: 0.3, max: 0.9, step: 0.1 },
    },
    wick_ratio_threshold: {
      label: 'Wick/Body Ratio (reversal)',
      inputType: 'number',
      defaultValue: 1.8,
      optimize: { enabled: true, min: 1.2, max: 2.6, step: 0.2 },
    },
    vwap_reclaim_tolerance_atr: {
      label: 'VWAP Reclaim Tolerance (ATR)',
      inputType: 'number',
      defaultValue: 0.35,
      optimize: { enabled: true, min: 0.15, max: 0.6, step: 0.05 },
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
      optimize: { enabled: true, min: 0.8, max: 1.6, step: 0.1 },
    },
    tpMultiplier: {
      label: 'TP Multiplier (ATR)',
      inputType: 'number',
      defaultValue: 2.0,
      optimize: { enabled: true, min: 1.2, max: 2.4, step: 0.2 },
    },
    reversal_sl_atr: {
      label: 'Reversal SL (ATR)',
      inputType: 'number',
      defaultValue: 1.0,
      optimize: { enabled: true, min: 0.8, max: 1.3, step: 0.1 },
    },
    reversal_tp_atr: {
      label: 'Reversal TP (ATR)',
      inputType: 'number',
      defaultValue: 1.5,
      optimize: { enabled: true, min: 1.2, max: 1.8, step: 0.1 },
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
      optimize: { enabled: true, min: 10, max: 20, step: 2 },
    },
    stoch_signal: {
      label: 'Stochastic Signal',
      inputType: 'number',
      defaultValue: 3,
      optimize: { enabled: true, min: 3, max: 5, step: 1 },
    },
    slMultiplier: {
      label: 'SL Multiplier',
      inputType: 'number',
      defaultValue: 2,
      optimize: { enabled: true, min: 1.5, max: 3.0, step: 0.5 },
    },
    tpMultiplier: {
      label: 'TP Multiplier',
      inputType: 'number',
      defaultValue: 5,
      optimize: { enabled: true, min: 3.0, max: 6.0, step: 0.5 },
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
