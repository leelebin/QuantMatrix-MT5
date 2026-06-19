const fs = require('fs');
const path = require('path');

const SymbolCustom = require('../models/SymbolCustom');
const PlaceholderSymbolCustom = require('../symbolCustom/logics/PlaceholderSymbolCustom');
const symbolCustomReportService = require('./symbolCustomReportService');
const symbolCustomOptimizerService = require('./symbolCustomOptimizerService');
const symbolCustomBacktestService = require('./symbolCustomBacktestService');

const LIVE_RUNTIME_GATE_WARNING = 'SymbolCustom live execution is available only through live runtime safety gates';
const SYMBOL_CUSTOM_PAPER_ENABLED_ENV = 'SYMBOL_CUSTOM_PAPER_ENABLED';
const USDJPY_JPY_MACRO_REVERSAL_V1 = 'USDJPY_JPY_MACRO_REVERSAL_V1';
const USDJPY_PAPER_CANDIDATE_PARAMETERS = Object.freeze({
  lookbackBars: 36,
  impulseAtrMultiplier: 1.2,
  reversalConfirmBars: 2,
  rsiPeriod: 14,
  rsiOverbought: 68,
  rsiOversold: 32,
  atrPeriod: 14,
  slAtrMultiplier: 1.2,
  tpAtrMultiplier: 1.8,
  maxBarsInTrade: 18,
  minAtr: 0,
  cooldownBars: 6,
  enableBuy: true,
  enableSell: false,
  allowedUtcHours: '23,0,1,7,8,9,10',
  blockedUtcHours: '',
  cooldownBarsAfterAnyExit: 6,
  cooldownBarsAfterSL: 18,
  maxDailyLosses: 3,
  maxDailyTrades: 6,
});

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

