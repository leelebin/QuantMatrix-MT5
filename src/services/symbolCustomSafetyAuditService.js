const fs = require('fs');
const path = require('path');

const SymbolCustom = require('../models/SymbolCustom');
const PlaceholderSymbolCustom = require('../symbolCustom/logics/PlaceholderSymbolCustom');
const symbolCustomReportService = require('./symbolCustomReportService');
const symbolCustomOptimizerService = require('./symbolCustomOptimizerService');
const symbolCustomBacktestService = require('./symbolCustomBacktestService');

const PHASE_1_LIVE_WARNING = 'Phase 1 does not support live execution';
const SYMBOL_CUSTOM_PAPER_ENABLED_ENV = 'SYMBOL_CUSTOM_PAPER_ENABLED';

function buildCheck(name, status, message) {
  return { name, status, message };
}

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relativePath), 'utf8');
}

function summarize(checks) {
  return checks.reduce((summary, check) => {
    const key = String(check.status || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(summary, key)) {
      summary[key] += 1;
    }
    return summary;
  }, { pass: 0, warn: 0, fail: 0 });
}

function sourceExcludes(source, patterns) {
  return patterns.every((pattern) => !pattern.test(source));
}

function auditLiveExecutionNotConnected() {
  try {
    const source = readProjectFile('src/services/symbolCustomEngine.js');
    const safe = sourceExcludes(source, [
      /tradeExecutor/i,
      /paperTradingService/i,
      /\.executeTrade\s*\(/,
      /_executePaperTrade\s*\(/,
    ]);

    return safe
      ? buildCheck('live execution not connected', 'PASS', 'symbolCustomEngine does not call tradeExecutor or paperTradingService.')
      : buildCheck('live execution not connected', 'FAIL', 'symbolCustomEngine appears to reference trade execution.');
  } catch (error) {
    return buildCheck('live execution not connected', 'FAIL', `Unable to inspect symbolCustomEngine: ${error.message}`);
  }
}

function auditOldOptimizerUntouched() {
  try {
    const modelSource = readProjectFile('src/models/SymbolCustomOptimizerRun.js');
    const serviceSource = readProjectFile('src/services/symbolCustomOptimizerService.js');
    const usesDedicatedDb = /symbolCustomOptimizerRunsDb/.test(modelSource);
    const avoidsOldOptimizer = sourceExcludes(`${modelSource}\n${serviceSource}`, [
      /optimizerRunsDb/,
      /optimizerService/,
      /optimizerWorker/,
      /backtestEngine/,
    ]);

    return usesDedicatedDb && avoidsOldOptimizer
      ? buildCheck('old optimizer untouched', 'PASS', 'SymbolCustom optimizer uses symbolCustomOptimizerRunsDb and avoids old optimizer/backtest services.')
      : buildCheck('old optimizer untouched', 'FAIL', 'SymbolCustom optimizer may touch old optimizer/backtest infrastructure.');
  } catch (error) {
    return buildCheck('old optimizer untouched', 'FAIL', `Unable to inspect SymbolCustom optimizer files: ${error.message}`);
  }
}

function auditOldBacktestUntouched() {
  try {
    const source = readProjectFile('src/services/symbolCustomBacktestService.js');
    const safe = sourceExcludes(source, [
      /backtestEngine/,
      /TrendFollowing/,
      /MeanReversion/,
      /Breakout/,
      /Momentum/,
      /MultiTimeframe/,
      /VolumeFlowHybrid/,
    ]);

    return safe
      ? buildCheck('old backtest untouched', 'PASS', 'SymbolCustom backtest service does not call old backtestEngine or six strategy classes.')
      : buildCheck('old backtest untouched', 'FAIL', 'SymbolCustom backtest service appears to reference old backtest or strategy classes.');
  } catch (error) {
    return buildCheck('old backtest untouched', 'FAIL', `Unable to inspect SymbolCustom backtest service: ${error.message}`);
  }
}

async function auditLiveEnabledRecords(symbolCustoms) {
  const liveEnabled = symbolCustoms.filter((record) => record.liveEnabled === true);
  if (liveEnabled.length === 0) {
    return buildCheck('default live disabled', 'PASS', 'No SymbolCustom records have liveEnabled=true.');
  }

  return buildCheck(
    'default live disabled',
    'WARN',
    `${liveEnabled.length} SymbolCustom record(s) have liveEnabled=true. ${PHASE_1_LIVE_WARNING}.`
  );
}

function auditPlaceholderDoesNotTrade() {
  const placeholder = new PlaceholderSymbolCustom();
  const result = placeholder.analyze({});

  return result && result.signal === 'NONE' && result.signal !== 'BUY' && result.signal !== 'SELL'
    ? buildCheck('placeholder does not trade', 'PASS', 'PLACEHOLDER_SYMBOL_CUSTOM returns signal NONE.')
    : buildCheck('placeholder does not trade', 'FAIL', 'PLACEHOLDER_SYMBOL_CUSTOM returned a tradable signal.');
}

function auditPaperRuntimeDefaultDisabled() {
  try {
    const source = readProjectFile('src/services/symbolCustomPaperRuntimeService.js');
    const serverSource = readProjectFile('src/server.js');
    const serviceRequiresTrue = source.includes(SYMBOL_CUSTOM_PAPER_ENABLED_ENV)
      && /process\.env\[[^\]]*SYMBOL_CUSTOM_PAPER_ENABLED_ENV[^\]]*\]\s*===\s*'true'/.test(source);
    const serverRequiresTrue = serverSource.includes(`process.env.${SYMBOL_CUSTOM_PAPER_ENABLED_ENV} === 'true'`);

    return serviceRequiresTrue && serverRequiresTrue
      ? buildCheck('symbolCustom paper runtime default disabled', 'PASS', 'SymbolCustom paper runtime only starts when SYMBOL_CUSTOM_PAPER_ENABLED=true.')
      : buildCheck('symbolCustom paper runtime default disabled', 'FAIL', 'SymbolCustom paper runtime start is not clearly gated by SYMBOL_CUSTOM_PAPER_ENABLED=true.');
  } catch (error) {
    return buildCheck('symbolCustom paper runtime default disabled', 'FAIL', `Unable to inspect paper runtime default: ${error.message}`);
  }
}

