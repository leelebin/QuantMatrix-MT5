const {
  findMissingParameterSchemaFields,
  findMissingParameterKeys,
  hasMissingLogicSchema,
  buildSchemaSyncWarning,
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
});
