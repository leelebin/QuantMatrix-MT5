/**
 * Symbol Resolver
 *
 * Maps canonical trading symbols (the stable names used everywhere in the
 * app — strategies, positions, backtest records, diagnostics filters) to
 * the actual broker-side names reported by MT5.
 *
 * Why it exists:
 *   Different brokers name the same instrument differently (e.g. BTCUSD vs
 *   BTCUSDm, BTCUSD.a, BTCUSDT). We do not want those broker suffixes to
 *   leak into the database or the UI. Instead, the canonical name stays
 *   stable and this service resolves it to the right broker name at the
 *   boundary with mt5Service.
 *
 * Resolution order (first match wins, case-sensitive to match MT5):
 *   1. Env override `QM_SYMBOL_ALIAS_<CANONICAL>` — comma-separated list
 *   2. CRYPTO_SYMBOL_ALIASES in config/instruments.js
 *   3. The canonical name itself (fallback)
 *
 * For non-crypto symbols where no aliases are declared, the canonical
 * name is used directly and resolution is still tracked so the diagnostic
 * endpoint can show "OK – using canonical" vs "FAILED – symbol not found".
 *
 * Fire-and-forget safety: when MT5 is not connected (e.g. in backtest /
 * tests), `resolveForBroker` falls back to returning the canonical name
 * unchanged so historical data paths keep working. Discovery (which
 * actually probes the broker) is only run when explicitly requested.
 */

const { CRYPTO_SYMBOL_ALIASES, getAllSymbols } = require('../config/instruments');

const STATUS = Object.freeze({
  UNKNOWN: 'unknown',     // Never attempted
  PENDING: 'pending',     // Discovery in progress
  OK: 'ok',               // Broker name confirmed via symbol_info
  CANONICAL: 'canonical', // No alias tried; using canonical as broker name
  MISSING: 'missing',     // No candidate returned a match
  ERROR: 'error',         // Bridge error during discovery
});

