const indicatorService = require('./indicatorService');
const volumeFeatureService = require('./volumeFeatureService');

const EXIT_REASON_LABELS = {
  SL_HIT: 'Stop loss hit',
  TP_HIT: 'Take profit hit',
  END_OF_DATA: 'Closed at end of data',
  MR_TIMEOUT: 'Mean reversion timeout',
  MR_RSI_EXHAUSTED: 'Mean reversion RSI exhaustion',
};

function normalizeNumber(value, decimals = 6) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(decimals));
}

function buildAlignedNumericSeries(candles, values, extractor = (value) => value, decimals = 6) {
  if (!Array.isArray(candles) || !Array.isArray(values) || values.length === 0) {
    return [];
  }

  const offset = candles.length - values.length;
  const points = [];

  values.forEach((value, index) => {
    const candle = candles[index + offset];
    if (!candle) return;
    const numericValue = normalizeNumber(extractor(value), decimals);
    if (!Number.isFinite(numericValue)) return;
    points.push({ time: candle.time, value: numericValue });
  });

  return points;
}

function buildAlignedFeatureSeries(candles, featureSeries, extractor, decimals = 6) {
  if (!Array.isArray(candles) || !Array.isArray(featureSeries) || featureSeries.length === 0) {
    return [];
  }

  const points = [];
  featureSeries.forEach((feature, index) => {
    const candle = candles[index];
    if (!candle || !feature) return;
    const numericValue = normalizeNumber(extractor(feature, candle), decimals);
    if (!Number.isFinite(numericValue)) return;
    points.push({ time: candle.time, value: numericValue });
  });

  return points;
}

function buildVolumeHistogram(candles) {
  return (candles || []).map((candle) => {
    const volume = normalizeNumber(volumeFeatureService.resolveVolume(candle), 2) || 0;
    const isUp = Number(candle.close) >= Number(candle.open);
    return {
      time: candle.time,
      value: volume,
      color: isUp ? 'rgba(16,185,129,0.65)' : 'rgba(239,68,68,0.65)',
    };
  });
}

function buildConstantLine(candles, value, decimals = 6) {
  return (candles || []).map((candle) => ({
    time: candle.time,
    value: normalizeNumber(value, decimals),
  }));
}

function buildBreakoutStructureSeries(candles, lookbackPeriod) {
  const lookback = Math.max(5, Math.round(Number(lookbackPeriod) || 20));
  const highSeries = [];
  const lowSeries = [];
  const midpointSeries = [];

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (i < lookback) {
      highSeries.push({ time: candle.time, value: null });
      lowSeries.push({ time: candle.time, value: null });
      midpointSeries.push({ time: candle.time, value: null });
      continue;
    }

    const lookbackCandles = candles.slice(i - lookback, i);
    const highest = Math.max(...lookbackCandles.map((item) => Number(item.high)));
    const lowest = Math.min(...lookbackCandles.map((item) => Number(item.low)));
    const midpoint = (highest + lowest) / 2;
    highSeries.push({ time: candle.time, value: normalizeNumber(highest, 5) });
    lowSeries.push({ time: candle.time, value: normalizeNumber(lowest, 5) });
    midpointSeries.push({ time: candle.time, value: normalizeNumber(midpoint, 5) });
  }

  return {
    highSeries: highSeries.filter((point) => Number.isFinite(point.value)),
    lowSeries: lowSeries.filter((point) => Number.isFinite(point.value)),
    midpointSeries: midpointSeries.filter((point) => Number.isFinite(point.value)),
  };
}

