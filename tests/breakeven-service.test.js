const breakevenService = require('../src/services/breakevenService');

describe('breakeven service', () => {
  const instrument = {
    spread: 1.5,
    pipSize: 0.0001,
  };

  test('resolveEffectiveBreakeven merges active profile defaults with strategy overrides', () => {
    const activeProfile = {
      tradeManagement: {
        breakeven: {
          enabled: true,
          triggerAtrMultiple: 0.9,
          includeSpreadCompensation: true,
          extraBufferPips: 0,
          trailStartAtrMultiple: 1.7,
          trailDistanceAtrMultiple: 1.1,
        },
      },
    };
    const strategy = {
      tradeManagement: {
        breakevenOverride: {
          triggerAtrMultiple: 0.6,
          extraBufferPips: 2,
        },
      },
    };

    expect(breakevenService.resolveEffectiveBreakeven(activeProfile, strategy)).toEqual({
      enabled: true,
      triggerAtrMultiple: 0.6,
      includeSpreadCompensation: true,
      extraBufferPips: 2,
      trailStartAtrMultiple: 1.7,
      trailDistanceAtrMultiple: 1.1,
    });
  });

  test('calculateBreakevenStop applies spread compensation and buffer for BUY positions', () => {
    const result = breakevenService.calculateBreakevenStop(
      {
        type: 'BUY',
        entryPrice: 1.1,
        currentSl: 1.095,
        atrAtEntry: 0.001,
        breakevenConfig: {
          enabled: true,
          triggerAtrMultiple: 0.8,
          includeSpreadCompensation: true,
          extraBufferPips: 2,
          trailStartAtrMultiple: 1.5,
          trailDistanceAtrMultiple: 1.0,
        },
      },
      1.1009,
      instrument
    );

    expect(result).toEqual(expect.objectContaining({
      shouldUpdate: true,
      phase: 'breakeven',
      newSl: 1.10035,
    }));
  });

  test('calculateBreakevenStop trails SELL positions once the trailing threshold is reached', () => {
    const result = breakevenService.calculateBreakevenStop(
      {
        type: 'SELL',
        entryPrice: 1.1,
        currentSl: 1.104,
        atrAtEntry: 0.001,
        breakevenConfig: {
          enabled: true,
          triggerAtrMultiple: 0.8,
          includeSpreadCompensation: true,
          extraBufferPips: 0,
          trailStartAtrMultiple: 1.5,
          trailDistanceAtrMultiple: 1.0,
        },
      },
      1.0983,
      instrument
    );

    expect(result).toEqual(expect.objectContaining({
      shouldUpdate: true,
      phase: 'trailing',
      newSl: 1.0993,
    }));
  });

  test('legacy positions without a snapshot keep the old 1.0 ATR breakeven trigger', () => {
    const result = breakevenService.calculateBreakevenStop(
      {
        type: 'BUY',
        entryPrice: 1.1,
        currentSl: 1.095,
        atrAtEntry: 0.001,
      },
      1.1009,
      instrument
    );

    expect(result.shouldUpdate).toBe(false);
    expect(result.phase).toBe('initial');
  });

  test('disabled breakeven config does not modify stops', () => {
    const result = breakevenService.calculateBreakevenStop(
      {
        type: 'BUY',
        entryPrice: 1.1,
        currentSl: 1.095,
        atrAtEntry: 0.001,
        breakevenConfig: {
          enabled: false,
          triggerAtrMultiple: 0.8,
          includeSpreadCompensation: true,
          extraBufferPips: 0,
          trailStartAtrMultiple: 1.5,
          trailDistanceAtrMultiple: 1.0,
        },
      },
      1.1012,
      instrument
    );

    expect(result.shouldUpdate).toBe(false);
    expect(result.phase).toBe('disabled');
  });
});
