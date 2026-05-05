const mt5Service = require('../services/mt5Service');
const strategyEngine = require('../services/strategyEngine');
const tradeExecutor = require('../services/tradeExecutor');
const positionMonitor = require('../services/positionMonitor');
const riskManager = require('../services/riskManager');
const strategyDailyStopService = require('../services/strategyDailyStopService');
const indicatorService = require('../services/indicatorService');
const websocketService = require('../services/websocketService');
const notificationService = require('../services/notificationService');
const Strategy = require('../models/Strategy');
const ExecutionAudit = require('../models/ExecutionAudit');
const { positionsDb, tradesDb } = require('../config/db');
const {
  CadenceScheduler,
  buildAssignmentStats,
  buildSignalScanBucketStatus,
  listActiveAssignments,
} = require('../services/assignmentRuntimeService');
const { getAllSymbols, getInstrument, instruments, INSTRUMENT_CATEGORIES } = require('../config/instruments');
const { buildBrokerComment, buildTradeComment } = require('../utils/tradeComment');
const { buildOpenTradeCapture } = require('../utils/tradeDataCapture');
const symbolResolver = require('../services/symbolResolver');
const liveTradingPermissionService = require('../services/liveTradingPermissionService');

let tradingScheduler = null;

function getPricePrecision(instrument) {
  const pipSize = String(instrument?.pipSize || '0.01');
  if (pipSize.includes('e-')) {
    return parseInt(pipSize.split('e-')[1], 10);
  }

  const decimalPart = pipSize.split('.')[1];
  return decimalPart ? decimalPart.length : 2;
}

function roundPrice(value, instrument) {
  return parseFloat(Number(value).toFixed(getPricePrecision(instrument)));
}

function getLotPrecision(instrument) {
  const lotStep = String(instrument?.lotStep || instrument?.minLot || '0.01');
  if (lotStep.includes('e-')) {
    return parseInt(lotStep.split('e-')[1], 10);
  }

  const decimalPart = lotStep.split('.')[1];
  return decimalPart ? decimalPart.length : 2;
}

