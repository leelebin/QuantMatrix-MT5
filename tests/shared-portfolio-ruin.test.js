jest.mock('../src/services/backtestEngine', () => ({
  _buildTradingInstrument: jest.fn(),
  _createStrategy: jest.fn(),
  _buildIndicators: jest.fn(),
  _prepareIndicatorSeries: jest.fn(),
  _buildVolumeFeatureSeries: jest.fn(),
  _strategyNeedsEntryIndicators: jest.fn(),
  _createRollingArrayWindowState: jest.fn(),
  _createRollingIndicatorWindowState: jest.fn(),
  _advanceRollingArrayWindowState: jest.fn(),
  _advanceRollingIndicatorWindowState: jest.fn(),
  _buildHigherTimeframeTrendSeries: jest.fn(),
  _sliceIndicatorWindow: jest.fn(),
  _applyHigherTimeframeTrend: jest.fn(),
  _checkSlTp: jest.fn(),
  _simulateTrailingStop: jest.fn(),
  _closeTrade: jest.fn(),
}));

jest.mock('../src/services/breakevenService', () => ({
  getDefaultBreakevenConfig: jest.fn(),
  normalizeBreakevenConfig: jest.fn(),
  DEFAULT_BREAKEVEN_CONFIG: {},
}));

jest.mock('../src/config/instruments', () => ({
  getInstrument: jest.fn(),
}));

jest.mock('../src/config/strategyParameters', () => ({
  resolveStrategyParameters: jest.fn(),
}));

jest.mock('../src/config/strategyExecution', () => ({
  getStrategyExecutionConfig: jest.fn(),
  getForcedTimeframeExecutionConfig: jest.fn(),
}));

const backtestEngine = require('../src/services/backtestEngine');
const breakevenService = require('../src/services/breakevenService');
const { getInstrument } = require('../src/config/instruments');
const { resolveStrategyParameters } = require('../src/config/strategyParameters');
const { getStrategyExecutionConfig } = require('../src/config/strategyExecution');
const { runSharedPortfolioBacktest } = require('../src/services/sharedPortfolioBacktest');

function createCandles() {
  const startMs = new Date('2025-01-01T00:00:00.000Z').getTime();
  const stepMs = 60 * 60 * 1000;

  return Array.from({ length: 320 }, (_, index) => {
    let open = 100;
    let close = 100;

    if (index >= 251) {
      open = 100 - (index - 251);
      close = 99 - (index - 251);
    }

    return {
      time: new Date(startMs + index * stepMs).toISOString(),
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      tickVolume: 1000,
      spread: 0,
      volume: 1000,
    };
  });
}

function createFetchCandles(candles) {
  return jest.fn(async () => ({
    candles,
    inRangeCandles: candles,
  }));
}

