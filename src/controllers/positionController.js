const Position = require('../models/Position');
const Trade = require('../models/Trade');
const ExecutionAudit = require('../models/ExecutionAudit');
const tradeExecutor = require('../services/tradeExecutor');
const tradeHistoryService = require('../services/tradeHistoryService');
const mt5Service = require('../services/mt5Service');
const positionMonitor = require('../services/positionMonitor');
const { paperPositionsDb } = require('../config/db');
const { LIVE_TRADE_COLUMNS, buildCsv, buildExportFilename } = require('../utils/tradeExport');
const { parseStrategyFromBrokerComment } = require('../utils/tradeComment');

function getTradeFilters(source = {}) {
  return {
    symbol: source.symbol || undefined,
    strategy: source.strategy || undefined,
    status: source.status || undefined,
    startDate: source.startDate || undefined,
    endDate: source.endDate || undefined,
  };
}

function getMt5OpenedAt(mt5Position = {}) {
  const timestamp = Number(mt5Position.time);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp * 1000);
}

function mergeMatchedPosition(basePosition = {}, mt5Position = {}, extraFields = {}) {
  return {
    ...basePosition,
    ...extraFields,
    currentSl: mt5Position.stopLoss ?? basePosition.currentSl ?? basePosition.stopLoss ?? null,
    currentTp: mt5Position.takeProfit ?? basePosition.currentTp ?? basePosition.takeProfit ?? null,
    currentPrice: mt5Position.currentPrice ?? basePosition.currentPrice ?? null,
    unrealizedPl: mt5Position.profit ?? basePosition.unrealizedPl ?? 0,
    lotSize: mt5Position.volume ?? basePosition.lotSize,
    mt5PositionId: mt5Position.id ?? basePosition.mt5PositionId ?? null,
    mt5EntryDealId: basePosition.mt5EntryDealId ?? basePosition.mt5DealId ?? null,
    mt5Comment: mt5Position.comment ?? basePosition.mt5Comment ?? null,
    comment: basePosition.comment ?? mt5Position.comment ?? null,
    openedAt: basePosition.openedAt || getMt5OpenedAt(mt5Position),
  };
}

function mergeLivePositions(localPositions = [], mt5Positions = [], paperPositions = []) {
  const localByMt5Id = new Map(
    localPositions
      .filter((position) => position.mt5PositionId != null)
      .map((position) => [String(position.mt5PositionId), position])
  );
  const paperByMt5Id = new Map(
    paperPositions
      .filter((position) => position.mt5PositionId != null)
      .map((position) => [String(position.mt5PositionId), position])
  );

  const merged = mt5Positions.map((mt5Position) => {
    const localPosition = localByMt5Id.get(String(mt5Position.id));
    if (localPosition) {
      return mergeMatchedPosition(localPosition, mt5Position, {
        source: localPosition.source || 'live_mt5',
        isExternal: false,
      });
    }

    const paperPosition = paperByMt5Id.get(String(mt5Position.id));
    if (paperPosition) {
      return mergeMatchedPosition(paperPosition, mt5Position, {
        _id: null,
        paperPositionId: paperPosition._id,
        source: 'paper_mt5',
        isExternal: false,
        isPaper: true,
      });
    }

    const parsedStrategy = parseStrategyFromBrokerComment(mt5Position.comment || '');

    return {
      _id: null,
      symbol: mt5Position.symbol,
      type: mt5Position.type,
      entryPrice: mt5Position.openPrice,
      currentSl: mt5Position.stopLoss,
      currentTp: mt5Position.takeProfit,
      currentPrice: mt5Position.currentPrice,
      unrealizedPl: mt5Position.profit || 0,
      lotSize: mt5Position.volume,
      strategy: parsedStrategy || null,
      mt5PositionId: mt5Position.id,
      mt5EntryDealId: null,
      mt5Comment: mt5Position.comment || null,
      comment: mt5Position.comment || null,
      openedAt: getMt5OpenedAt(mt5Position),
      source: String(mt5Position.comment || '').startsWith('PT|') ? 'paper_mt5_unlinked' : 'mt5',
      isExternal: true,
      isPaper: String(mt5Position.comment || '').startsWith('PT|'),
    };
  });

  const mt5Ids = new Set(mt5Positions.map((position) => String(position.id)));
  localPositions.forEach((localPosition) => {
    if (!localPosition.mt5PositionId || mt5Ids.has(String(localPosition.mt5PositionId))) return;
    merged.push(localPosition);
  });

  return merged.sort((a, b) => {
    const aTime = a?.openedAt ? new Date(a.openedAt).getTime() : 0;
    const bTime = b?.openedAt ? new Date(b.openedAt).getTime() : 0;
    return bTime - aTime;
  });
}

