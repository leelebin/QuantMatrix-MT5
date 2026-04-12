const Position = require('../models/Position');
const Trade = require('../models/Trade');
const ExecutionAudit = require('../models/ExecutionAudit');
const tradeExecutor = require('../services/tradeExecutor');
const tradeHistoryService = require('../services/tradeHistoryService');

// @desc    Get all open positions
// @route   GET /api/positions
exports.getPositions = async (req, res) => {
  try {
    const positions = await Position.findAll();
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
    const symbol = req.query.symbol;
    const query = {};
    if (symbol) query.symbol = symbol;

    const trades = await Trade.findAll(query, limit);
    res.json({ success: true, data: trades, count: trades.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get trade statistics
// @route   GET /api/trades/stats
exports.getTradeStats = async (req, res) => {
  try {
    const stats = await Trade.getStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Reconcile trade history against MT5 broker deals
// @route   POST /api/trades/reconcile
exports.reconcileTrades = async (req, res) => {
  try {
    const limit = parseInt(req.body.limit ?? req.query.limit, 10) || 100;
    const symbol = req.body.symbol ?? req.query.symbol;
    const result = await tradeHistoryService.reconcileClosedTrades({ limit, symbol });

    res.json({
      success: true,
      message: `Reconciled ${result.updated} of ${result.checked} trades against MT5 history`,
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
