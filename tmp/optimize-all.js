// Multi-symbol multi-strategy optimization driver.
// Runs grid optimizer for every enabled (strategy, symbol) instance,
// applies the best parameter set if it passes the profitability bar,
// disables the combo if it doesn't, and writes a JSON report.

const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = 'http://localhost:5000';
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IklGamVHQTJTZFRoeTVsREIiLCJpYXQiOjE3NzcxMDE3OTAsImV4cCI6MTc3NzE4ODE5MH0.wZ7B4Ldjf9mg4IPjSfS0yPOOiuOFcve0XY3omgoZ9Ww';
const REFRESH_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IklGamVHQTJTZFRoeTVsREIiLCJpYXQiOjE3NzcxMDE3OTAsImV4cCI6MTc3NzcwNjU5MH0.CJk2yLj4G36evAzTWPDK3CChCS0fob_sv2w6QQdF1bQ';

const START_DATE = '2025-10-15';
const END_DATE = '2026-04-20';
const INITIAL_BALANCE = 10000;
const OPTIMIZE_FOR = 'profitFactor';

let accessToken = TOKEN;

const REPORT_PATH = path.join(__dirname, 'optimize-report.json');
const PROGRESS_PATH = path.join(__dirname, 'optimize-progress.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(PROGRESS_PATH, line + '\n'); } catch (_) {}
}

