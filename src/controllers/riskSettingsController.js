const RiskProfile = require('../models/RiskProfile');
const strategyDailyStopService = require('../services/strategyDailyStopService');

async function buildRiskSettingsPayload() {
  const profiles = await RiskProfile.findAll();
  const activeProfile = profiles.find((profile) => profile.isActive) || null;

  return {
    activeProfileId: activeProfile?._id || null,
    activeProfileName: activeProfile?.name || null,
    activeProfile,
    profiles,
  };
}

function sendError(res, err) {
  if (err.statusCode) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
      errors: err.details || [],
    });
  }

  return res.status(500).json({
    success: false,
    message: err.message || 'Server error',
  });
}

exports.getRiskSettings = async (req, res) => {
  try {
    res.json({ success: true, data: await buildRiskSettingsPayload() });
  } catch (err) {
    sendError(res, err);
  }
};

exports.createRiskProfile = async (req, res) => {
  try {
    await RiskProfile.create(req.body || {});
    res.status(201).json({ success: true, data: await buildRiskSettingsPayload() });
  } catch (err) {
    sendError(res, err);
  }
};

exports.updateRiskProfile = async (req, res) => {
  try {
    const profile = await RiskProfile.update(req.params.id, req.body || {});
    if (!profile) {
      return res.status(404).json({ success: false, message: 'Risk profile not found' });
    }

    res.json({ success: true, data: await buildRiskSettingsPayload() });
  } catch (err) {
    sendError(res, err);
  }
};

exports.deleteRiskProfile = async (req, res) => {
  try {
    const profile = await RiskProfile.delete(req.params.id);
    if (!profile) {
      return res.status(404).json({ success: false, message: 'Risk profile not found' });
    }

    res.json({ success: true, data: await buildRiskSettingsPayload() });
  } catch (err) {
    sendError(res, err);
  }
};

exports.activateRiskProfile = async (req, res) => {
  try {
    const profile = await RiskProfile.activate(req.params.id);
    if (!profile) {
      return res.status(404).json({ success: false, message: 'Risk profile not found' });
    }

    res.json({ success: true, data: await buildRiskSettingsPayload() });
  } catch (err) {
    sendError(res, err);
  }
};

exports.getStrategyDailyStops = async (req, res) => {
  try {
    const scope = strategyDailyStopService.normalizeScope(req.query?.scope || 'live');
    const config = await strategyDailyStopService.getActiveConfig();
    const todayStoppedStrategies = await strategyDailyStopService.getTodayStoppedStrategies({ scope }, config);
    const { tradingDay, resetAt } = strategyDailyStopService.resolveTradingDay(new Date(), config);
    const blockedEntriesToday = strategyDailyStopService.getBlockedEntriesToday(tradingDay, scope);

    res.json({
      success: true,
      data: {
        scope,
        config,
        tradingDay,
        resetAt,
        todayStoppedStrategies,
        todayStoppedStrategiesCount: todayStoppedStrategies.length,
        blockedEntriesTodayByStrategyDailyStop: blockedEntriesToday,
      },
    });
  } catch (err) {
    sendError(res, err);
  }
};

exports.resetStrategyDailyStop = async (req, res) => {
  try {
    const { strategy, symbol, timeframe } = req.body || {};
    const scope = strategyDailyStopService.normalizeScope(req.body?.scope || req.query?.scope || 'live');
    if (!strategy || !symbol || !timeframe) {
      return res.status(400).json({
        success: false,
        message: 'strategy, symbol, and timeframe are required',
      });
    }

    const actor = req.user?.email || req.headers['x-actor'] || 'manual-reset';
    const result = await strategyDailyStopService.manualReset({
      scope,
      strategy,
      symbol,
      timeframe,
      actor,
    });

    res.json({ success: true, data: result });
  } catch (err) {
    sendError(res, err);
  }
};
