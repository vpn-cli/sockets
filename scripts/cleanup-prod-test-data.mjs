#!/usr/bin/env node
/**
 * Production Test Data Cleanup Script (DRY-RUN BY DEFAULT)
 *
 * Uses the same detection rules as scripts/audit-prod-test-data.mjs.
 * - Default mode (no flags): DRY-RUN inside a READ ONLY transaction. Prints counts & IDs only; makes ZERO changes.
 * - Execute mode (--execute): Deletes suspected commentary first, then suspected matches inside a single transaction.
 *
 * Usage:
 *   node scripts/cleanup-prod-test-data.mjs                      # Dry-run (safe, read-only)
 *   node scripts/cleanup-prod-test-data.mjs --since ... --until ...
 *   node scripts/cleanup-prod-test-data.mjs --match-ids 888,777  # Restrict scope to specific match IDs
 *   node scripts/cleanup-prod-test-data.mjs --execute            # Actually delete suspected test rows
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
    if (!opts.execute) {
      // Dry-run is strictly READ ONLY at the Postgres level
      await client.query('BEGIN TRANSACTION READ ONLY');
      const report = await findSuspectedTestData(client, {
        since: opts.since,
        until: opts.until,
        matchIds: opts.matchIds,
      });
      await client.query('ROLLBACK');

      const output = {
        mode: 'DRY_RUN',
        host,
        database,
        wouldDelete: {
          commentaryCount: report.suspectedCommentary.count,
          commentaryIds: report.suspectedCommentary.ids,
          matchesCount: report.suspectedMatches.count,
          matchIds: report.suspectedMatches.ids,
        },
        breakdown: {
          matchesByReason: report.suspectedMatches.byReason,
          commentaryByReason: report.suspectedCommentary.byReason,
        },
      };

      if (opts.json) {
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      console.log('======================================================');
      console.log('DRY-RUN CLEANUP (NO ROWS DELETED - READ ONLY MODE)');
      console.log('======================================================');
      console.log(`Target Host     : ${host}`);
      console.log(`Target Database : ${database}`);
      console.log('');
      console.log(`[commentary] Would delete count: ${report.suspectedCommentary.count}`);
      console.log(`  IDs: [${report.suspectedCommentary.ids.join(', ')}]`);
      console.log('');
      console.log(`[matches] Would delete count: ${report.suspectedMatches.count}`);
      console.log(`  IDs: [${report.suspectedMatches.ids.join(', ')}]`);
      console.log('');
      console.log('To apply this deletion, re-run with --execute:');
      console.log('  node scripts/cleanup-prod-test-data.mjs --execute');
      return;
    }

    // Explicit --execute mode: delete commentary first, then matches, atomically
    await client.query('BEGIN');

    const report = await findSuspectedTestData(client, {
      since: opts.since,
      until: opts.until,
      matchIds: opts.matchIds,
    });

    const commentaryIdsToDelete = report.suspectedCommentary.ids;
    const matchIdsToDelete = report.suspectedMatches.ids;

    let deletedCommentaryIds = [];
    if (commentaryIdsToDelete.length > 0 || matchIdsToDelete.length > 0) {
      // Delete all suspected commentary rows + any commentary referencing matches being deleted
      const delCommentary = await client.query(
        `DELETE FROM commentary
         WHERE id = ANY($1::int[])
            OR match_id = ANY($2::int[])
         RETURNING id`,
        [commentaryIdsToDelete, matchIdsToDelete]
      );
      deletedCommentaryIds = delCommentary.rows.map((r) => Number(r.id)).sort((a, b) => a - b);
    }

    let deletedMatchIds = [];
    if (matchIdsToDelete.length > 0) {
      const delMatches = await client.query(
        `DELETE FROM matches
         WHERE id = ANY($1::int[])
         RETURNING id`,
        [matchIdsToDelete]
      );
      deletedMatchIds = delMatches.rows.map((r) => Number(r.id)).sort((a, b) => a - b);
    }

    await client.query('COMMIT');

    const result = {
      mode: 'EXECUTED',
      host,
      database,
      deleted: {
        commentaryCount: deletedCommentaryIds.length,
        commentaryIds: deletedCommentaryIds,
        matchesCount: deletedMatchIds.length,
        matchIds: deletedMatchIds,
      },
    };

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log('======================================================');
    console.log('CLEANUP EXECUTED (TRANSACTION COMMITTED)');
    console.log('======================================================');
    console.log(`Target Host     : ${host}`);
    console.log(`Target Database : ${database}`);
    console.log('');
    console.log(`[commentary] Deleted count: ${deletedCommentaryIds.length}`);
    console.log(`  Deleted IDs: [${deletedCommentaryIds.join(', ')}]`);
    console.log('');
    console.log(`[matches] Deleted count: ${deletedMatchIds.length}`);
    console.log(`  Deleted IDs: [${deletedMatchIds.join(', ')}]`);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[CLEANUP ERROR]', err.message);
  process.exit(1);
});
