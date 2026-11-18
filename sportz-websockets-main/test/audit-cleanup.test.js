import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { eq, inArray } from 'drizzle-orm';
import { db, pool } from '../src/db/db.js';
import { matches, commentary } from '../src/db/schema.js';
import { findSuspectedTestData } from '../../scripts/lib/prod-test-data-rules.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(__dirname, '../..');
const AUDIT_SCRIPT = path.resolve(WORKSPACE_ROOT, 'scripts/audit-prod-test-data.mjs');
const CLEANUP_SCRIPT = path.resolve(WORKSPACE_ROOT, 'scripts/cleanup-prod-test-data.mjs');

describe('Audit & Cleanup Scripts (verified against local Docker Postgres 5433)', () => {
  const createdMatchIds = [];

  afterEach(async () => {
    if (createdMatchIds.length > 0) {
      await db.delete(commentary).where(inArray(commentary.matchId, createdMatchIds));
      await db.delete(matches).where(inArray(matches.id, createdMatchIds));
      createdMatchIds.length = 0;
    }
  });

  it('flags suspected test rows while ignoring real football-data.org rows, and cleanup is dry-run by default', async () => {
    // 1. Insert a realistic production match + commentary (must NOT be flagged)
    const [realMatch] = await db
      .insert(matches)
      .values({
        sport: 'football',
        homeTeam: 'Manchester City FC',
        awayTeam: 'Aston Villa FC',
        status: 'live',
        startTime: new Date('2026-11-18T15:00:00Z'),
        homeScore: 1,
        awayScore: 0,
        lastSeq: 1,
        provider: 'football-data.org',
        providerMatchId: `real_match_${Date.now()}`,
      })
      .returning();
    createdMatchIds.push(realMatch.id);

    const [realCommentary] = await db
      .insert(commentary)
      .values({
        matchId: realMatch.id,
        sequence: 1,
        minute: 22,
        message: '[Event-based] SCORE UPDATE: Manchester City FC 1 - 0 Aston Villa FC.',
        provider: 'football-data.org',
        providerEventId: `football-data.org_m${realMatch.id}_score_1_0_2026-11-18T15:22:00Z`,
      })
      .returning();

    // 2. Insert a unit-test fixture match (Arsenal vs Chelsea, null provider/startTime) + test commentary
    const [testFixtureMatch] = await db
      .insert(matches)
      .values({
        sport: 'football',
        homeTeam: 'Arsenal',
        awayTeam: 'Chelsea',
        status: 'live',
        homeScore: 0,
        awayScore: 0,
        lastSeq: 1,
      })
      .returning();
    createdMatchIds.push(testFixtureMatch.id);

    const [testCommentary1] = await db
      .insert(commentary)
      .values({
        matchId: testFixtureMatch.id,
        sequence: 1,
        minute: 10,
        message: 'Seq 1 live event',
        provider: 'test-gap',
        providerEventId: `gap_1_${Date.now()}`,
      })
      .returning();

    // 3. Insert a hardcoded match ID 888
    await db
      .insert(matches)
      .values({
        id: 888,
        sport: 'football',
        homeTeam: 'Alpha FC',
        awayTeam: 'Beta FC',
        status: 'live',
        homeScore: 0,
        awayScore: 0,
      })
      .onConflictDoNothing();
    createdMatchIds.push(888);

    const [testCommentary888] = await db
      .insert(commentary)
      .values({
        matchId: 888,
        sequence: 1,
        minute: 5,
        message: 'Pre-pause event via Redis',
      })
      .returning();

    // 4. Verify audit script (READ-ONLY) output contains ONLY counts & IDs and flags exact test IDs
    const auditRaw = execFileSync(process.execPath, [AUDIT_SCRIPT, '--json'], {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      encoding: 'utf8',
    });
    const auditJson = JSON.parse(auditRaw);

    expect(auditJson.mode).toBe('READ_ONLY_AUDIT');
    expect(auditJson.suspectedMatches.ids).toContain(testFixtureMatch.id);
    expect(auditJson.suspectedMatches.ids).toContain(888);
    expect(auditJson.suspectedMatches.ids).not.toContain(realMatch.id);

    expect(auditJson.suspectedCommentary.ids).toContain(testCommentary1.id);
    expect(auditJson.suspectedCommentary.ids).toContain(testCommentary888.id);
    expect(auditJson.suspectedCommentary.ids).not.toContain(realCommentary.id);

    // 5. Verify cleanup script runs DRY-RUN by default and deletes NOTHING
    const dryRunRaw = execFileSync(process.execPath, [CLEANUP_SCRIPT, '--json'], {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      encoding: 'utf8',
    });
    const dryRunJson = JSON.parse(dryRunRaw);
    expect(dryRunJson.mode).toBe('DRY_RUN');
    expect(dryRunJson.wouldDelete.matchIds).toContain(888);
    expect(dryRunJson.wouldDelete.matchIds).toContain(testFixtureMatch.id);

    // Rows must still exist after dry-run
    const stillThere = await db.select().from(matches).where(eq(matches.id, testFixtureMatch.id));
    expect(stillThere.length).toBe(1);

    // 6. Verify cleanup script WITH --execute deletes ONLY the test rows and preserves the real row
    const execRaw = execFileSync(process.execPath, [CLEANUP_SCRIPT, '--execute', '--json'], {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      encoding: 'utf8',
    });
    const execJson = JSON.parse(execRaw);
    expect(execJson.mode).toBe('EXECUTED');
    expect(execJson.deleted.matchIds).toContain(888);
    expect(execJson.deleted.matchIds).toContain(testFixtureMatch.id);
    expect(execJson.deleted.matchIds).not.toContain(realMatch.id);

    // Real match + commentary survived untouched
    const realMatchAfter = await db.select().from(matches).where(eq(matches.id, realMatch.id));
    const realCommAfter = await db
      .select()
      .from(commentary)
      .where(eq(commentary.id, realCommentary.id));
    expect(realMatchAfter.length).toBe(1);
    expect(realCommAfter.length).toBe(1);

    // Test rows are gone
    const client = await pool.connect();
    try {
      const afterReport = await findSuspectedTestData(client);
      expect(afterReport.suspectedMatches.count).toBe(0);
      expect(afterReport.suspectedCommentary.count).toBe(0);
    } finally {
      client.release();
    }
  });
});
