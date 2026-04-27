// Smoke-test the backtest cost model end-to-end. Generates 4000 synthetic
// EURUSD 15m candles, runs TrendFollowing twice — once with no cost model
// and once with a realistic broker cost model — and prints the summary
// + per-trade cost breakdown so you can see profit being eaten by costs.

require('dotenv').config();
const path = require('path');

const Datastore = require('nedb-promises');
const original = Datastore.create;
Datastore.create = function patchedCreate(opts = {}) {
  return original.call(this, { inMemoryOnly: true });
};

const backtestEngine = require(path.resolve(__dirname, '..', 'src', 'services', 'backtestEngine'));

function buildEURUSDCandles({ start = '2026-01-01T00:00:00.000Z', count = 4000, basePrice = 1.10 }) {
  const candles = [];
  let price = basePrice;
  let t = new Date(start).getTime();
  const stepMs = 15 * 60 * 1000;
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

  const baseParams = {
    symbol: 'EURUSD',
    strategyType: 'TrendFollowing',
    timeframe: '15m',
    candles,
    initialBalance: 500,
    spreadPips: 1.2,
    slippagePips: 0.5,
    parameterPreset: 'default',
  };

  const noCosts = await backtestEngine.simulate(baseParams);

  const withCosts = await backtestEngine.simulate({
    ...baseParams,
    costModel: {
      commissionPerLot: 7,         // $7/lot per side
      commissionPerSide: true,     // entry AND exit
      swapLongPerLotPerDay: -1.5,  // small overnight long debit
      swapShortPerLotPerDay: -2.5, // bigger short debit
      fixedFeePerTrade: -0.10,     // tiny per-trade venue fee
    },
  });

  console.log('\n=== No cost model ===');
  console.log({
    trades: noCosts.trades.length,
    grossProfitMoney: noCosts.summary.grossProfitMoney,
    grossLossMoney: noCosts.summary.grossLossMoney,
    netProfitMoney: noCosts.summary.netProfitMoney,
    profitFactor: noCosts.summary.profitFactor,
    totalCommission: noCosts.summary.totalCommission,
    totalSwap: noCosts.summary.totalSwap,
    totalFees: noCosts.summary.totalFees,
    totalTradingCosts: noCosts.summary.totalTradingCosts,
    grossNetDifference: noCosts.summary.grossNetDifference,
  });

  console.log('\n=== With cost model (per-side $7 commission, swap, $0.10 fee) ===');
  console.log({
    trades: withCosts.trades.length,
    grossProfitMoney: withCosts.summary.grossProfitMoney,
    grossLossMoney: withCosts.summary.grossLossMoney,
    netProfitMoney: withCosts.summary.netProfitMoney,
    profitFactor: withCosts.summary.profitFactor,
    totalCommission: withCosts.summary.totalCommission,
    totalSwap: withCosts.summary.totalSwap,
    totalFees: withCosts.summary.totalFees,
    totalTradingCosts: withCosts.summary.totalTradingCosts,
    grossNetDifference: withCosts.summary.grossNetDifference,
    costModelUsed: withCosts.costModelUsed,
  });

  console.log('\nFirst 3 trades with costs:');
  for (const t of withCosts.trades.slice(0, 3)) {
    console.log({
      id: t.id, type: t.type,
      lotSize: t.lotSize,
      grossProfitLoss: t.grossProfitLoss,
      commission: t.commission,
      swap: t.swap,
      fee: t.fee,
      profitLoss: t.profitLoss,
      overnightDays: t.overnightDays,
      costModelUsed: t.costModelUsed,
    });
  }

  // Sanity: each trade's profitLoss == gross + commission + swap + fee
  const drift = withCosts.trades.filter((t) => Math.abs(
    t.profitLoss - (t.grossProfitLoss + t.commission + t.swap + t.fee)
  ) > 0.011);
  console.log(`\nTrades whose net != gross + costs (should be 0): ${drift.length}`);

  // Sanity: total trading costs should equal grossProfitLoss totals - net
  const grossNetExpected = parseFloat(
    (withCosts.summary.grossProfitMoney - withCosts.summary.grossLossMoney - withCosts.summary.netProfitMoney).toFixed(2)
  );
  console.log(`grossNetDifference reported: ${withCosts.summary.grossNetDifference}, expected: ${grossNetExpected}`);
})().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