function envAliasKey(canonical) {
  return `QM_SYMBOL_ALIAS_${String(canonical).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function envOverrideCandidates(canonical) {
  const raw = process.env[envAliasKey(canonical)];
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function uniqueOrdered(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

class SymbolResolver {
  constructor() {
    // canonical -> { broker, status, error, lastCheckedAt, candidates, tried }
    this._resolutions = new Map();
  }

  /**
   * Ordered list of broker-side candidate names to try for a canonical
   * symbol. Env overrides come first so operators can force a specific
   * broker name without touching code.
   */
  getCandidates(canonical) {
    const envCandidates = envOverrideCandidates(canonical);
    const builtin = CRYPTO_SYMBOL_ALIASES[canonical] || [];
    return uniqueOrdered([...envCandidates, ...builtin, canonical]);
  }

  /**
   * Synchronous lookup — returns the last resolved broker name for a
   * canonical symbol, or the canonical name itself if no resolution has
   * been attempted yet. This is safe to call from hot paths (candle
   * fetch, order placement) because it never hits the bridge.
   */
  resolveForBroker(canonical) {
    if (!canonical) return canonical;
    const entry = this._resolutions.get(canonical);
    if (entry && entry.broker) return entry.broker;
    return canonical;
  }

  getResolution(canonical) {
    const entry = this._resolutions.get(canonical);
    if (!entry) {
      return {
        canonical,
        broker: null,
        status: STATUS.UNKNOWN,
        error: null,
        lastCheckedAt: null,
        candidates: this.getCandidates(canonical),
        tried: [],
      };
    }
    return { canonical, ...entry };
  }

  /**
   * Actively probe MT5 for the first candidate that returns symbol_info.
   * Must be called with a connected mt5Service. Records the resolution
   * and returns it. Never throws — on any bridge error the resolution is
   * marked ERROR and the canonical name is returned as a safe fallback.
   *
   * @param {string} canonical
   * @param {object} mt5ServiceInstance - must expose getSymbolInfo(symbol)
   */
  async discover(canonical, mt5ServiceInstance) {
    const candidates = this.getCandidates(canonical);
    const tried = [];
    let lastError = null;

    for (const candidate of candidates) {
      try {
        const info = await mt5ServiceInstance.getSymbolInfo(candidate);
        tried.push({ name: candidate, matched: info != null });
        if (info) {
          const entry = {
            broker: info.symbol || candidate,
            status: STATUS.OK,
            error: null,
            lastCheckedAt: new Date().toISOString(),
            candidates,
            tried,
            info: {
              tradeModeName: info.tradeModeName || null,
              digits: info.digits ?? null,
              visible: info.visible ?? null,
            },
          };
          this._resolutions.set(canonical, entry);
          return { canonical, ...entry };
        }
      } catch (err) {
        lastError = err.message || String(err);
        tried.push({ name: candidate, matched: false, error: lastError });
      }
    }

    const entry = {
      broker: null,
      status: lastError ? STATUS.ERROR : STATUS.MISSING,
      error: lastError,
      lastCheckedAt: new Date().toISOString(),
      candidates,
      tried,
    };
    this._resolutions.set(canonical, entry);
    return { canonical, ...entry };
  }

  /**
   * Discover all canonical symbols currently registered in the
   * instruments config. Intended to be called once after MT5 connects.
   * Runs resolutions in parallel (up to `concurrency` at a time) to
   * avoid overloading the bridge.
   *
   * Returns a report: { resolved: [...], missing: [...], errors: [...] }.
   * Never throws. Individual failures are isolated.
   */
  async discoverAll(mt5ServiceInstance, { concurrency = 4, symbols = null } = {}) {
    const canonicalSymbols = Array.isArray(symbols) && symbols.length > 0
      ? symbols
      : getAllSymbols();

    const queue = [...canonicalSymbols];
    const results = [];

    async function worker(self) {
      while (queue.length > 0) {
        const canonical = queue.shift();
        if (!canonical) break;
        try {
          const res = await self.discover(canonical, mt5ServiceInstance);
          results.push(res);
        } catch (err) {
          results.push({
            canonical,
            broker: null,
            status: STATUS.ERROR,
            error: err.message || String(err),
            lastCheckedAt: new Date().toISOString(),
            candidates: self.getCandidates(canonical),
            tried: [],
          });
        }
      }
    }

    const workers = [];
    for (let i = 0; i < Math.max(1, concurrency); i += 1) {
      workers.push(worker(this));
    }
    await Promise.all(workers);

    const report = {
      total: canonicalSymbols.length,
      resolved: results.filter((r) => r.status === STATUS.OK),
      missing: results.filter((r) => r.status === STATUS.MISSING),
      errors: results.filter((r) => r.status === STATUS.ERROR),
    };

    if (report.missing.length > 0) {
      console.warn(
        `[SymbolResolver] ${report.missing.length} canonical symbol(s) not available on broker: ${report.missing.map((m) => m.canonical).join(', ')}`
      );
    }
    if (report.errors.length > 0) {
      console.warn(
        `[SymbolResolver] ${report.errors.length} symbol(s) errored during discovery`
      );
    }

    return report;
  }

  /**
   * Report-style snapshot of every known canonical symbol plus its
   * current resolution state. Drives the /api/trading/symbols diagnostic
   * endpoint and the Diagnostics page.
   */
  getStatusReport() {
    const canonicals = getAllSymbols();
    return canonicals.map((canonical) => this.getResolution(canonical));
  }

  /**
   * Is this canonical symbol known to have a working broker alias? Used
   * by live/paper code paths to skip symbols the broker does not offer
   * rather than spamming MT5 with failed requests.
   *
   * Returns true when:
   *   - resolution is OK, OR
   *   - we have never attempted discovery (optimistic — backtest &
   *     test environments never call discover and should still work).
   *
   * Returns false only when we actively tried and failed (MISSING/ERROR).
   */
  isBrokerAvailable(canonical) {
    const entry = this._resolutions.get(canonical);
    if (!entry) return true;
    return entry.status === STATUS.OK || entry.status === STATUS.CANONICAL;
  }

  /**
   * Manually mark a canonical symbol as resolved to a specific broker
   * name. Useful in tests or when the user supplies an override via the
   * admin UI. Status is forced to OK.
   */
  setManualResolution(canonical, brokerName) {
    this._resolutions.set(canonical, {
      broker: brokerName,
      status: STATUS.OK,
      error: null,
      lastCheckedAt: new Date().toISOString(),
      candidates: this.getCandidates(canonical),
      tried: [{ name: brokerName, matched: true, manual: true }],
    });
  }

  /**
   * Clear cached resolutions. Does not touch env overrides. Called by
   * the diagnostic endpoint if the user wants to re-run discovery.
   */
  clear() {
    this._resolutions.clear();
  }
}

function createSymbolResolver() {
  return new SymbolResolver();
}

const symbolResolver = createSymbolResolver();

symbolResolver.STATUS = STATUS;
symbolResolver.envAliasKey = envAliasKey;
symbolResolver.SymbolResolver = SymbolResolver;
symbolResolver.createSymbolResolver = createSymbolResolver;

module.exports = symbolResolver;