// @desc    Get all open positions
// @route   GET /api/positions
exports.getPositions = async (req, res) => {
  try {
    let positions = await Position.findAll();
    let paperPositions = [];

    if (mt5Service.isConnected()) {
      try {
        positions = await positionMonitor.syncPositions({ broadcast: false });
        paperPositions = await paperPositionsDb.find({ status: 'OPEN' });
        const mt5Positions = await mt5Service.getPositions();
        positions = mergeLivePositions(positions, mt5Positions, paperPositions);
      } catch (syncError) {
        console.warn('[Positions] Live sync failed:', syncError.message);
      }
    }

    res.json({ success: true, data: positions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get single position
// @route   GET /api/positions/:id
exports.getPosition = async (req, res) => {
  try {
    const position = await Position.findById(req.params.id);
    if (!position) {
      return res.status(404).json({ success: false, message: 'Position not found' });
    }
    res.json({ success: true, data: position });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Close a position manually
// @route   POST /api/positions/:id/close
exports.closePosition = async (req, res) => {
  try {
    const result = await tradeExecutor.closePosition(req.params.id, 'MANUAL');
    if (!result.success) {
      return res.status(400).json({ success: false, message: result.message });
    }
    res.json({
      success: true,
      message: 'Position closed',
      data: { profitLoss: result.profitLoss, profitPips: result.profitPips },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get trade history
// @route   GET /api/trades
exports.getTrades = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const filters = getTradeFilters(req.query);
    const trades = await Trade.findByFilters(filters, limit);
    res.json({ success: true, data: trades, count: trades.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get trade statistics
// @route   GET /api/trades/stats
exports.getTradeStats = async (req, res) => {
  try {
    const filters = getTradeFilters(req.query);
    const stats = await Trade.getStats(filters);
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Export trade history as CSV
// @route   GET /api/trades/export.csv
exports.exportTradesCsv = async (req, res) => {
  try {
    const filters = getTradeFilters(req.query);
    const trades = await Trade.findForExport(filters);
    const csv = buildCsv(LIVE_TRADE_COLUMNS, trades);
    const filename = buildExportFilename(filters);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Reconcile trade history against MT5 broker deals
// @route   POST /api/trades/reconcile
exports.reconcileTrades = async (req, res) => {
  try {
    const parsedLimit = parseInt(req.body.limit ?? req.query.limit, 10);
    const limit = Number.isFinite(parsedLimit) && parsedLimit >= 0 ? parsedLimit : 500;
    const mode = req.body.mode ?? req.query.mode ?? 'incremental';
    const symbol = req.body.symbol ?? req.query.symbol;
    const startDate = req.body.startDate ?? req.query.startDate;
    const endDate = req.body.endDate ?? req.query.endDate;
    const result = await tradeHistoryService.syncTradesFromBroker({
      mode,
      limit,
      symbol,
      startDate,
      endDate,
    });

    res.json({
      success: true,
      message: `MT5 sync complete: ${result.imported || 0} imported, ${result.updated || 0} updated, ${result.skipped || 0} skipped across ${result.checked || 0} broker trades`,
      data: result,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get execution audit history
// @route   GET /api/trades/execution-audits
exports.getExecutionAudits = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const query = {};
    if (req.query.scope) query.scope = req.query.scope;
    if (req.query.status) query.status = req.query.status;
    if (req.query.symbol) query.symbol = req.query.symbol;

    const audits = await ExecutionAudit.findAll(query, limit);
    res.json({ success: true, data: audits, count: audits.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
