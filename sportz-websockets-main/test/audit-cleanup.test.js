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

  it('matches only test-specific fields (never numeric IDs), preserves real & seeded simulated matches, and defaults to dry-run', async () => {
    // 1. Real production match that happens to have numeric id = 888 (must NOT be flagged!)
    const [realMatch888] = await db
      .insert(matches)
      .values({
        id: 888,
        sport: 'football',
        homeTeam: 'Manchester City FC',
        awayTeam: 'Aston Villa FC',
        status: 'live',
        startTime: new Date('2026-11-18T15:00:00Z'),
        endTime: new Date('2026-11-18T17:00:00Z'),
        homeScore: 1,
        awayScore: 0,
        lastSeq: 1,
        provider: 'football-data.org',
        providerMatchId: `real_match_${Date.now()}`,
      })
      .returning();
    createdMatchIds.push(realMatch888.id);

    const [realCommentary] = await db
      .insert(commentary)
      .values({
        matchId: realMatch888.id,
        sequence: 1,
        minute: 22,
        message: '[Event-based] SCORE UPDATE: Manchester City FC 1 - 0 Aston Villa FC.',
        provider: 'football-data.org',
        providerEventId: `football-data.org_m${realMatch888.id}_score_1_0_2026-11-18T15:22:00Z`,
      })
      .returning();

    // 2. Seeded simulated match (provider=null, BUT startTime & endTime are non-null, per seed.js / POST /matches)
    // Even if it used Arsenal vs Chelsea, non-null startTime/endTime keeps it safe!
    const [seededSimMatch] = await db
      .insert(matches)
      .values({
        sport: 'football',
        homeTeam: 'Arsenal',
        awayTeam: 'Chelsea',
        status: 'live',
        startTime: new Date('2026-11-18T12:00:00Z'),
        endTime: new Date('2026-11-18T13:45:00Z'),
        homeScore: 2,
        awayScore: 1,
        lastSeq: 2,
      })
      .returning();
    createdMatchIds.push(seededSimMatch.id);

    const [seededSimCommentary] = await db
      .insert(commentary)
      .values({
        matchId: seededSimMatch.id,
        sequence: 1,
        minute: 14,
        message: 'Great through ball into the box.',
      })
      .returning();

    // 3. Unit-test fixture match (auto-generated id, provider=null, startTime=null, endTime=null) + test commentary
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

    // 4. Explicit test-named match + fd_test_ commentary
    const [testNamedMatch] = await db
      .insert(matches)
      .values({
        sport: 'football',
        homeTeam: 'Benchmark Team A',
        awayTeam: 'Mock FC',
        status: 'live',
        homeScore: 0,
        awayScore: 0,
      })
      .returning();
    createdMatchIds.push(testNamedMatch.id);

    const [testCommentary2] = await db
      .insert(commentary)
      .values({
        matchId: testNamedMatch.id,
        sequence: 1,
        minute: 5,
        message: 'First attempt on target',
        provider: 'football-data.org',
        providerEventId: `fd_test_${Date.now()}_1`,
      })
      .returning();

    // 5. Verify READ-ONLY audit script output flags ONLY test rows
    const auditRaw = execFileSync(process.execPath, [AUDIT_SCRIPT, '--json'], {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      encoding: 'utf8',
    });
    const auditJson = JSON.parse(auditRaw);

    expect(auditJson.mode).toBe('READ_ONLY_AUDIT');
    expect(auditJson.suspectedMatches.ids).toContain(testFixtureMatch.id);
    expect(auditJson.suspectedMatches.ids).toContain(testNamedMatch.id);
    expect(auditJson.suspectedMatches.ids).not.toContain(realMatch888.id);
    expect(auditJson.suspectedMatches.ids).not.toContain(seededSimMatch.id);

    expect(auditJson.suspectedCommentary.ids).toContain(testCommentary1.id);
    expect(auditJson.suspectedCommentary.ids).toContain(testCommentary2.id);
    expect(auditJson.suspectedCommentary.ids).not.toContain(realCommentary.id);
    expect(auditJson.suspectedCommentary.ids).not.toContain(seededSimCommentary.id);

    // 6. Verify cleanup script defaults to DRY-RUN and deletes NOTHING
    const dryRunRaw = execFileSync(process.execPath, [CLEANUP_SCRIPT, '--json'], {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      encoding: 'utf8',
    });
    const dryRunJson = JSON.parse(dryRunRaw);
    expect(dryRunJson.mode).toBe('DRY_RUN');
    expect(dryRunJson.wouldDelete.matchIds).toContain(testFixtureMatch.id);
    expect(dryRunJson.wouldDelete.matchIds).toContain(testNamedMatch.id);
    expect(dryRunJson.wouldDelete.matchIds).not.toContain(realMatch888.id);
    expect(dryRunJson.wouldDelete.matchIds).not.toContain(seededSimMatch.id);

    const stillThere = await db.select().from(matches).where(eq(matches.id, testFixtureMatch.id));
    expect(stillThere.length).toBe(1);

    // 7. Verify --execute deletes ONLY test rows and preserves both real (id 888) and seeded simulated matches
    const execRaw = execFileSync(process.execPath, [CLEANUP_SCRIPT, '--execute', '--json'], {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      encoding: 'utf8',
    });
    const execJson = JSON.parse(execRaw);
    expect(execJson.mode).toBe('EXECUTED');
    expect(execJson.deleted.matchIds).toContain(testFixtureMatch.id);
    expect(execJson.deleted.matchIds).toContain(testNamedMatch.id);
    expect(execJson.deleted.matchIds).not.toContain(realMatch888.id);
    expect(execJson.deleted.matchIds).not.toContain(seededSimMatch.id);

    expect((await db.select().from(matches).where(eq(matches.id, realMatch888.id))).length).toBe(1);
    expect((await db.select().from(matches).where(eq(matches.id, seededSimMatch.id))).length).toBe(1);
    expect((await db.select().from(commentary).where(eq(commentary.id, realCommentary.id))).length).toBe(1);
    expect((await db.select().from(commentary).where(eq(commentary.id, seededSimCommentary.id))).length).toBe(1);

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