function humanizeExitReason(reasonCode) {
  if (!reasonCode) return '';
  if (EXIT_REASON_LABELS[reasonCode]) return EXIT_REASON_LABELS[reasonCode];
  return String(reasonCode)
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function buildTradeEvent(trade) {
  const setupReason = trade.setupReason || trade.reason || '';
  const triggerReason = trade.triggerReason || '';
  const entryReason = trade.entryReason
    || [setupReason, triggerReason].filter(Boolean).join(' | ')
    || trade.reason
    || '';

  return {
    tradeId: trade.id,
    direction: trade.type,
    entryTime: trade.entryTime,
    entryPrice: trade.entryPrice,
    entryReason,
    setupReason,
    triggerReason,
    exitTime: trade.exitTime,
    exitPrice: trade.exitPrice,
    exitReason: trade.exitReasonText || humanizeExitReason(trade.exitReason),
    exitReasonCode: trade.exitReason || '',
    profitLoss: trade.profitLoss,
    profitPips: trade.profitPips,
    module: trade.indicatorsAtEntry?.module || null,
  };
}

function buildPricePanel(strategyType, candles, indicators, resolvedParams, volumeFeatureSeries) {
  const series = [];

  if (strategyType === 'TrendFollowing') {
    series.push({
      id: 'ema20',
      type: 'line',
      title: 'EMA 20',
      color: '#f59e0b',
      values: buildAlignedNumericSeries(candles, indicators.ema20),
    });
    series.push({
      id: 'ema50',
      type: 'line',
      title: 'EMA 50',
      color: '#3b82f6',
      values: buildAlignedNumericSeries(candles, indicators.ema50),
    });
  } else if (strategyType === 'MeanReversion') {
    series.push({
      id: 'bbUpper',
      type: 'line',
      title: 'BB Upper',
      color: '#f59e0b',
      values: buildAlignedNumericSeries(candles, indicators.bollingerBands, (value) => value.upper),
    });
    series.push({
      id: 'bbMiddle',
      type: 'line',
      title: 'BB Middle',
      color: '#94a3b8',
      values: buildAlignedNumericSeries(candles, indicators.bollingerBands, (value) => value.middle),
    });
    series.push({
      id: 'bbLower',
      type: 'line',
      title: 'BB Lower',
      color: '#10b981',
      values: buildAlignedNumericSeries(candles, indicators.bollingerBands, (value) => value.lower),
    });
  } else if (strategyType === 'Momentum') {
    series.push({
      id: 'ema50',
      type: 'line',
      title: 'EMA 50',
      color: '#3b82f6',
      values: buildAlignedNumericSeries(candles, indicators.ema50),
    });
  } else if (strategyType === 'Breakout') {
    const structure = buildBreakoutStructureSeries(candles, resolvedParams.lookback_period);
    series.push({
      id: 'breakoutHigh',
      type: 'line',
      title: 'Lookback High',
      color: '#ef4444',
      values: structure.highSeries,
    });
    series.push({
      id: 'breakoutLow',
      type: 'line',
      title: 'Lookback Low',
      color: '#10b981',
      values: structure.lowSeries,
    });
    series.push({
      id: 'structureMid',
      type: 'line',
      title: 'Structure Mid',
      color: '#94a3b8',
      values: structure.midpointSeries,
    });
  } else if (strategyType === 'MultiTimeframe') {
    series.push({
      id: 'ema200',
      type: 'line',
      title: 'EMA 200',
      color: '#8b5cf6',
      values: buildAlignedNumericSeries(candles, indicators.ema200),
    });
  } else if (strategyType === 'VolumeFlowHybrid') {
    series.push({
      id: 'ema20',
      type: 'line',
      title: 'EMA 20',
      color: '#f59e0b',
      values: buildAlignedNumericSeries(candles, indicators.ema20),
    });
    series.push({
      id: 'ema50',
      type: 'line',
      title: 'EMA 50',
      color: '#3b82f6',
      values: buildAlignedNumericSeries(candles, indicators.ema50),
    });
    series.push({
      id: 'sessionVwap',
      type: 'line',
      title: 'Session VWAP',
      color: '#22d3ee',
      values: buildAlignedFeatureSeries(candles, volumeFeatureSeries, (feature) => feature.sessionVwap),
    });
  }

  return {
    id: 'price',
    kind: 'price',
    title: 'Price',
    series,
  };
}

function buildStrategyPanels(strategyType, candles, indicators, volumeFeatureSeries) {
  if (strategyType === 'TrendFollowing') {
    return [
      {
        id: 'rsi',
        kind: 'oscillator',
        title: 'RSI',
        referenceLines: [30, 50, 70],
        series: [
          {
            id: 'rsi',
            type: 'line',
            title: 'RSI',
            color: '#22c55e',
            values: buildAlignedNumericSeries(candles, indicators.rsi, (value) => value, 3),
          },
        ],
      },
      {
        id: 'volume',
        kind: 'volume',
        title: 'Volume',
        series: [
          {
            id: 'volume',
            type: 'histogram',
            title: 'Volume',
            color: '#64748b',
            values: buildVolumeHistogram(candles),
          },
        ],
      },
    ];
  }

  if (strategyType === 'MeanReversion') {
    return [
      {
        id: 'rsi',
        kind: 'oscillator',
        title: 'RSI',
        referenceLines: [30, 50, 70],
        series: [
          {
            id: 'rsi',
            type: 'line',
            title: 'RSI',
            color: '#22c55e',
            values: buildAlignedNumericSeries(candles, indicators.rsi, (value) => value, 3),
          },
        ],
      },
      {
        id: 'volume',
        kind: 'volume',
        title: 'Volume',
        series: [
          {
            id: 'volume',
            type: 'histogram',
            title: 'Volume',
            color: '#64748b',
            values: buildVolumeHistogram(candles),
          },
        ],
      },
    ];
  }

  if (strategyType === 'Momentum') {
    return [
      {
        id: 'macd',
        kind: 'oscillator',
        title: 'MACD',
        series: [
          {
            id: 'macdLine',
            type: 'line',
            title: 'MACD',
            color: '#3b82f6',
            values: buildAlignedNumericSeries(candles, indicators.macd, (value) => value.MACD, 5),
          },
          {
            id: 'macdSignal',
            type: 'line',
            title: 'Signal',
            color: '#f59e0b',
            values: buildAlignedNumericSeries(candles, indicators.macd, (value) => value.signal, 5),
          },
          {
            id: 'macdHistogram',
            type: 'histogram',
            title: 'Histogram',
            color: '#64748b',
            values: buildAlignedNumericSeries(candles, indicators.macd, (value) => value.histogram, 5)
              .map((point) => ({
                ...point,
                color: point.value >= 0 ? 'rgba(16,185,129,0.65)' : 'rgba(239,68,68,0.65)',
              })),
          },
        ],
      },
      {
        id: 'rsi',
        kind: 'oscillator',
        title: 'RSI',
        referenceLines: [30, 50, 70],
        series: [
          {
            id: 'rsi',
            type: 'line',
            title: 'RSI',
            color: '#22c55e',
            values: buildAlignedNumericSeries(candles, indicators.rsi, (value) => value, 3),
          },
        ],
      },
      {
        id: 'volume',
        kind: 'volume',
        title: 'Volume',
        series: [
          {
            id: 'volume',
            type: 'histogram',
            title: 'Volume',
            color: '#64748b',
            values: buildVolumeHistogram(candles),
          },
        ],
      },
    ];
  }

  if (strategyType === 'Breakout') {
    return [
      {
        id: 'rsi',
        kind: 'oscillator',
        title: 'RSI',
        referenceLines: [30, 50, 70],
        series: [
          {
            id: 'rsi',
            type: 'line',
            title: 'RSI',
            color: '#22c55e',
            values: buildAlignedNumericSeries(candles, indicators.rsi, (value) => value, 3),
          },
        ],
      },
      {
        id: 'volume',
        kind: 'volume',
        title: 'Volume',
        series: [
          {
            id: 'volume',
            type: 'histogram',
            title: 'Volume',
            color: '#64748b',
            values: buildVolumeHistogram(candles),
          },
        ],
      },
    ];
  }

  if (strategyType === 'MultiTimeframe') {
    return [
      {
        id: 'macd',
        kind: 'oscillator',
        title: 'MACD',
        series: [
          {
            id: 'macdLine',
            type: 'line',
            title: 'MACD',
            color: '#3b82f6',
            values: buildAlignedNumericSeries(candles, indicators.macd, (value) => value.MACD, 5),
          },
          {
            id: 'macdSignal',
            type: 'line',
            title: 'Signal',
            color: '#f59e0b',
            values: buildAlignedNumericSeries(candles, indicators.macd, (value) => value.signal, 5),
          },
          {
            id: 'macdHistogram',
            type: 'histogram',
            title: 'Histogram',
            color: '#64748b',
            values: buildAlignedNumericSeries(candles, indicators.macd, (value) => value.histogram, 5)
              .map((point) => ({
                ...point,
                color: point.value >= 0 ? 'rgba(16,185,129,0.65)' : 'rgba(239,68,68,0.65)',
              })),
          },
        ],
      },
      {
        id: 'stochastic',
        kind: 'oscillator',
        title: 'Stochastic',
        referenceLines: [20, 50, 80],
        series: [
          {
            id: 'stochK',
            type: 'line',
            title: '%K',
            color: '#22c55e',
            values: buildAlignedNumericSeries(candles, indicators.stochastic, (value) => value.k, 3),
          },
          {
            id: 'stochD',
            type: 'line',
            title: '%D',
            color: '#e879f9',
            values: buildAlignedNumericSeries(candles, indicators.stochastic, (value) => value.d, 3),
          },
        ],
      },
      {
        id: 'volume',
        kind: 'volume',
        title: 'Volume',
        series: [
          {
            id: 'volume',
            type: 'histogram',
            title: 'Volume',
            color: '#64748b',
            values: buildVolumeHistogram(candles),
          },
        ],
      },
    ];
  }

  if (strategyType === 'VolumeFlowHybrid') {
    return [
      {
        id: 'delta',
        kind: 'oscillator',
        title: 'Cumulative Delta',
        series: [
          {
            id: 'cumulativeDelta',
            type: 'line',
            title: 'Cumulative Delta',
            color: '#22c55e',
            values: buildAlignedFeatureSeries(candles, volumeFeatureSeries, (feature) => feature.cumulativeDelta, 2),
          },
        ],
      },
      {
        id: 'rvol',
        kind: 'oscillator',
        title: 'RVOL',
        series: [
          {
            id: 'rvol',
            type: 'line',
            title: 'RVOL',
            color: '#f59e0b',
            values: buildAlignedFeatureSeries(candles, volumeFeatureSeries, (feature) => feature.rvol, 3),
          },
        ],
      },
      {
        id: 'volume',
        kind: 'volume',
        title: 'Volume',
        series: [
          {
            id: 'volume',
            type: 'histogram',
            title: 'Volume',
            color: '#64748b',
            values: buildVolumeHistogram(candles),
          },
        ],
      },
    ];
  }

  return [];
}

function buildTradeMarkers(tradeEvents) {
  const markers = [];
  (tradeEvents || []).forEach((trade) => {
    if (trade.entryTime && Number.isFinite(Number(trade.entryPrice))) {
      markers.push({
        tradeId: trade.tradeId,
        stage: 'entry',
        time: trade.entryTime,
        price: normalizeNumber(trade.entryPrice, 5),
        direction: trade.direction,
        label: trade.direction === 'BUY' ? 'Buy' : 'Sell',
      });
    }
    if (trade.exitTime && Number.isFinite(Number(trade.exitPrice))) {
      markers.push({
        tradeId: trade.tradeId,
        stage: 'exit',
        time: trade.exitTime,
        price: normalizeNumber(trade.exitPrice, 5),
        direction: trade.direction,
        label: trade.profitLoss >= 0 ? 'Exit +' : 'Exit -',
      });
    }
  });
  return markers;
}

function filterValuesByRange(values, startMs, endMs) {
  return (values || []).filter((point) => {
    const time = new Date(point.time).getTime();
    if (startMs != null && time < startMs) return false;
    if (endMs != null && time > endMs) return false;
    return true;
  });
}

function getDefaultVisibleRange(candles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    return { from: null, to: null };
  }

  const windowSize = Math.min(160, candles.length);
  return {
    from: candles[Math.max(0, candles.length - windowSize)].time,
    to: candles[candles.length - 1].time,
  };
}

