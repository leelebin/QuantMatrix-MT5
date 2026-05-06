#!/usr/bin/env node

const dotenv = require('dotenv');

dotenv.config();

const dataSyncService = require('../src/services/dataSyncService');

const VALID_REASONS = new Set(['daily_settlement', 'manual']);

function parseArgs(argv) {
  const args = {};

  for (let index = 2; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith('--')) continue;

    const withoutPrefix = entry.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    if (equalsIndex !== -1) {
      args[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[withoutPrefix] = next;
      index += 1;
    } else {
      args[withoutPrefix] = 'true';
    }
  }

  return args;
}

function printHelp() {
  console.log([
    'Usage:',
    '  node scripts/sync-data-to-cloud.js --reason=daily_settlement',
    '  node scripts/sync-data-to-cloud.js --reason=manual',
    '',
    'Optional:',
    '  --force    Upload even when DATA_SYNC_ENABLED=false',
  ].join('\n'));
}

function parseReason(args) {
  const reason = args.reason || 'manual';
  if (!VALID_REASONS.has(reason)) {
    throw new Error(`Invalid --reason "${reason}". Expected daily_settlement or manual.`);
  }
  return reason;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) {
    printHelp();
    return;
  }

  const result = await dataSyncService.syncDataToCloud({
    reason: parseReason(args),
    force: args.force === 'true',
  });

  console.log(JSON.stringify(result, null, 2));

  if (!result.success) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    success: false,
    provider: 'rclone',
    remote: process.env.DATA_SYNC_REMOTE || 'quantmatrix-drive',
    remotePath: null,
    zipPath: null,
    manifestPath: null,
    uploadedFiles: [],
    error: {
      code: 'DATA_SYNC_FAILED',
      message: error.message,
    },
  }, null, 2));
  process.exitCode = 1;
});
