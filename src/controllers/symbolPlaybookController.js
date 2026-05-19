const { listSymbolPlaybooks } = require('../config/symbolPlaybooks');
const { getBreakevenAnalysisReport } = require('../services/breakevenAnalysisReportService');
const { getPlaybookRecommendations } = require('../services/playbookRecommendationService');
const { getSymbolPlaybookReport } = require('../services/symbolPlaybookReportService');

exports.getSymbolPlaybooks = async (req, res) => {
  try {
    const playbooks = listSymbolPlaybooks();
    res.json({
      success: true,
      count: playbooks.length,
      playbooks,
    });
  } catch (error) {
    console.error('[SymbolPlaybooks] getSymbolPlaybooks error:', error.message);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to load symbol playbooks',
    });
  }
};

exports.getSymbolPlaybookReport = async (req, res) => {
  try {
    const report = await getSymbolPlaybookReport({
      since: req.query?.since,
      scope: req.query?.scope,
    });

    res.json({
      success: true,
      ...report,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error('[SymbolPlaybooks] getSymbolPlaybookReport error:', error.message);
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to load symbol playbook report',
    });
  }
};

exports.getBreakevenAnalysisReport = async (req, res) => {
  try {
    const report = await getBreakevenAnalysisReport({
      since: req.query?.since,
      scope: req.query?.scope,
    });

    res.json({
      success: true,
      ...report,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error('[SymbolPlaybooks] getBreakevenAnalysisReport error:', error.message);
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to load breakeven analysis report',
    });
  }
};

exports.getPlaybookRecommendations = async (req, res) => {
  try {
    const recommendations = await getPlaybookRecommendations({
      since: req.query?.since,
      scope: req.query?.scope,
    });

    res.json({
      success: true,
      ...recommendations,
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error('[SymbolPlaybooks] getPlaybookRecommendations error:', error.message);
    res.status(statusCode).json({
      success: false,
      message: error.message || 'Failed to load symbol playbook recommendations',
    });
  }
};