function createHttpError(message, statusCode = 400, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

function ensureDebugTradingAllowed(accountInfo = {}) {
  const mode = mt5Service.getAccountModeName(accountInfo);
  const isPaperLike = accountInfo.isDemo === true
    || accountInfo.isContest === true
    || mode === 'DEMO'
    || mode === 'CONTEST';

  if (isPaperLike) {
    mt5Service.ensurePaperTradingAccount(accountInfo);
    return {
      mode,
      scope: 'paper',
    };
  }

  mt5Service.ensureLiveTradingAllowed(accountInfo);
  return {
    mode,
    scope: 'live',
  };
}

function normalizeManualVolume(volume, instrument) {
  const numericVolume = Number(volume);
  if (!Number.isFinite(numericVolume) || numericVolume <= 0) {
    throw createHttpError('Lot size must be a positive number.');
  }

  const lotStep = Number(instrument?.lotStep) || 0.01;
  const minLot = Number(instrument?.minLot) || lotStep;
  const precision = getLotPrecision(instrument);
  const normalizedVolume = parseFloat(numericVolume.toFixed(precision));
  const stepRatio = normalizedVolume / lotStep;

  if (normalizedVolume < minLot) {
    throw createHttpError(
      `Lot size must be at least ${minLot.toFixed(precision)} for ${instrument.symbol}.`
    );
  }

  if (Math.abs(stepRatio - Math.round(stepRatio)) > 1e-8) {
    throw createHttpError(
      `Lot size must follow step ${lotStep.toFixed(precision)} for ${instrument.symbol}.`
    );
  }

  return normalizedVolume;
}

async function recordTestOrderAudit(stage, status, signal, extra = {}) {
  const audit = await ExecutionAudit.create({
    scope: 'live',
    stage,
    status,
    symbol: signal?.symbol || extra.symbol || null,
    type: signal?.signal || extra.type || null,
    strategy: signal?.strategy || 'TestOrder',
    volume: extra.volume ?? null,
    code: extra.code ?? null,
    codeName: extra.codeName || null,
    message: extra.message || '',
    accountMode: extra.accountInfo ? mt5Service.getAccountModeName(extra.accountInfo) : null,
    accountLogin: extra.accountInfo?.login || null,
    accountServer: extra.accountInfo?.server || null,
    source: 'test_order',
    details: extra.details || null,
    createdAt: extra.createdAt || new Date(),
  });

  websocketService.broadcast('status', 'execution_audit', audit);
  return audit;
}

async function buildProtectedTestSignal(symbol, direction, priceData) {
  const instrument = getInstrument(symbol);
  if (!instrument) {
    throw createHttpError(`Unknown instrument: ${symbol}`);
  }

  const entryPrice = direction === 'BUY' ? Number(priceData.ask) : Number(priceData.bid);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw createHttpError(`Cannot determine entry price for ${symbol}`);
  }

  let atr = null;
  try {
    const candles = await mt5Service.getCandles(symbol, instrument.timeframe || '1h', null, 120);
    const closedCandles = Array.isArray(candles) && candles.length > 1 ? candles.slice(0, -1) : [];
    if (closedCandles.length >= 20) {
      const atrSeries = indicatorService.atr(closedCandles, 14);
      const latestAtr = atrSeries[atrSeries.length - 1];
      if (Number.isFinite(latestAtr) && latestAtr > 0) {
        atr = latestAtr;
      }
    }
  } catch (err) {
    atr = null;
  }

  const minSlDistance = instrument.spread * instrument.pipSize * 3;
  const slDistance = atr
    ? Math.max(atr * (Number(instrument.riskParams?.slMultiplier) || 1), minSlDistance)
    : minSlDistance;
  const tpDistance = atr
    ? Math.max(atr * (Number(instrument.riskParams?.tpMultiplier) || 2), minSlDistance)
    : (minSlDistance * Math.max(Number(instrument.riskParams?.tpMultiplier) || 2, 1));

  const sl = direction === 'BUY'
    ? roundPrice(entryPrice - slDistance, instrument)
    : roundPrice(entryPrice + slDistance, instrument);
  const tp = direction === 'BUY'
    ? roundPrice(entryPrice + tpDistance, instrument)
    : roundPrice(entryPrice - tpDistance, instrument);

  return {
    symbol,
    signal: direction,
    strategy: 'TestOrder',
    confidence: 1,
    entryPrice,
    sl,
    tp,
    reason: atr ? 'Protected live test order' : 'Protected live test order (fallback distance)',
    indicatorsSnapshot: atr ? { atr } : {},
  };
}

