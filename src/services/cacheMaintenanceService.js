const economicCalendarService = require('./economicCalendarService');

const VALID_SCOPES = new Set(['safe']);

function normalizeScope(scope = 'safe') {
  const normalized = String(scope || 'safe').trim().toLowerCase();
  if (!VALID_SCOPES.has(normalized)) {
    const error = new Error(`Unsupported cache scope: ${scope}`);
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

async function getSafeCacheTargets() {
  const economicCalendarTarget = await economicCalendarService.getCacheStatus();
  return [economicCalendarTarget];
}

function buildSummary(scope, targets) {
  const safeTargets = Array.isArray(targets) ? targets : [];
  return {
    scope,
    targets: safeTargets,
    totalSizeBytes: safeTargets.reduce((sum, target) => sum + (Number(target.totalSizeBytes) || 0), 0),
  };
}

async function getCacheStatus(scope = 'safe') {
  const normalizedScope = normalizeScope(scope);
  if (normalizedScope === 'safe') {
    return buildSummary(normalizedScope, await getSafeCacheTargets());
  }

  return buildSummary(normalizedScope, []);
}

async function clearCache(scope = 'safe') {
  const normalizedScope = normalizeScope(scope);
  const before = await getCacheStatus(normalizedScope);

  if (normalizedScope === 'safe') {
    await economicCalendarService.clearCache();
  }

  const after = await getCacheStatus(normalizedScope);
  const freedBytes = Math.max((before.totalSizeBytes || 0) - (after.totalSizeBytes || 0), 0);
  const clearedTargets = (before.targets || [])
    .filter((target) => {
      const memoryExists = Boolean(target.memory && target.memory.exists);
      const diskExists = Boolean(target.disk && target.disk.exists);
      return memoryExists || diskExists;
    })
    .map((target) => ({
      key: target.key,
      label: target.label,
    }));

  const message = clearedTargets.length
    ? `Cleared ${clearedTargets.length} safe cache target${clearedTargets.length === 1 ? '' : 's'}`
    : 'Safe cache is already clear';

  return {
    ...after,
    clearedTargets,
    freedBytes,
    message,
  };
}

module.exports = {
  VALID_SCOPES,
  normalizeScope,
  getCacheStatus,
  clearCache,
};
