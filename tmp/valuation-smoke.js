// Smoke-test the refactored backtestEngine + instrumentValuation helper.
// Generates a synthetic 4-month 15m candle series for EURUSD and runs
// TrendFollowing through it. Prints the first few trades plus the new
// per-trade money fields to confirm the unified helper is wired in.

require('dotenv').config();
const path = require('path');

// Don't touch the real backtests db — patch nedb-promises to use an in-memory
// store so the smoke test does not pollute production data.
const Datastore = require('nedb-promises');
const original = Datastore.create;
Datastore.create = function patchedCreate(opts = {}) {
  return original.call(this, { inMemoryOnly: true });
};

const backtestEngine = require(path.resolve(__dirname, '..', 'src', 'services', 'backtestEngine'));
const valuation = require(path.resolve(__dirname, '..', 'src', 'utils', 'instrumentValuation'));

function buildEURUSDCandles({ start = '2026-01-01T00:00:00.000Z', count = 4000, basePrice = 1.10 }) {
  const candles = [];
  let price = basePrice;
  let t = new Date(start).getTime();
  const stepMs = 15 * 60 * 1000;

  // Slow drift + 200-bar wave + tiny noise → strategies can latch a trend
  for (let i = 0; i < count; i++) {
    const drift = 0.000005;
    const wave = Math.sin(i / 200) * 0.002;
    const noise = (Math.random() - 0.5) * 0.00015;
    const open = price;
    const close = open + drift + wave * 0.001 + noise;
    const high = Math.max(open, close) + Math.abs(noise) * 1.5;
    const low = Math.min(open, close) - Math.abs(noise) * 1.5;
    candles.push({
      time: new Date(t).toISOString(),
      open, high, low, close,
      volume: 1000 + Math.floor(Math.random() * 500),
    });
    price = close;
    t += stepMs;
  }
  return candles;
}

(async () => {
  const candles = buildEURUSDCandles({ count: 4000 });
  console.log(`Generated ${candles.length} synthetic 15m candles`);

  const result = await backtestEngine.simulate({
    symbol: 'EURUSD',
    strategyType: 'TrendFollowing',
    timeframe: '15m',
    candles,
    initialBalance: 500,
    spreadPips: 1.2,
    slippagePips: 0.5,
    parameterPreset: 'default',
  });

  console.log('\n=== Summary ===');
  console.log(JSON.stringify(result.summary, null, 2));

  console.log(`\nTrades: ${result.trades.length}`);
  console.log('First 3 trades (new per-trade fields):');
  for (const t of result.trades.slice(0, 3)) {
    console.log({
      id: t.id, type: t.type,
      entryPrice: t.entryPrice, exitPrice: t.exitPrice,
      lotSize: t.lotSize,
      profitPips: t.profitPips,
      grossProfitLoss: t.grossProfitLoss,
      commission: t.commission,
      swap: t.swap,
      fee: t.fee,
      profitLoss: t.profitLoss,
      plannedRiskAmount: t.plannedRiskAmount,
      realizedRMultiple: t.realizedRMultiple,
      targetRMultipleCaptured: t.targetRMultipleCaptured,
    });
  }

  // Sanity check: profitLoss == grossProfitLoss when no costs modelled
  const mismatched = result.trades.filter((t) => Math.abs(t.profitLoss - t.grossProfitLoss) > 0.01);
  console.log(`\nTrades where profitLoss ≠ grossProfitLoss (should be 0 with no cost model): ${mismatched.length}`);

  // Standalone helper sanity check
  console.log('\n=== Helper direct call sanity ===');
  const { getInstrument } = require(path.resolve(__dirname, '..', 'src', 'config', 'instruments'));
  for (const sym of ['EURUSD', 'XAUUSD', 'BTCUSD', 'NAS100', 'XTIUSD']) {
    const inst = getInstrument(sym);
    const ctx = valuation.getValuationContext(inst);
    console.log(`${sym.padEnd(8)} pipSize=${ctx.pipSize} pipValue=${ctx.pipValue} contractSize=${ctx.contractSize} tickValue=${ctx.tickValue.toFixed(4)} lotPrec=${ctx.lotPrecision} pricePrec=${ctx.pricePrecision}`);
  }
})().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