async function persistOpenedDebugTrade(signal, volume, order, brokerComment) {
  const executedEntryPrice = order.entryDeal?.price || order.price || signal.entryPrice;
  const openedAt = order.entryDeal?.time ? new Date(order.entryDeal.time) : new Date();
  const mt5PositionId = order.positionId || order.orderId || null;
  const mt5EntryDealId = order.entryDeal?.id || order.dealId || null;
  const mt5Comment = order.entryDeal?.comment || brokerComment;
  const tradeComment = buildTradeComment(signal, mt5Comment);
  const entryCommission = Number(order.entryDeal?.commission) || 0;
  const entrySwap = Number(order.entryDeal?.swap) || 0;
  const entryFee = Number(order.entryDeal?.fee) || 0;
  const openCapture = buildOpenTradeCapture(signal, {});
  const slippageEstimate = Number.isFinite(Number(executedEntryPrice)) && Number.isFinite(Number(signal.entryPrice))
    ? parseFloat((Number(executedEntryPrice) - Number(signal.entryPrice)).toFixed(10))
    : null;

  const position = await positionsDb.insert({
    symbol: signal.symbol,
    type: signal.signal,
    entryPrice: executedEntryPrice,
    currentPrice: executedEntryPrice,
    currentSl: signal.sl,
    currentTp: signal.tp,
    lotSize: volume,
    originalLotSize: volume,
    mt5PositionId,
    mt5EntryDealId,
    mt5Comment,
    strategy: signal.strategy,
    comment: tradeComment,
    confidence: signal.confidence,
    reason: openCapture.signalReason || signal.reason,
    atrAtEntry: signal.indicatorsSnapshot?.atr || 0,
    ...openCapture,
    partialsExecutedIndices: [],
    maxFavourablePrice: executedEntryPrice,
    requestedEntryPrice: signal.entryPrice || null,
    slippageEstimate,
    brokerRetcodeOpen: order.retcode ?? null,
    indicatorsSnapshot: openCapture.indicatorsSnapshot,
    unrealizedPl: 0,
    openedAt,
    status: 'OPEN',
  });

  await tradesDb.insert({
    symbol: signal.symbol,
    type: signal.signal,
    entryPrice: executedEntryPrice,
    sl: signal.sl,
    tp: signal.tp,
    lotSize: volume,
    strategy: signal.strategy,
    confidence: signal.confidence,
    reason: openCapture.signalReason || signal.reason,
    entryReason: openCapture.entryReason,
    setupReason: openCapture.setupReason,
    triggerReason: openCapture.triggerReason,
    initialSl: openCapture.initialSl,
    initialTp: openCapture.initialTp,
    finalSl: openCapture.finalSl,
    finalTp: openCapture.finalTp,
    requestedEntryPrice: signal.entryPrice || null,
    slippageEstimate,
    brokerRetcodeOpen: order.retcode ?? null,
    indicatorsSnapshot: openCapture.indicatorsSnapshot,
    commission: entryCommission,
    swap: entrySwap,
    fee: entryFee,
    mt5PositionId,
    mt5OrderId: order.orderId || null,
    mt5EntryDealId,
    mt5Comment,
    comment: tradeComment,
    positionDbId: position._id,
    status: 'OPEN',
    openedAt,
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    profitLoss: null,
    profitPips: null,
  });

  websocketService.broadcast('trades', 'trade_opened', position);
  websocketService.broadcast('positions', 'position_update', { action: 'opened', position });
  await notificationService.notifyTradeOpened(position);

  return position;
}

async function getLiveAssignments(activeProfile = null) {
  await Strategy.initDefaults(strategyEngine.getStrategiesInfo());
  return listActiveAssignments({ activeProfile, scope: 'live' });
}

async function getLiveAccountInfo({ reconnectOnMismatch = false } = {}) {
  if (typeof mt5Service.reloadConnectionEnvFromFile === 'function') {
    mt5Service.reloadConnectionEnvFromFile();
  }

  if (mt5Service.isConnected()) {
    const accountInfo = await mt5Service.getAccountInfo();
    if (typeof mt5Service.getAccountConfigMatch !== 'function') {
      return { accountInfo, accountConfigMatch: null, reconnected: false };
    }

    const accountConfigMatch = mt5Service.getAccountConfigMatch(accountInfo);
    if (accountConfigMatch.matches || !reconnectOnMismatch) {
      return { accountInfo, accountConfigMatch, reconnected: false };
    }

    await mt5Service.disconnect();
  }

  await mt5Service.connect();
  const accountInfo = await mt5Service.getAccountInfo();
  const accountConfigMatch = typeof mt5Service.getAccountConfigMatch === 'function'
    ? mt5Service.getAccountConfigMatch(accountInfo)
    : null;
  return { accountInfo, accountConfigMatch, reconnected: true };
}

