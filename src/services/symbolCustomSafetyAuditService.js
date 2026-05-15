const fs = require('fs');
const path = require('path');

const SymbolCustom = require('../models/SymbolCustom');
const PlaceholderSymbolCustom = require('../symbolCustom/logics/PlaceholderSymbolCustom');
const symbolCustomReportService = require('./symbolCustomReportService');
const symbolCustomOptimizerService = require('./symbolCustomOptimizerService');
const symbolCustomBacktestService = require('./symbolCustomBacktestService');

const PHASE_1_LIVE_WARNING = 'Phase 1 does not support live execution';
const SYMBOL_CUSTOM_PAPER_ENABLED_ENV = 'SYMBOL_CUSTOM_PAPER_ENABLED';
const USDJPY_JPY_MACRO_REVERSAL_V1 = 'USDJPY_JPY_MACRO_REVERSAL_V1';

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

function auditUsdjpyMacroReversalRegistered() {
  try {
    const { getSymbolCustomLogic, isSymbolCustomRegistered } = require('../symbolCustom/registry');
    const logic = getSymbolCustomLogic(USDJPY_JPY_MACRO_REVERSAL_V1);
    const registered = isSymbolCustomRegistered(USDJPY_JPY_MACRO_REVERSAL_V1)
      && logic
      && logic.name === USDJPY_JPY_MACRO_REVERSAL_V1;

    return registered
      ? buildCheck('USDJPY_JPY_MACRO_REVERSAL_V1 is registered', 'PASS', 'USDJPY macro reversal SymbolCustom logic is available in the registry.')
      : buildCheck('USDJPY_JPY_MACRO_REVERSAL_V1 is registered', 'FAIL', 'USDJPY macro reversal SymbolCustom logic is not registered.');
  } catch (error) {
    return buildCheck('USDJPY_JPY_MACRO_REVERSAL_V1 is registered', 'FAIL', `Unable to inspect USDJPY macro reversal registry entry: ${error.message}`);
  }
}

function auditUsdjpyMacroReversalBacktestOnly() {
  try {
    const { getSymbolCustomLogic } = require('../symbolCustom/registry');
    const logic = getSymbolCustomLogic(USDJPY_JPY_MACRO_REVERSAL_V1);
    const paper = logic ? logic.analyze({ scope: 'paper', symbol: 'USDJPY' }) : null;
    const live = logic ? logic.analyze({ scope: 'live', symbol: 'USDJPY' }) : null;
    const source = readProjectFile('src/symbolCustom/logics/UsdjpyJpyMacroReversalV1.js');
    const backtestOnly = paper?.signal === 'NONE'
      && live?.signal === 'NONE'
      && source.includes("scope !== 'backtest'")
      && source.includes('backtest-only in Phase 2D');

    return backtestOnly
      ? buildCheck('USDJPY_JPY_MACRO_REVERSAL_V1 is backtest-only', 'PASS', 'USDJPY macro reversal returns NONE outside backtest scope.')
      : buildCheck('USDJPY_JPY_MACRO_REVERSAL_V1 is backtest-only', 'FAIL', 'USDJPY macro reversal may emit tradable signals outside backtest scope.');
  } catch (error) {
    return buildCheck('USDJPY_JPY_MACRO_REVERSAL_V1 is backtest-only', 'FAIL', `Unable to inspect USDJPY macro reversal scope gating: ${error.message}`);
  }
}

function auditUsdjpyMacroReversalDoesNotReferenceSixStrategies() {
  try {
    const source = readProjectFile('src/symbolCustom/logics/UsdjpyJpyMacroReversalV1.js');
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
      ? buildCheck('USDJPY_JPY_MACRO_REVERSAL_V1 does not reference six strategies', 'PASS', 'USDJPY macro reversal is independent of the six strategy classes.')
      : buildCheck('USDJPY_JPY_MACRO_REVERSAL_V1 does not reference six strategies', 'FAIL', 'USDJPY macro reversal appears to reference six strategy classes.');
  } catch (error) {
    return buildCheck('USDJPY_JPY_MACRO_REVERSAL_V1 does not reference six strategies', 'FAIL', `Unable to inspect USDJPY macro reversal strategy isolation: ${error.message}`);
  }
}

