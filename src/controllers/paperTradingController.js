const paperTradingService = require('../services/paperTradingService');
const dailyReportService = require('../services/dailyReportService');
const TradeLog = require('../models/TradeLog');

// @desc    Start paper trading mode
// @route   POST /api/paper-trading/start
exports.startPaperTrading = async (req, res) => {
  try {
    const result = await paperTradingService.start();
    if (result.success) {
      // Also start the daily report scheduler
      dailyReportService.start();
    }
    res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    console.error('[PaperTrading] Start error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Stop paper trading mode
// @route   POST /api/paper-trading/stop
exports.stopPaperTrading = async (req, res) => {
  try {
    const result = await paperTradingService.stop();
    dailyReportService.stop();
    res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get paper trading status
// @route   GET /api/paper-trading/status
exports.getStatus = async (req, res) => {
  try {
    const status = await paperTradingService.getStatus();
    status.dailyReport = dailyReportService.getStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get open paper positions
// @route   GET /api/paper-trading/positions
exports.getPositions = async (req, res) => {
  try {
    const positions = await paperTradingService.getPositions();
    res.json({ success: true, data: positions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Close a paper position manually
// @route   POST /api/paper-trading/positions/:id/close
exports.closePosition = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const result = await paperTradingService.closePosition(id, reason || 'MANUAL');
    if (!result.success) {
      return res.status(404).json(result);
    }
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get trade log (all paper trades)
// @route   GET /api/paper-trading/trade-log
exports.getTradeLog = async (req, res) => {
  try {
    const { status, symbol, limit } = req.query;
    const query = {};
    if (status) query.status = status;
    if (symbol) query.symbol = symbol;
    const trades = await TradeLog.findAll(query, parseInt(limit) || 200);
    res.json({ success: true, data: trades });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Get trade log statistics
// @route   GET /api/paper-trading/stats
exports.getStats = async (req, res) => {
  try {
    const { symbol, strategy } = req.query;
    const query = {};
    if (symbol) query.symbol = symbol;
    if (strategy) query.strategy = strategy;
    const stats = await TradeLog.getStats(query);
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @desc    Manually trigger daily report (for testing or on-demand)
// @route   POST /api/paper-trading/report
exports.generateReport = async (req, res) => {
  try {
    const { date } = req.body;
    const reportDate = date ? new Date(date) : new Date();
    const report = await dailyReportService.generateAndSendReport(reportDate);
    res.json({ success: true, message: 'Report sent to Telegram', preview: report });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
