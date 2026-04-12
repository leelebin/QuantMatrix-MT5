const RiskProfile = require('../models/RiskProfile');

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