function buildLiveConnectionStatus(accountInfo = null, accountConfigMatch = null) {
  if (typeof mt5Service.reloadConnectionEnvFromFile === 'function') {
    mt5Service.reloadConnectionEnvFromFile();
  }

  const config = typeof mt5Service.getPublicConnectionConfig === 'function'
    ? mt5Service.getPublicConnectionConfig()
    : null;
  const match = accountConfigMatch || (
    accountInfo && typeof mt5Service.getAccountConfigMatch === 'function'
      ? mt5Service.getAccountConfigMatch(accountInfo)
      : null
  );
  const runtimeIdentity = typeof mt5Service.buildRuntimeIdentityStatus === 'function'
    ? mt5Service.buildRuntimeIdentityStatus(accountInfo)
    : null;

  return {
    scope: 'live',
    config,
    runtimeIdentity,
    accountConfigMatch: match,
    warning: match && !match.matches
      ? `Live MT5 account mismatch: expected ${match.expected.login || '--'}@${match.expected.server || '--'}, got ${match.actual.login || '--'}@${match.actual.server || '--'}`
      : null,
  };
}

function getSafeLiveConnectionStatus() {
  try {
    return buildLiveConnectionStatus();
  } catch (error) {
    return {
      scope: 'live',
      config: null,
      runtimeIdentity: null,
      accountConfigMatch: null,
      warning: error.message || 'Unable to build live connection diagnostics',
    };
  }
}

function buildLiveTradingStartFailure(error) {
  const liveConnection = getSafeLiveConnectionStatus();
  const diagnostics = error.details?.diagnostics || error.details || null;
  const config = diagnostics?.config || liveConnection.config || {};
  const expected = diagnostics?.expectedAccount || {
    login: config.login || null,
    server: config.server || null,
  };
  const nextSteps = [];

  if (!config.pathConfigured) {
    nextSteps.push(`Set ${config.env?.path || 'MT5_LIVE_PATH'} to the real-account MT5 terminal64.exe path on this machine/VPS.`);
  } else {
    nextSteps.push(`Open/check the MT5 terminal at ${config.path}; make sure it is not updating or waiting for login/UAC prompts.`);
  }

  if (diagnostics?.peer?.connected) {
    nextSteps.push(`Paper is already connected. Use separate terminal installs and set both MT5_LIVE_PATH and MT5_PAPER_PATH.`);
  }

  nextSteps.push(`Verify ${config.env?.login || 'MT5_LIVE_LOGIN'} / ${config.env?.server || 'MT5_LIVE_SERVER'} points to the REAL account you want to trade.`);
  nextSteps.push('Restart the backend after changing terminal paths, then click Start Live Trading again.');

  let message = error.message || 'Failed to start live trading';
  if (error.code === 'MT5_CONNECT_TIMEOUT' || error.code === 'MT5_COMMAND_TIMEOUT' || /timeout/i.test(message)) {
    message = `Live MT5 connection timed out for ${expected.login || '--'}@${expected.server || '--'}. `
      + 'The backend could not get a response from MT5 connect. See diagnostics for the likely cause.';
  }

  return {
    message,
    data: {
      errorCode: error.code || null,
      method: error.method || null,
      liveConnection,
      diagnostics,
      nextSteps,
    },
  };
}

function getTradingScheduler() {
  if (!tradingScheduler) {
    tradingScheduler = new CadenceScheduler({
      name: 'live-trading',
      buildAssignments: async (bucket) => {
        const assignments = await getLiveAssignments();
        return assignments
          .filter((assignment) => assignment.cadenceMs === bucket.cadenceMs)
          .map((assignment) => ({
            symbol: assignment.symbol,
            strategyType: assignment.strategyType,
            strategyInstance: assignment.strategyInstance,
            category: assignment.category,
            categoryFallback: assignment.categoryFallback,
            scanMode: 'signal',
            scanReason: 'cadence',
          }));
      },
      runAssignments: async (analysisTasks) => {
        await strategyEngine.analyzeAll(
          async (symbol, timeframe, count) => await mt5Service.getCandles(symbol, timeframe, null, count),
          async (signal) => {
            await tradeExecutor.executeTrade(signal);
          },
          null,
          { scope: 'live', mode: 'live', analysisTasks }
        );
        await positionMonitor.syncNow('forced_sync');
      },
      onError: (error, bucket) => {
        console.error(`[Trading Loop ${bucket.timeframe}] Error:`, error.message);
      },
    });
  }

  return tradingScheduler;
}

