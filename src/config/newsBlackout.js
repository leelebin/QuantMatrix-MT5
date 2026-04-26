const DEFAULT_NEWS_BLACKOUT_CONFIG = Object.freeze({
  enabled: true,
  beforeMinutes: 40,
  afterMinutes: 20,
  impactLevels: ['High'],
});

const LEGACY_NEWS_BLACKOUT_CONFIGS = Object.freeze([
  Object.freeze({
    enabled: false,
    beforeMinutes: 15,
    afterMinutes: 15,
    impactLevels: ['High'],
  }),
  Object.freeze({
    enabled: true,
    beforeMinutes: 30,
    afterMinutes: 15,
    impactLevels: ['High'],
  }),
]);

const CURRENCY_MAPPING = Object.freeze({
  EURUSD: ['USD', 'EUR'],
  USDJPY: ['USD', 'JPY'],
  GBPUSD: ['USD', 'GBP'],
  AUDUSD: ['USD', 'AUD'],
  USDCAD: ['USD', 'CAD'],
  NZDUSD: ['USD', 'NZD'],
  USDCHF: ['USD', 'CHF'],
  EURJPY: ['EUR', 'JPY'],
  GBPJPY: ['GBP', 'JPY'],
  EURGBP: ['EUR', 'GBP'],
  AUDNZD: ['AUD', 'NZD'],
  XAUUSD: ['USD'],
  XAGUSD: ['USD'],
  XTIUSD: ['USD'],
  XBRUSD: ['USD'],
  US30: ['USD'],
  SPX500: ['USD'],
  NAS100: ['USD'],
  BTCUSD: ['USD'],
  ETHUSD: ['USD'],
  LTCUSD: ['USD'],
  XRPUSD: ['USD'],
  BCHUSD: ['USD'],
  SOLUSD: ['USD'],
  ADAUSD: ['USD'],
  DOGEUSD: ['USD'],
});

const VALID_IMPACT_LEVELS = new Set(['Low', 'Medium', 'High']);

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function clampMinutes(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.min(240, Math.max(0, Math.round(numeric)));
}

function normalizeImpactLevels(impactLevels, fallback) {
  const source = Array.isArray(impactLevels) ? impactLevels : fallback;
  const normalized = [...new Set(
    source
      .map((level) => {
        const text = String(level || '').trim().toLowerCase();
        if (text === 'low') return 'Low';
        if (text === 'medium') return 'Medium';
        if (text === 'high') return 'High';
        return null;
      })
      .filter((level) => VALID_IMPACT_LEVELS.has(level))
  )];

  return normalized.length > 0 ? normalized : [...fallback];
}

function getAffectedCurrencies(symbol) {
  if (!symbol || !CURRENCY_MAPPING[symbol]) {
    return [];
  }

  return [...CURRENCY_MAPPING[symbol]];
}

function normalizeNewsBlackoutConfig(partial, defaults = DEFAULT_NEWS_BLACKOUT_CONFIG) {
  const base = cloneValue(defaults || DEFAULT_NEWS_BLACKOUT_CONFIG);
  const input = partial && typeof partial === 'object' ? partial : {};

  return {
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : Boolean(base.enabled),
    beforeMinutes: clampMinutes(input.beforeMinutes, base.beforeMinutes),
    afterMinutes: clampMinutes(input.afterMinutes, base.afterMinutes),
    impactLevels: normalizeImpactLevels(input.impactLevels, base.impactLevels),
  };
}

function areNewsConfigsEquivalent(left, right) {
  const normalizedLeft = normalizeNewsBlackoutConfig(left);
  const normalizedRight = normalizeNewsBlackoutConfig(right);

  return normalizedLeft.enabled === normalizedRight.enabled
    && normalizedLeft.beforeMinutes === normalizedRight.beforeMinutes
    && normalizedLeft.afterMinutes === normalizedRight.afterMinutes
    && JSON.stringify(normalizedLeft.impactLevels) === JSON.stringify(normalizedRight.impactLevels);
}

function isLegacyNewsBlackoutConfig(config) {
  if (config == null) {
    return true;
  }

  return LEGACY_NEWS_BLACKOUT_CONFIGS.some((candidate) => areNewsConfigsEquivalent(config, candidate));
}

module.exports = {
  DEFAULT_NEWS_BLACKOUT_CONFIG,
  LEGACY_NEWS_BLACKOUT_CONFIGS,
  CURRENCY_MAPPING,
  areNewsConfigsEquivalent,
  getAffectedCurrencies,
  isLegacyNewsBlackoutConfig,
  normalizeNewsBlackoutConfig,
};
