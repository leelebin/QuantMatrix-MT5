const fs = require('fs');
const path = require('path');
const { DATA_GROUP_DIRS, tradesDb, tradeLogDb } = require('../config/db');

const WEEKLY_TRADES_DIR = path.join(DATA_GROUP_DIRS.history, 'weekly-trades');

const SOURCES = Object.freeze({
  live: {
    label: 'Live trades',
    prefix: 'live',
    db: tradesDb,
  },
  paper: {
    label: 'Paper trades',
    prefix: 'paper',
    db: tradeLogDb,
  },
});

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function parseDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getReviewDate(trade) {
  return parseDate(trade.closedAt)
    || parseDate(trade.openedAt)
    || parseDate(trade.brokerSyncedAt)
    || null;
}

function getIsoWeek(date) {
  const utcDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - day);

  const year = utcDate.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((utcDate - yearStart) / 86400000) + 1) / 7);

  return `${year}-W${String(week).padStart(2, '0')}`;
}

function normalizeScope(scope = 'all') {
  const normalized = String(scope || 'all').trim().toLowerCase();
  if (normalized === 'all') return Object.keys(SOURCES);
  if (!SOURCES[normalized]) {
    const error = new Error(`Unknown weekly review export scope: ${scope}`);
    error.statusCode = 400;
    throw error;
  }
  return [normalized];
}

function clearGeneratedFiles(outputDir, sourceNames) {
  if (!fs.existsSync(outputDir)) return;
  const prefixes = sourceNames.map((name) => SOURCES[name].prefix);
  const generatedPattern = new RegExp(`^(${prefixes.join('|')})-\\d{4}-W\\d{2}\\.jsonl$`);

  for (const entry of fs.readdirSync(outputDir)) {
    if (generatedPattern.test(entry)) {
      fs.unlinkSync(path.join(outputDir, entry));
    }
  }
}

function toReviewRecord(trade, sourceName, reviewDate, week) {
  return {
    reviewSource: sourceName,
    reviewWeek: week,
    reviewDate: reviewDate.toISOString(),
    originalId: trade._id || null,
    ...trade,
  };
}

function summarizeRecords(records) {
  let pnl = 0;
  let wins = 0;
  let losses = 0;
  let closed = 0;
  let open = 0;

  for (const record of records) {
    const status = String(record.status || '').toUpperCase();
    if (status === 'OPEN') open += 1;
    if (status === 'CLOSED' || record.closedAt) closed += 1;

    const profitLoss = Number(record.profitLoss);
    if (Number.isFinite(profitLoss)) {
      pnl += profitLoss;
      if (profitLoss > 0) wins += 1;
      if (profitLoss < 0) losses += 1;
    }
  }

  return {
    records: records.length,
    closed,
    open,
    wins,
    losses,
    pnl: Math.round(pnl * 100) / 100,
  };
}

function writeJsonl(filePath, records) {
  const body = records.map((record) => JSON.stringify(record)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

async function exportSource(sourceName, outputDir) {
  const source = SOURCES[sourceName];
  const rows = await source.db.find({});
  const grouped = new Map();
  let skipped = 0;

  for (const row of rows) {
    const reviewDate = getReviewDate(row);
    if (!reviewDate) {
      skipped += 1;
      continue;
    }

    const week = getIsoWeek(reviewDate);
    if (!grouped.has(week)) grouped.set(week, []);
    grouped.get(week).push(toReviewRecord(row, sourceName, reviewDate, week));
  }

  const weeks = [];
  for (const [week, records] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    records.sort((left, right) => {
      const leftTime = parseDate(left.reviewDate)?.getTime() || 0;
      const rightTime = parseDate(right.reviewDate)?.getTime() || 0;
      return leftTime - rightTime;
    });

    const filename = `${source.prefix}-${week}.jsonl`;
    const filePath = path.join(outputDir, filename);
    writeJsonl(filePath, records);

    weeks.push({
      week,
      filename,
      path: filePath,
      ...summarizeRecords(records),
    });
  }

  const totals = weeks.reduce((acc, week) => ({
    records: acc.records + week.records,
    closed: acc.closed + week.closed,
    open: acc.open + week.open,
    wins: acc.wins + week.wins,
    losses: acc.losses + week.losses,
    pnl: Math.round((acc.pnl + week.pnl) * 100) / 100,
  }), {
    records: 0,
    closed: 0,
    open: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
  });

  return {
    source: sourceName,
    label: source.label,
    skipped,
    weeks,
    totals,
  };
}

async function exportWeeklyTradeReviews(options = {}) {
  const sourceNames = normalizeScope(options.scope || 'all');
  const outputDir = options.outputDir || WEEKLY_TRADES_DIR;
  ensureDir(outputDir);

  if (options.rebuild !== false) {
    clearGeneratedFiles(outputDir, sourceNames);
  }

  const sources = [];
  for (const sourceName of sourceNames) {
    sources.push(await exportSource(sourceName, outputDir));
  }

  const totalRecords = sources.reduce((sum, source) => sum + source.totals.records, 0);
  const summary = {
    generatedAt: new Date().toISOString(),
    outputDir,
    rebuild: options.rebuild !== false,
    totalRecords,
    sources,
  };

  fs.writeFileSync(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return summary;
}

module.exports = {
  WEEKLY_TRADES_DIR,
  exportWeeklyTradeReviews,
  getIsoWeek,
  getReviewDate,
  normalizeScope,
};