function extractFunctionSource(source, functionName) {
  const start = source.indexOf(`function ${functionName}`);
  if (start === -1) return '';
  const nextFunction = source.indexOf('\nasync function ', start + 1);
  const nextPlainFunction = source.indexOf('\nfunction ', start + 1);
  const nextModuleExports = source.indexOf('\nmodule.exports', start + 1);
  const candidates = [nextFunction, nextPlainFunction, nextModuleExports]
    .filter((index) => index > start);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

function buildUsdjpyAuditCandles(count = 48) {
  const candles = [];
  let previousClose = 150;
  for (let index = 0; index < count; index += 1) {
    const time = new Date(Date.UTC(2026, 0, 1, 0, index * 5)).toISOString();
    const close = previousClose - 0.16;
    candles.push({
      time,
      open: previousClose,
      high: Math.max(previousClose, close) + 0.08,
      low: Math.min(previousClose, close) - 0.08,
      close,
      volume: 100 + index,
    });
    previousClose = close;
  }

  const last = candles[candles.length - 1];
  candles[candles.length - 1] = {
    ...last,
    open: last.close - 0.08,
    low: last.close - 0.2,
    high: last.close + 0.08,
    close: last.close,
  };
  return candles;
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
      ? buildCheck('symbolCustom engine does not execute directly', 'PASS', 'symbolCustomEngine does not call tradeExecutor or paperTradingService directly.')
      : buildCheck('symbolCustom engine does not execute directly', 'FAIL', 'symbolCustomEngine appears to reference trade execution.');
  } catch (error) {
    return buildCheck('symbolCustom engine does not execute directly', 'FAIL', `Unable to inspect symbolCustomEngine: ${error.message}`);
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
    `${liveEnabled.length} SymbolCustom record(s) have liveEnabled=true. ${LIVE_RUNTIME_GATE_WARNING}.`
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

function auditSymbolCustomLiveRuntimeExecutionPathGated() {
  try {
    const engineSource = readProjectFile('src/services/symbolCustomEngine.js');
    const liveRuntimeSource = readProjectFile('src/services/symbolCustomLiveRuntimeService.js');
    const paperRuntimeSource = readProjectFile('src/services/symbolCustomPaperRuntimeService.js');
    const liveGated = /scope\s*===\s*'live'/.test(engineSource)
      && /evaluateSymbolCustomLiveReadiness/.test(engineSource)
      && /SYMBOL_CUSTOM_LIVE_NOT_ENABLED/.test(engineSource)
      && /SYMBOL_CUSTOM_LIVE_NOT_ALLOWED/.test(engineSource)
      && /SYMBOL_CUSTOM_LIVE_STATUS_NOT_READY/.test(engineSource)
      && /liveAnalysisAllowed/.test(engineSource);
    const liveRuntimeExecutesThroughGates = /handleSymbolCustomLiveSignal/.test(liveRuntimeSource)
      && /resolveLiveSignalHandler/.test(liveRuntimeSource)
      && /executeTrade/.test(liveRuntimeSource)
      && /if\s*\(!isExecutionEnabled\(\)\)/.test(liveRuntimeSource)
      && /getLiveRuntimeGate/.test(liveRuntimeSource)
      && /LIVE_ALLOWED_LOGICS/.test(liveRuntimeSource)
      && /findOpenSymbolCustomPosition/.test(liveRuntimeSource);
    const paperRuntimeDoesNotStartLive = !/scope:\s*'live'/.test(paperRuntimeSource)
      && sourceExcludes(paperRuntimeSource, [
        /\bexecuteTrade\s*\(/,
        /tradeExecutor/i,
        /placeOrder\s*\(/,
        /preflightOrder\s*\(/,
      ]);

    return liveGated && liveRuntimeExecutesThroughGates && paperRuntimeDoesNotStartLive
      ? buildCheck('symbolCustom live runtime execution path gated', 'PASS', 'SymbolCustom live runtime can submit to tradeExecutor only after live/readiness/primary/allow-list/open-position gates.')
      : buildCheck('symbolCustom live runtime execution path gated', 'FAIL', 'SymbolCustom live runtime execution path or paper isolation is not clear.');
  } catch (error) {
    return buildCheck('symbolCustom live runtime execution path gated', 'FAIL', `Unable to inspect live runtime path: ${error.message}`);
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
      && /setupType/.test(source)
      && /'symbol_custom'/.test(source)
      && /strategyType:\s*'SymbolCustom'/.test(source)
      && /candidatePreset/.test(source)
      && /parameterSnapshot/.test(source);

    return marksSource
      ? buildCheck('paper runtime marks source symbolCustom', 'PASS', 'SymbolCustom paper payloads include source, scope, setupType, and strategyType metadata.')
      : buildCheck('paper runtime marks source symbolCustom', 'FAIL', 'SymbolCustom paper payload metadata is incomplete.');
  } catch (error) {
    return buildCheck('paper runtime marks source symbolCustom', 'FAIL', `Unable to inspect paper payload metadata: ${error.message}`);
  }
}

function auditPaperRuntimeRequiresPaperEnabled() {
  try {
    const engineSource = readProjectFile('src/services/symbolCustomEngine.js');
    const runtimeSource = readProjectFile('src/services/symbolCustomPaperRuntimeService.js');
    const ok = /findAll\(\{\s*paperEnabled:\s*true\s*\}\)/.test(engineSource)
      && /symbolCustom\.paperEnabled\s*!==\s*true/.test(runtimeSource);

    return ok
      ? buildCheck('paper runtime requires paperEnabled true', 'PASS', 'SymbolCustom paper runtime only scans records with paperEnabled=true.')
      : buildCheck('paper runtime requires paperEnabled true', 'FAIL', 'SymbolCustom paper runtime may scan records without paperEnabled=true.');
  } catch (error) {
    return buildCheck('paper runtime requires paperEnabled true', 'FAIL', `Unable to inspect paperEnabled gate: ${error.message}`);
  }
}

function auditPaperRuntimeKeepsLiveEnabledObservable() {
  try {
    const source = readProjectFile('src/services/symbolCustomPaperRuntimeService.js');
    const ok = !/symbolCustom\.liveEnabled\s*===\s*true/.test(source)
      && !source.includes('SYMBOL_CUSTOM_PAPER_LIVE_ENABLED_BLOCKED')
      && /symbolCustom\.paperEnabled\s*!==\s*true/.test(source)
      && source.includes('PAPER_ALLOWED_LOGICS');

    return ok
      ? buildCheck('paper runtime keeps liveEnabled records observable', 'PASS', 'SymbolCustom paper runtime continues paper observation for records that are also liveEnabled.')
      : buildCheck('paper runtime keeps liveEnabled records observable', 'FAIL', 'SymbolCustom paper runtime may block paper observation when liveEnabled=true.');
  } catch (error) {
    return buildCheck('paper runtime keeps liveEnabled records observable', 'FAIL', `Unable to inspect liveEnabled paper observation gate: ${error.message}`);
  }
}

function auditPaperRuntimeUsesExplicitLogicAllowList() {
  try {
    const source = readProjectFile('src/services/symbolCustomPaperRuntimeService.js');
    const ok = source.includes('PAPER_ALLOWED_LOGICS')
      && source.includes(USDJPY_JPY_MACRO_REVERSAL_V1)
      && source.includes('XAUUSD_VOLUME_FLOW_BREAKOUT_NY_V1')
      && source.includes('XAUUSD_MICROSTRUCTURE_SCALP_V1')
      && source.includes('XAUUSD_EMA50_PULLBACK_TREND_V1')
      && source.includes('XAUUSD_VOLUME_PROFILE_STRATEGY_V1')
      && source.includes('XTIUSD_OIL_BREAKOUT_RETEST_V1')
      && source.includes('XBRUSD_OIL_LONG_RETEST_SESSION_V2')
      && source.includes('XAGUSD_VOL_TARGET_TREND_V1')
      && source.includes('SYMBOL_CUSTOM_PAPER_LOGIC_NOT_ALLOWED');

    return ok
      ? buildCheck('paper runtime uses explicit logic allow-list', 'PASS', 'SymbolCustom paper runtime allows only explicitly approved paper-trial logics.')
      : buildCheck('paper runtime uses explicit logic allow-list', 'FAIL', 'SymbolCustom paper runtime logic allow-list is not clear.');
  } catch (error) {
    return buildCheck('paper runtime uses explicit logic allow-list', 'FAIL', `Unable to inspect paper logic allow-list: ${error.message}`);
  }
}

function auditSymbolCustomPaperTradesIncludeMetadata() {
  try {
    const runtimeSource = readProjectFile('src/services/symbolCustomPaperRuntimeService.js');
    const paperSource = readProjectFile('src/services/paperTradingService.js');
    const runtimePayloadOk = ['symbolCustomId', 'symbolCustomName', 'logicName', 'candidatePreset', 'setupType', 'parameterSnapshot']
      .every((token) => runtimeSource.includes(token));
    const paperRecordOk = /buildSymbolCustomPaperTradeFields/.test(paperSource)
      && ['symbolCustomId', 'symbolCustomName', 'logicName', 'candidatePreset', 'parameterSnapshot', 'symbolCustomMetadata']
        .every((token) => paperSource.includes(token));

    return runtimePayloadOk && paperRecordOk
      ? buildCheck('symbolCustom paper trades include metadata', 'PASS', 'SymbolCustom paper payloads and records include identifying metadata.')
      : buildCheck('symbolCustom paper trades include metadata', 'FAIL', 'SymbolCustom paper metadata fields are incomplete.');
  } catch (error) {
    return buildCheck('symbolCustom paper trades include metadata', 'FAIL', `Unable to inspect SymbolCustom paper metadata: ${error.message}`);
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

function auditLiveRuntimeDefaultDisabled() {
  try {
    const source = readProjectFile('src/services/symbolCustomLiveRuntimeService.js');
    const serverSource = readProjectFile('src/server.js');
    const serviceRequiresTrue = source.includes('SYMBOL_CUSTOM_LIVE_ENABLED_ENV')
      && /process\.env\[[^\]]*SYMBOL_CUSTOM_LIVE_ENABLED_ENV[^\]]*\]\s*===\s*'true'/.test(source);
    const serverRequiresTrue = serverSource.includes("process.env.SYMBOL_CUSTOM_LIVE_ENABLED === 'true'")
      && /symbolCustomLiveRuntimeService\.start\s*\(/.test(serverSource)
      && serverSource.includes('[SymbolCustom] Live runtime disabled');

    return serviceRequiresTrue && serverRequiresTrue
      ? buildCheck('symbolCustom live runtime default disabled', 'PASS', 'SymbolCustom live runtime only starts when SYMBOL_CUSTOM_LIVE_ENABLED=true.')
      : buildCheck('symbolCustom live runtime default disabled', 'FAIL', 'SymbolCustom live runtime start is not clearly gated by SYMBOL_CUSTOM_LIVE_ENABLED=true.');
  } catch (error) {
    return buildCheck('symbolCustom live runtime default disabled', 'FAIL', `Unable to inspect live runtime default: ${error.message}`);
  }
}

function auditLiveRuntimeExecutionEnvGated() {
  try {
    const source = readProjectFile('src/services/symbolCustomLiveRuntimeService.js');
    const handlerSource = extractFunctionSource(source, 'handleSymbolCustomLiveSignal');
    const resolverSource = extractFunctionSource(source, 'resolveLiveSignalHandler');
    const executionCheckIndex = handlerSource.indexOf('if (!isExecutionEnabled())');
    const handlerResolveIndex = handlerSource.indexOf('resolveLiveSignalHandler');
    const gated = source.includes('SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED_ENV')
      && source.includes('SYMBOL_CUSTOM_LIVE_EXECUTION_DISABLED')
      && executionCheckIndex !== -1
      && handlerResolveIndex !== -1
      && executionCheckIndex < handlerResolveIndex
      && resolverSource.includes('executeTrade');

    return gated
      ? buildCheck('symbolCustom live execution env gated', 'PASS', 'SymbolCustom live runtime cannot call tradeExecutor unless SYMBOL_CUSTOM_LIVE_EXECUTION_ENABLED=true.')
      : buildCheck('symbolCustom live execution env gated', 'FAIL', 'SymbolCustom live execution gate is not clearly before tradeExecutor resolution.');
  } catch (error) {
    return buildCheck('symbolCustom live execution env gated', 'FAIL', `Unable to inspect live execution env gate: ${error.message}`);
  }
}

function auditLiveRuntimeRequiresReadinessPrimaryAndAllowList() {
  try {
    const source = readProjectFile('src/services/symbolCustomLiveRuntimeService.js');
    const ok = source.includes('evaluateSymbolCustomLiveReadiness')
      && source.includes('LIVE_ALLOWED_LOGICS')
      && source.includes('XAUUSD_EMA50_PULLBACK_TREND_V1')
      && source.includes('SYMBOL_CUSTOM_LIVE_LOGIC_NOT_ALLOWED')
      && source.includes('symbolCustom.isPrimaryLive !== true')
      && source.includes('SYMBOL_CUSTOM_LIVE_NOT_PRIMARY');

    return ok
      ? buildCheck('symbolCustom live runtime readiness gated', 'PASS', 'SymbolCustom live runtime requires engine readiness, primary-live selection, and explicit logic allow-list.')
      : buildCheck('symbolCustom live runtime readiness gated', 'FAIL', 'SymbolCustom live runtime readiness/primary/allow-list gates are incomplete.');
  } catch (error) {
    return buildCheck('symbolCustom live runtime readiness gated', 'FAIL', `Unable to inspect live runtime readiness gates: ${error.message}`);
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
    const liveGated = /scope\s*===\s*'live'/.test(source)
      && /evaluateSymbolCustomLiveReadiness/.test(source)
      && /LIVE_READY_STATUSES/.test(source)
      && /allowLive/.test(source)
      && /liveEnabled/.test(source);

    return backtestAllowed && liveGated
      ? buildCheck('backtest scope allowed live blocked', 'PASS', 'SymbolCustom engine allows backtest scope while live analysis is gated by readiness flags.')
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

function auditUsdjpyPaperScopeEnabledLiveBlocked() {
  try {
    const { getSymbolCustomLogic } = require('../symbolCustom/registry');
    const logic = getSymbolCustomLogic(USDJPY_JPY_MACRO_REVERSAL_V1);
    const candles = buildUsdjpyAuditCandles();
    const paper = logic ? logic.analyze({
      scope: 'paper',
      symbol: 'USDJPY',
      parameters: USDJPY_PAPER_CANDIDATE_PARAMETERS,
      candles: { setup: candles, entry: candles, higher: candles },
      currentBar: candles[candles.length - 1],
      currentIndex: candles.length - 1,
      currentUtcHour: 0,
    }) : null;
    const live = logic ? logic.analyze({ scope: 'live', symbol: 'USDJPY' }) : null;
    const source = readProjectFile('src/symbolCustom/logics/UsdjpyJpyMacroReversalV1.js');
    const paperEnabled = paper?.signal === 'BUY'
      && paper?.metadata?.candidatePreset === 'buy_session_conservative'
      && live?.signal === 'NONE'
      && live?.status === 'BLOCKED'
      && source.includes("scope !== 'backtest' && scope !== 'paper'")
      && source.includes('LIVE_BLOCKED_REASON');

    return paperEnabled
      ? buildCheck('USDJPY paper scope enabled live blocked', 'PASS', 'USDJPY macro reversal can emit paper trial signals while live remains blocked.')
      : buildCheck('USDJPY paper scope enabled live blocked', 'FAIL', 'USDJPY paper scope or live block behavior is not configured as expected.');
  } catch (error) {
    return buildCheck('USDJPY paper scope enabled live blocked', 'FAIL', `Unable to inspect USDJPY macro reversal scope gating: ${error.message}`);
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

function auditUsdjpyGuardrailsPaperBacktestOnly() {
  try {
    const source = readProjectFile('src/symbolCustom/logics/UsdjpyJpyMacroReversalV1.js');
    const hasGuardrails = source.includes('enableBuy')
      && source.includes('allowedUtcHours')
      && source.includes('cooldownBarsAfterSL')
      && source.includes('maxDailyLosses');
    const guardedCallIndex = source.indexOf('const guardrailReason = shouldBlockByGuardrails');
    const gated = guardedCallIndex > -1
      && source.indexOf("scope !== 'backtest' && scope !== 'paper'") < guardedCallIndex
      && source.includes("scope === 'live'");

    return hasGuardrails && gated
      ? buildCheck('USDJPY guardrails are paper/backtest-only', 'PASS', 'USDJPY guardrails are evaluated only after paper/backtest scope gating.')
      : buildCheck('USDJPY guardrails are paper/backtest-only', 'FAIL', 'USDJPY guardrail scope gating is not clear.');
  } catch (error) {
    return buildCheck('USDJPY guardrails are paper/backtest-only', 'FAIL', `Unable to inspect USDJPY guardrails: ${error.message}`);
  }
}

function auditUsdjpyLiveStillBlockedAfterGuardrails() {
  try {
    const { getSymbolCustomLogic } = require('../symbolCustom/registry');
    const logic = getSymbolCustomLogic(USDJPY_JPY_MACRO_REVERSAL_V1);
    const live = logic.analyze({
      scope: 'live',
      parameters: { enableBuy: true, enableSell: true },
      currentUtcHour: 0,
    });
    const safe = live?.signal === 'NONE' && live?.status === 'BLOCKED';

    return safe
      ? buildCheck('USDJPY live remains blocked after guardrail changes', 'PASS', 'USDJPY guardrails do not enable live signals.')
      : buildCheck('USDJPY live remains blocked after guardrail changes', 'FAIL', 'USDJPY emitted a tradable live signal.');
  } catch (error) {
    return buildCheck('USDJPY live remains blocked after guardrail changes', 'FAIL', `Unable to test USDJPY live scope: ${error.message}`);
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

function auditUsdjpyLiveRemainsBlockedForPresetComparison() {
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
    const live = logic.analyze({ scope: 'live', parameters, currentUtcHour: 0 });
    const safe = live?.signal === 'NONE' && live?.status === 'BLOCKED';

    return safe
      ? buildCheck('USDJPY live remains blocked for preset comparison', 'PASS', 'Guardrail presets do not enable USDJPY live signals.')
      : buildCheck('USDJPY live remains blocked for preset comparison', 'FAIL', 'USDJPY emitted a tradable live signal under preset parameters.');
  } catch (error) {
    return buildCheck('USDJPY live remains blocked for preset comparison', 'FAIL', `Unable to test USDJPY preset live safety: ${error.message}`);
  }
}

function auditCandidateValidationDoesNotCallTradeExecutor() {
  try {
    const source = readProjectFile('src/services/symbolCustomCandidateValidationService.js');
    const safe = sourceExcludes(source, [
      /tradeExecutor/i,
      /\bexecuteTrade\s*\(/,
      /placeOrder\s*\(/,
      /preflightOrder\s*\(/,
    ]);

    return safe
      ? buildCheck('candidate validation does not call tradeExecutor', 'PASS', 'SymbolCustom candidate validation only orchestrates backtest/evaluation services.')
      : buildCheck('candidate validation does not call tradeExecutor', 'FAIL', 'SymbolCustom candidate validation appears to reference live order execution.');
  } catch (error) {
    return buildCheck('candidate validation does not call tradeExecutor', 'FAIL', `Unable to inspect candidate validation tradeExecutor isolation: ${error.message}`);
  }
}

function auditCandidateValidationDoesNotCallRiskManager() {
  try {
    const source = readProjectFile('src/services/symbolCustomCandidateValidationService.js');
    const safe = sourceExcludes(source, [
      /riskManager/i,
      /calculateLotSize\s*\(/,
      /calculatePositionSize\s*\(/,
    ]);

    return safe
      ? buildCheck('candidate validation does not call riskManager', 'PASS', 'SymbolCustom candidate validation does not reference live risk sizing.')
      : buildCheck('candidate validation does not call riskManager', 'FAIL', 'SymbolCustom candidate validation appears to reference riskManager.');
  } catch (error) {
    return buildCheck('candidate validation does not call riskManager', 'FAIL', `Unable to inspect candidate validation risk isolation: ${error.message}`);
  }
}

function auditCandidateValidationDoesNotCallPaperTradingService() {
  try {
    const source = readProjectFile('src/services/symbolCustomCandidateValidationService.js');
    const safe = sourceExcludes(source, [
      /paperTradingService/i,
      /submitSymbolCustomSignal\s*\(/,
      /submitExternalPaperSignal\s*\(/,
      /_executePaperTrade\s*\(/,
    ]);

    return safe
      ? buildCheck('candidate validation does not call paperTradingService', 'PASS', 'SymbolCustom candidate validation does not submit paper signals.')
      : buildCheck('candidate validation does not call paperTradingService', 'FAIL', 'SymbolCustom candidate validation appears to reference paper execution.');
  } catch (error) {
    return buildCheck('candidate validation does not call paperTradingService', 'FAIL', `Unable to inspect candidate validation paper isolation: ${error.message}`);
  }
}

function auditCandidateValidationDoesNotCallOldBacktestEngine() {
  try {
    const source = readProjectFile('src/services/symbolCustomCandidateValidationService.js');
    const safe = sourceExcludes(source, [
      /backtestEngine/,
      /runBacktest\s*\(/,
    ]);

    return safe
      ? buildCheck('candidate validation does not call old backtestEngine', 'PASS', 'SymbolCustom candidate validation uses SymbolCustom backtest service only.')
      : buildCheck('candidate validation does not call old backtestEngine', 'FAIL', 'SymbolCustom candidate validation appears to reference old backtestEngine.');
  } catch (error) {
    return buildCheck('candidate validation does not call old backtestEngine', 'FAIL', `Unable to inspect candidate validation backtest isolation: ${error.message}`);
  }
}

function auditCandidateValidationDoesNotCallSixStrategies() {
  try {
    const source = readProjectFile('src/services/symbolCustomCandidateValidationService.js');
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
      ? buildCheck('candidate validation does not call six strategies', 'PASS', 'SymbolCustom candidate validation does not reference six strategy classes.')
      : buildCheck('candidate validation does not call six strategies', 'FAIL', 'SymbolCustom candidate validation appears to reference six strategy classes.');
  } catch (error) {
    return buildCheck('candidate validation does not call six strategies', 'FAIL', `Unable to inspect candidate validation strategy isolation: ${error.message}`);
  }
}

function auditSchemaSyncDoesNotChangePaperLive() {
  try {
    const source = readProjectFile('src/services/symbolCustomService.js');
    const syncSource = extractFunctionSource(source, 'syncSymbolCustomSchemaFromLogic');
    const hasSync = syncSource.includes('parameterSchema') && syncSource.includes('parameters');
    const leavesExecutionFlags = sourceExcludes(syncSource, [
      /paperEnabled\s*:/,
      /liveEnabled\s*:/,
      /allowLive\s*:/,
      /isPrimaryLive\s*:/,
      /status\s*:/,
    ]);

    return hasSync && leavesExecutionFlags
      ? buildCheck('schema sync does not change paper/live/liveEnabled', 'PASS', 'Schema sync only patches parameters and parameterSchema.')
      : buildCheck('schema sync does not change paper/live/liveEnabled', 'FAIL', 'Schema sync appears to modify execution flags or status.');
  } catch (error) {
    return buildCheck('schema sync does not change paper/live/liveEnabled', 'FAIL', `Unable to inspect schema sync flag safety: ${error.message}`);
  }
}

function auditSchemaSyncDoesNotTouchTradingSystems() {
  try {
    const source = readProjectFile('src/services/symbolCustomService.js');
    const syncSource = extractFunctionSource(source, 'syncSymbolCustomSchemaFromLogic');
    const safe = sourceExcludes(syncSource, [
      /tradeExecutor/i,
      /riskManager/i,
      /backtestEngine/i,
      /optimizerService/i,
      /TrendFollowing/,
      /MeanReversion/,
      /Breakout/,
      /MultiTimeframe/,
      /Momentum/,
      /VolumeFlowHybrid/,
      /paperTradingService/i,
      /placeOrder\s*\(/,
      /executeTrade\s*\(/,
    ]);

    return safe
      ? buildCheck('schema sync does not touch trading systems', 'PASS', 'Schema sync is isolated to SymbolCustom configuration fields.')
      : buildCheck('schema sync does not touch trading systems', 'FAIL', 'Schema sync appears to reference trading, risk, old backtest, optimizer, or six strategy systems.');
  } catch (error) {
    return buildCheck('schema sync does not touch trading systems', 'FAIL', `Unable to inspect schema sync isolation: ${error.message}`);
  }
}

function auditApplyCandidateDoesNotChangeExecutionFlags() {
  try {
    const source = readProjectFile('src/services/symbolCustomService.js');
    const applySource = extractFunctionSource(source, 'applySymbolCustomCandidateParameters');
    const hasApply = applySource.includes('parameters') && applySource.includes('SymbolCustom.update');
    const leavesExecutionFlags = sourceExcludes(applySource, [
      /paperEnabled\s*:/,
      /liveEnabled\s*:/,
      /allowLive\s*:/,
      /isPrimaryLive\s*:/,
      /status\s*:/,
    ]);

    return hasApply && leavesExecutionFlags
      ? buildCheck('candidate apply does not change paper/live/status', 'PASS', 'Candidate apply only patches stored parameters.')
      : buildCheck('candidate apply does not change paper/live/status', 'FAIL', 'Candidate apply appears to modify execution flags or status.');
  } catch (error) {
    return buildCheck('candidate apply does not change paper/live/status', 'FAIL', `Unable to inspect candidate apply flag safety: ${error.message}`);
  }
}

function auditApplyCandidateDoesNotTouchTradingSystems() {
  try {
    const source = readProjectFile('src/services/symbolCustomService.js');
    const applySource = extractFunctionSource(source, 'applySymbolCustomCandidateParameters');
    const safe = sourceExcludes(applySource, [
      /tradeExecutor/i,
      /riskManager/i,
      /backtestEngine/i,
      /optimizerService/i,
      /TrendFollowing/,
      /MeanReversion/,
      /Breakout/,
      /MultiTimeframe/,
      /Momentum/,
      /VolumeFlowHybrid/,
      /paperTradingService/i,
      /placeOrder\s*\(/,
      /executeTrade\s*\(/,
    ]);

    return safe
      ? buildCheck('candidate apply does not touch trading systems', 'PASS', 'Candidate apply is isolated to SymbolCustom parameters.')
      : buildCheck('candidate apply does not touch trading systems', 'FAIL', 'Candidate apply appears to reference trading, risk, old backtest, optimizer, or six strategy systems.');
  } catch (error) {
    return buildCheck('candidate apply does not touch trading systems', 'FAIL', `Unable to inspect candidate apply isolation: ${error.message}`);
  }
}

function auditLivePromotionPreservesPaperLiveEnabled() {
  try {
    const source = readProjectFile('src/services/symbolCustomLivePromotionService.js');
    const promoteSource = extractFunctionSource(source, 'promoteSymbolCustomToLiveReady');
    const hasPromotionPatch = promoteSource.includes('SymbolCustom.update')
      && source.includes("status: 'live_ready'")
      && source.includes('allowLive: true')
      && source.includes('isPrimaryLive: true')
      && source.includes('LIVE_READY_PATCH');
    const preservesPaperLive = sourceExcludes(promoteSource, [
      /paperEnabled\s*:/,
      /liveEnabled\s*:/,
    ]);

    return hasPromotionPatch && preservesPaperLive
      ? buildCheck('live promotion preserves paper/live enabled', 'PASS', 'Live promotion only patches status, allowLive, and isPrimaryLive.')
      : buildCheck('live promotion preserves paper/live enabled', 'FAIL', 'Live promotion may modify paperEnabled or liveEnabled.');
  } catch (error) {
    return buildCheck('live promotion preserves paper/live enabled', 'FAIL', `Unable to inspect live promotion flag safety: ${error.message}`);
  }
}

function auditLivePromotionRequiresStrictValidationEvidence() {
  try {
    const source = readProjectFile('src/services/symbolCustomLivePromotionService.js');
    const hasThresholds = source.includes('DEFAULT_LIVE_PROMOTION_THRESHOLDS')
      && source.includes('full_window')
      && source.includes('recent_window')
      && source.includes('minProfitFactor')
      && source.includes('maxDrawdown')
      && source.includes('maxConsecutiveLosses');
    const hasEvidenceGate = source.includes('strict validation evidence supplied')
      && source.includes('evaluateRangeChecks')
      && source.includes('equityCurveHasBalance')
      && source.includes('equityCurveHasEquity');

    return hasThresholds && hasEvidenceGate
      ? buildCheck('live promotion requires strict validation evidence', 'PASS', 'Live promotion requires full/recent strict validation evidence with performance and curve-field gates.')
      : buildCheck('live promotion requires strict validation evidence', 'FAIL', 'Live promotion evidence gates are incomplete.');
  } catch (error) {
    return buildCheck('live promotion requires strict validation evidence', 'FAIL', `Unable to inspect live promotion evidence gates: ${error.message}`);
  }
}

function auditLivePromotionDoesNotTouchTradingSystems() {
  try {
    const source = readProjectFile('src/services/symbolCustomLivePromotionService.js');
    const safe = sourceExcludes(source, [
      /tradeExecutor/i,
      /riskManager/i,
      /backtestEngine/i,
      /optimizerService/i,
      /TrendFollowing/,
      /MeanReversion/,
      /Breakout/,
      /MultiTimeframe/,
      /Momentum/,
      /VolumeFlowHybrid/,
      /paperTradingService/i,
      /placeOrder\s*\(/,
      /executeTrade\s*\(/,
      /preflightOrder\s*\(/,
    ]);

    return safe
      ? buildCheck('live promotion does not touch trading systems', 'PASS', 'Live promotion only reads validation evidence and updates SymbolCustom readiness flags.')
      : buildCheck('live promotion does not touch trading systems', 'FAIL', 'Live promotion appears to reference trading, risk, old backtest, optimizer, or six strategy systems.');
  } catch (error) {
    return buildCheck('live promotion does not touch trading systems', 'FAIL', `Unable to inspect live promotion isolation: ${error.message}`);
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
  checks.push(auditSymbolCustomLiveRuntimeExecutionPathGated());
  checks.push(auditPaperRuntimeNeverCallsTradeExecutor());
  checks.push(auditPaperRuntimeMarksSymbolCustomSource());
  checks.push(auditPaperRuntimeRequiresPaperEnabled());
  checks.push(auditPaperRuntimeKeepsLiveEnabledObservable());
  checks.push(auditPaperRuntimeUsesExplicitLogicAllowList());
  checks.push(auditSymbolCustomPaperTradesIncludeMetadata());
  checks.push(auditPaperRuntimeRequiresEnvForSchedulerStart());
  checks.push(auditLiveRuntimeDefaultDisabled());
  checks.push(auditLiveRuntimeExecutionEnvGated());
  checks.push(auditLiveRuntimeRequiresReadinessPrimaryAndAllowList());
  checks.push(auditScanOnceRespectsEnvGateUnlessForced());
  checks.push(auditPaperRuntimeDoesNotCallPrivatePaperExecution());
  checks.push(auditPublicPaperSignalWrapperExists());
  checks.push(auditMissingCandleProviderDetected());
  checks.push(auditBacktestScopeAllowedLiveBlocked());
  checks.push(auditUsdjpyMacroReversalRegistered());
  checks.push(auditUsdjpyPaperScopeEnabledLiveBlocked());
  checks.push(auditUsdjpyMacroReversalDoesNotReferenceSixStrategies());
  checks.push(auditUsdjpyMacroReversalDoesNotReferenceTradeExecutor());
  checks.push(auditUsdjpyMacroReversalDoesNotReferenceRiskManager());
  checks.push(auditUsdjpyMacroReversalDoesNotReferenceOldBacktestEngine());
  checks.push(auditUsdjpyGuardrailsPaperBacktestOnly());
  checks.push(auditUsdjpyLiveStillBlockedAfterGuardrails());
  checks.push(auditEvaluationServiceDoesNotCallTradeExecutor());
  checks.push(auditEvaluationServiceDoesNotCallRiskManager());
  checks.push(auditEvaluationServiceDoesNotCallOldBacktestEngine());
  checks.push(auditEvaluationServiceDoesNotCallSixStrategies());
  checks.push(auditPresetComparisonDoesNotCallTradeExecutor());
  checks.push(auditPresetComparisonDoesNotCallPaperTradingService());
  checks.push(auditPresetComparisonDoesNotCallOldBacktestEngine());
  checks.push(auditPresetComparisonDoesNotCallSixStrategies());
  checks.push(auditUsdjpyLiveRemainsBlockedForPresetComparison());
  checks.push(auditCandidateValidationDoesNotCallTradeExecutor());
  checks.push(auditCandidateValidationDoesNotCallRiskManager());
  checks.push(auditCandidateValidationDoesNotCallPaperTradingService());
  checks.push(auditCandidateValidationDoesNotCallOldBacktestEngine());
  checks.push(auditCandidateValidationDoesNotCallSixStrategies());
  checks.push(auditSchemaSyncDoesNotChangePaperLive());
  checks.push(auditSchemaSyncDoesNotTouchTradingSystems());
  checks.push(auditApplyCandidateDoesNotChangeExecutionFlags());
  checks.push(auditApplyCandidateDoesNotTouchTradingSystems());
  checks.push(auditLivePromotionPreservesPaperLiveEnabled());
  checks.push(auditLivePromotionRequiresStrictValidationEvidence());
  checks.push(auditLivePromotionDoesNotTouchTradingSystems());

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
