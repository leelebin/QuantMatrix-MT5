function parseStrategyFromBrokerComment(comment = '') {
  const parts = String(comment || '').split('|').map((part) => part.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[1] : null;
}

function buildBrokerComment(signal = {}, prefix = 'QM') {
  const strategy = signal.strategy || 'Strategy';
  const side = signal.signal || signal.type || 'NA';
  const confidence = Number.isFinite(signal.confidence) ? Number(signal.confidence).toFixed(2) : 'NA';
  const raw = [prefix, strategy, side, confidence].join('|');
  return raw.length <= 31 ? raw : raw.slice(0, 31);
}

function buildTradeComment(signal = {}, fallbackComment = '') {
  const strategy = signal.strategy || parseStrategyFromBrokerComment(fallbackComment) || 'Unknown';
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
  parseStrategyFromBrokerComment,
  buildBrokerComment,
  buildTradeComment,
};
