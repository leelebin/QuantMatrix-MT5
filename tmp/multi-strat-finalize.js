// Multi-strategy walk-forward decision pass.
// Iterates STRATEGIES x SYMBOLS, running IS optimization + OOS validation
// against medium-frequency gates. Decisions applied per-instance, then
// Strategy.symbols matrix synced preserving other strategies' columns.

const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = 'http://localhost:5000';
const FULL_START = '2025-10-15';
const FULL_END = '2026-04-25';
const OOS_START = '2026-02-15';
const OOS_END = '2026-04-25';
const INITIAL_BALANCE = 500;
const OPTIMIZE_FOR = 'returnPercent';

const STRATEGIES = [
  'MeanReversion',
  'Momentum',
  'Breakout',
  'VolumeFlowHybrid',
  'MultiTimeframe',
];

const SYMBOLS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCHF', 'USDCAD', 'NZDUSD',
  'XAUUSD', 'XAGUSD', 'BTCUSD', 'ETHUSD', 'NAS100', 'US30', 'XTIUSD',
];

const REPORT_PATH = path.join(__dirname, 'multi-strat-report.json');
const PROGRESS_PATH = path.join(__dirname, 'multi-strat-progress.log');

function readRefresh() {
  const data = fs.readFileSync(path.join(__dirname, '..', 'data', 'users.db'), 'utf8');
  const lines = data.split('\n').filter(Boolean);
  let latest = null;
  for (const ln of lines) { try { const o = JSON.parse(ln); if (o._id === 'IFjeGA2SdThy5lDB') latest = o; } catch (_) {} }
  return latest?.refreshToken;
}

let accessToken = null;
let refreshToken = readRefresh();

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(PROGRESS_PATH, line + '\n'); } catch (_) {}
}

function request(method, urlPath, body, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
      headers: { 'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let chunks = ''; res.on('data', (c) => chunks += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : {} }); }
        catch (_) { resolve({ status: res.statusCode, body: { rawText: chunks } }); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    if (data) req.write(data); req.end();
  });
}

async function refreshAccess() {
  const r = await request('POST', '/api/auth/refresh-token', { refreshToken });
  if (r.status === 200 && r.body?.data?.accessToken) {
    accessToken = r.body.data.accessToken;
    if (r.body.data.refreshToken) refreshToken = r.body.data.refreshToken;
    return true;
  }
  return false;
}

async function authed(method, p, b, t) {
  let r = await request(method, p, b, t);
  if (r.status === 401) { await refreshAccess(); r = await request(method, p, b, t); }
  return r;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureInstance(strategy, symbol) {
  const r = await authed('PUT', `/api/strategy-instances/${strategy}/${symbol}`, { parameters: {}, enabled: false });
  return r.status === 200;
}

async function waitIdle(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await authed('GET', '/api/optimizer/progress');
    if (r.status === 200 && !r.body?.data?.running) return true;
    await sleep(2000);
  }
  return false;
}

async function runOpt({ strategy, symbol, startDate, endDate }) {
  await waitIdle();
  const r = await authed('POST', '/api/optimizer/run', {
    symbol, strategyType: strategy, startDate, endDate,
    initialBalance: INITIAL_BALANCE, optimizeFor: OPTIMIZE_FOR,
  });
  if (r.status !== 200) return { error: `start ${r.status}: ${JSON.stringify(r.body).slice(0,200)}` };

  await sleep(2000);
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const p = await authed('GET', '/api/optimizer/progress');
    if (p.status === 200 && !p.body?.data?.running) break;
    await sleep(3000);
  }
  const result = await authed('GET', '/api/optimizer/result');
  if (result.status !== 200) return { error: `result ${result.status}` };
  return { best: result.body?.data?.bestResult || null, totalCombos: result.body?.data?.totalCombos };
}

async function runBacktest({ strategy, symbol, startDate, endDate, parameters }) {
  const r = await authed('POST', '/api/backtest/run', {
    symbol, strategyType: strategy, startDate, endDate,
    initialBalance: INITIAL_BALANCE, parameters,
  });
  if (r.status !== 200) return { error: `bt ${r.status}: ${JSON.stringify(r.body).slice(0,200)}` };
  return { summary: r.body?.data?.summary };
}

function months(s, e) { return ((new Date(e) - new Date(s)) / 86400000) / 30.4375; }

function summarize(s, startStr, endStr) {
  if (!s) return null;
  const m = months(startStr, endStr);
  const trades = s.totalTrades ?? 0;
  const pf = s.profitFactor ?? 0;
  const ret = s.returnPercent ?? 0;
  const wr = (s.winRate ?? 0) * 100;
  const dd = s.maxDrawdownPercent ?? 0;
  const sharpe = s.sharpeRatio ?? 0;
  return { trades, pf, ret, monthlyReturn: m > 0 ? ret / m : ret, wr, dd, sharpe, perMonth: m > 0 ? trades / m : 0 };
}