function request(method, urlPath, body) {
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
        'Authorization': `Bearer ${accessToken}`,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        try {
          const parsed = chunks ? JSON.parse(chunks) : {};
          resolve({ status: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ status: res.statusCode, body: { rawText: chunks } });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(new Error('request timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function refreshAccessToken() {
  const r = await request('POST', '/api/auth/refresh-token', { refreshToken: REFRESH_TOKEN });
  if (r.status === 200 && r.body?.data?.accessToken) {
    accessToken = r.body.data.accessToken;
    log(`Token refreshed`);
    return true;
  }
  log(`Token refresh failed: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return false;
}

async function authedRequest(method, urlPath, body) {
  let r = await request(method, urlPath, body);
  if (r.status === 401) {
    await refreshAccessToken();
    r = await request(method, urlPath, body);
  }
  return r;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForOptimizerIdle(timeoutMs = 10 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await authedRequest('GET', '/api/optimizer/progress');
    if (r.status === 200) {
      const p = r.body?.data || {};
      if (!p.running) return true;
    }
    await sleep(3000);
  }
  return false;
}

async function pollUntilDone(timeoutMs = 30 * 60 * 1000, label = '') {
  const start = Date.now();
  let lastPct = -1;
  while (Date.now() - start < timeoutMs) {
    const r = await authedRequest('GET', '/api/optimizer/progress');
    if (r.status === 200) {
      const p = r.body?.data || {};
      const pct = Math.round(((p.completed || 0) / Math.max(1, p.total || 1)) * 100);
      if (pct !== lastPct && pct % 20 === 0) {
        log(`  ${label}: ${pct}% (${p.completed}/${p.total})`);
        lastPct = pct;
      }
      if (!p.running) return true;
    }
    await sleep(4000);
  }
  return false;
}

function passesGate(best) {
  if (!best) return { pass: false, reason: 'no result' };
  const trades = best.trades ?? best.totalTrades ?? 0;
  const pf = best.profitFactor ?? 0;
  const ret = best.totalReturn ?? best.netReturn ?? 0;
  const wr = best.winRate ?? 0;
  const dd = best.maxDrawdown ?? best.maxDrawdownPercent ?? 0;
  const sharpe = best.sharpeRatio ?? 0;

  const reasons = [];
  if (trades < 25) reasons.push(`trades=${trades} (<25)`);
  if (pf < 1.25) reasons.push(`PF=${pf.toFixed(2)} (<1.25)`);
  if (ret < 0.03) reasons.push(`return=${(ret * 100).toFixed(1)}% (<3%)`);
  if (dd > 0.35) reasons.push(`maxDD=${(dd * 100).toFixed(1)}% (>35%)`);
  if (wr < 0.4) reasons.push(`winRate=${(wr * 100).toFixed(1)}% (<40%)`);
  if (sharpe < 0.6) reasons.push(`sharpe=${sharpe.toFixed(2)} (<0.6)`);
  if (reasons.length) return { pass: false, reason: reasons.join('; '), metrics: { trades, pf, ret, wr, dd, sharpe } };
  return { pass: true, reason: 'all gates passed', metrics: { trades, pf, ret, wr, dd, sharpe } };
}

async function getCurrentInstances() {
  const r = await authedRequest('GET', '/api/strategy-instances');
  if (r.status !== 200) throw new Error(`fetch instances failed: ${r.status}`);
  const list = r.body?.data || [];
  return list.filter(x => x && x.strategyName && x.symbol);
}

async function runOneCombo({ strategy, symbol }) {
  log(`---> ${strategy} / ${symbol}: starting optimizer`);
  await waitForOptimizerIdle();

  const r = await authedRequest('POST', '/api/optimizer/run', {
    symbol,
    strategyType: strategy,
    startDate: START_DATE,
    endDate: END_DATE,
    initialBalance: INITIAL_BALANCE,
    optimizeFor: OPTIMIZE_FOR,
  });
  if (r.status !== 200) {
    log(`  startup failed status=${r.status} body=${JSON.stringify(r.body).slice(0, 300)}`);
    return { strategy, symbol, error: `startup status ${r.status}: ${r.body?.message || ''}` };
  }

  const ok = await pollUntilDone(20 * 60 * 1000, `${strategy}/${symbol}`);
  if (!ok) {
    log(`  poll timeout, requesting stop`);
    await authedRequest('POST', '/api/optimizer/stop');
    await waitForOptimizerIdle(60000);
    return { strategy, symbol, error: 'timeout' };
  }

  const result = await authedRequest('GET', '/api/optimizer/result');
  if (result.status !== 200) {
    return { strategy, symbol, error: `no result status ${result.status}` };
  }
  const data = result.body?.data || {};
  const best = data.bestResult || data.best || null;
  const top10 = data.top10 || [];
  return { strategy, symbol, best, top10, totalCombos: data.totalCombos || data.combinations || null };
}

async function applyDecision({ strategy, symbol, decision, best }) {
  if (decision === 'enable_with_params') {
    const params = best?.parameters || best?.params || {};
    const r = await authedRequest('PUT', `/api/strategy-instances/${strategy}/${symbol}`, {
      parameters: params,
      enabled: true,
    });
    return r.status === 200;
  }
  if (decision === 'disable') {
    const r = await authedRequest('PUT', `/api/strategy-instances/${strategy}/${symbol}`, {
      enabled: false,
    });
    return r.status === 200;
  }
  return false;
}

(async function main() {
  fs.writeFileSync(PROGRESS_PATH, '');
  log('=== optimize-all start ===');
  log(`base=${BASE} period=${START_DATE}..${END_DATE} balance=${INITIAL_BALANCE}`);

  await refreshAccessToken();

  const instances = await getCurrentInstances();
  log(`Found ${instances.length} strategy instances total`);

  const enabled = instances.filter(x => x.enabled !== false);
  log(`Currently enabled: ${enabled.length}`);

  const combos = enabled.map(x => ({ strategy: x.strategyName, symbol: x.symbol }));
  combos.sort((a, b) => a.strategy.localeCompare(b.strategy) || a.symbol.localeCompare(b.symbol));

  const report = {
    startedAt: new Date().toISOString(),
    period: { start: START_DATE, end: END_DATE },
    initialBalance: INITIAL_BALANCE,
    optimizeFor: OPTIMIZE_FOR,
    total: combos.length,
    items: [],
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  for (let i = 0; i < combos.length; i++) {
    const c = combos[i];
    log(`[${i + 1}/${combos.length}] ${c.strategy} / ${c.symbol}`);
    let item;
    try {
      const out = await runOneCombo(c);
      if (out.error) {
        item = {
          strategy: c.strategy,
          symbol: c.symbol,
          status: 'error',
          error: out.error,
          decision: 'disable',
          decisionApplied: false,
        };
        item.decisionApplied = await applyDecision({ strategy: c.strategy, symbol: c.symbol, decision: 'disable' });
      } else {
        const gate = passesGate(out.best);
        const decision = gate.pass ? 'enable_with_params' : 'disable';
        item = {
          strategy: c.strategy,
          symbol: c.symbol,
          status: 'ok',
          totalCombos: out.totalCombos,
          best: out.best,
          gate,
          decision,
          decisionApplied: false,
        };
        item.decisionApplied = await applyDecision({ strategy: c.strategy, symbol: c.symbol, decision, best: out.best });
        log(`  -> ${decision} (${gate.reason}) applied=${item.decisionApplied}`);
      }
    } catch (e) {
      item = {
        strategy: c.strategy,
        symbol: c.symbol,
        status: 'exception',
        error: String(e?.message || e),
        decision: 'skip',
        decisionApplied: false,
      };
      log(`  EXCEPTION: ${item.error}`);
    }
    report.items.push(item);
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  }

  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  log(`=== optimize-all done. report at ${REPORT_PATH} ===`);
})().catch(err => {
  log(`FATAL ${err?.stack || err}`);
  process.exit(1);
});