function buildChartData({
  symbol,
  strategyType,
  timeframe,
  candles,
  indicators,
  resolvedParams,
  tradeStartTime,
  tradeEndTime,
  trades = [],
  volumeFeatureSeries = [],
}) {
  const startMs = tradeStartTime ? new Date(tradeStartTime).getTime() : null;
  const endMs = tradeEndTime ? new Date(tradeEndTime).getTime() : null;
  const displayCandles = (candles || []).filter((candle) => {
    const time = new Date(candle.time).getTime();
    if (startMs != null && time < startMs) return false;
    if (endMs != null && time > endMs) return false;
    return true;
  });

  const fullIndicators = indicators || indicatorService.calculateForStrategy(strategyType, candles, resolvedParams);
  const fullVolumeFeatures = strategyType === 'VolumeFlowHybrid'
    ? (Array.isArray(volumeFeatureSeries) && volumeFeatureSeries.length > 0
      ? volumeFeatureSeries
      : volumeFeatureService.buildFeatureSeries(candles, {
        volumeAvgPeriod: Math.max(5, Math.round(Number(resolvedParams.volume_avg_period) || 20)),
        deltaSmoothing: Math.max(2, Math.round(Number(resolvedParams.cumulative_delta_smoothing) || 8)),
      }))
    : null;

  const tradeEvents = trades.map(buildTradeEvent);
  const panels = [
    buildPricePanel(strategyType, candles, fullIndicators, resolvedParams, fullVolumeFeatures),
    ...buildStrategyPanels(strategyType, candles, fullIndicators, fullVolumeFeatures),
  ].map((panel) => ({
    ...panel,
    series: (panel.series || []).map((series) => ({
      ...series,
      values: filterValuesByRange(series.values, startMs, endMs),
    })),
  }));

  return {
    symbol,
    strategy: strategyType,
    effectiveTimeframe: timeframe,
    period: {
      start: tradeStartTime,
      end: tradeEndTime,
    },
    candles: displayCandles.map((candle) => ({
      time: candle.time,
      open: normalizeNumber(candle.open, 5),
      high: normalizeNumber(candle.high, 5),
      low: normalizeNumber(candle.low, 5),
      close: normalizeNumber(candle.close, 5),
      volume: normalizeNumber(volumeFeatureService.resolveVolume(candle), 2) || 0,
    })),
    panels,
    tradeEvents,
    tradeMarkers: buildTradeMarkers(tradeEvents),
    defaultVisibleRange: getDefaultVisibleRange(displayCandles),
  };
}

module.exports = {
  buildChartData,
  humanizeExitReason,
};
