const { riskProfilesDb } = require('../config/db');
const breakevenService = require('../services/breakevenService');

const DEFAULT_PROFILE_NAME = 'Bootstrap Risk';

const DEFAULT_STRATEGY_DAILY_STOP = Object.freeze({
  enabled: true,
  consecutiveLossesToStop: 2,
  countBreakEvenAsLoss: false,
  countSmallLossAsLoss: false,
  smallLossThresholdR: -0.30,
  breakevenEpsilonR: 0.05,
  useRealizedPnLOnly: true,
  stopUntil: 'end_of_day',
  resetTimezone: 'Asia/Kuala_Lumpur',
  resetHour: 0,
  resetMinute: 0,
});

function getDefaultStrategyDailyStop() {
  return { ...DEFAULT_STRATEGY_DAILY_STOP };
}

function normalizeStrategyDailyStop(raw, existing = null) {
  const base = existing ? { ...DEFAULT_STRATEGY_DAILY_STOP, ...existing } : { ...DEFAULT_STRATEGY_DAILY_STOP };
  if (raw == null || typeof raw !== 'object') return base;

  const errors = [];
  const out = { ...base };

  if (raw.enabled !== undefined) out.enabled = Boolean(raw.enabled);
  if (raw.countBreakEvenAsLoss !== undefined) out.countBreakEvenAsLoss = Boolean(raw.countBreakEvenAsLoss);
  if (raw.countSmallLossAsLoss !== undefined) out.countSmallLossAsLoss = Boolean(raw.countSmallLossAsLoss);
  if (raw.useRealizedPnLOnly !== undefined) out.useRealizedPnLOnly = Boolean(raw.useRealizedPnLOnly);

  if (raw.consecutiveLossesToStop !== undefined) {
    const v = parseInt(raw.consecutiveLossesToStop, 10);
    if (!Number.isFinite(v) || v < 1 || v > 50) {
      errors.push({ field: 'strategyDailyStop.consecutiveLossesToStop', message: 'Must be integer between 1 and 50' });
    } else out.consecutiveLossesToStop = v;
  }

  if (raw.smallLossThresholdR !== undefined) {
    const v = Number(raw.smallLossThresholdR);
    if (!Number.isFinite(v) || v > 0) {
      errors.push({ field: 'strategyDailyStop.smallLossThresholdR', message: 'Must be a non-positive number (in R units)' });
    } else out.smallLossThresholdR = v;
  }

  if (raw.breakevenEpsilonR !== undefined) {
    const v = Number(raw.breakevenEpsilonR);
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      errors.push({ field: 'strategyDailyStop.breakevenEpsilonR', message: 'Must be between 0 and 1' });
    } else out.breakevenEpsilonR = v;
  }

  if (raw.stopUntil !== undefined) {
    const v = String(raw.stopUntil);
    if (v !== 'end_of_day') {
      errors.push({ field: 'strategyDailyStop.stopUntil', message: 'Only "end_of_day" is supported' });
    } else out.stopUntil = v;
  }

  if (raw.resetTimezone !== undefined) {
    const v = String(raw.resetTimezone || '').trim();
    if (!v) {
      errors.push({ field: 'strategyDailyStop.resetTimezone', message: 'Required' });
    } else out.resetTimezone = v;
  }

  if (raw.resetHour !== undefined) {
    const v = parseInt(raw.resetHour, 10);
    if (!Number.isFinite(v) || v < 0 || v > 23) {
      errors.push({ field: 'strategyDailyStop.resetHour', message: 'Must be integer 0..23' });
    } else out.resetHour = v;
  }

  if (raw.resetMinute !== undefined) {
    const v = parseInt(raw.resetMinute, 10);
    if (!Number.isFinite(v) || v < 0 || v > 59) {
      errors.push({ field: 'strategyDailyStop.resetMinute', message: 'Must be integer 0..59' });
    } else out.resetMinute = v;
  }

  if (errors.length) {
    const err = new Error('Validation failed');
    err.statusCode = 400;
    err.details = errors;
    throw err;
  }

  return out;
}

let initPromise = null;

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function roundPercent(value) {
  const num = toNumber(value);
  if (num == null) return null;
  return parseFloat(num.toFixed(4));
}

