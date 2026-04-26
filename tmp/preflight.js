// Preflight: MT5 bridge connectivity + symbol mapping + strategy matrix + scheduler tick.
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

(async () => {
  await refreshAccess();
  const out = {};

  // 1. Trading status (covers MT5 connectivity)
  const status = await authed('GET', '/api/trading/status');
  out.tradingStatus = { httpStatus: status.status, body: status.body };
  console.log('=== /api/trading/status ===');
  console.log(JSON.stringify(status.body, null, 2));

  // 2. Symbol mapping
  const syms = await authed('GET', '/api/trading/symbols');
  out.symbols = { httpStatus: syms.status, body: syms.body };
  console.log('\n=== /api/trading/symbols (count) ===');
  const list = syms.body?.data?.symbols || syms.body?.data || [];
  console.log(`count=${Array.isArray(list) ? list.length : 'n/a'}`);
  if (Array.isArray(list) && list.length) {
    for (const s of list) console.log(`  ${JSON.stringify(s)}`);
  } else {
    console.log(JSON.stringify(syms.body, null, 2).slice(0, 1500));
  }

  // 3. Strategy matrix
  const strats = await authed('GET', '/api/strategies');
  out.strategies = { httpStatus: strats.status, body: strats.body };
  const list2 = strats.body?.data || [];
  console.log('\n=== /api/strategies (matrix) ===');
  for (const s of list2) {
    console.log(`  ${s.name.padEnd(20)} symbols=${(s.symbols || []).join(', ')}`);
  }

  // 4. Strategy instances (per-cell parameters)
  const inst = await authed('GET', '/api/strategy-instances');
  out.instances = { httpStatus: inst.status, body: inst.body };
  const ilist = inst.body?.data || [];
  const enabled = ilist.filter((x) => x.enabled);
  console.log(`\n=== /api/strategy-instances enabled count=${enabled.length} (total=${ilist.length}) ===`);
  for (const x of enabled) {
    console.log(`  ${x.strategyName?.padEnd(20)} ${x.symbol?.padEnd(10)} enabled=${x.enabled}`);
  }

  fs.writeFileSync(path.join(__dirname, 'preflight-result.json'), JSON.stringify(out, null, 2));
  console.log('\nSaved tmp/preflight-result.json');
})().catch((e) => { console.error('ERR', e); process.exit(1); });
