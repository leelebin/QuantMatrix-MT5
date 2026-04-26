// Sync the parent Strategy table (Strategy.symbols + Strategy.enabled) with the
// per-instance enable/disable decisions written by apply-decisions.js.

const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE = 'http://localhost:5000';
let accessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IklGamVHQTJTZFRoeTVsREIiLCJpYXQiOjE3NzcxMDQ5NTQsImV4cCI6MTc3NzE5MTM1NH0.uTy1a8VwaHPbdnTd3dsJmGq3APh17HPtblH3a9zk4YY';

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
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
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

(async function main() {
  const decisions = JSON.parse(fs.readFileSync(path.join(__dirname, 'final-decisions.json'), 'utf8')).decisions;

  // Build assignmentsBySymbol from the kept (enabled) combos.
  const enabledCombos = decisions.filter(d => d.decision === 'enable_with_params');

  const assignmentsBySymbol = {};
  // Need to seed with every existing symbol so we don't accidentally leave stale entries.
  const symbolsR = await request('GET', '/api/strategies/assignments');
  const allSymbols = symbolsR.body?.data?.symbols || [];
  for (const sym of allSymbols) assignmentsBySymbol[sym] = [];

  for (const e of enabledCombos) {
    if (!assignmentsBySymbol[e.symbol]) assignmentsBySymbol[e.symbol] = [];
    assignmentsBySymbol[e.symbol].push(e.strategy);
  }

  console.log(`Sending PUT /api/strategies/assignments with ${enabledCombos.length} kept combos across ${Object.values(assignmentsBySymbol).flat().length} symbol-strategy assignments`);
  const r = await request('PUT', '/api/strategies/assignments', { assignmentsBySymbol });
  console.log(`assignments PUT -> ${r.status}`);
  if (r.status !== 200) {
    console.error('FAIL:', JSON.stringify(r.body));
    process.exit(1);
  }

  // Find strategies with 0 enabled symbols and toggle them off.
  const stratR = await request('GET', '/api/strategies');
  const strategies = stratR.body?.data || [];
  console.log(`\nStrategy table after sync:`);
  for (const s of strategies) {
    const symList = (s.symbols || []).join(',') || '(none)';
    console.log(`  ${s.name.padEnd(18)} enabled=${s.enabled} symbols=${symList}`);
  }

  // Toggle off any strategy whose symbols ended up empty (full failure).
  for (const s of strategies) {
    if ((!s.symbols || s.symbols.length === 0) && s.enabled) {
      console.log(`\nToggling OFF parent strategy ${s.name} (no symbols left)`);
      const tr = await request('PUT', `/api/strategies/${s._id}/toggle`);
      console.log(`  toggle -> ${tr.status}`);
    }
  }

  // Final verification.
  const finalR = await request('GET', '/api/strategies');
  console.log('\nFinal Strategy table:');
  for (const s of finalR.body?.data || []) {
    const symList = (s.symbols || []).join(',') || '(none)';
    console.log(`  ${s.name.padEnd(18)} enabled=${s.enabled} symbols=${symList}`);
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
