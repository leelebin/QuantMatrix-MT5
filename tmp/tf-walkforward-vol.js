// Same walk-forward as tf-walkforward.js, but on high-volatility trending
// instruments (gold, crypto, indices). Symbols already have other strategy
// types as primary in instruments.js; we layer TrendFollowing in via the
// per-instance mechanism (each StrategyInstance is keyed by (strategy, symbol)
// and runs independently).

const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = 'http://localhost:5000';
const IS_START = '2025-10-15';
const IS_END = '2026-02-15';
const OOS_START = '2026-02-15';
const OOS_END = '2026-04-25';
const INITIAL_BALANCE = 500;
const OPTIMIZE_FOR = 'returnPercent';

const SYMBOLS = ['XAUUSD', 'BTCUSD', 'ETHUSD', 'NAS100', 'US30', 'XTIUSD', 'XAGUSD', 'SOLUSD'];
const STRATEGY = 'TrendFollowing';

const REPORT_PATH = path.join(__dirname, 'tf-walkforward-vol-report.json');
const PROGRESS_PATH = path.join(__dirname, 'tf-walkforward-vol-progress.log');

function getCurrentRefreshToken() {
  const data = fs.readFileSync(path.join(__dirname, '..', 'data', 'users.db'), 'utf8');
  const lines = data.split('\n').filter(Boolean);
  let latest = null;
  for (const ln of lines) {
    try { const o = JSON.parse(ln); if (o._id === 'IFjeGA2SdThy5lDB') latest = o; } catch (_) {}
  }
  if (!latest?.refreshToken) throw new Error('no refresh token');
  return latest.refreshToken;
}

let accessToken = null;
let refreshToken = getCurrentRefreshToken();

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(PROGRESS_PATH, line + '\n'); } catch (_) {}
}