function parsePositiveInt(value) {
  const num = parseInt(value, 10);
  return Number.isFinite(num) ? num : null;
}

function buildValidationError(details, message = 'Validation failed') {
  const error = new Error(message);
  error.statusCode = 400;
  error.details = details;
  return error;
}

function parseSeedPercent(envKey, fallbackFraction) {
  const raw = toNumber(process.env[envKey]);
  const value = raw != null && raw > 0 ? raw : fallbackFraction;
  return value <= 1 ? value * 100 : value;
}

function getSeedProfile() {
  return {
    name: DEFAULT_PROFILE_NAME,
    nameKey: DEFAULT_PROFILE_NAME.toLowerCase(),
    maxRiskPerTradePct: roundPercent(parseSeedPercent('MAX_RISK_PER_TRADE', 0.05)),
    maxDailyLossPct: roundPercent(parseSeedPercent('MAX_DAILY_LOSS', 0.05)),
    maxDrawdownPct: roundPercent(parseSeedPercent('MAX_DRAWDOWN', 0.10)),
    maxConcurrentPositions: parsePositiveInt(process.env.MAX_CONCURRENT_POSITIONS) || 5,
    maxPositionsPerSymbol: parsePositiveInt(process.env.MAX_POSITIONS_PER_SYMBOL) || 2,
    allowAggressiveMinLot: false,
    tradeManagement: breakevenService.getDefaultTradeManagement(),
    strategyDailyStop: getDefaultStrategyDailyStop(),
    isActive: true,
  };
}

function normalizeProfilePayload(data = {}, { partial = false, existingProfile = null } = {}) {
  const errors = [];
  const cleaned = {};

  if (!partial || data.name !== undefined) {
    const name = String(data.name || '').trim();
    if (!name) {
      errors.push({ field: 'name', message: 'Name is required' });
    } else {
      cleaned.name = name;
      cleaned.nameKey = name.toLowerCase();
    }
  }

  const percentFields = [
    'maxRiskPerTradePct',
    'maxDailyLossPct',
    'maxDrawdownPct',
  ];

  for (const field of percentFields) {
    if (partial && data[field] === undefined) continue;
    const value = roundPercent(data[field]);
    if (value == null || value <= 0 || value > 100) {
      errors.push({ field, message: 'Must be greater than 0 and less than or equal to 100' });
    } else {
      cleaned[field] = value;
    }
  }

  const intFields = [
    'maxConcurrentPositions',
    'maxPositionsPerSymbol',
  ];

  for (const field of intFields) {
    if (partial && data[field] === undefined) continue;
    const value = parsePositiveInt(data[field]);
    if (value == null || value < 1) {
      errors.push({ field, message: 'Must be an integer greater than or equal to 1' });
    } else {
      cleaned[field] = value;
    }
  }

  if (!partial || data.allowAggressiveMinLot !== undefined) {
    cleaned.allowAggressiveMinLot = Boolean(data.allowAggressiveMinLot);
  }

  try {
    const tradeManagement = breakevenService.normalizeProfileTradeManagement(data.tradeManagement, {
      partial,
      existingTradeManagement: existingProfile?.tradeManagement || null,
    });
    if (tradeManagement !== undefined) {
      cleaned.tradeManagement = tradeManagement;
    }
  } catch (err) {
    if (err?.details) {
      errors.push(...err.details);
    } else {
      throw err;
    }
  }

  if (!partial || data.strategyDailyStop !== undefined) {
    try {
      cleaned.strategyDailyStop = normalizeStrategyDailyStop(
        data.strategyDailyStop,
        existingProfile?.strategyDailyStop || null
      );
    } catch (err) {
      if (err?.details) {
        errors.push(...err.details);
      } else {
        throw err;
      }
    }
  }

  if (!partial && cleaned.isActive === undefined) {
    cleaned.isActive = false;
  }

  if (errors.length > 0) {
    throw buildValidationError(errors);
  }

  return cleaned;
}

