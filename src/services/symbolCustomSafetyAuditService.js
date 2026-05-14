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
    const runnerSource = readProjectFile('src/services/symbolCustomBacktestRunnerService.js');
    const safe = sourceExcludes(`${source}\n${runnerSource}`, [
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

function auditSymbolCustomBacktestDoesNotCallOldBacktestEngine() {
  try {
    const source = readProjectFile('src/services/symbolCustomBacktestService.js');
    const runnerSource = readProjectFile('src/services/symbolCustomBacktestRunnerService.js');
    const safe = sourceExcludes(`${source}\n${runnerSource}`, [
      /backtestEngine/,
      /runBacktest\s*\(/,
    ]);

    return safe
      ? buildCheck('symbolCustom backtest does not call old backtestEngine', 'PASS', 'SymbolCustom backtest service and runner do not call old backtestEngine.')
      : buildCheck('symbolCustom backtest does not call old backtestEngine', 'FAIL', 'SymbolCustom backtest appears to call old backtestEngine.');
  } catch (error) {
    return buildCheck('symbolCustom backtest does not call old backtestEngine', 'FAIL', `Unable to inspect SymbolCustom backtest isolation: ${error.message}`);
  }
}

function auditSymbolCustomBacktestDoesNotCallSixStrategies() {
  try {
    const source = readProjectFile('src/services/symbolCustomBacktestService.js');
    const runnerSource = readProjectFile('src/services/symbolCustomBacktestRunnerService.js');
    const safe = sourceExcludes(`${source}\n${runnerSource}`, [
      /TrendFollowing/,
      /MeanReversion/,
      /Breakout/,
      /Momentum/,
      /MultiTimeframe/,
      /VolumeFlowHybrid/,
      /src\/strategies/,
      /\.\.\/strategies/,
    ]);

    return safe
      ? buildCheck('symbolCustom backtest does not call six strategies', 'PASS', 'SymbolCustom backtest only calls SymbolCustom logic.')
      : buildCheck('symbolCustom backtest does not call six strategies', 'FAIL', 'SymbolCustom backtest appears to reference six strategy classes.');
  } catch (error) {
    return buildCheck('symbolCustom backtest does not call six strategies', 'FAIL', `Unable to inspect strategy isolation: ${error.message}`);
  }
}

function auditPlaceholderBacktestReturnsStub() {
  try {
    const source = readProjectFile('src/services/symbolCustomBacktestService.js');
    const ok = source.includes('PLACEHOLDER_SYMBOL_CUSTOM')
      && /status:\s*'stub'/.test(source)
      && source.includes('Placeholder SymbolCustom has no active backtest logic');

    return ok
      ? buildCheck('placeholder backtest returns stub', 'PASS', 'Placeholder SymbolCustom backtest returns stub with zero-trade message.')
      : buildCheck('placeholder backtest returns stub', 'FAIL', 'Placeholder SymbolCustom backtest stub behavior is not clear.');
  } catch (error) {
    return buildCheck('placeholder backtest returns stub', 'FAIL', `Unable to inspect placeholder backtest behavior: ${error.message}`);
  }
}

function auditNonPlaceholderBacktestRequiresCandles() {
  try {
    const source = readProjectFile('src/services/symbolCustomBacktestService.js');
    const ok = source.includes('SYMBOL_CUSTOM_BACKTEST_CANDLES_REQUIRED')
      && /resolveBacktestCandles/.test(source)
      && /candleProvider/.test(source);

    return ok
      ? buildCheck('non-placeholder backtest requires candles', 'PASS', 'Non-placeholder SymbolCustom backtests require candles or candleProvider.')
      : buildCheck('non-placeholder backtest requires candles', 'FAIL', 'Non-placeholder SymbolCustom backtests may run without candles.');
  } catch (error) {
    return buildCheck('non-placeholder backtest requires candles', 'FAIL', `Unable to inspect candle requirements: ${error.message}`);
  }
}

function auditCandleProviderDoesNotCallTradeExecutor() {
  try {
    const source = readProjectFile('src/services/symbolCustomCandleProviderService.js');
    const safe = sourceExcludes(source, [
      /tradeExecutor/i,
      /\bexecuteTrade\s*\(/,
      /placeOrder\s*\(/,
      /preflightOrder\s*\(/,
      /closePosition\s*\(/,
      /modifyPosition\s*\(/,
    ]);

    return safe
      ? buildCheck('symbolCustom candle provider does not call tradeExecutor', 'PASS', 'SymbolCustom candle provider only reads historical candles and does not reference order placement.')
      : buildCheck('symbolCustom candle provider does not call tradeExecutor', 'FAIL', 'SymbolCustom candle provider appears to reference live order placement.');
  } catch (error) {
    return buildCheck('symbolCustom candle provider does not call tradeExecutor', 'FAIL', `Unable to inspect SymbolCustom candle provider: ${error.message}`);
  }
}

function auditCandleProviderDoesNotCallOldBacktestEngine() {
  try {
    const source = readProjectFile('src/services/symbolCustomCandleProviderService.js');
    const safe = sourceExcludes(source, [
      /backtestEngine/,
      /runBacktest\s*\(/,
    ]);

    return safe
      ? buildCheck('symbolCustom candle provider does not call old backtestEngine', 'PASS', 'SymbolCustom candle provider is isolated from the old backtestEngine.')
      : buildCheck('symbolCustom candle provider does not call old backtestEngine', 'FAIL', 'SymbolCustom candle provider appears to reference old backtestEngine.');
  } catch (error) {
    return buildCheck('symbolCustom candle provider does not call old backtestEngine', 'FAIL', `Unable to inspect SymbolCustom candle provider backtest isolation: ${error.message}`);
  }
}

function auditCandleProviderDoesNotCallSixStrategies() {
  try {
    const source = readProjectFile('src/services/symbolCustomCandleProviderService.js');
    const safe = sourceExcludes(source, [
      /TrendFollowing/,
      /MeanReversion/,
      /Breakout/,
      /Momentum/,
      /MultiTimeframe/,
      /VolumeFlowHybrid/,
      /src\/strategies/,
      /\.\.\/strategies/,
    ]);

    return safe
      ? buildCheck('symbolCustom candle provider does not call six strategies', 'PASS', 'SymbolCustom candle provider does not reference six strategy classes.')
      : buildCheck('symbolCustom candle provider does not call six strategies', 'FAIL', 'SymbolCustom candle provider appears to reference six strategy classes.');
  } catch (error) {
    return buildCheck('symbolCustom candle provider does not call six strategies', 'FAIL', `Unable to inspect SymbolCustom candle provider strategy isolation: ${error.message}`);
  }
}

function auditHistoricalBacktestRequiresDateRange() {
  try {
    const providerSource = readProjectFile('src/services/symbolCustomCandleProviderService.js');
    const serviceSource = readProjectFile('src/services/symbolCustomBacktestService.js');
    const ok = providerSource.includes('SYMBOL_CUSTOM_BACKTEST_DATE_RANGE_REQUIRED')
      && /if\s*\(!startDate\s*\|\|\s*!endDate\)/.test(providerSource)
      && serviceSource.includes('SYMBOL_CUSTOM_BACKTEST_DATE_RANGE_REQUIRED');

    return ok
      ? buildCheck('symbolCustom historical backtest requires date range', 'PASS', 'Historical SymbolCustom backtests require explicit startDate and endDate.')
      : buildCheck('symbolCustom historical backtest requires date range', 'FAIL', 'Historical SymbolCustom backtests may run without an explicit date range.');
  } catch (error) {
    return buildCheck('symbolCustom historical backtest requires date range', 'FAIL', `Unable to inspect historical date range requirement: ${error.message}`);
  }
}

function auditPlaceholderStillDoesNotRequireCandles() {
  try {
    const source = readProjectFile('src/services/symbolCustomBacktestService.js');
    const placeholderIndex = source.indexOf('logic.name === PLACEHOLDER_SYMBOL_CUSTOM');
    const resolveIndex = source.indexOf('resolveBacktestCandles');
    const ok = placeholderIndex !== -1
      && resolveIndex !== -1
      && placeholderIndex < source.indexOf('const resolved = await resolveBacktestCandles');

    return ok
      ? buildCheck('placeholder still does not require candles', 'PASS', 'Placeholder backtests return stub before candle provider resolution.')
      : buildCheck('placeholder still does not require candles', 'FAIL', 'Placeholder backtest may require candles unexpectedly.');
  } catch (error) {
    return buildCheck('placeholder still does not require candles', 'FAIL', `Unable to inspect placeholder candle behavior: ${error.message}`);
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

function auditScanOnceRespectsEnvGateUnlessForced() {
  try {
    const controllerSource = readProjectFile('src/controllers/symbolCustomController.js');
    const runtimeSource = readProjectFile('src/services/symbolCustomPaperRuntimeService.js');
    const controllerPassesForce = /force:\s*req\.body\?\.force\s*===\s*true/.test(controllerSource);
    const runtimeHasDisabledResult = runtimeSource.includes('SYMBOL_CUSTOM_PAPER_RUNTIME_DISABLED')
      && /if\s*\(!enabled\s*&&\s*!forced\)/.test(runtimeSource);

    return controllerPassesForce && runtimeHasDisabledResult
      ? buildCheck('scan-once respects env gate unless forced', 'PASS', 'scan-once defaults to the runtime env gate and only forces when body.force=true.')
      : buildCheck('scan-once respects env gate unless forced', 'FAIL', 'scan-once may bypass the SymbolCustom paper runtime env gate.');
  } catch (error) {
    return buildCheck('scan-once respects env gate unless forced', 'FAIL', `Unable to inspect scan-once env gate: ${error.message}`);
  }
}

function auditPaperRuntimeDoesNotCallPrivatePaperExecution() {
  try {
    const source = readProjectFile('src/services/symbolCustomPaperRuntimeService.js');
    const safe = !source.includes('_executePaperTrade');

    return safe
      ? buildCheck('runtime does not call private paper execution', 'PASS', 'SymbolCustom runtime uses public paper signal wrappers only.')
      : buildCheck('runtime does not call private paper execution', 'FAIL', 'SymbolCustom runtime still references private paper execution.');
  } catch (error) {
    return buildCheck('runtime does not call private paper execution', 'FAIL', `Unable to inspect paper runtime wrapper usage: ${error.message}`);
  }
}

function auditPublicPaperSignalWrapperExists() {
  try {
    const source = readProjectFile('src/services/paperTradingService.js');
    const exists = /async\s+submitSymbolCustomSignal\s*\(/.test(source)
      && /this\._executePaperTrade\s*\(/.test(source);

    return exists
      ? buildCheck('public paper signal wrapper exists', 'PASS', 'paperTradingService exposes submitSymbolCustomSignal for SymbolCustom paper signals.')
      : buildCheck('public paper signal wrapper exists', 'FAIL', 'paperTradingService public SymbolCustom paper wrapper is missing.');
  } catch (error) {
    return buildCheck('public paper signal wrapper exists', 'FAIL', `Unable to inspect paperTradingService wrapper: ${error.message}`);
  }
}

function auditMissingCandleProviderDetected() {
  try {
    const source = readProjectFile('src/services/symbolCustomPaperRuntimeService.js');
    const detectsProvider = source.includes('SYMBOL_CUSTOM_CANDLE_PROVIDER_REQUIRED')
      && source.includes('PLACEHOLDER_SYMBOL_CUSTOM')
      && /assertCandleProviderAvailable/.test(source);

    return detectsProvider
      ? buildCheck('missing candle provider detected', 'PASS', 'Non-placeholder SymbolCustom paper scans require an injected candle provider.')
      : buildCheck('missing candle provider detected', 'FAIL', 'Non-placeholder SymbolCustom paper scans may run without candle provider detection.');
  } catch (error) {
    return buildCheck('missing candle provider detected', 'FAIL', `Unable to inspect candle provider detection: ${error.message}`);
  }
}

function auditBacktestScopeAllowedLiveBlocked() {
  try {
    const source = readProjectFile('src/services/symbolCustomEngine.js');
    const backtestAllowed = /VALID_SCOPES\s*=\s*Object\.freeze\(\['paper',\s*'backtest',\s*'live'\]\)/.test(source);
    const liveBlocked = /scope\s*===\s*'live'/.test(source)
      && /BLOCKED/.test(source)
      && /SYMBOL_CUSTOM_LIVE_NOT_SUPPORTED_IN_PHASE_2/.test(source);

    return backtestAllowed && liveBlocked
      ? buildCheck('backtest scope allowed live blocked', 'PASS', 'SymbolCustom engine allows backtest scope while live scope remains blocked.')
      : buildCheck('backtest scope allowed live blocked', 'FAIL', 'SymbolCustom scope safety is not configured as expected.');
  } catch (error) {
    return buildCheck('backtest scope allowed live blocked', 'FAIL', `Unable to inspect SymbolCustom scopes: ${error.message}`);
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
  checks.push(auditSymbolCustomBacktestDoesNotCallOldBacktestEngine());
  checks.push(auditSymbolCustomBacktestDoesNotCallSixStrategies());
  checks.push(auditPlaceholderBacktestReturnsStub());
  checks.push(auditNonPlaceholderBacktestRequiresCandles());
  checks.push(auditCandleProviderDoesNotCallTradeExecutor());
  checks.push(auditCandleProviderDoesNotCallOldBacktestEngine());
  checks.push(auditCandleProviderDoesNotCallSixStrategies());
  checks.push(auditHistoricalBacktestRequiresDateRange());
  checks.push(auditPlaceholderStillDoesNotRequireCandles());
  checks.push(auditPaperRuntimeDefaultDisabled());
  checks.push(auditSymbolCustomLiveRuntimeNotConnected());
  checks.push(auditPaperRuntimeNeverCallsTradeExecutor());
  checks.push(auditPaperRuntimeMarksSymbolCustomSource());
  checks.push(auditPaperRuntimeRequiresEnvForSchedulerStart());
  checks.push(auditScanOnceRespectsEnvGateUnlessForced());
  checks.push(auditPaperRuntimeDoesNotCallPrivatePaperExecution());
  checks.push(auditPublicPaperSignalWrapperExists());
  checks.push(auditMissingCandleProviderDetected());
  checks.push(auditBacktestScopeAllowedLiveBlocked());

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