function request(method, urlPath, body, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : {} }); }
        catch (_) { resolve({ status: res.statusCode, body: { rawText: chunks } }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function refreshAccess() {
  const r = await request('POST', '/api/auth/refresh-token', { refreshToken });
  if (r.status === 200 && r.body?.data?.accessToken) {
    accessToken = r.body.data.accessToken;
    if (r.body.data.refreshToken) refreshToken = r.body.data.refreshToken;
    return true;
  }
  log(`Token refresh failed: ${r.status}`);
  return false;
}

async function authed(method, urlPath, body, timeoutMs) {
  let r = await request(method, urlPath, body, timeoutMs);
  if (r.status === 401) { await refreshAccess(); r = await request(method, urlPath, body, timeoutMs); }
  return r;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureInstance(symbol) {
  // Create or reset the (TrendFollowing, symbol) instance with clean defaults
  // so the optimizer doesn't inherit stale persisted params from a prior run.
  const r = await authed('PUT', `/api/strategy-instances/${STRATEGY}/${symbol}`, {
    parameters: {},
    enabled: false,
  });
  return r.status === 200;
}

async function waitOptimizerIdle(timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await authed('GET', '/api/optimizer/progress');
    if (r.status === 200 && !r.body?.data?.running) return true;
    await sleep(2000);
  }
  return false;
}

async function runOptimizer({ symbol, strategy, startDate, endDate }) {
  await waitOptimizerIdle();
  const startResp = await authed('POST', '/api/optimizer/run', {
    symbol, strategyType: strategy, startDate, endDate,
    initialBalance: INITIAL_BALANCE, optimizeFor: OPTIMIZE_FOR,
  });
  if (startResp.status !== 200) {
    return { error: `start ${startResp.status}: ${JSON.stringify(startResp.body).slice(0, 200)}` };
  }

  // Wait for run to finish (poll). Optimizer runs are fast (~3s) for small
  // grids, so we tolerate immediate-not-running on first check after start.
  await sleep(2000);
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const r = await authed('GET', '/api/optimizer/progress');
    if (r.status === 200 && !r.body?.data?.running) break;
    await sleep(3000);
  }

  const result = await authed('GET', '/api/optimizer/result');
  if (result.status !== 200) return { error: `result ${result.status}` };
  const data = result.body?.data || {};
  const best = data.bestResult || data.best || null;
  return { best, totalCombos: data.totalCombos || data.combinations || null };
}

async function runBacktest({ symbol, strategy, startDate, endDate, parameters }) {
  const r = await authed('POST', '/api/backtest/run', {
    symbol, strategyType: strategy, startDate, endDate,
    initialBalance: INITIAL_BALANCE, parameters,
  }, 240000);
  if (r.status !== 200) return { error: `bt ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}` };
  return { summary: r.body?.data?.summary || null };
}

function monthsBetween(s, e) {
  return ((new Date(e) - new Date(s)) / (1000 * 60 * 60 * 24)) / 30.4375;
}

function summarize(summary, s, e) {
  if (!summary) return null;
  const months = monthsBetween(s, e);
  const trades = summary.totalTrades ?? 0;
  const pf = summary.profitFactor ?? 0;
  const ret = summary.returnPercent ?? 0;
  const wr = (summary.winRate ?? 0) * 100;
  const dd = summary.maxDrawdownPercent ?? 0;
  const sharpe = summary.sharpeRatio ?? 0;
  const monthlyReturn = months > 0 ? ret / months : ret;
  return { trades, pf, ret, monthlyReturn, wr, dd, sharpe };
}

function gateIs(m) {
  if (!m) return { pass: false, reasons: ['no metrics'] };
  const reasons = [];
  if (m.trades < 6) reasons.push(`IS trades=${m.trades}<6`);
  if (m.pf < 1.5) reasons.push(`IS PF=${m.pf.toFixed(2)}<1.5`);
  if (m.monthlyReturn < 8) reasons.push(`IS mRet=${m.monthlyReturn.toFixed(1)}%<8%`);
  if (m.dd > 30) reasons.push(`IS DD=${m.dd.toFixed(1)}%>30%`);
  if (m.wr < 55) reasons.push(`IS WR=${m.wr.toFixed(1)}%<55%`);
  return { pass: reasons.length === 0, reasons };
}

function gateOos(m) {
  if (!m) return { pass: false, reasons: ['no metrics'] };
  const reasons = [];
  if (m.trades < 2) reasons.push(`OOS trades=${m.trades}<2`);
  if (m.pf < 1.2) reasons.push(`OOS PF=${m.pf.toFixed(2)}<1.2`);
  if (m.monthlyReturn < 5) reasons.push(`OOS mRet=${m.monthlyReturn.toFixed(1)}%<5%`);
  if (m.dd > 25) reasons.push(`OOS DD=${m.dd.toFixed(1)}%>25%`);
  if (m.wr < 50) reasons.push(`OOS WR=${m.wr.toFixed(1)}%<50%`);
  return { pass: reasons.length === 0, reasons };
}

async function applyDecision({ strategy, symbol, decision, parameters }) {
  const body = decision === 'enable_with_params'
    ? { parameters, enabled: true }
    : { enabled: false };
  const r = await authed('PUT', `/api/strategy-instances/${strategy}/${symbol}`, body);
  return r.status === 200;
}

(async function main() {
  fs.writeFileSync(PROGRESS_PATH, '');
  log(`=== TF walk-forward (volatile basket) start ===`);
  log(`IS=${IS_START}..${IS_END}  OOS=${OOS_START}..${OOS_END}  balance=$${INITIAL_BALANCE}`);
  await refreshAccess();

  const report = { startedAt: new Date().toISOString(), strategy: STRATEGY,
    period: { is: { start: IS_START, end: IS_END }, oos: { start: OOS_START, end: OOS_END } },
    initialBalance: INITIAL_BALANCE, items: [] };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  for (const symbol of SYMBOLS) {
    log(`\n──── ${symbol} ────`);
    const item = { strategy: STRATEGY, symbol, status: 'pending' };

    try {
      const created = await ensureInstance(symbol);
      log(`  instance reset/created: ${created}`);

      log(`  IS optimizing ${IS_START}..${IS_END}`);
      const optOut = await runOptimizer({ symbol, strategy: STRATEGY, startDate: IS_START, endDate: IS_END });
      if (optOut.error || !optOut.best) {
        item.status = 'opt_failed'; item.error = optOut.error || 'no best';
        log(`  ↳ opt FAILED: ${item.error}`);
        item.decision = 'disable';
        item.decisionApplied = await applyDecision({ strategy: STRATEGY, symbol, decision: 'disable' });
        report.items.push(item); fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
        continue;
      }

      const params = optOut.best.parameters || {};
      const isMetrics = summarize(optOut.best.summary, IS_START, IS_END);
      const isGate = gateIs(isMetrics);
      log(`  IS: trades=${isMetrics.trades} PF=${isMetrics.pf.toFixed(2)} mRet=${isMetrics.monthlyReturn.toFixed(1)}% WR=${isMetrics.wr.toFixed(1)}% DD=${isMetrics.dd.toFixed(1)}% pass=${isGate.pass}`);
      log(`  IS params (sweep): adx=${params.adx_threshold} pull=${params.pullback_atr_max} sl=${params.slMultiplier} tp=${params.tpMultiplier}`);
      item.is = { params, metrics: isMetrics, gate: isGate, totalCombos: optOut.totalCombos };

      if (!isGate.pass) {
        item.status = 'is_fail'; item.decision = 'disable';
        item.decisionApplied = await applyDecision({ strategy: STRATEGY, symbol, decision: 'disable' });
        log(`  ↳ DISABLE — IS gate fail: ${isGate.reasons.join(', ')}`);
        report.items.push(item); fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
        continue;
      }

      log(`  OOS validating ${OOS_START}..${OOS_END}`);
      const btOut = await runBacktest({ symbol, strategy: STRATEGY, startDate: OOS_START, endDate: OOS_END, parameters: params });
      if (btOut.error || !btOut.summary) {
        item.status = 'oos_failed'; item.error = btOut.error || 'no summary';
        item.decision = 'disable';
        item.decisionApplied = await applyDecision({ strategy: STRATEGY, symbol, decision: 'disable' });
        log(`  ↳ OOS FAILED: ${item.error}`);
        report.items.push(item); fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
        continue;
      }
      const oosMetrics = summarize(btOut.summary, OOS_START, OOS_END);
      const oosGate = gateOos(oosMetrics);
      log(`  OOS: trades=${oosMetrics.trades} PF=${oosMetrics.pf.toFixed(2)} mRet=${oosMetrics.monthlyReturn.toFixed(1)}% WR=${oosMetrics.wr.toFixed(1)}% DD=${oosMetrics.dd.toFixed(1)}% pass=${oosGate.pass}`);
      item.oos = { metrics: oosMetrics, gate: oosGate };

      if (!oosGate.pass) {
        item.status = 'oos_fail'; item.decision = 'disable';
        item.decisionApplied = await applyDecision({ strategy: STRATEGY, symbol, decision: 'disable' });
        log(`  ↳ DISABLE — OOS gate fail: ${oosGate.reasons.join(', ')}`);
      } else {
        item.status = 'pass'; item.decision = 'enable_with_params';
        item.decisionApplied = await applyDecision({ strategy: STRATEGY, symbol, decision: 'enable_with_params', parameters: params });
        log(`  ↳ ENABLE — both gates pass (applied=${item.decisionApplied})`);
      }
      report.items.push(item); fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    } catch (err) {
      item.status = 'exception'; item.error = String(err?.message || err);
      log(`  EXCEPTION: ${item.error}`);
      report.items.push(item); fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    }
  }

  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  const passed = report.items.filter((x) => x.status === 'pass');
  log(`\n=== done. PASS=${passed.length}/${report.items.length} ===`);
  for (const it of passed) log(`  PASS: ${it.symbol}  IS=${it.is.metrics.monthlyReturn.toFixed(1)}%/mo  OOS=${it.oos.metrics.monthlyReturn.toFixed(1)}%/mo`);
})().catch((err) => { log(`FATAL ${err?.stack || err}`); process.exit(1); });