function gateIs(m) {
  if (!m) return { pass: false, reasons: ['no metrics'] };
  const r = [];
  if (m.trades < 30) r.push(`IS trades=${m.trades}<30`);
  if (m.pf < 1.3) r.push(`IS PF=${m.pf.toFixed(2)}<1.3`);
  if (m.monthlyReturn < 2.0) r.push(`IS mRet=${m.monthlyReturn.toFixed(1)}%<2.0%`);
  if (m.dd > 25) r.push(`IS DD=${m.dd.toFixed(1)}%>25%`);
  if (m.wr < 50) r.push(`IS WR=${m.wr.toFixed(1)}%<50%`);
  return { pass: r.length === 0, reasons: r };
}
function gateOos(m) {
  if (!m) return { pass: false, reasons: ['no metrics'] };
  const r = [];
  if (m.trades < 6) r.push(`OOS trades=${m.trades}<6`);
  if (m.pf < 1.1) r.push(`OOS PF=${m.pf.toFixed(2)}<1.1`);
  if (m.wr < 45) r.push(`OOS WR=${m.wr.toFixed(1)}%<45%`);
  if (m.dd > 30) r.push(`OOS DD=${m.dd.toFixed(1)}%>30%`);
  return { pass: r.length === 0, reasons: r };
}

async function applyDecision({ strategy, symbol, decision, parameters }) {
  const body = decision === 'enable_with_params'
    ? { parameters, enabled: true }
    : { enabled: false };
  const r = await authed('PUT', `/api/strategy-instances/${strategy}/${symbol}`, body);
  return r.status === 200;
}

// Sync the matrix once at the end. enabledByStrategy is { strategyName: Set<symbol> }.
// Existing strategies not in enabledByStrategy keep their current symbol assignments.
async function syncMatrix(enabledByStrategy) {
  const symbolsR = await authed('GET', '/api/strategies/assignments');
  const allSymbols = symbolsR.body?.data?.symbols || [];
  const matrixR = await authed('GET', '/api/strategies');
  const allStrategies = matrixR.body?.data || [];
  const ourStrategies = new Set(Object.keys(enabledByStrategy));
  const assignmentsBySymbol = {};
  for (const sym of allSymbols) {
    assignmentsBySymbol[sym] = [];
    for (const s of allStrategies) {
      if (ourStrategies.has(s.name)) continue;
      if ((s.symbols || []).includes(sym)) assignmentsBySymbol[sym].push(s.name);
    }
  }
  for (const [sName, set] of Object.entries(enabledByStrategy)) {
    for (const sym of set) {
      if (!assignmentsBySymbol[sym]) assignmentsBySymbol[sym] = [];
      if (!assignmentsBySymbol[sym].includes(sName)) assignmentsBySymbol[sym].push(sName);
    }
  }
  const r = await authed('PUT', '/api/strategies/assignments', { assignmentsBySymbol });
  return r.status === 200;
}