function auditUsdjpyMacroReversalDoesNotReferenceTradeExecutor() {
  try {
    const source = readProjectFile('src/symbolCustom/logics/UsdjpyJpyMacroReversalV1.js');
    const safe = sourceExcludes(source, [
      /tradeExecutor/i,
      /\bexecuteTrade\s*\(/,
      /placeOrder\s*\(/,
      /preflightOrder\s*\(/,
    ]);

    return safe
      ? buildCheck('USDJPY_JPY_MACRO_REVERSAL_V1 does not reference tradeExecutor', 'PASS', 'USDJPY macro reversal has no live order execution references.')
      : buildCheck('USDJPY_JPY_MACRO_REVERSAL_V1 does not reference tradeExecutor', 'FAIL', 'USDJPY macro reversal appears to reference live order execution.');
  } catch (error) {
    return buildCheck('USDJPY_JPY_MACRO_REVERSAL_V1 does not reference tradeExecutor', 'FAIL', `Unable to inspect USDJPY macro reversal live isolation: ${error.message}`);
  }
}

function auditUsdjpyMacroReversalDoesNotReferenceRiskManager() {
  try {
    const source = readProjectFile('src/symbolCustom/logics/UsdjpyJpyMacroReversalV1.js');
    const safe = sourceExcludes(source, [
      /riskManager/i,
      /calculateLotSize\s*\(/,
    ]);

    return safe
      ? buildCheck('USDJPY_JPY_MACRO_REVERSAL_V1 does not reference riskManager', 'PASS', 'USDJPY macro reversal does not use live lot sizing.')
      : buildCheck('USDJPY_JPY_MACRO_REVERSAL_V1 does not reference riskManager', 'FAIL', 'USDJPY macro reversal appears to reference riskManager lot sizing.');
  } catch (error) {
    return buildCheck('USDJPY_JPY_MACRO_REVERSAL_V1 does not reference riskManager', 'FAIL', `Unable to inspect USDJPY macro reversal risk isolation: ${error.message}`);
  }
}

function auditUsdjpyMacroReversalDoesNotReferenceOldBacktestEngine() {
  try {
    const source = readProjectFile('src/symbolCustom/logics/UsdjpyJpyMacroReversalV1.js');
    const safe = sourceExcludes(source, [
      /backtestEngine/,
      /runBacktest\s*\(/,
    ]);

    return safe
      ? buildCheck('USDJPY_JPY_MACRO_REVERSAL_V1 does not reference old backtestEngine', 'PASS', 'USDJPY macro reversal does not reference old backtestEngine.')
      : buildCheck('USDJPY_JPY_MACRO_REVERSAL_V1 does not reference old backtestEngine', 'FAIL', 'USDJPY macro reversal appears to reference old backtestEngine.');
  } catch (error) {
    return buildCheck('USDJPY_JPY_MACRO_REVERSAL_V1 does not reference old backtestEngine', 'FAIL', `Unable to inspect USDJPY macro reversal backtest isolation: ${error.message}`);
  }
}

function auditUsdjpyGuardrailsBacktestOnly() {
  try {
    const source = readProjectFile('src/symbolCustom/logics/UsdjpyJpyMacroReversalV1.js');
    const hasGuardrails = source.includes('enableBuy')
      && source.includes('allowedUtcHours')
      && source.includes('cooldownBarsAfterSL')
      && source.includes('maxDailyLosses');
    const guardedCallIndex = source.indexOf('const guardrailReason = shouldBlockByGuardrails');
    const gated = guardedCallIndex > -1
      && source.indexOf("scope !== 'backtest'") < guardedCallIndex
      && source.includes('backtest-only in Phase 2D');

    return hasGuardrails && gated
      ? buildCheck('USDJPY guardrails are backtest-only', 'PASS', 'USDJPY guardrails are evaluated only after backtest scope gating.')
      : buildCheck('USDJPY guardrails are backtest-only', 'FAIL', 'USDJPY guardrail scope gating is not clear.');
  } catch (error) {
    return buildCheck('USDJPY guardrails are backtest-only', 'FAIL', `Unable to inspect USDJPY guardrails: ${error.message}`);
  }
}

function auditUsdjpyPaperLiveStillNoneAfterGuardrails() {
  try {
    const { getSymbolCustomLogic } = require('../symbolCustom/registry');
    const logic = getSymbolCustomLogic(USDJPY_JPY_MACRO_REVERSAL_V1);
    const paper = logic.analyze({
      scope: 'paper',
      parameters: { enableBuy: true, enableSell: true },
      currentUtcHour: 0,
    });
    const live = logic.analyze({
      scope: 'live',
      parameters: { enableBuy: true, enableSell: true },
      currentUtcHour: 0,
    });
    const safe = paper?.signal === 'NONE' && live?.signal === 'NONE';

    return safe
      ? buildCheck('USDJPY paper/live still return NONE after guardrail changes', 'PASS', 'USDJPY guardrails do not enable paper/live signals.')
      : buildCheck('USDJPY paper/live still return NONE after guardrail changes', 'FAIL', 'USDJPY emitted a tradable paper/live signal.');
  } catch (error) {
    return buildCheck('USDJPY paper/live still return NONE after guardrail changes', 'FAIL', `Unable to test USDJPY paper/live scope: ${error.message}`);
  }
}

function auditEvaluationServiceDoesNotCallTradeExecutor() {
  try {
    const source = readProjectFile('src/services/symbolCustomEvaluationService.js');
    const safe = sourceExcludes(source, [
      /tradeExecutor/i,
      /\bexecuteTrade\s*\(/,
      /placeOrder\s*\(/,
      /preflightOrder\s*\(/,
    ]);

    return safe
      ? buildCheck('evaluation service does not call tradeExecutor', 'PASS', 'SymbolCustom evaluation is read-only and has no live order references.')
      : buildCheck('evaluation service does not call tradeExecutor', 'FAIL', 'SymbolCustom evaluation appears to reference tradeExecutor.');
  } catch (error) {
    return buildCheck('evaluation service does not call tradeExecutor', 'FAIL', `Unable to inspect evaluation tradeExecutor isolation: ${error.message}`);
  }
}

function auditEvaluationServiceDoesNotCallRiskManager() {
  try {
    const source = readProjectFile('src/services/symbolCustomEvaluationService.js');
    const safe = sourceExcludes(source, [
      /riskManager/i,
      /calculateLotSize\s*\(/,
    ]);

    return safe
      ? buildCheck('evaluation service does not call riskManager', 'PASS', 'SymbolCustom evaluation does not use live lot sizing.')
      : buildCheck('evaluation service does not call riskManager', 'FAIL', 'SymbolCustom evaluation appears to reference riskManager.');
  } catch (error) {
    return buildCheck('evaluation service does not call riskManager', 'FAIL', `Unable to inspect evaluation risk isolation: ${error.message}`);
  }
}

function auditEvaluationServiceDoesNotCallOldBacktestEngine() {
  try {
    const source = readProjectFile('src/services/symbolCustomEvaluationService.js');
    const safe = sourceExcludes(source, [
      /backtestEngine/,
      /runBacktest\s*\(/,
    ]);

    return safe
      ? buildCheck('evaluation service does not call old backtestEngine', 'PASS', 'SymbolCustom evaluation only analyzes saved backtest records.')
      : buildCheck('evaluation service does not call old backtestEngine', 'FAIL', 'SymbolCustom evaluation appears to reference old backtestEngine.');
  } catch (error) {
    return buildCheck('evaluation service does not call old backtestEngine', 'FAIL', `Unable to inspect evaluation backtest isolation: ${error.message}`);
  }
}

function auditEvaluationServiceDoesNotCallSixStrategies() {
  try {
    const source = readProjectFile('src/services/symbolCustomEvaluationService.js');
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
      ? buildCheck('evaluation service does not call six strategies', 'PASS', 'SymbolCustom evaluation is isolated from six strategy classes.')
      : buildCheck('evaluation service does not call six strategies', 'FAIL', 'SymbolCustom evaluation appears to reference six strategy classes.');
  } catch (error) {
    return buildCheck('evaluation service does not call six strategies', 'FAIL', `Unable to inspect evaluation strategy isolation: ${error.message}`);
  }
}

function auditPresetComparisonDoesNotCallTradeExecutor() {
  try {
    const source = readProjectFile('src/services/symbolCustomPresetComparisonService.js');
    const safe = sourceExcludes(source, [
      /tradeExecutor/i,
      /\bexecuteTrade\s*\(/,
      /placeOrder\s*\(/,
      /preflightOrder\s*\(/,
    ]);

    return safe
      ? buildCheck('preset comparison does not call tradeExecutor', 'PASS', 'SymbolCustom preset comparison only orchestrates backtest/evaluation services.')
      : buildCheck('preset comparison does not call tradeExecutor', 'FAIL', 'SymbolCustom preset comparison appears to reference live order execution.');
  } catch (error) {
    return buildCheck('preset comparison does not call tradeExecutor', 'FAIL', `Unable to inspect preset comparison tradeExecutor isolation: ${error.message}`);
  }
}

function auditPresetComparisonDoesNotCallPaperTradingService() {
  try {
    const source = readProjectFile('src/services/symbolCustomPresetComparisonService.js');
    const safe = sourceExcludes(source, [
      /paperTradingService/i,
      /submitSymbolCustomSignal\s*\(/,
      /submitExternalPaperSignal\s*\(/,
      /_executePaperTrade\s*\(/,
    ]);

    return safe
      ? buildCheck('preset comparison does not call paperTradingService', 'PASS', 'SymbolCustom preset comparison does not submit paper signals.')
      : buildCheck('preset comparison does not call paperTradingService', 'FAIL', 'SymbolCustom preset comparison appears to reference paper execution.');
  } catch (error) {
    return buildCheck('preset comparison does not call paperTradingService', 'FAIL', `Unable to inspect preset comparison paper isolation: ${error.message}`);
  }
}

function auditPresetComparisonDoesNotCallOldBacktestEngine() {
  try {
    const source = readProjectFile('src/services/symbolCustomPresetComparisonService.js');
    const safe = sourceExcludes(source, [
      /backtestEngine/,
      /runBacktest\s*\(/,
    ]);

    return safe
      ? buildCheck('preset comparison does not call old backtestEngine', 'PASS', 'SymbolCustom preset comparison uses SymbolCustom backtest service only.')
      : buildCheck('preset comparison does not call old backtestEngine', 'FAIL', 'SymbolCustom preset comparison appears to reference old backtestEngine.');
  } catch (error) {
    return buildCheck('preset comparison does not call old backtestEngine', 'FAIL', `Unable to inspect preset comparison backtest isolation: ${error.message}`);
  }
}

function auditPresetComparisonDoesNotCallSixStrategies() {
  try {
    const source = readProjectFile('src/services/symbolCustomPresetComparisonService.js');
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
      ? buildCheck('preset comparison does not call six strategies', 'PASS', 'SymbolCustom preset comparison does not reference six strategy classes.')
      : buildCheck('preset comparison does not call six strategies', 'FAIL', 'SymbolCustom preset comparison appears to reference six strategy classes.');
  } catch (error) {
    return buildCheck('preset comparison does not call six strategies', 'FAIL', `Unable to inspect preset comparison strategy isolation: ${error.message}`);
  }
}

function auditUsdjpyPaperLiveRemainNoneForPresetComparison() {
  try {
    const { getSymbolCustomLogic } = require('../symbolCustom/registry');
    const logic = getSymbolCustomLogic(USDJPY_JPY_MACRO_REVERSAL_V1);
    const parameters = {
      enableBuy: true,
      enableSell: true,
      allowedUtcHours: '23,0,1,7,8,9,10',
      cooldownBarsAfterAnyExit: 6,
      cooldownBarsAfterSL: 18,
      maxDailyLosses: 3,
      maxDailyTrades: 6,
    };
    const paper = logic.analyze({ scope: 'paper', parameters, currentUtcHour: 0 });
    const live = logic.analyze({ scope: 'live', parameters, currentUtcHour: 0 });
    const safe = paper?.signal === 'NONE' && live?.signal === 'NONE';

    return safe
      ? buildCheck('USDJPY paper/live remains NONE for preset comparison', 'PASS', 'Guardrail presets do not enable USDJPY paper/live signals.')
      : buildCheck('USDJPY paper/live remains NONE for preset comparison', 'FAIL', 'USDJPY emitted a tradable paper/live signal under preset parameters.');
  } catch (error) {
    return buildCheck('USDJPY paper/live remains NONE for preset comparison', 'FAIL', `Unable to test USDJPY preset paper/live safety: ${error.message}`);
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
  checks.push(auditUsdjpyMacroReversalRegistered());
  checks.push(auditUsdjpyMacroReversalBacktestOnly());
  checks.push(auditUsdjpyMacroReversalDoesNotReferenceSixStrategies());
  checks.push(auditUsdjpyMacroReversalDoesNotReferenceTradeExecutor());
  checks.push(auditUsdjpyMacroReversalDoesNotReferenceRiskManager());
  checks.push(auditUsdjpyMacroReversalDoesNotReferenceOldBacktestEngine());
  checks.push(auditUsdjpyGuardrailsBacktestOnly());
  checks.push(auditUsdjpyPaperLiveStillNoneAfterGuardrails());
  checks.push(auditEvaluationServiceDoesNotCallTradeExecutor());
  checks.push(auditEvaluationServiceDoesNotCallRiskManager());
  checks.push(auditEvaluationServiceDoesNotCallOldBacktestEngine());
  checks.push(auditEvaluationServiceDoesNotCallSixStrategies());
  checks.push(auditPresetComparisonDoesNotCallTradeExecutor());
  checks.push(auditPresetComparisonDoesNotCallPaperTradingService());
  checks.push(auditPresetComparisonDoesNotCallOldBacktestEngine());
  checks.push(auditPresetComparisonDoesNotCallSixStrategies());
  checks.push(auditUsdjpyPaperLiveRemainNoneForPresetComparison());

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
