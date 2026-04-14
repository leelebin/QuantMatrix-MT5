/**
 * Multi-Timeframe Strategy
 * For Metals: XAUUSD (Gold), XAGUSD (Silver)
 *
 * Higher TF (H4) confirms trend direction via EMA200.
 * Setup TF (H1) forms the directional setup via MACD histogram turns.
 * Entry TF (M15) triggers execution via MACD + stochastic confirmation.
 *
 * SL/TP remain based on the H1 ATR framework.
 */

const BaseStrategy = require('./BaseStrategy');

class MultiTimeframeStrategy extends BaseStrategy {
  constructor() {
    super('MultiTimeframe', 'Multi-timeframe MACD + Stochastic for metals');
    this.higherTfTrend = null;
  }

  buildExitPlan(/* instrument, signal, indicators, context */) {
    // TP = 5x ATR. Wider trail so large metal swings aren't cut short, plus
    // a 2x ATR partial to lock in structural profit.
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
        mode: 'atr',
      },
      partials: [
        { atProfitAtr: 2.0, closeFraction: 0.4, label: 'mtf_tp1' },
      ],
      timeExit: null,
      adaptiveEvaluator: 'MultiTimeframe',
    };
  }

  /**
   * Adaptive exit for multi-timeframe.
   *   ① Higher-TF trend has flipped against position — force aggressive
   *      exit, the structural backdrop is gone.
   *   ② MACD histogram flipped against us — tighten trail.
   */
  evaluateExit(position, context = {}) {
    const { indicators } = context;
    if (!indicators) return null;

    const direction = position?.type;
    if (this.higherTfTrend && this.higherTfTrend.trend) {
      const htfAgainst =
        (direction === 'BUY' && this.higherTfTrend.trend === 'BEARISH')
        || (direction === 'SELL' && this.higherTfTrend.trend === 'BULLISH');
      if (htfAgainst) {
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
    }

    const currentMacd = this.latest(indicators.macd);
    if (currentMacd) {
      const histAgainst = direction === 'BUY'
        ? currentMacd.histogram <= 0
        : currentMacd.histogram >= 0;
      if (histAgainst) {
        return {
          trailing: {
            enabled: true,
            startAtrMultiple: 1.5,
            distanceAtrMultiple: 1.0,
            mode: 'atr',
          },
        };
      }
    }

    return null;
  }

  setHigherTimeframeTrend(trend, data) {
    this.higherTfTrend = { trend, ...data };
  }

  analyze(candles, indicators, instrument, context = {}) {
    const { ema200, macd, stochastic, atr } = indicators;

    if (!macd || !stochastic || !atr || macd.length < 2 || stochastic.length < 2) {
      return this.noSignal();
    }

    const currentPrice = this.latestCandle(candles).close;
    const currentMacd = this.latest(macd);
    const currentStoch = this.latest(stochastic);
    const currentAtr = this.latest(atr);
    const currentEma200 = this.latest(ema200);

    if (!currentMacd || !currentStoch || !currentAtr) {
      return this.noSignal();
    }

    let trendDirection = 'NEUTRAL';
    if (this.higherTfTrend) {
      trendDirection = this.higherTfTrend.trend;
    } else if (currentEma200) {
      trendDirection = currentPrice > currentEma200 ? 'BULLISH' : 'BEARISH';
    }

    const setup = this._buildSetup(candles, indicators, instrument, trendDirection);
    const snapshot = {
      ema200: currentEma200,
      macdLine: currentMacd.MACD,
      macdSignal: currentMacd.signal,
      macdHistogram: currentMacd.histogram,
      stochK: currentStoch.k,
      stochD: currentStoch.d,
      atr: currentAtr,
      price: currentPrice,
      higherTfTrend: trendDirection,
    };

    if (!setup) {
      return this.noSignal({
        setupTimeframe: instrument.timeframe || '1h',
        entryTimeframe: instrument.entryTimeframe || null,
      });
    }

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
      entryMacdHistogram: trigger.currentMacd.histogram,
      entryStochK: trigger.currentStoch.k,
      entryStochD: trigger.currentStoch.d,
      entryAtr: trigger.currentAtr,
      entryPrice: trigger.currentPrice,
      entryTimeframe: instrument.entryTimeframe,
    }, {
      triggerReason: trigger.reason,
      entryCandleTime: trigger.entryCandleTime,
    });
  }

  _buildSetup(candles, indicators, instrument, trendDirection) {
    const { macd, stochastic, atr } = indicators;
    const currentPrice = this.latestCandle(candles).close;
    const currentMacd = this.latest(macd);
    const currentStoch = this.latest(stochastic);
    const currentAtr = this.latest(atr);

    if (!currentMacd || !currentStoch || !currentAtr || trendDirection === 'NEUTRAL') {
      return null;
    }

    const recentMacdTurn = this._findRecentMacdTurn(macd, trendDirection);
    if (!recentMacdTurn) {
      return null;
    }

    const stochMomentumOk = trendDirection === 'BULLISH'
      ? currentStoch.k > currentStoch.d
      : currentStoch.k < currentStoch.d;
    if (!stochMomentumOk) {
      return null;
    }

    const direction = trendDirection === 'BULLISH' ? 'BUY' : 'SELL';
    const sl = direction === 'BUY'
      ? currentPrice - (instrument.riskParams.slMultiplier * currentAtr)
      : currentPrice + (instrument.riskParams.slMultiplier * currentAtr);
    const tp = direction === 'BUY'
      ? currentPrice + (instrument.riskParams.tpMultiplier * currentAtr)
      : currentPrice - (instrument.riskParams.tpMultiplier * currentAtr);

    return {
      direction,
      confidence: this._calcConfidence(currentStoch, currentMacd, trendDirection),
      sl,
      tp,
      setupCandleTime: candles[candles.length - 1 - recentMacdTurn.offset]?.time || this.latestCandle(candles).time,
      reason: direction === 'BUY'
        ? '1h BUY setup: bullish higher-timeframe trend + MACD histogram turned positive + stochastic momentum aligned'
        : '1h SELL setup: bearish higher-timeframe trend + MACD histogram turned negative + stochastic momentum aligned',
    };
  }

  _findRecentMacdTurn(macd, trendDirection, maxAge = 2) {
    const maxOffset = Math.min(maxAge - 1, macd.length - 2);
    for (let offset = 0; offset <= maxOffset; offset++) {
      const prevMacd = this.latest(macd, offset + 1);
      const currentMacd = this.latest(macd, offset);
      if (!prevMacd || !currentMacd) continue;

      if (trendDirection === 'BULLISH' && prevMacd.histogram <= 0 && currentMacd.histogram > 0) {
        return { offset };
      }
      if (trendDirection === 'BEARISH' && prevMacd.histogram >= 0 && currentMacd.histogram < 0) {
        return { offset };
      }
    }
    return null;
  }

  _buildEntryTrigger(entryCandles, entryIndicators, direction) {
    const { macd, stochastic, atr } = entryIndicators;

    if (!entryCandles || entryCandles.length < 2 || !macd || !stochastic || !atr || macd.length < 2 || stochastic.length < 2) {
      return { triggered: false, reason: 'Waiting for 15m data' };
    }

    const currentCandle = this.latestCandle(entryCandles);
    const currentMacd = this.latest(macd);
    const currentStoch = this.latest(stochastic);
    const prevStoch = this.latest(stochastic, 1);
    const currentAtr = this.latest(atr);
    const avgAtr = this.average(atr, 20);

    if (!currentMacd || !currentStoch || !prevStoch || !currentAtr || !avgAtr) {
      return { triggered: false, reason: 'Waiting for 15m indicators' };
    }

    if (currentAtr < avgAtr * 0.7) {
      return { triggered: false, reason: '15m trigger blocked: volatility too low' };
    }

    if (direction === 'BUY') {
      const stochCrossUp = prevStoch.k <= prevStoch.d && currentStoch.k > currentStoch.d;
      if (!(currentMacd.histogram > 0 && stochCrossUp)) {
        return { triggered: false, reason: '15m BUY trigger waiting for MACD > 0 and stochastic cross up' };
      }
      return {
        triggered: true,
        reason: '15m BUY trigger: MACD histogram positive with stochastic cross up',
        currentMacd,
        currentStoch,
        currentAtr,
        currentPrice: currentCandle.close,
        entryCandleTime: currentCandle.time,
      };
    }

    const stochCrossDown = prevStoch.k >= prevStoch.d && currentStoch.k < currentStoch.d;
    if (!(currentMacd.histogram < 0 && stochCrossDown)) {
      return { triggered: false, reason: '15m SELL trigger waiting for MACD < 0 and stochastic cross down' };
    }
    return {
      triggered: true,
      reason: '15m SELL trigger: MACD histogram negative with stochastic cross down',
      currentMacd,
      currentStoch,
      currentAtr,
      currentPrice: currentCandle.close,
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

  _calcConfidence(stoch, macd, trend) {
    let confidence = 0.5;
    if (trend !== 'NEUTRAL') confidence += 0.1;
    if (stoch.k < 20 || stoch.k > 80) confidence += 0.15;
    if (Math.abs(macd.histogram) > Math.abs(macd.signal) * 0.5) confidence += 0.1;
    return Math.min(confidence, 0.95);
  }
}

module.exports = MultiTimeframeStrategy;
