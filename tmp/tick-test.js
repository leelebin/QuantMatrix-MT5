// Tick-test: cleanup stray SPX500 instances, start scheduler, observe ~35s, stop.
const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = 'http://localhost:5000';

function readRefresh() {
  const data = fs.readFileSync(path.join(__dirname, '..', 'data', 'users.db'), 'utf8');
  let latest = null;
  for (const ln of data.split('\n').filter(Boolean)) {
    try { const o = JSON.parse(ln); if (o._id === 'IFjeGA2SdThy5lDB') latest = o; } catch (_) {}
  }
  return latest?.refreshToken;
}

let accessToken = null;
let refreshToken = readRefresh();

function request(method, urlPath, body, timeoutMs = 60000) {
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

(async () => {
  await refreshAccess();

  // 0. Verify balance
  const acct = await authed('GET', '/api/trading/status');
  console.log(`Balance: $${acct.body?.data?.risk?.balance}, Equity: $${acct.body?.data?.risk?.equity}`);
  console.log(`tradingEnabled before: ${acct.body?.data?.tradingEnabled}, loop: ${acct.body?.data?.tradingLoopActive}`);

  // 1. Clean stray SPX500 instances (matrix doesn't include them)
  console.log('\n=== cleanup stray SPX500 instances ===');
  for (const strat of ['Breakout', 'MultiTimeframe']) {
    const r = await authed('PUT', `/api/strategy-instances/${strat}/SPX500`, { enabled: false });
    console.log(`  ${strat}/SPX500 disable: ${r.status}`);
  }

  // 2. Start PAPER trading (demo route)
  console.log('\n=== POST /api/paper-trading/start ===');
  const start = await authed('POST', '/api/paper-trading/start', {});
  console.log(`  status=${start.status} body=${JSON.stringify(start.body).slice(0,400)}`);

  // 3. Observe 40s, polling paper-trading status every 8s
  for (let i = 0; i < 5; i++) {
    await sleep(8000);
    const s = await authed('GET', '/api/paper-trading/status');
    const d = s.body?.data || {};
    const buckets = (d.signalScanBuckets || d.scanBuckets || []).map((b) => `${b.cadenceLabel || b.timeframe}:lastScan=${b.lastScanAt ? new Date(b.lastScanAt).toISOString().slice(11,19) : '–'} running=${b.running}`);
    console.log(`[t+${(i+1)*8}s] running=${d.running} positions=${d.openPositions ?? d.positionsCount ?? '?'}  ${buckets.join(' | ')}`);
  }

  // 4. Show recent signals + positions
  const finalStat = await authed('GET', '/api/paper-trading/status');
  const positions = await authed('GET', '/api/paper-trading/positions');
  console.log(`\n=== status snapshot ===`);
  console.log(JSON.stringify(finalStat.body?.data, null, 2).slice(0, 2000));
  console.log(`\n=== open paper positions (n=${(positions.body?.data || []).length}) ===`);
  for (const p of (positions.body?.data || []).slice(0, 10)) console.log(`  ${JSON.stringify(p)}`);

  // 5. Stop
  console.log('\n=== POST /api/paper-trading/stop ===');
  const stop = await authed('POST', '/api/paper-trading/stop', {});
  console.log(`  status=${stop.status} body=${JSON.stringify(stop.body).slice(0,200)}`);

  // 6. Verify stopped
  const after = await authed('GET', '/api/paper-trading/status');
  console.log(`After stop: running=${after.body?.data?.running}`);
  const final = finalStat;

  // Save full snapshot
  fs.writeFileSync(path.join(__dirname, 'tick-test-result.json'), JSON.stringify({ start: start.body, finalStatus: final.body, stop: stop.body }, null, 2));
  console.log('Saved tmp/tick-test-result.json');
})().catch((e) => { console.error('ERR', e); process.exit(1); });