function auditSymbolCustomLiveRuntimeNotConnected() {
  try {
    const engineSource = readProjectFile('src/services/symbolCustomEngine.js');
    const runtimeSource = readProjectFile('src/services/symbolCustomPaperRuntimeService.js');
    const liveBlocked = /scope\s*===\s*'live'/.test(engineSource)
      && /BLOCKED/.test(engineSource)
      && /SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_2/.test(engineSource);
    const runtimeDoesNotStartLive = sourceExcludes(runtimeSource, [
      /scope:\s*'live'/,
      /liveEnabled/,
    ]);

    return liveBlocked && runtimeDoesNotStartLive
      ? buildCheck('symbolCustom live runtime not connected', 'PASS', 'SymbolCustom live scope is blocked and the paper runtime has no live runtime path.')
      : buildCheck('symbolCustom live runtime not connected', 'FAIL', 'SymbolCustom live runtime path may be connected.');
  } catch (error) {
    return buildCheck('symbolCustom live runtime not connected', 'FAIL', `Unable to inspect live runtime isolation: ${error.message}`);
  }
}

function auditPaperRuntimeNeverCallsTradeExecutor() {
  try {
    const source = readProjectFile('src/services/symbolCustomPaperRuntimeService.js');
    const safe = sourceExcludes(source, [
      /tradeExecutor/i,
      /\bexecuteTrade\s*\(/,
      /mt5Service/i,
      /placeOrder\s*\(/,
      /preflightOrder\s*\(/,
    ]);

    return safe
      ? buildCheck('paper runtime never calls tradeExecutor', 'PASS', 'SymbolCustom paper runtime routes signals through the paper service and does not reference live order placement.')
      : buildCheck('paper runtime never calls tradeExecutor', 'FAIL', 'SymbolCustom paper runtime appears to reference live order placement.');
  } catch (error) {
    return buildCheck('paper runtime never calls tradeExecutor', 'FAIL', `Unable to inspect paper runtime isolation: ${error.message}`);
  }
}

function auditPaperRuntimeMarksSymbolCustomSource() {
  try {
    const source = readProjectFile('src/services/symbolCustomPaperRuntimeService.js');
    const marksSource = /source:\s*'symbolCustom'/.test(source)
      && /scope:\s*'paper'/.test(source)
      && /setupType:\s*'symbol_custom'/.test(source)
      && /strategyType:\s*'SymbolCustom'/.test(source);

    return marksSource
      ? buildCheck('paper runtime marks source symbolCustom', 'PASS', 'SymbolCustom paper payloads include source, scope, setupType, and strategyType metadata.')
      : buildCheck('paper runtime marks source symbolCustom', 'FAIL', 'SymbolCustom paper payload metadata is incomplete.');
  } catch (error) {
    return buildCheck('paper runtime marks source symbolCustom', 'FAIL', `Unable to inspect paper payload metadata: ${error.message}`);
  }
}

function auditPaperRuntimeRequiresEnvForSchedulerStart() {
  try {
    const serverSource = readProjectFile('src/server.js');
    const requiresEnv = serverSource.includes(`process.env.${SYMBOL_CUSTOM_PAPER_ENABLED_ENV} === 'true'`)
      && /symbolCustomPaperRuntimeService\.start\s*\(/.test(serverSource)
      && serverSource.includes('[SymbolCustom] Paper runtime disabled');

    return requiresEnv
      ? buildCheck('paper runtime scheduler env gated', 'PASS', 'Server startup only starts SymbolCustom paper runtime when SYMBOL_CUSTOM_PAPER_ENABLED=true.')
      : buildCheck('paper runtime scheduler env gated', 'FAIL', 'Server startup does not clearly gate SymbolCustom paper runtime start by env flag.');
  } catch (error) {
    return buildCheck('paper runtime scheduler env gated', 'FAIL', `Unable to inspect server startup gating: ${error.message}`);
  }
}

function auditPrimaryLiveUniqueness(symbolCustoms) {
  const grouped = new Map();
  symbolCustoms
    .filter((record) => record.isPrimaryLive === true)
    .forEach((record) => {
      const symbol = String(record.symbol || 'UNKNOWN').toUpperCase();
      grouped.set(symbol, (grouped.get(symbol) || 0) + 1);
    });

  const conflicts = Array.from(grouped.entries()).filter(([, count]) => count > 1);
  if (conflicts.length === 0) {
    return buildCheck('primary live uniqueness', 'PASS', 'No symbol has multiple primary live SymbolCustom records.');
  }

  return buildCheck(
    'primary live uniqueness',
    'WARN',
    `Multiple primary live SymbolCustom records found for: ${conflicts.map(([symbol]) => symbol).join(', ')}. No automatic fix applied.`
  );
}

function auditRouteHealth() {
  try {
    const routes = require('../routes/symbolCustomRoutes');
    if (typeof routes !== 'function') {
      return buildCheck('route health', 'FAIL', 'SymbolCustom routes did not load as an Express router.');
    }

    const optimizerPreview = symbolCustomOptimizerService.buildParameterGridPreview([
      { key: 'lookbackBars', type: 'number', min: 10, max: 20, step: 10 },
    ], 2);

    const servicesReady = typeof symbolCustomReportService.buildSymbolCustomReport === 'function'
      && typeof symbolCustomBacktestService.runSymbolCustomBacktest === 'function'
      && optimizerPreview.totalCombinations === 2
      && optimizerPreview.parameterGridPreview.length === 2;

    return servicesReady
      ? buildCheck('route health', 'PASS', 'SymbolCustom routes, report, optimizer stub, and backtest stub are available.')
      : buildCheck('route health', 'FAIL', 'One or more SymbolCustom API services are unavailable.');
  } catch (error) {
    return buildCheck('route health', 'FAIL', `SymbolCustom routes or services failed to load: ${error.message}`);
  }
}

async function runSymbolCustomPhase1SafetyAudit() {
  const checks = [];
  checks.push(auditLiveExecutionNotConnected());
  checks.push(auditOldOptimizerUntouched());
  checks.push(auditOldBacktestUntouched());
  checks.push(auditPaperRuntimeDefaultDisabled());
  checks.push(auditSymbolCustomLiveRuntimeNotConnected());
  checks.push(auditPaperRuntimeNeverCallsTradeExecutor());
  checks.push(auditPaperRuntimeMarksSymbolCustomSource());
  checks.push(auditPaperRuntimeRequiresEnvForSchedulerStart());

  let symbolCustoms = [];
  try {
    symbolCustoms = await SymbolCustom.findAll({});
  } catch (error) {
    checks.push(buildCheck('symbolCustom records readable', 'FAIL', `Unable to read SymbolCustom records: ${error.message}`));
  }

  checks.push(await auditLiveEnabledRecords(symbolCustoms));
  checks.push(auditPlaceholderDoesNotTrade());
  checks.push(auditPrimaryLiveUniqueness(symbolCustoms));
  checks.push(auditRouteHealth());

  return {
    success: true,
    checks,
    summary: summarize(checks),
  };
}

module.exports = {
  runSymbolCustomPhase1SafetyAudit,
};
