// Re-evaluate gates using correct field paths and apply enable/disable decisions.

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
        'Authorization': accessToken ? `Bearer ${accessToken}` : '',
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

async function refreshToken() { return true; }

function evalGate(s) {
  if (!s) return { pass: false, reasons: ['no summary'], metrics: {} };
  const trades = s.totalTrades ?? 0;
  const pf = s.profitFactor ?? 0;
  const ret = s.returnPercent ?? 0;
  const wr = s.winRate ?? 0;
  const dd = s.maxDrawdownPercent ?? 0;
  const sharpe = s.sharpeRatio ?? 0;

  const reasons = [];
  if (trades < 25) reasons.push(`trades=${trades}<25`);
  if (pf < 1.25) reasons.push(`PF=${pf.toFixed(2)}<1.25`);
  if (ret < 3) reasons.push(`return=${ret.toFixed(1)}%<3%`);
  if (dd > 35) reasons.push(`maxDD=${dd.toFixed(1)}%>35%`);
  if (wr < 0.4) reasons.push(`WR=${(wr * 100).toFixed(1)}%<40%`);
  if (sharpe < 0.6) reasons.push(`sharpe=${sharpe.toFixed(2)}<0.6`);

  return {
    pass: reasons.length === 0,
    reasons,
    metrics: { trades, pf, ret, wr: wr * 100, dd, sharpe },
  };
}

(async function main() {
  await refreshToken();
  const reportPath = path.join(__dirname, 'optimize-report.json');
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

  const decisions = [];

  for (const item of report.items) {
    const summary = item.best?.summary;
    const params = item.best?.parameters || {};
    const gate = evalGate(summary);
    const decision = gate.pass ? 'enable_with_params' : 'disable';

    let applied = false;
    let body = decision === 'enable_with_params'
      ? { parameters: params, enabled: true }
      : { enabled: false };
    const r = await request('PUT', `/api/strategy-instances/${item.strategy}/${item.symbol}`, body);
    applied = r.status === 200;

    decisions.push({
      strategy: item.strategy,
      symbol: item.symbol,
      decision,
      applied,
      gateReasons: gate.reasons,
      metrics: gate.metrics,
      parameters: decision === 'enable_with_params' ? params : null,
    });

    console.log(`${item.strategy}/${item.symbol}: ${decision} (${applied ? 'applied' : 'FAILED'}) reasons=[${gate.reasons.join(',')}] m=${JSON.stringify(gate.metrics)}`);
  }

  const decisionPath = path.join(__dirname, 'final-decisions.json');
  fs.writeFileSync(decisionPath, JSON.stringify({
    summary: {
      total: decisions.length,
      enabled: decisions.filter(d => d.decision === 'enable_with_params').length,
      disabled: decisions.filter(d => d.decision === 'disable').length,
      appliedOk: decisions.filter(d => d.applied).length,
    },
    decisions,
  }, null, 2));
  console.log(`\nWrote ${decisionPath}`);
})().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
