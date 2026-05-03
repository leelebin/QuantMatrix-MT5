/**
 * Session Filter — blocks strategy analysis during high-risk market periods:
 *
 *   1. Known low-liquidity holidays (European + US markets fully or partially closed).
 *   2. NFP release window (first Friday of every month, 12:00–14:00 UTC).
 *   3. FOMC decision window (hardcoded 2025 dates, 18:00–20:00 UTC).
 *      → Update FOMC_DECISION_DATES each year with the new FOMC calendar.
 *   4. Low-liquidity inter-session window (22:00–01:00 UTC) — used by
 *      volume-sensitive strategies only (Breakout, VolumeFlowHybrid).
 *
 * Usage:
 *   const { isHighRiskPeriod, isLowLiquiditySession } = require('../utils/sessionFilter');
 *
 *   // Block all strategies
 *   const check = isHighRiskPeriod();
 *   if (check.blocked) { console.log(check.reason); return; }
 *
 *   // Block volume-sensitive strategies only
 *   if (isLowLiquiditySession()) { continue; }
 */

// ─── Holiday dates (YYYY-MM-DD, UTC) ────────────────────────────────────────
// All dates where European or US markets are closed / extremely thin.
// Update the list when a new calendar year begins.
const HOLIDAY_DATES = new Set([
  // 2025
  '2025-01-01', // New Year's Day
  '2025-04-18', // Good Friday (EU + US)
  '2025-04-21', // Easter Monday (EU)
  '2025-05-01', // Labour Day (EU) — the primary trigger for this filter
  '2025-05-29', // Ascension Day (DE, FR, NL)
  '2025-06-09', // Whit Monday (DE, FR, NL)
  '2025-07-04', // US Independence Day
  '2025-08-25', // UK Summer Bank Holiday
  '2025-11-11', // Armistice Day (FR, BE)
  '2025-11-27', // US Thanksgiving
  '2025-11-28', // US Black Friday (thin liquidity)
  '2025-12-24', // Christmas Eve (thin)
  '2025-12-25', // Christmas Day
  '2025-12-26', // Boxing Day (UK + EU)
  '2025-12-31', // New Year's Eve (thin)

  // 2026
  '2026-01-01', // New Year's Day
  '2026-04-03', // Good Friday 2026
  '2026-04-06', // Easter Monday 2026
  '2026-05-01', // Labour Day
  '2026-05-14', // Ascension Day 2026
  '2026-05-25', // Whit Monday 2026
  '2026-07-03', // US Independence Day (observed)
  '2026-11-26', // US Thanksgiving
  '2026-12-24', // Christmas Eve
  '2026-12-25', // Christmas Day
  '2026-12-28', // Boxing Day (observed)
  '2026-12-31', // New Year's Eve
]);

// ─── FOMC decision dates (2025) ─────────────────────────────────────────────
// Announcement is always at ~18:00 UTC (2:00 PM ET).
// Block window: 17:45–20:00 UTC on each date.
// Source: federalreserve.gov — update this list each January.
const FOMC_DECISION_DATES = new Set([
  '2025-01-29',
  '2025-03-19',
  '2025-05-07',
  '2025-06-18',
  '2025-07-30',
  '2025-09-17',
  '2025-10-29',
  '2025-12-10',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toUtcDateString(date) {
  return date.toISOString().slice(0, 10);
}

function utcMinutes(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

// Returns true on the first Friday of the month (NFP day).
function isNfpDay(date) {
  return date.getUTCDay() === 5 && date.getUTCDate() <= 7;
}

// ─── Exported checks ─────────────────────────────────────────────────────────

/**
 * Returns { blocked: boolean, reason: string }.
 * blocked=true means ALL strategies should skip this analysis cycle.
 *
 * @param {Date} [now=new Date()]
 */
function isHighRiskPeriod(now = new Date()) {
  const dateStr = toUtcDateString(now);
  const mins = utcMinutes(now);

  // 1. Known holiday
  if (HOLIDAY_DATES.has(dateStr)) {
    return {
      blocked: true,
      reason: `Holiday session (${dateStr}) — strategy analysis paused`,
    };
  }

  // 2. NFP window: first Friday of month, 12:00–14:00 UTC
  if (isNfpDay(now) && mins >= 720 && mins < 840) {
    return {
      blocked: true,
      reason: `NFP release window (${now.toUTCString()}) — strategy analysis paused`,
    };
  }

  // 3. FOMC window: known decision days, 17:45–20:00 UTC
  if (FOMC_DECISION_DATES.has(dateStr) && mins >= 1065 && mins < 1200) {
    return {
      blocked: true,
      reason: `FOMC decision window (${dateStr}) — strategy analysis paused`,
    };
  }

  return { blocked: false, reason: '' };
}

/**
 * Returns true during the thin inter-session window (22:00–01:00 UTC).
 * Used by volume-sensitive strategies (Breakout, VolumeFlowHybrid) only.
 *
 * @param {Date} [now=new Date()]
 */
function isLowLiquiditySession(now = new Date()) {
  const hour = now.getUTCHours();
  return hour >= 22 || hour < 1;
}

module.exports = { isHighRiskPeriod, isLowLiquiditySession };
