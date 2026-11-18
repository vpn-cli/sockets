#!/usr/bin/env node
/**
 * READ-ONLY Production Test Data Audit Script
 *
 * Inspects `matches` and `commentary` inside a Postgres READ ONLY transaction
 * and reports suspected test/benchmark rows (counts and IDs ONLY).
 *
 * Usage:
 *   node scripts/audit-prod-test-data.mjs
 *   node scripts/audit-prod-test-data.mjs --since 2026-11-16T00:00:00Z --until 2026-11-19T00:00:00Z
 *   node scripts/audit-prod-test-data.mjs --json
 */
import {
  pg,
  loadDatabaseUrl,
  parseCliArgs,
  findSuspectedTestData,
} from './lib/prod-test-data-rules.mjs';

async function main() {
  const opts = parseCliArgs();
  const { dbUrl, host, database } = loadDatabaseUrl();

  const pool = new pg.Pool({ connectionString: dbUrl });
  const client = await pool.connect();

  try {
    // Enforce read-only at the Postgres transaction level
    await client.query('BEGIN TRANSACTION READ ONLY');

    const report = await findSuspectedTestData(client, {
      since: opts.since,
      until: opts.until,
      matchIds: opts.matchIds,
    });

    await client.query('ROLLBACK');

    const output = {
      mode: 'READ_ONLY_AUDIT',
      host,
      database,
      filters: {
        since: opts.since,
        until: opts.until,
        matchIds: opts.matchIds,
      },
      ...report,
    };

    if (opts.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    console.log('======================================================');
    console.log('READ-ONLY AUDIT: Suspected Test/Benchmark Data');
    console.log('======================================================');
    console.log(`Target Host     : ${host}`);
    console.log(`Target Database : ${database}`);
    if (opts.since || opts.until) {
      console.log(`Time Window     : ${opts.since || '(any)'} -> ${opts.until || '(any)'}`);
    }
    console.log(`Total Rows      : matches=${report.totals.matches}, commentary=${report.totals.commentary}`);
    console.log('');

    console.log(`[matches] Suspected test rows count: ${report.suspectedMatches.count}`);
    if (Object.keys(report.suspectedMatches.byReason).length > 0) {
      console.log('  Breakdown by rule:', JSON.stringify(report.suspectedMatches.byReason));
    }
    console.log(`  IDs: [${report.suspectedMatches.ids.join(', ')}]`);
    console.log('');

    console.log(`[commentary] Suspected test rows count: ${report.suspectedCommentary.count}`);
    if (Object.keys(report.suspectedCommentary.byReason).length > 0) {
      console.log('  Breakdown by rule:', JSON.stringify(report.suspectedCommentary.byReason));
    }
    console.log(`  IDs: [${report.suspectedCommentary.ids.join(', ')}]`);

    if (report.suspectedCommentary.otherMatchIdsWithTestCommentary.length > 0) {
      console.log(
        `  Non-test match IDs referenced by suspected commentary: [${report.suspectedCommentary.otherMatchIdsWithTestCommentary.join(', ')}]`
      );
    }

    if (report.windowSummary) {
      console.log('');
      console.log(
        `[time-window] All rows created in window (${opts.since || '*'} .. ${opts.until || '*'}):`
      );
      console.log(
        `  matches count=${report.windowSummary.matchesCount}, IDs: [${report.windowSummary.matchIds.join(', ')}]`
      );
      console.log(
        `  commentary count=${report.windowSummary.commentaryCount}, IDs: [${report.windowSummary.commentaryIds.join(', ')}]`
      );
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[AUDIT ERROR]', err.message);
  process.exit(1);
});