describe('shared portfolio ruin stop', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    getInstrument.mockImplementation((symbol) => ({
      symbol,
      spread: 0,
      pipSize: 0,
    }));

    resolveStrategyParameters.mockReturnValue({});
    getStrategyExecutionConfig.mockImplementation((symbol, strategy) => ({
      symbol,
      strategy,
      timeframe: '1h',
      higherTimeframe: null,
      entryTimeframe: null,
    }));

    breakevenService.getDefaultBreakevenConfig.mockReturnValue({ enabled: false });
    breakevenService.normalizeBreakevenConfig.mockReturnValue({ enabled: false });

    backtestEngine._buildTradingInstrument.mockReturnValue({
      pipSize: 1,
      pipValue: 1,
      minLot: 1,
      lotStep: 1,
      contractSize: 20,
      riskParams: { riskPercent: 1 },
    });
    backtestEngine._buildIndicators.mockImplementation((candles) => ({
      atr: candles.map(() => 1),
    }));
    backtestEngine._prepareIndicatorSeries.mockImplementation((indicators) => indicators);
    backtestEngine._buildVolumeFeatureSeries.mockReturnValue(null);
    backtestEngine._strategyNeedsEntryIndicators.mockReturnValue(false);
    backtestEngine._createRollingArrayWindowState.mockImplementation((candles) => ({ candles }));
    backtestEngine._createRollingIndicatorWindowState.mockImplementation((indicators) => ({ indicators }));
    backtestEngine._advanceRollingArrayWindowState.mockImplementation((state, barIdx) => (
      state && state.candles ? state.candles.slice(0, barIdx + 1) : []
    ));
    backtestEngine._advanceRollingIndicatorWindowState.mockImplementation((state, barIdx) => {
      const ind = state && state.indicators ? state.indicators : {};
      const out = {};
      Object.keys(ind).forEach((key) => {
        out[key] = Array.isArray(ind[key]) ? ind[key].slice(0, barIdx + 1) : ind[key];
      });
      return out;
    });
    backtestEngine._buildHigherTimeframeTrendSeries.mockReturnValue(null);
    backtestEngine._sliceIndicatorWindow.mockImplementation((indicators, _length, start, end) => ({
      atr: indicators.atr.slice(start, end),
    }));
    backtestEngine._applyHigherTimeframeTrend.mockImplementation(() => {});
    backtestEngine._checkSlTp.mockReturnValue(null);
    backtestEngine._simulateTrailingStop.mockReturnValue({ updated: false });
    backtestEngine._closeTrade.mockImplementation((position, exitPrice, reason, exitTime, tradingInstrument) => ({
      ...position,
      exitPrice,
      exitTime,
      reason,
      profitLoss: (position.type === 'BUY'
        ? exitPrice - position.entryPrice
        : position.entryPrice - exitPrice) * position.lotSize * tradingInstrument.contractSize,
    }));
    backtestEngine._createStrategy.mockImplementation(() => {
      let signaled = false;
      return {
        analyze() {
          if (signaled) {
            return { signal: 'NONE' };
          }
          signaled = true;
          return {
            signal: 'BUY',
            sl: 50,
            tp: 150,
            reason: 'test-entry',
            indicatorsSnapshot: null,
          };
        },
      };
    });
  });

  test('triggers bust, force-closes open positions, and stops the event loop early', async () => {
    const candles = createCandles();
    const result = await runSharedPortfolioBacktest({
      combinations: [
        { symbol: 'EURUSD', strategy: 'TrendFollowing' },
        { symbol: 'USDJPY', strategy: 'Momentum' },
      ],
      initialBalance: 100,
      ruinThreshold: 0,
      start: candles[0].time,
      endExclusive: new Date(new Date(candles[candles.length - 1].time).getTime() + 60 * 60 * 1000).toISOString(),
      fetchCandles: createFetchCandles(candles),
      storedParametersByStrategy: new Map(),
      breakevenByStrategy: new Map(),
    });

    expect(result.bust).toEqual(expect.objectContaining({
      triggered: true,
      reason: 'RUIN_EQUITY',
    }));
    expect(result.bust.forcedCloseCount).toBeGreaterThanOrEqual(2);
    expect(result.bust.remainingEventsSkipped).toBeGreaterThan(0);
    expect(result.trades.filter((trade) => trade.reason === 'BUST')).toHaveLength(2);

    const lastEquityPoint = result.equityCurve[result.equityCurve.length - 1];
    expect(new Date(lastEquityPoint.time).getTime()).toBeLessThan(new Date(candles[candles.length - 1].time).getTime());
  });

  test('higher ruin thresholds trigger earlier than zero', async () => {
    const candles = createCandles();
    const baseArgs = {
      combinations: [
        { symbol: 'EURUSD', strategy: 'TrendFollowing' },
        { symbol: 'USDJPY', strategy: 'Momentum' },
      ],
      initialBalance: 100,
      start: candles[0].time,
      endExclusive: new Date(new Date(candles[candles.length - 1].time).getTime() + 60 * 60 * 1000).toISOString(),
      fetchCandles: createFetchCandles(candles),
      storedParametersByStrategy: new Map(),
      breakevenByStrategy: new Map(),
    };

    const bustAtZero = await runSharedPortfolioBacktest({
      ...baseArgs,
      ruinThreshold: 0,
    });
    const bustAtHalf = await runSharedPortfolioBacktest({
      ...baseArgs,
      ruinThreshold: 50,
    });

    expect(bustAtZero.bust.triggered).toBe(true);
    expect(bustAtHalf.bust.triggered).toBe(true);
    expect(new Date(bustAtHalf.bust.time).getTime()).toBeLessThan(new Date(bustAtZero.bust.time).getTime());
  });
});
