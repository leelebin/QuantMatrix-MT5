const trailingStopService = require('../src/services/trailingStopService');

function buildExitPlan(overrides = {}) {
  return {
    breakeven: {
      enabled: false,
      triggerAtrMultiple: 0.8,
      includeSpreadCompensation: false,
      extraBufferPips: 0,
    },
    trailing: {
      enabled: false,
      startAtrMultiple: 1.5,
      distanceAtrMultiple: 1.0,
      mode: 'atr',
    },
    partials: [],
    timeExit: null,
    adaptiveEvaluator: null,
    ...overrides,
  };
}

describe('trailingStopService.processPositions partial management', () => {
  test('fires partial closes and persists remaining lot size', async () => {
    const partialCloseFn = jest.fn().mockResolvedValue({ success: true });
    const updatePositionFn = jest.fn().mockResolvedValue(1);
    const modifyFn = jest.fn().mockResolvedValue(true);

    const position = {
      _id: 'pos-1',
      symbol: 'EURUSD',
      type: 'BUY',
      entryPrice: 1.1,
      currentSl: 1.095,
      currentTp: 1.11,
      lotSize: 0.5,
      originalLotSize: 0.5,
      mt5PositionId: '7001',
      atrAtEntry: 0.001,
      partialsExecutedIndices: [],
      maxFavourablePrice: 1.1,
      exitPlan: buildExitPlan({
        partials: [{ atProfitAtr: 1.0, closeFraction: 0.4, label: 'tp1' }],
      }),
    };

    const updates = await trailingStopService.processPositions(
      [position],
      async () => ({ bid: 1.1025, ask: 1.1027 }),
      modifyFn,
      {
        partialCloseFn,
        updatePositionFn,
      }
    );

    expect(partialCloseFn).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'pos-1', maxFavourablePrice: 1.1025 }),
      0.2,
      expect.objectContaining({ label: 'tp1' })
    );
    expect(updatePositionFn).toHaveBeenCalledWith(
      'pos-1',
      expect.objectContaining({
        partialsExecutedIndices: [0],
        lotSize: 0.3,
      })
    );
    expect(updatePositionFn).toHaveBeenCalledWith(
      'pos-1',
      expect.objectContaining({
        maxFavourablePrice: 1.1025,
      })
    );
    expect(modifyFn).not.toHaveBeenCalled();
    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'PARTIAL_TP',
        positionId: '7001',
        volumeClosed: 0.2,
      }),
    ]));
  });

  test('does not refire partials that were already executed', async () => {
    const partialCloseFn = jest.fn().mockResolvedValue({ success: true });
    const updatePositionFn = jest.fn().mockResolvedValue(1);

    const position = {
      _id: 'pos-2',
      symbol: 'EURUSD',
      type: 'BUY',
      entryPrice: 1.1,
      currentSl: 1.095,
      currentTp: 1.11,
      lotSize: 0.3,
      originalLotSize: 0.5,
      mt5PositionId: '7002',
      atrAtEntry: 0.001,
      partialsExecutedIndices: [0],
      maxFavourablePrice: 1.1,
      exitPlan: buildExitPlan({
        partials: [{ atProfitAtr: 1.0, closeFraction: 0.4, label: 'tp1' }],
      }),
    };

    await trailingStopService.processPositions(
      [position],
      async () => ({ bid: 1.1025, ask: 1.1027 }),
      async () => true,
      {
        partialCloseFn,
        updatePositionFn,
      }
    );

    expect(partialCloseFn).not.toHaveBeenCalled();
  });

  test('light scan skips adaptive evaluateExit hooks', async () => {
    const evaluateExit = jest.fn(() => ({
      trailing: {
        enabled: true,
        startAtrMultiple: 1.0,
        distanceAtrMultiple: 0.5,
        mode: 'atr',
      },
    }));

    const position = {
      _id: 'pos-3',
      symbol: 'EURUSD',
      type: 'BUY',
      entryPrice: 1.1,
      currentSl: 1.095,
      currentTp: 1.11,
      lotSize: 0.3,
      originalLotSize: 0.3,
      mt5PositionId: '7003',
      strategy: 'Breakout',
      atrAtEntry: 0.001,
      partialsExecutedIndices: [],
      maxFavourablePrice: 1.1,
      exitPlan: buildExitPlan({
        adaptiveEvaluator: 'Breakout',
      }),
    };

    const modifyFn = jest.fn().mockResolvedValue(true);
    await trailingStopService.processPositions(
      [position],
      async () => ({ bid: 1.101, ask: 1.1012 }),
      modifyFn,
      {
        getStrategy: () => ({ evaluateExit }),
        getLiveContext: jest.fn().mockResolvedValue({
          candles: [],
          indicators: {},
        }),
      },
      {
        scanMode: 'light',
        cycleState: { fingerprints: new Set() },
        scanMetadataByPosition: new Map([
          ['pos-3', { scanReason: 'just_opened', category: 'forex', categoryFallback: false }],
        ]),
      }
    );

    expect(evaluateExit).not.toHaveBeenCalled();
    expect(modifyFn).not.toHaveBeenCalled();
  });

  test('deduplicates identical management actions across light and heavy scans in the same cycle', async () => {
    const modifyFn = jest.fn().mockResolvedValue(true);
    const cycleState = { fingerprints: new Set() };
    const position = {
      _id: 'pos-4',
      symbol: 'EURUSD',
      type: 'BUY',
      entryPrice: 1.1,
      currentSl: 1.095,
      currentTp: 1.11,
      lotSize: 0.2,
      originalLotSize: 0.2,
      mt5PositionId: '7004',
      atrAtEntry: 0.001,
      partialsExecutedIndices: [],
      maxFavourablePrice: 1.1,
      exitPlan: buildExitPlan({
        breakeven: {
          enabled: true,
          triggerAtrMultiple: 0.5,
          includeSpreadCompensation: false,
          extraBufferPips: 0,
        },
      }),
    };

    await trailingStopService.processPositions(
      [position],
      async () => ({ bid: 1.101, ask: 1.1012 }),
      modifyFn,
      {},
      {
        scanMode: 'light',
        cycleState,
        scanMetadataByPosition: new Map([
          ['pos-4', { scanReason: 'just_opened', category: 'forex', categoryFallback: false }],
        ]),
      }
    );

    await trailingStopService.processPositions(
      [position],
      async () => ({ bid: 1.101, ask: 1.1012 }),
      modifyFn,
      {},
      {
        scanMode: 'heavy',
        cycleState,
        scanMetadataByPosition: new Map([
          ['pos-4', { scanReason: 'just_opened', category: 'forex', categoryFallback: false }],
        ]),
      }
    );

    expect(modifyFn).toHaveBeenCalledTimes(1);
  });

  test('treats targetTp differences as different fingerprints', async () => {
    const modifyFn = jest.fn().mockResolvedValue(true);
    const cycleState = { fingerprints: new Set() };
    const basePosition = {
      _id: 'pos-5',
      symbol: 'EURUSD',
      type: 'BUY',
      entryPrice: 1.1,
      currentSl: 1.095,
      lotSize: 0.2,
      originalLotSize: 0.2,
      mt5PositionId: '7005',
      atrAtEntry: 0.001,
      partialsExecutedIndices: [],
      maxFavourablePrice: 1.1,
      exitPlan: buildExitPlan({
        breakeven: {
          enabled: true,
          triggerAtrMultiple: 0.5,
          includeSpreadCompensation: false,
          extraBufferPips: 0,
        },
      }),
    };

    await trailingStopService.processPositions(
      [{ ...basePosition, currentTp: 1.11 }],
      async () => ({ bid: 1.101, ask: 1.1012 }),
      modifyFn,
      {},
      {
        scanMode: 'light',
        cycleState,
        scanMetadataByPosition: new Map([
          ['pos-5', { scanReason: 'just_opened', category: 'forex', categoryFallback: false }],
        ]),
      }
    );

    await trailingStopService.processPositions(
      [{ ...basePosition, currentTp: 1.112 }],
      async () => ({ bid: 1.101, ask: 1.1012 }),
      modifyFn,
      {},
      {
        scanMode: 'heavy',
        cycleState,
        scanMetadataByPosition: new Map([
          ['pos-5', { scanReason: 'just_opened', category: 'forex', categoryFallback: false }],
        ]),
      }
    );

    expect(modifyFn).toHaveBeenCalledTimes(2);
  });
});