(async function main() {
  fs.writeFileSync(PROGRESS_PATH, '');
  log('=== multi-strategy walk-forward start ===');
  log(`Strategies: ${STRATEGIES.join(', ')}`);
  log(`Symbols: ${SYMBOLS.join(', ')}`);
  log(`Period IS=${FULL_START}..${FULL_END}  OOS=${OOS_START}..${OOS_END}  balance=$${INITIAL_BALANCE}`);
  await refreshAccess();

  const report = {
    startedAt: new Date().toISOString(),
    strategies: STRATEGIES,
    period: { full: { start: FULL_START, end: FULL_END }, oos: { start: OOS_START, end: OOS_END } },
    initialBalance: INITIAL_BALANCE,
    items: [],
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  const enabledByStrategy = Object.fromEntries(STRATEGIES.map((s) => [s, []]));

  for (const strategy of STRATEGIES) {
    log(`\n════════ STRATEGY: ${strategy} ════════`);
    for (const symbol of SYMBOLS) {
      log(`\n──── ${strategy} / ${symbol} ────`);
      const item = { strategy, symbol, status: 'pending' };
      try {
        await ensureInstance(strategy, symbol);
        log(`  IS optimizing ${FULL_START}..${FULL_END}`);
        const opt = await runOpt({ strategy, symbol, startDate: FULL_START, endDate: FULL_END });
        if (opt.error || !opt.best) {
          item.status = 'opt_failed'; item.error = opt.error || 'no best';
          item.decision = 'disable'; item.decisionApplied = await applyDecision({ strategy, symbol, decision: 'disable' });
          log(`  ↳ opt failed: ${item.error}`);
          report.items.push(item); fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
          continue;
        }
        const params = opt.best.parameters || {};
        const isM = summarize(opt.best.summary, FULL_START, FULL_END);
        const isG = gateIs(isM);
        log(`  IS: trades=${isM.trades}(${isM.perMonth.toFixed(1)}/mo) PF=${isM.pf.toFixed(2)} mRet=${isM.monthlyReturn.toFixed(1)}% WR=${isM.wr.toFixed(1)}% DD=${isM.dd.toFixed(1)}% sharpe=${isM.sharpe.toFixed(2)} combos=${opt.totalCombos}`);
        log(`  IS params: ${JSON.stringify(params)}`);
        item.is = { metrics: isM, gate: isG, params, totalCombos: opt.totalCombos };

        if (!isG.pass) {
          item.status = 'is_fail'; item.decision = 'disable';
          item.decisionApplied = await applyDecision({ strategy, symbol, decision: 'disable' });
          log(`  ↳ DISABLE — IS fail: ${isG.reasons.join(', ')}`);
          report.items.push(item); fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
          continue;
        }

        log(`  OOS validating ${OOS_START}..${OOS_END}`);
        const bt = await runBacktest({ strategy, symbol, startDate: OOS_START, endDate: OOS_END, parameters: params });
        if (bt.error || !bt.summary) {
          item.status = 'oos_failed'; item.error = bt.error;
          item.decision = 'disable'; item.decisionApplied = await applyDecision({ strategy, symbol, decision: 'disable' });
          log(`  ↳ OOS failed: ${bt.error}`);
          report.items.push(item); fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
          continue;
        }
        const oosM = summarize(bt.summary, OOS_START, OOS_END);
        const oosG = gateOos(oosM);
        log(`  OOS: trades=${oosM.trades}(${oosM.perMonth.toFixed(1)}/mo) PF=${oosM.pf.toFixed(2)} mRet=${oosM.monthlyReturn.toFixed(1)}% WR=${oosM.wr.toFixed(1)}% DD=${oosM.dd.toFixed(1)}%`);
        item.oos = { metrics: oosM, gate: oosG };

        if (!oosG.pass) {
          item.status = 'oos_fail'; item.decision = 'disable';
          item.decisionApplied = await applyDecision({ strategy, symbol, decision: 'disable' });
          log(`  ↳ DISABLE — OOS fail: ${oosG.reasons.join(', ')}`);
        } else {
          item.status = 'pass'; item.decision = 'enable_with_params';
          item.decisionApplied = await applyDecision({ strategy, symbol, decision: 'enable_with_params', parameters: params });
          enabledByStrategy[strategy].push(symbol);
          log(`  ↳ ENABLE — both gates passed (applied=${item.decisionApplied})`);
        }
        report.items.push(item); fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
      } catch (err) {
        item.status = 'exception'; item.error = String(err?.message || err);
        log(`  EXCEPTION: ${item.error}`);
        report.items.push(item); fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
      }
    }
  }

  log(`\nSyncing matrix:`);
  for (const [s, syms] of Object.entries(enabledByStrategy)) {
    log(`  ${s}: ${syms.length ? syms.join(', ') : '(none)'}`);
  }
  const synced = await syncMatrix(enabledByStrategy);
  log(`  sync result: ${synced}`);

  report.finishedAt = new Date().toISOString();
  report.enabledByStrategy = enabledByStrategy;
  report.syncOk = synced;
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  log(`\n=== final summary ===`);
  for (const it of report.items) {
    const tag = it.status === 'pass' ? 'PASS' : (it.status === 'is_fail' ? 'IS_FAIL' : it.status.toUpperCase());
    if (it.is) {
      log(`  ${tag.padEnd(9)} ${it.strategy.padEnd(18)} ${it.symbol.padEnd(8)} IS=${it.is.metrics.trades}t/${it.is.metrics.monthlyReturn.toFixed(1)}%mo PF=${it.is.metrics.pf.toFixed(2)} WR=${it.is.metrics.wr.toFixed(1)}% DD=${it.is.metrics.dd.toFixed(1)}%${it.oos ? `  OOS=${it.oos.metrics.trades}t/${it.oos.metrics.monthlyReturn.toFixed(1)}%mo PF=${it.oos.metrics.pf.toFixed(2)} WR=${it.oos.metrics.wr.toFixed(1)}%` : ''}`);
    } else {
      log(`  ${tag.padEnd(9)} ${it.strategy.padEnd(18)} ${it.symbol.padEnd(8)} (no metrics) ${it.error || ''}`);
    }
  }
})().catch((err) => { log(`FATAL ${err?.stack || err}`); process.exit(1); });
