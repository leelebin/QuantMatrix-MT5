const KNOWN_STRATEGY_NAMES = [
  'TrendFollowing',
  'MeanReversion',
  'Momentum',
  'Breakout',
  'MultiTimeframe',
  'VolumeFlowHybrid',
];

const TRUNCATED_STRATEGY_LENGTH = 13;

function normalizeStrategyKey(strategy = '') {
  return String(strategy || '').trim().replace(/[\s_-]+/g, '').toLowerCase();
}

const STRATEGY_NAME_ALIASES = new Map();
KNOWN_STRATEGY_NAMES.forEach((name) => {
  STRATEGY_NAME_ALIASES.set(normalizeStrategyKey(name), name);
  const truncated = name.slice(0, TRUNCATED_STRATEGY_LENGTH);
  if (truncated && truncated !== name) {
    STRATEGY_NAME_ALIASES.set(normalizeStrategyKey(truncated), name);
  }
});

function normalizeStrategyName(strategy = '') {
  const raw = String(strategy || '').trim();
  if (!raw) return '';

  const key = normalizeStrategyKey(raw);
  const directMatch = STRATEGY_NAME_ALIASES.get(key);
  if (directMatch) return directMatch;

  const prefixMatch = KNOWN_STRATEGY_NAMES.find((name) => {
    const canonicalKey = normalizeStrategyKey(name);
    return canonicalKey.startsWith(key) || key.startsWith(canonicalKey);
  });

  return prefixMatch || raw;
}

function getStrategyNameAliases(strategy = '') {
  const canonical = normalizeStrategyName(strategy);
  if (!canonical) return [];

  const aliases = new Set([canonical]);
  const truncated = canonical.slice(0, TRUNCATED_STRATEGY_LENGTH);
  if (truncated && truncated !== canonical) aliases.add(truncated);

  const raw = String(strategy || '').trim();
  if (raw) aliases.add(raw);

  return [...aliases];
}

function parseStrategyFromBrokerComment(comment = '') {
  const parts = String(comment || '').split('|').map((part) => part.trim()).filter(Boolean);
  return parts.length >= 2 ? normalizeStrategyName(parts[1]) : null;
}

function buildBrokerComment(signal = {}, prefix = 'QM') {
  const strategy = normalizeStrategyName(signal.strategy || 'Strategy') || 'Strategy';
  const side = signal.signal || signal.type || 'NA';
  const confidence = Number.isFinite(signal.confidence) ? Number(signal.confidence).toFixed(2) : 'NA';
  const raw = [prefix, strategy, side, confidence].join('|');
  return raw.length <= 31 ? raw : raw.slice(0, 31);
}

function buildTradeComment(signal = {}, fallbackComment = '') {
  const strategy = normalizeStrategyName(signal.strategy || parseStrategyFromBrokerComment(fallbackComment) || 'Unknown') || 'Unknown';
  const side = signal.signal || signal.type || null;
  const confidence = Number.isFinite(signal.confidence)
    ? `${Math.round(Number(signal.confidence) * 100)}%`
    : null;
  const reason = String(signal.reason || '').trim();

  const parts = [`Strategy=${strategy}`];
  if (side) parts.push(`Signal=${side}`);
  if (confidence) parts.push(`Confidence=${confidence}`);
  if (reason) parts.push(`Reason=${reason}`);

  return parts.join(' | ');
}

module.exports = {
  normalizeStrategyName,
  getStrategyNameAliases,
  parseStrategyFromBrokerComment,
  buildBrokerComment,
  buildTradeComment,
};
