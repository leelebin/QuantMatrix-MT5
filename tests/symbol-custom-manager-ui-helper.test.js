const {
  findMissingParameterSchemaFields,
  findMissingParameterKeys,
  hasMissingLogicSchema,
  buildSchemaSyncWarning,
  buildPaperReadiness,
} = require('../public/js/symbolCustomManager');

describe('symbolCustomManager schema sync UI helpers', () => {
  test('detects missing schema fields by comparing record schema to logic schema', () => {
    const record = {
      parameterSchema: [{ key: 'lookbackBars', type: 'number' }],
      parameters: { lookbackBars: 36 },
    };
    const logicSchema = [
      { key: 'lookbackBars', type: 'number' },
      { key: 'enableBuy', type: 'boolean' },
      { key: 'enableSell', type: 'boolean' },
    ];

    expect(findMissingParameterSchemaFields(record, logicSchema)).toEqual(['enableBuy', 'enableSell']);
  });

  test('detects missing parameter keys from logic defaults', () => {
    const record = {
      parameters: {
        lookbackBars: 36,
        enableBuy: false,
      },
    };

    expect(findMissingParameterKeys(record, {
      lookbackBars: 36,
      enableBuy: true,
      enableSell: true,
    })).toEqual(['enableSell']);
  });

  test('uses backend schemaSyncStatus when present', () => {
    const record = {
      schemaSyncStatus: {
        hasMissing: true,
        missingSchemaFields: ['cooldownBarsAfterSL'],
        missingParameters: ['cooldownBarsAfterSL'],
      },
    };

    expect(hasMissingLogicSchema(record)).toBe(true);
    expect(findMissingParameterSchemaFields(record)).toEqual(['cooldownBarsAfterSL']);
    expect(findMissingParameterKeys(record)).toEqual(['cooldownBarsAfterSL']);
    expect(buildSchemaSyncWarning(record)).toBe(
      'This SymbolCustom is missing parameters from its registered logic. Run Sync Parameters From Logic.'
    );
  });

  test('does not warn when schema and parameters are complete', () => {
    const record = {
      parameterSchema: [{ key: 'enableBuy' }],
      parameters: { enableBuy: true },
    };
    const logicSchema = [{ key: 'enableBuy' }];
    const logicDefaults = { enableBuy: true };

    expect(hasMissingLogicSchema(record, logicSchema, logicDefaults)).toBe(false);
    expect(buildSchemaSyncWarning(record, logicSchema, logicDefaults)).toBe('');
  });

  test('builds USDJPY paper readiness from stored candidate parameters and env status', () => {
    const readiness = buildPaperReadiness({
      _id: 'sc-usdjpy',
      logicName: 'USDJPY_JPY_MACRO_REVERSAL_V1',
      paperEnabled: false,
      liveEnabled: false,
      parameters: {
        enableBuy: true,
        enableSell: false,
        allowedUtcHours: '23,0,1,7,8,9,10',
        blockedUtcHours: '',
        cooldownBarsAfterAnyExit: 6,
        cooldownBarsAfterSL: 18,
        maxDailyLosses: 3,
        maxDailyTrades: 6,
      },
    }, { enabled: true });

    expect(readiness).toEqual(expect.objectContaining({
      backtestValidated: true,
      candidatePresetApplied: true,
      candidatePreset: 'buy_session_conservative',
      paperAllowedByLogic: true,
      paperEnabled: false,
      envEnabled: true,
      liveEnabled: false,
    }));
    expect(readiness.note).toContain('manually enable paperEnabled');
  });
});