// @desc    Start automated trading
// @route   POST /api/trading/start
exports.startTrading = async (req, res) => {
  try {
    const { accountInfo, accountConfigMatch, reconnected } = await getLiveAccountInfo({ reconnectOnMismatch: true });
    let liveTradingPermission = null;
    const body = req.body || {};
    const shouldAllowLiveTrading = body.allowLiveTrading === true || body.allowLiveTrading === 'true';

    if (shouldAllowLiveTrading) {
      mt5Service.ensureLiveAccountReady(accountInfo);
      liveTradingPermission = await liveTradingPermissionService.setAllowLiveTrading(true, {
        persist: body.persistAllowLiveTrading !== false,
      });
    }

    mt5Service.ensureLiveTradingAllowed(accountInfo);

    process.env.TRADING_ENABLED = 'true';
    const assignments = await getLiveAssignments();
    const assignmentStats = buildAssignmentStats(assignments);
    positionMonitor.start();
    getTradingScheduler().start();

    const signalScanBuckets = buildSignalScanBucketStatus(assignments, getTradingScheduler().getBucketStates());

    res.json({
      success: true,
      message: 'Trading started',
      data: {
        account: {
          balance: accountInfo.balance,
          equity: accountInfo.equity,
          currency: accountInfo.currency,
          mode: mt5Service.getAccountModeName(accountInfo),
        },
        symbols: assignmentStats.activeSymbols || getAllSymbols().length,
        activeAssignments: assignmentStats.activeAssignments,
        activeSymbols: assignmentStats.activeSymbols,
        monitorRunning: true,
        signalScanBuckets,
        scanBuckets: signalScanBuckets,
        positionMonitor: positionMonitor.getStatus(),
        liveTradingAllowed: liveTradingPermissionService.isAllowLiveTradingEnabled(),
        allowLiveTradingPersisted: Boolean(liveTradingPermission?.persisted),
        liveConnection: buildLiveConnectionStatus(accountInfo, accountConfigMatch),
        reconnected,
      },
    });
  } catch (err) {
    console.error('[Trading] Start error:', err.message);
    const failure = buildLiveTradingStartFailure(err);
    res.status(500).json({ success: false, message: failure.message, data: failure.data });
  }
};

