const { riskProfilesDb } = require('../config/db');

const DEFAULT_PROFILE_NAME = 'Bootstrap Risk';

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
    isActive: true,
  };
}

function normalizeProfilePayload(data = {}, { partial = false } = {}) {
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

    const cleaned = normalizeProfilePayload(data, { partial: true });
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

  toRuntimeSettings(profile) {
    return {
      profile,
      maxRiskPerTrade: (Number(profile?.maxRiskPerTradePct) || 0) / 100,
      maxDailyLoss: (Number(profile?.maxDailyLossPct) || 0) / 100,
      maxDrawdown: (Number(profile?.maxDrawdownPct) || 0) / 100,
      maxConcurrentPositions: parsePositiveInt(profile?.maxConcurrentPositions) || 5,
      maxPositionsPerSymbol: parsePositiveInt(profile?.maxPositionsPerSymbol) || 2,
      allowAggressiveMinLot: Boolean(profile?.allowAggressiveMinLot),
    };
  },
};

module.exports = RiskProfile;
