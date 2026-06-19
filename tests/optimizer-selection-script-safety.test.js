const fs = require('fs');
const path = require('path');

function readSelectionScript() {
  return fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'run-optimizer-selection.js'),
    'utf8'
  );
}

describe('run-optimizer-selection safety contract', () => {
  test('declares read-only report mode and no automatic paper/live enabling', () => {
    const source = readSelectionScript();

    expect(source).toContain('Read-only optimizer strategy selection runner');
    expect(source).toMatch(/readOnly:\s*true/);
    expect(source).toMatch(/mutatesRuntimeState:\s*false/);
    expect(source).toMatch(/mutatesStrategyInstances:\s*false/);
    expect(source).toMatch(/autoEnablesPaper:\s*false/);
    expect(source).toMatch(/autoEnablesLive:\s*false/);
    expect(source).toMatch(/walkForwardSplit:\s*DEFAULT_WALK_FORWARD_SPLIT/);
    expect(source).toContain('optimizationWindowMode');
    expect(source).toContain('Suggested Paper Enable List');
    expect(source).toContain('Suggested Live Candidate List');
    expect(source).toContain('Do Not Enable');
  });

  test('walk-forward report uses train optimization with validation and OOS summaries', () => {
    const source = readSelectionScript();

    expect(source).toContain('DEFAULT_WALK_FORWARD_SPLIT');
    expect(source).toContain('buildWalkForwardRanges');
    expect(source).toContain('simulateFixedParamsForSegment');
    expect(source).toContain('assessWalkForwardMetrics');
    expect(source).toContain("optimizationWindow: walkForwardRanges ? 'train' : 'full_range'");
    expect(source).toContain('Walk-Forward / OOS Validation');
    expect(source).toContain('validationDegradationPercent');
    expect(source).toContain('outOfSampleDegradationPercent');
  });

  test('VolumeFlowHybrid audit is report-only and exposes filter/management fields', () => {
    const source = readSelectionScript();

    expect(source).toContain('buildVolumeFlowHybridAudit');
    expect(source).toContain('VolumeFlowHybrid Audit Notes');
    expect(source).toContain('volumeFlowHybridBreakdown');
    expect(source).toContain('vfhBreakoutTrades');
    expect(source).toContain('vfhSessionFilteredSignals');
    expect(source).toContain('vfhBreakevenExitTrades');
    expect(source).toContain('vfhPartialCloseTrades');
    expect(source).toContain('vfhDirectionControlTpRateAfterTrigger');
    expect(source).toContain('VolumeFlowHybrid audit is report-only');
    expect(source).toContain('Uses 5m/1m replay assumptions');
  });

  test('does not write strategy runtime or paper/live enable flags', () => {
    const source = readSelectionScript();
    const withoutReportWrites = source.replace(/fs\.writeFileSync\([^)]+\);/g, '');

    expect(withoutReportWrites).not.toMatch(/\b(?:liveEnabled|paperEnabled)\s*[:=]/);
    expect(withoutReportWrites).not.toMatch(/\b(?:allowLive|isPrimaryLive)\s*[:=]/);
    expect(withoutReportWrites).not.toMatch(/\bStrategyInstance\.(?:update|insert|remove|save)\b/);
    expect(withoutReportWrites).not.toMatch(/\bStrategy\.(?:update|insert|remove|save)\b/);
    expect(withoutReportWrites).not.toMatch(/\bRiskProfile\.(?:update|insert|remove|save)\b/);
    expect(withoutReportWrites).not.toMatch(/\bruntimeMatrix.*(?:save|update|enable)/i);
  });
});
