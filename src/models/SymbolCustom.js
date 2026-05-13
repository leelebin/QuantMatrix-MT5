const { symbolCustomsDb } = require('../config/db');

const VALID_STATUSES = Object.freeze([
  'draft',
  'paper_testing',
  'validated',
  'live_ready',
  'disabled',
  'archived',
]);

const DEFAULT_TIMEFRAMES = Object.freeze({
  setupTimeframe: null,
  entryTimeframe: null,
  higherTimeframe: null,
});

const DEFAULT_RISK_CONFIG = Object.freeze({
  riskWeight: null,
  maxRiskPerTradePct: null,
  maxDailyLossR: null,
  maxConsecutiveLosses: null,
});

const DEFAULT_SESSION_FILTER = Object.freeze({
  enabled: false,
  sessions: [],
});

const DEFAULT_NEWS_FILTER = Object.freeze({
  enabled: false,
  beforeMinutes: null,
  afterMinutes: null,
  impactLevels: [],
});

const DEFAULT_BE_CONFIG = Object.freeze({
  enabled: false,
  style: null,
  triggerR: null,
  hardBEAtR: null,
  trailStartR: null,
});

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Date);
}

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeRequiredString(value, field, errors, { uppercase = false } = {}) {
  if (typeof value !== 'string') {
    errors.push({ field, message: 'Must be a non-empty string' });
    return undefined;
  }

  const normalized = uppercase ? normalizeSymbol(value) : value.trim();
  if (!normalized) {
    errors.push({ field, message: 'Must be a non-empty string' });
    return undefined;
  }

  return normalized;
}

function normalizeOptionalString(value, field, errors) {
  if (value == null) return value === null ? null : undefined;
  if (typeof value !== 'string') {
    errors.push({ field, message: 'Must be a string' });
    return undefined;
  }
  return value.trim();
}

function normalizeBoolean(value, field, errors) {
  if (typeof value !== 'boolean') {
    errors.push({ field, message: 'Must be boolean' });
    return undefined;
  }
  return value;
}

function normalizeNumberOrNull(value, field, errors) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    errors.push({ field, message: 'Must be a number' });
    return undefined;
  }
  return number;
}

function normalizePlainObject(value, field, errors) {
  if (!isPlainObject(value)) {
    errors.push({ field, message: 'Must be an object' });
    return undefined;
  }
  return cloneValue(value);
}

function normalizeObjectWithDefaults(value, defaults, field, errors) {
  if (value === undefined) return cloneValue(defaults);
  if (!isPlainObject(value)) {
    errors.push({ field, message: 'Must be an object' });
    return undefined;
  }
  return {
    ...cloneValue(defaults),
    ...cloneValue(value),
  };
}

function buildValidationError(errors) {
  const error = new Error('Validation failed');
  error.statusCode = 400;
  error.details = errors;
  return error;
}

function mergePatch(existing, patch) {
  const next = { ...patch };
  for (const field of ['timeframes', 'riskConfig', 'sessionFilter', 'newsFilter', 'beConfig']) {
    if (patch[field] !== undefined && isPlainObject(existing?.[field]) && isPlainObject(patch[field])) {
      next[field] = {
        ...cloneValue(existing[field]),
        ...cloneValue(patch[field]),
      };
    }
  }
  return next;
}

