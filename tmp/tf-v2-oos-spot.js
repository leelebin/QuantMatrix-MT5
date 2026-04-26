// OOS spot-check for high-IS-return / high-DD candidates that missed the gate.
const fs = require('fs');
const path = require('path');
const http = require('http');

function readRefresh() {
  const data = fs.readFileSync(path.join(__dirname, '..', 'data', 'users.db'), 'utf8');
  const lines = data.split('\n').filter(Boolean);
  let latest = null;
  for (const ln of lines) { try { const o = JSON.parse(ln); if (o._id === 'IFjeGA2SdThy5lDB') latest = o; } catch (_) {} }
  return latest?.refreshToken;
}

let accessToken = null;
let refreshToken = readRefresh();

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL('http://localhost:5000' + urlPath);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
      headers: { 'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let chunks = ''; res.on('data', (c) => chunks += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : {} }); } catch (_) { resolve({ status: res.statusCode, body: {} }); } });
    });
    req.on('error', reject);
    if (data) req.write(data); req.end();
  });
}

async function refreshAccess() {
  const r = await request('POST', '/api/auth/refresh-token', { refreshToken });
  if (r.status === 200) { accessToken = r.body.data.accessToken; if (r.body.data.refreshToken) refreshToken = r.body.data.refreshToken; return true; }
  return false;
}

const cases = [
  { symbol: 'XAGUSD', params: { breakout_lookback: 3, pullback_atr_max: 1.4, rsi_buy_min: 56, slMultiplier: 2, tpMultiplier: 1.5, riskPercent: 0.02 } },
  { symbol: 'XAUUSD', params: { breakout_lookback: 4, pullback_atr_max: 1.05, rsi_buy_min: 50, slMultiplier: 2, tpMultiplier: 3, riskPercent: 0.02 } },
];

(async () => {
  await refreshAccess();
  for (const c of cases) {
    const r = await request('POST', '/api/backtest/run', {
      symbol: c.symbol, strategyType: 'TrendFollowing',
      startDate: '2026-02-15', endDate: '2026-04-25',
      initialBalance: 500, parameters: c.params,
    });
    if (r.status !== 200) { console.log(c.symbol, 'FAIL', r.status, JSON.stringify(r.body).slice(0,200)); continue; }
    const s = r.body?.data?.summary || {};
    const m = ((new Date('2026-04-25') - new Date('2026-02-15')) / 86400000) / 30.4375;
    console.log(`${c.symbol}: trades=${s.totalTrades} PF=${(s.profitFactor||0).toFixed(2)} ret=${(s.returnPercent||0).toFixed(1)}% (${(((s.returnPercent||0)/m)).toFixed(1)}%/mo) WR=${((s.winRate||0)*100).toFixed(1)}% DD=${(s.maxDrawdownPercent||0).toFixed(1)}%`);
  }
})();
