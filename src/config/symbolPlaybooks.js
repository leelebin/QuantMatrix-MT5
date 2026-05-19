const FALLBACK_PLAYBOOK = {
  role: 'unclassified',
  category: 'unknown',
  allowedSetups: [],
  preferredEntryStyle: 'none',
  riskWeight: 0,
  beStyle: 'default',
  liveBias: 'paper_first',
  notes: 'No symbol playbook configured.',
};

const SYMBOL_PLAYBOOKS = {
  XAUUSD: {
    role: 'growth_engine',
    category: 'metals',
    allowedSetups: [
      'event_breakout',
      'trend_pullback',
      'momentum_continuation',
      'safe_haven_rotation',
    ],
    preferredEntryStyle: 'pullback_after_breakout',
    riskWeight: 1.0,
    beStyle: 'medium_loose',
    liveBias: 'allowed_observe',
  },
  XAGUSD: {
    role: 'growth_engine_high_volatility',
    category: 'metals',
    allowedSetups: [
      'momentum_continuation',
      'volatility_expansion',
      'gold_follow_through',
    ],
    preferredEntryStyle: 'confirmation_then_retest',
    riskWeight: 0.8,
    beStyle: 'medium_loose',
    liveBias: 'paper_first',
  },
  XTIUSD: {
    role: 'event_driven_growth',
    category: 'energy',
    allowedSetups: [
      'oil_news_continuation',
      'breakdown_retest',
      'supply_shock_momentum',
    ],
    preferredEntryStyle: 'retest',
    riskWeight: 0.8,
    beStyle: 'medium',
    liveBias: 'allowed_observe',
  },
  XBRUSD: {
    role: 'event_driven_growth',
    category: 'energy',
    allowedSetups: [
      'oil_news_continuation',
      'breakdown_retest',
      'supply_shock_momentum',
    ],
    preferredEntryStyle: 'retest',
    riskWeight: 0.7,
    beStyle: 'medium',
    liveBias: 'paper_first',
  },
  EURUSD: {
    role: 'stabilizer',
    category: 'forex',
    allowedSetups: [
      'm15_intraday_pullback',
      'session_range_reversal',
      'dollar_trend_follow',
    ],
    preferredEntryStyle: 'session_pullback',
    riskWeight: 0.35,
    beStyle: 'tight',
    liveBias: 'allowed_small',
  },
  GBPUSD: {
    role: 'forex_opportunistic',
    category: 'forex',
    allowedSetups: [
      'm15_intraday_pullback',
      'session_range_reversal',
      'dollar_trend_follow',
    ],
    preferredEntryStyle: 'session_pullback',
    riskWeight: 0.4,
    beStyle: 'tight',
    liveBias: 'caution',
  },
  USDCHF: {
    role: 'safe_haven_fx',
    category: 'forex',
    allowedSetups: [
      'safe_haven_rotation',
      'dollar_trend_follow',
      'breakout_retest',
    ],
    preferredEntryStyle: 'retest',
    riskWeight: 0.5,
    beStyle: 'medium_tight',
    liveBias: 'allowed_observe',
  },
  USDCAD: {
    role: 'commodity_fx',
    category: 'forex',
    allowedSetups: [
      'dollar_trend_follow',
      'oil_cad_correlation',
      'm15_intraday_pullback',
    ],
    preferredEntryStyle: 'session_pullback',
    riskWeight: 0.45,
    beStyle: 'medium_tight',
    liveBias: 'paper_first',
  },
  NAS100: {
    role: 'index_momentum',
    category: 'indices',
    allowedSetups: [
      'us_session_momentum',
      'post_news_continuation',
      'ai_risk_on_momentum',
    ],
    preferredEntryStyle: 'pullback_after_impulse',
    riskWeight: 0.5,
    beStyle: 'medium',
    liveBias: 'paper_first',
  },
  SPX500: {
    role: 'index_momentum',
    category: 'indices',
    allowedSetups: [
      'us_session_momentum',
      'post_news_continuation',
    ],
    preferredEntryStyle: 'pullback_after_impulse',
    riskWeight: 0.4,
    beStyle: 'medium',
    liveBias: 'paper_first',
  },
  US30: {
    role: 'disabled_observe',
    category: 'indices',
    allowedSetups: [],
    preferredEntryStyle: 'none',
    riskWeight: 0,
    beStyle: 'none',
    liveBias: 'disabled',
  },
  BTCUSD: {
    role: 'crypto_momentum',
    category: 'crypto',
    allowedSetups: [
      'risk_on_momentum',
      'high_tf_breakout',
      'liquidity_sweep_reversal',
    ],
    preferredEntryStyle: 'confirmation',
    riskWeight: 0.4,
    beStyle: 'loose',
    liveBias: 'signal_only',
  },
  ETHUSD: {
    role: 'crypto_momentum',
    category: 'crypto',
    allowedSetups: [
      'risk_on_momentum',
      'high_tf_breakout',
    ],
    preferredEntryStyle: 'confirmation',
    riskWeight: 0.35,
    beStyle: 'loose',
    liveBias: 'signal_only',
  },
};

function normalizeSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function clonePlaybook(playbook) {
  return {
    ...playbook,
    allowedSetups: Array.isArray(playbook.allowedSetups)
      ? [...playbook.allowedSetups]
      : [],
  };
}

function toListedPlaybook(symbol, playbook) {
  const cloned = clonePlaybook(playbook);
  return {
    symbol,
    role: cloned.role,
    category: cloned.category,
    allowedSetups: cloned.allowedSetups,
    preferredEntryStyle: cloned.preferredEntryStyle,
    riskWeight: cloned.riskWeight,
    beStyle: cloned.beStyle,
    liveBias: cloned.liveBias,
    notes: cloned.notes || null,
  };
}

function inferSymbolCategory(symbol) {
  const playbook = SYMBOL_PLAYBOOKS[normalizeSymbol(symbol)];
  return playbook ? playbook.category : FALLBACK_PLAYBOOK.category;
}

function getSymbolPlaybook(symbol) {
  const playbook = SYMBOL_PLAYBOOKS[normalizeSymbol(symbol)];
  return clonePlaybook(playbook || FALLBACK_PLAYBOOK);
}

function listSymbolPlaybooks() {
  return Object.entries(SYMBOL_PLAYBOOKS).map(([symbol, playbook]) => (
    toListedPlaybook(symbol, playbook)
  ));
}

module.exports = {
  SYMBOL_PLAYBOOKS,
  getSymbolPlaybook,
  inferSymbolCategory,
  listSymbolPlaybooks,
};