const SymbolCustom = {
  validatePayload(payload = {}, { partial = false } = {}) {
    const errors = [];
    const cleaned = {};
    const source = isPlainObject(payload) ? payload : {};

    if (!isPlainObject(payload)) {
      errors.push({ field: 'payload', message: 'Must be an object' });
    }

    if (!partial || source.symbol !== undefined) {
      cleaned.symbol = normalizeRequiredString(source.symbol, 'symbol', errors, { uppercase: true });
    }

    if (!partial || source.symbolCustomName !== undefined) {
      cleaned.symbolCustomName = normalizeRequiredString(source.symbolCustomName, 'symbolCustomName', errors);
    }

    if (!partial || source.displayName !== undefined) {
      cleaned.displayName = source.displayName === undefined && !partial
        ? undefined
        : normalizeOptionalString(source.displayName, 'displayName', errors);
    }

    if (!partial || source.description !== undefined) {
      cleaned.description = source.description === undefined && !partial
        ? ''
        : normalizeOptionalString(source.description, 'description', errors);
    }

    if (!partial || source.logicName !== undefined) {
      cleaned.logicName = source.logicName === undefined && partial
        ? undefined
        : normalizeOptionalString(source.logicName, 'logicName', errors);
    }

    if (!partial || source.version !== undefined) {
      const version = source.version === undefined ? 1 : Number(source.version);
      if (!Number.isInteger(version) || version < 1) {
        errors.push({ field: 'version', message: 'Must be an integer greater than or equal to 1' });
      } else {
        cleaned.version = version;
      }
    }

    if (!partial || source.status !== undefined) {
      const status = source.status === undefined ? 'draft' : String(source.status || '').trim();
      if (!VALID_STATUSES.includes(status)) {
        errors.push({ field: 'status', message: `Must be one of: ${VALID_STATUSES.join(', ')}` });
      } else {
        cleaned.status = status;
      }
    }

    for (const field of ['paperEnabled', 'liveEnabled', 'isPrimaryLive', 'allowLive']) {
      if (!partial || source[field] !== undefined) {
        cleaned[field] = source[field] === undefined
          ? false
          : normalizeBoolean(source[field], field, errors);
      }
    }

    if (!partial || source.timeframes !== undefined) {
      cleaned.timeframes = source.timeframes === undefined && partial
        ? undefined
        : normalizeObjectWithDefaults(source.timeframes, DEFAULT_TIMEFRAMES, 'timeframes', errors);
    }

    if (!partial || source.parameterSchema !== undefined) {
      if (source.parameterSchema === undefined && !partial) {
        cleaned.parameterSchema = [];
      } else if (!Array.isArray(source.parameterSchema)) {
        errors.push({ field: 'parameterSchema', message: 'Must be an array' });
      } else {
        cleaned.parameterSchema = cloneValue(source.parameterSchema);
      }
    }

    if (!partial || source.parameters !== undefined) {
      cleaned.parameters = source.parameters === undefined && !partial
        ? {}
        : normalizePlainObject(source.parameters, 'parameters', errors);
    }

    if (!partial || source.riskConfig !== undefined) {
      const riskConfig = source.riskConfig === undefined && partial
        ? undefined
        : normalizeObjectWithDefaults(source.riskConfig, DEFAULT_RISK_CONFIG, 'riskConfig', errors);
      if (riskConfig && Object.prototype.hasOwnProperty.call(riskConfig, 'riskWeight') && riskConfig.riskWeight != null) {
        riskConfig.riskWeight = normalizeNumberOrNull(riskConfig.riskWeight, 'riskConfig.riskWeight', errors);
      }
      cleaned.riskConfig = riskConfig;
    }

    if (!partial || source.sessionFilter !== undefined) {
      cleaned.sessionFilter = source.sessionFilter === undefined && partial
        ? undefined
        : normalizeObjectWithDefaults(source.sessionFilter, DEFAULT_SESSION_FILTER, 'sessionFilter', errors);
    }

    if (!partial || source.newsFilter !== undefined) {
      cleaned.newsFilter = source.newsFilter === undefined && partial
        ? undefined
        : normalizeObjectWithDefaults(source.newsFilter, DEFAULT_NEWS_FILTER, 'newsFilter', errors);
    }

    if (!partial || source.beConfig !== undefined) {
      cleaned.beConfig = source.beConfig === undefined && partial
        ? undefined
        : normalizeObjectWithDefaults(source.beConfig, DEFAULT_BE_CONFIG, 'beConfig', errors);
    }

    for (const field of ['entryConfig', 'exitConfig']) {
      if (!partial || source[field] !== undefined) {
        cleaned[field] = source[field] === undefined && !partial
          ? {}
          : normalizePlainObject(source[field], field, errors);
      }
    }

    for (const field of ['hypothesis', 'designNotes', 'aiResearchSummary']) {
      if (!partial || source[field] !== undefined) {
        cleaned[field] = source[field] === undefined && !partial
          ? ''
          : normalizeOptionalString(source[field], field, errors);
      }
    }

    for (const key of Object.keys(cleaned)) {
      if (cleaned[key] === undefined) {
        delete cleaned[key];
      }
    }

    if (errors.length > 0) {
      throw buildValidationError(errors);
    }

    return cleaned;
  },

  async assertUniqueName(symbol, symbolCustomName, existingId = null) {
    const existing = await this.findByName(symbol, symbolCustomName);
    if (existing && existing._id !== existingId) {
      const error = new Error('symbolCustomName must be unique within the same symbol');
      error.statusCode = 409;
      error.details = [
        { field: 'symbolCustomName', message: 'Already exists for this symbol' },
      ];
      throw error;
    }
  },

  async create(payload) {
    const cleaned = this.validatePayload(payload, { partial: false });
    await this.assertUniqueName(cleaned.symbol, cleaned.symbolCustomName);

    const now = new Date();
    const record = {
      ...cleaned,
      displayName: cleaned.displayName || cleaned.symbolCustomName,
      createdAt: now,
      updatedAt: now,
    };

    return await symbolCustomsDb.insert(record);
  },

  async findAll(filter = {}) {
    return await symbolCustomsDb.find(filter || {}).sort({ symbol: 1, symbolCustomName: 1 });
  },

  async findById(id) {
    return await symbolCustomsDb.findOne({ _id: id });
  },

  async findBySymbol(symbol) {
    return await symbolCustomsDb.find({ symbol: normalizeSymbol(symbol) }).sort({ symbolCustomName: 1 });
  },

  async findByName(symbol, symbolCustomName) {
    return await symbolCustomsDb.findOne({
      symbol: normalizeSymbol(symbol),
      symbolCustomName: String(symbolCustomName || '').trim(),
    });
  },

  async update(id, payload) {
    const existing = await this.findById(id);
    if (!existing) return null;

    const cleaned = this.validatePayload(payload, { partial: true });
    const nextSymbol = cleaned.symbol || existing.symbol;
    const nextName = cleaned.symbolCustomName || existing.symbolCustomName;
    if (cleaned.symbol !== undefined || cleaned.symbolCustomName !== undefined) {
      await this.assertUniqueName(nextSymbol, nextName, id);
    }

    const patch = mergePatch(existing, cleaned);
    if (Object.keys(patch).length > 0) {
      await symbolCustomsDb.update(
        { _id: id },
        { $set: { ...patch, updatedAt: new Date() } }
      );
    }

    return await this.findById(id);
  },

  async remove(id) {
    const existing = await this.findById(id);
    if (!existing) return null;

    await symbolCustomsDb.remove({ _id: id }, {});
    return existing;
  },

  async duplicate(id, overrides = {}) {
    const existing = await this.findById(id);
    if (!existing) return null;

    const sourceCopy = cloneValue(existing);
    delete sourceCopy._id;
    delete sourceCopy.createdAt;
    delete sourceCopy.updatedAt;

    const nextPayload = {
      ...sourceCopy,
      ...cloneValue(overrides || {}),
      symbolCustomName: overrides && overrides.symbolCustomName
        ? overrides.symbolCustomName
        : `${existing.symbolCustomName}_COPY_${Date.now()}`,
      status: 'draft',
      paperEnabled: false,
      liveEnabled: false,
      isPrimaryLive: false,
      allowLive: false,
    };

    return await this.create(nextPayload);
  },
};

module.exports = SymbolCustom;
module.exports.VALID_STATUSES = VALID_STATUSES;