// @desc    Stop automated trading
// @route   POST /api/trading/stop
exports.stopTrading = async (req, res) => {
  try {
    process.env.TRADING_ENABLED = 'false';

    if (tradingScheduler) {
      tradingScheduler.stop();
      tradingScheduler = null;
    }

    positionMonitor.stop();

    res.json({ success: true, message: 'Trading stopped' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get trading status
// @route   GET /api/trading/status
exports.getStatus = async (req, res) => {
  try {
    const connected = mt5Service.isConnected();
    const tradingEnabled = process.env.TRADING_ENABLED === 'true';
    const monitorStatus = positionMonitor.getStatus();

    let riskStatus = null;
    let account = null;
    let liveConnection = buildLiveConnectionStatus();
    const assignments = await getLiveAssignments();
    const assignmentStats = buildAssignmentStats(assignments);
    if (connected) {
      const { accountInfo, accountConfigMatch } = await getLiveAccountInfo({ reconnectOnMismatch: false });
      liveConnection = buildLiveConnectionStatus(accountInfo, accountConfigMatch);
      riskStatus = await riskManager.getRiskStatus(accountInfo);
      account = {
        login: accountInfo.login,
        server: accountInfo.server,
        mode: mt5Service.getAccountModeName(accountInfo),
        tradeAllowed: accountInfo.tradeAllowed,
      };
    }

    let strategyDailyStopStatus = null;
    try {
      const config = await strategyDailyStopService.getActiveConfig();
      const { tradingDay, resetAt } = strategyDailyStopService.resolveTradingDay(new Date(), config);
      const todayStoppedStrategies = await strategyDailyStopService.getTodayStoppedStrategies({}, config);
      strategyDailyStopStatus = {
        enabled: config?.enabled !== false,
        tradingDay,
        resetAt,
        todayStoppedStrategies,
        todayStoppedStrategiesCount: todayStoppedStrategies.length,
        blockedEntriesTodayByStrategyDailyStop: strategyDailyStopService.getBlockedEntriesToday(tradingDay),
      };
    } catch (_) {
      strategyDailyStopStatus = null;
    }

    res.json({
      success: true,
      data: {
        mt5Connected: connected,
        account,
        liveConnection,
        runtimeIdentity: liveConnection.runtimeIdentity,
        liveRuntimeIdentity: liveConnection.runtimeIdentity,
        wsClients: websocketService.getClientCount(),
        tradingEnabled,
        liveTradingAllowed: liveTradingPermissionService.isAllowLiveTradingEnabled(),
        tradingLoopActive: Boolean(tradingScheduler && tradingScheduler.isRunning()),
        activeAssignments: assignmentStats.activeAssignments,
        activeSymbols: assignmentStats.activeSymbols,
        signalScanBuckets: buildSignalScanBucketStatus(assignments, tradingScheduler ? tradingScheduler.getBucketStates() : new Map()),
        scanBuckets: buildSignalScanBucketStatus(assignments, tradingScheduler ? tradingScheduler.getBucketStates() : new Map()),
        positionMonitor: monitorStatus,
        monitor: monitorStatus,
        risk: riskStatus,
        strategyDailyStop: strategyDailyStopStatus,
        todayStoppedStrategiesCount: strategyDailyStopStatus?.todayStoppedStrategiesCount || 0,
        blockedEntriesTodayByStrategyDailyStop: strategyDailyStopStatus?.blockedEntriesTodayByStrategyDailyStop || 0,
        recentSignals: strategyEngine.getRecentSignals(null, 10),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Test/debug order placement - supports manual lot size and optional auto-close
// @route   POST /api/trading/test-order
exports.testOrder = async (req, res) => {
  let order = null;

  try {
    if (!mt5Service.isConnected()) {
      await mt5Service.connect();
    }

    const accountInfo = await mt5Service.getAccountInfo();
    const debugAccount = ensureDebugTradingAllowed(accountInfo);

    const {
      symbol = 'EURUSD',
      type = 'BUY',
      volume,
      autoClose,
    } = req.body || {};
    const direction = type.toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    const instrument = getInstrument(symbol);
    if (!instrument) {
      return res.status(400).json({ success: false, message: `Unknown instrument: ${symbol}` });
    }

    const manualVolumeRequested = volume !== undefined && volume !== null && String(volume).trim() !== '';
    const autoCloseExplicit = autoClose === true || String(autoClose).toLowerCase() === 'true';
    const shouldAutoClose = autoClose === undefined ? !manualVolumeRequested : autoCloseExplicit;
    const price = await mt5Service.getPrice(symbol);
    if (!price || (!price.bid && !price.ask)) {
      return res.status(400).json({ success: false, message: `Cannot get price for ${symbol}` });
    }

    const baseSignal = await buildProtectedTestSignal(symbol, direction, price);
    const signal = {
      ...baseSignal,
      strategy: manualVolumeRequested ? 'ManualDebug' : 'TestOrder',
      reason: manualVolumeRequested
        ? 'Manual debug order from Settings'
        : baseSignal.reason,
    };

    let finalVolume = null;

    if (manualVolumeRequested) {
      finalVolume = normalizeManualVolume(volume, instrument);
    } else {
      const riskCheck = await riskManager.validateTrade(signal, accountInfo, { scope: 'live' });
      if (!riskCheck.allowed) {
        await recordTestOrderAudit('risk', 'BLOCKED', signal, {
          message: riskCheck.reason,
          code: 'RISK_RULE',
          codeName: 'RISK_RULE',
          volume: riskCheck.lotSize || null,
          accountInfo,
          details: { riskCheck },
        });
        return res.status(400).json({ success: false, message: riskCheck.reason });
      }

      if (riskCheck.overrideApplied && riskCheck.auditMessage) {
        await recordTestOrderAudit('risk', 'INFO', signal, {
          message: riskCheck.auditMessage,
          code: 'AGGRESSIVE_MIN_LOT',
          codeName: 'AGGRESSIVE_MIN_LOT',
          volume: riskCheck.lotSize,
          accountInfo,
          details: { riskCheck },
        });
      }

      finalVolume = riskCheck.lotSize;
    }

    const brokerComment = buildBrokerComment(signal, 'QM');
    const preflight = await mt5Service.preflightOrder(
      symbol,
      direction,
      finalVolume,
      signal.sl,
      signal.tp,
      brokerComment
    );
    if (!mt5Service.isOrderAllowed(preflight)) {
      const preflightMessage = mt5Service.getPreflightMessage(preflight);
      await recordTestOrderAudit('preflight', 'BLOCKED', signal, {
        message: preflightMessage,
        code: preflight.retcode,
        codeName: preflight.retcodeName,
        volume: finalVolume,
        accountInfo,
        details: preflight,
      });
      return res.status(400).json({ success: false, message: preflightMessage });
    }

    console.log(`[Test Order] Placing protected ${direction} ${finalVolume} ${symbol}...`);

    order = await mt5Service.placeOrder(
      symbol,
      direction,
      finalVolume,
      signal.sl,
      signal.tp,
      brokerComment
    );

    console.log('[Test Order] Order placed:', JSON.stringify(order));

    if (shouldAutoClose) {
      await new Promise((resolve) => setTimeout(resolve, 2000));

      if (order && order.positionId) {
        try {
          const closeResult = await mt5Service.closePosition(String(order.positionId));
          console.log('[Test Order] Position closed.');

          return res.json({
            success: true,
            message: `Test order completed: ${direction} ${finalVolume} ${symbol} opened and closed with protection`,
            data: {
              symbol,
              type: direction,
              volume: finalVolume,
              openPrice: order?.price || signal.entryPrice,
              accountMode: debugAccount.mode,
              executionScope: debugAccount.scope,
              stopLoss: signal.sl,
              takeProfit: signal.tp,
              autoClose: true,
              order,
              closeResult,
            },
          });
        } catch (closeErr) {
          const message = `Test order opened with protective SL/TP, but auto-close failed: ${closeErr.message}`;
          await recordTestOrderAudit('test_order_close', 'ERROR', signal, {
            message,
            code: closeErr.code ?? closeErr.details?.retcode ?? null,
            codeName: closeErr.codeName ?? closeErr.details?.retcodeName ?? null,
            volume: finalVolume,
            accountInfo,
            details: {
              order,
              stopLoss: signal.sl,
              takeProfit: signal.tp,
              error: closeErr.message,
            },
          });

          return res.status(500).json({
            success: false,
            message,
            data: {
              symbol,
              type: direction,
              volume: finalVolume,
              stopLoss: signal.sl,
              takeProfit: signal.tp,
              order,
            },
          });
        }
      }

      const message = 'Test order was placed with protective SL/TP, but no position id was returned for auto-close.';
      await recordTestOrderAudit('test_order_close', 'ERROR', signal, {
        message,
        volume: finalVolume,
        accountInfo,
        details: { order, stopLoss: signal.sl, takeProfit: signal.tp },
      });

      return res.status(500).json({
        success: false,
        message,
        data: {
          symbol,
          type: direction,
          volume: finalVolume,
          stopLoss: signal.sl,
          takeProfit: signal.tp,
          order,
        },
      });
    }

    const position = await persistOpenedDebugTrade(signal, finalVolume, order, brokerComment);
    await recordTestOrderAudit('test_order_open', 'INFO', signal, {
      message: `Manual debug order opened: ${direction} ${finalVolume} ${symbol}`,
      volume: finalVolume,
      accountInfo,
      details: {
        autoClose: false,
        order,
        positionId: position._id,
        stopLoss: signal.sl,
        takeProfit: signal.tp,
      },
    });

    return res.json({
      success: true,
      message: `Debug order opened: ${direction} ${finalVolume} ${symbol}`,
      data: {
        symbol,
        type: direction,
        volume: finalVolume,
        openPrice: order?.price || signal.entryPrice,
        accountMode: debugAccount.mode,
        executionScope: debugAccount.scope,
        stopLoss: signal.sl,
        takeProfit: signal.tp,
        autoClose: false,
        order,
        position,
      },
    });
  } catch (err) {
    console.error('[Test Order] Error:', err.message);
    res.status(err.statusCode || 500).json({ success: false, message: err.message, data: order ? { order } : undefined });
  }
};

// @desc    List all canonical trading symbols with metadata
// @route   GET /api/trading/symbols
// Returns canonical symbol, category, strategy type, pip config, plus
// broker alias resolution status (OK / MISSING / CANONICAL / UNKNOWN).
// Safe to call when MT5 is disconnected — resolution just reports UNKNOWN.
exports.getSymbolsStatus = async (req, res) => {
  try {
    const report = symbolResolver.getStatusReport();
    const reportByCanonical = Object.fromEntries(
      report.map((entry) => [entry.canonical, entry])
    );

    const symbols = getAllSymbols().map((canonical) => {
      const instrument = instruments[canonical];
      const resolution = reportByCanonical[canonical] || symbolResolver.getResolution(canonical);
      return {
        canonical,
        category: instrument.category,
        strategyType: instrument.strategyType,
        pipSize: instrument.pipSize,
        pipValue: instrument.pipValue,
        contractSize: instrument.contractSize,
        minLot: instrument.minLot,
        lotStep: instrument.lotStep,
        spread: instrument.spread,
        timeframe: instrument.timeframe,
        higherTimeframe: instrument.higherTimeframe || null,
        entryTimeframe: instrument.entryTimeframe || null,
        broker: resolution.broker,
        resolutionStatus: resolution.status,
        resolutionError: resolution.error,
        candidates: resolution.candidates,
      };
    });

    const byCategory = {};
    for (const entry of symbols) {
      if (!byCategory[entry.category]) byCategory[entry.category] = [];
      byCategory[entry.category].push(entry.canonical);
    }

    res.json({
      success: true,
      data: {
        symbols,
        categories: INSTRUMENT_CATEGORIES,
        byCategory,
        mt5Connected: mt5Service.isConnected(),
      },
    });
  } catch (err) {
    console.error('[Trading] getSymbolsStatus error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Re-run broker symbol alias discovery
// @route   POST /api/trading/symbols/rediscover
exports.rediscoverSymbols = async (req, res) => {
  try {
    if (!mt5Service.isConnected()) {
      return res.status(400).json({
        success: false,
        message: 'MT5 is not connected. Connect before running discovery.',
      });
    }

    symbolResolver.clear();
    const report = await symbolResolver.discoverAll(mt5Service);
    res.json({
      success: true,
      data: {
        total: report.total,
        resolved: report.resolved.length,
        missing: report.missing.map((m) => m.canonical),
        errors: report.errors.map((e) => ({ canonical: e.canonical, error: e.error })),
      },
    });
  } catch (err) {
    console.error('[Trading] rediscoverSymbols error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get MT5 account info
// @route   GET /api/trading/account
exports.getAccount = async (req, res) => {
  try {
    if (!mt5Service.isConnected()) {
      await mt5Service.connect();
    }
    const accountInfo = await mt5Service.getAccountInfo();
    res.json({ success: true, data: accountInfo });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