const RiskProfile = {
  async ensureSeeded() {
    if (initPromise) {
      await initPromise;
      return;
    }

    initPromise = (async () => {
      const count = await riskProfilesDb.count({});
      if (count > 0) return;

      const now = new Date();
      await riskProfilesDb.insert({
        ...getSeedProfile(),
        createdAt: now,
        updatedAt: now,
      });
    })();

    try {
      await initPromise;
    } finally {
      initPromise = null;
    }
  },

  async findAll() {
    await this.ensureSeeded();
    return await riskProfilesDb.find({}).sort({ isActive: -1, createdAt: 1 });
  },

  async findById(id) {
    await this.ensureSeeded();
    return await riskProfilesDb.findOne({ _id: id });
  },

  async findByNameKey(nameKey) {
    await this.ensureSeeded();
    return await riskProfilesDb.findOne({ nameKey });
  },

  async getActive() {
    await this.ensureSeeded();
    let profile = await riskProfilesDb.findOne({ isActive: true });
    if (!profile) {
      const firstProfile = await riskProfilesDb.findOne({});
      if (!firstProfile) return null;
      profile = await this.activate(firstProfile._id);
    }
    return profile;
  },

  async create(data) {
    await this.ensureSeeded();
    const cleaned = normalizeProfilePayload(data);
    const existing = await this.findByNameKey(cleaned.nameKey);
    if (existing) {
      throw buildValidationError([{ field: 'name', message: 'Name already exists' }]);
    }

    const now = new Date();
    const profile = await riskProfilesDb.insert({
      ...cleaned,
      isActive: false,
      createdAt: now,
      updatedAt: now,
    });

    return profile;
  },

  async update(id, data) {
    await this.ensureSeeded();
    const existing = await this.findById(id);
    if (!existing) return null;

    const cleaned = normalizeProfilePayload(data, { partial: true, existingProfile: existing });
    if (cleaned.nameKey && cleaned.nameKey !== existing.nameKey) {
      const nameMatch = await this.findByNameKey(cleaned.nameKey);
      if (nameMatch && nameMatch._id !== id) {
        throw buildValidationError([{ field: 'name', message: 'Name already exists' }]);
      }
    }

    if (Object.keys(cleaned).length > 0) {
      await riskProfilesDb.update(
        { _id: id },
        { $set: { ...cleaned, updatedAt: new Date() } }
      );
    }

    return await this.findById(id);
  },

  async activate(id) {
    await this.ensureSeeded();
    const existing = await this.findById(id);
    if (!existing) return null;

    const now = new Date();
    await riskProfilesDb.update({}, { $set: { isActive: false, updatedAt: now } }, { multi: true });
    await riskProfilesDb.update({ _id: id }, { $set: { isActive: true, updatedAt: now } });
    return await this.findById(id);
  },

  async delete(id) {
    await this.ensureSeeded();
    const existing = await this.findById(id);
    if (!existing) return null;

    const count = await riskProfilesDb.count({});
    if (count <= 1) {
      throw buildValidationError([{ field: 'profile', message: 'Cannot delete the last risk profile' }], 'Cannot delete profile');
    }

    if (existing.isActive) {
      throw buildValidationError([{ field: 'profile', message: 'Activate another profile before deleting the current active profile' }], 'Cannot delete profile');
    }

    await riskProfilesDb.remove({ _id: id }, {});
    return existing;
  },

  getDefaultStrategyDailyStop,
  normalizeStrategyDailyStop,

  getStrategyDailyStop(profile) {
    try {
      return normalizeStrategyDailyStop(profile?.strategyDailyStop || null);
    } catch (_) {
      return getDefaultStrategyDailyStop();
    }
  },

  toRuntimeSettings(profile) {
    const breakeven = breakevenService.getProfileBreakeven(profile);
    const strategyDailyStop = this.getStrategyDailyStop(profile);
    return {
      profile,
      maxRiskPerTrade: (Number(profile?.maxRiskPerTradePct) || 0) / 100,
      maxDailyLoss: (Number(profile?.maxDailyLossPct) || 0) / 100,
      maxDrawdown: (Number(profile?.maxDrawdownPct) || 0) / 100,
      maxConcurrentPositions: parsePositiveInt(profile?.maxConcurrentPositions) || 5,
      maxPositionsPerSymbol: parsePositiveInt(profile?.maxPositionsPerSymbol) || 2,
      allowAggressiveMinLot: Boolean(profile?.allowAggressiveMinLot),
      tradeManagement: {
        breakeven,
      },
      breakeven,
      strategyDailyStop,
    };
  },
};

module.exports = RiskProfile;
