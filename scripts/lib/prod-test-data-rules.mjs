import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve pg and dotenv from sportz-websockets-main/node_modules so scripts work from workspace root
const backendPkgJson = new URL('../../sportz-websockets-main/package.json', import.meta.url);
const requireFromBackend = createRequire(backendPkgJson);

export const pg = requireFromBackend('pg');
export const dotenv = requireFromBackend('dotenv');

export const KNOWN_TEST_MATCH_IDS = [777, 888, 999999];

export function loadDatabaseUrl() {
  if (!process.env.DATABASE_URL) {
    const envPath = path.resolve(__dirname, '../../sportz-websockets-main/.env');
    dotenv.config({ path: envPath, quiet: true });
  }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error(
      'DATABASE_URL is not set. Pass DATABASE_URL in the environment or ensure sportz-websockets-main/.env exists.'
    );
  }
  const parsed = new URL(dbUrl);
  return {
    dbUrl,
    host: parsed.host,
    database: parsed.pathname.replace(/^\//, ''),
  };
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const opts = {
    execute: false,
    json: false,
    since: null,
    until: null,
    matchIds: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--execute' || arg === '--apply') {
      opts.execute = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--since' && i + 1 < argv.length) {
      opts.since = argv[++i];
    } else if (arg === '--until' && i + 1 < argv.length) {
      opts.until = argv[++i];
    } else if (arg === '--match-ids' && i + 1 < argv.length) {
      opts.matchIds = argv[++i]
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    }
  }

  if (opts.since && Number.isNaN(Date.parse(opts.since))) {
    throw new Error(`Invalid --since timestamp: "${opts.since}"`);
  }
  if (opts.until && Number.isNaN(Date.parse(opts.until))) {
    throw new Error(`Invalid --until timestamp: "${opts.until}"`);
  }

  return opts;
}

/**
 * SQL predicate for matches rows that look like test or benchmark leftovers.
 * Conservative against real football-data.org matches (which always have
 * provider='football-data.org', provider_match_id IS NOT NULL, and start_time IS NOT NULL).
 */
export const SUSPECTED_TEST_MATCHES_SQL = `
  SELECT
    id,
    CASE
      WHEN id IN (777, 888, 999999)
        OR id BETWEEN 888800 AND 898800
        OR id BETWEEN 988800 AND 998800
        THEN 'known_test_match_id'
      WHEN provider ILIKE 'test%'
        OR provider ILIKE 'mock%'
        OR provider ILIKE '%benchmark%'
        OR provider ILIKE '%replay-test%'
        OR provider_match_id ILIKE 'test%'
        OR provider_match_id ILIKE 'mock%'
        OR provider_match_id ILIKE 'bench%'
        THEN 'test_provider'
      WHEN home_team ~* '(^|\\y)(test|mock|dummy|benchmark|loadtest|fake)(\\y|$)'
        OR away_team ~* '(^|\\y)(test|mock|dummy|benchmark|loadtest|fake)(\\y|$)'
        THEN 'test_team_name'
      WHEN provider IS NULL
        AND provider_match_id IS NULL
        AND start_time IS NULL
        AND sport = 'football'
        AND (
          (home_team = 'Arsenal' AND away_team = 'Chelsea')
          OR (home_team = 'Liverpool' AND away_team = 'Real Madrid')
          OR (home_team = 'Bayern' AND away_team = 'Dortmund')
          OR (home_team = 'PSG' AND away_team = 'Marseille')
        )
        THEN 'unit_test_fixture_signature'
      ELSE NULL
    END AS match_reason
  FROM matches
  WHERE (
    id IN (777, 888, 999999)
    OR id BETWEEN 888800 AND 898800
    OR id BETWEEN 988800 AND 998800
    OR provider ILIKE 'test%'
    OR provider ILIKE 'mock%'
    OR provider ILIKE '%benchmark%'
    OR provider ILIKE '%replay-test%'
    OR provider_match_id ILIKE 'test%'
    OR provider_match_id ILIKE 'mock%'
    OR provider_match_id ILIKE 'bench%'
    OR home_team ~* '(^|\\y)(test|mock|dummy|benchmark|loadtest|fake)(\\y|$)'
    OR away_team ~* '(^|\\y)(test|mock|dummy|benchmark|loadtest|fake)(\\y|$)'
    OR (
      provider IS NULL
      AND provider_match_id IS NULL
      AND start_time IS NULL
      AND sport = 'football'
      AND (
        (home_team = 'Arsenal' AND away_team = 'Chelsea')
        OR (home_team = 'Liverpool' AND away_team = 'Real Madrid')
        OR (home_team = 'Bayern' AND away_team = 'Dortmund')
        OR (home_team = 'PSG' AND away_team = 'Marseille')
      )
    )
  )
`;

/**
 * SQL predicate for commentary rows that look like test or benchmark leftovers,
 * OR belong to a suspected test match ID passed as $1 (integer[]).
 */
export const SUSPECTED_TEST_COMMENTARY_SQL = `
  SELECT
    id,
    match_id,
    CASE
      WHEN match_id = ANY($1::int[])
        THEN 'belongs_to_suspected_test_match'
      WHEN match_id IN (777, 888, 999999)
        OR match_id BETWEEN 888800 AND 898800
        OR match_id BETWEEN 988800 AND 998800
        THEN 'known_test_match_id'
      WHEN provider ILIKE 'test%'
        OR provider ILIKE 'mock%'
        OR provider ILIKE '%benchmark%'
        OR provider ILIKE '%replay-test%'
        THEN 'test_provider'
      WHEN provider_event_id LIKE 'fd_test_%'
        OR provider_event_id LIKE 'fd_dup_%'
        OR provider_event_id LIKE 'fd_var_%'
        OR provider_event_id LIKE 'fd_zero_%'
        OR provider_event_id LIKE 'fd_pause_%'
        OR provider_event_id LIKE 'fd_upsert_dup_%'
        OR provider_event_id LIKE 'fm_%'
        OR provider_event_id LIKE 'ev_test_%'
        OR provider_event_id LIKE 'bulk_%'
        OR provider_event_id LIKE 'cross_%'
        OR provider_event_id LIKE 'outage_%'
        OR provider_event_id LIKE 'race_%'
        OR provider_event_id LIKE 'gap_%'
        OR provider_event_id LIKE 'stampede_%'
        OR provider_event_id LIKE 'client_replay_%'
        THEN 'test_provider_event_id'
      WHEN message ~* '^(Match event #[0-9]+ occurred\\.|Telemetry point [0-9]+|Early event [0-9]+|Missed event [0-9]+|Outage event [0-9]+|Historical event [0-9]+|Live concurrent event [0-9]+ during replay|Seq [0-9]+ (live )?event|Stampede commentary seq [0-9]+|Pre-pause event via Redis|Degraded event during pause|Post-unpause restored event|Event [0-9]+|First attempt on target|Second event|First score|Duplicate event ID with score update|Bayern 1st goal|Dortmund equalizer|Bayern winner)$'
        OR message ILIKE '%benchmark%'
        OR message ILIKE '%load test%'
        OR message ILIKE '%load-test%'
        THEN 'test_message_pattern'
      ELSE NULL
    END AS commentary_reason
  FROM commentary
  WHERE (
    match_id = ANY($1::int[])
    OR match_id IN (777, 888, 999999)
    OR match_id BETWEEN 888800 AND 898800
    OR match_id BETWEEN 988800 AND 998800
    OR provider ILIKE 'test%'
    OR provider ILIKE 'mock%'
    OR provider ILIKE '%benchmark%'
    OR provider ILIKE '%replay-test%'
    OR provider_event_id LIKE 'fd_test_%'
    OR provider_event_id LIKE 'fd_dup_%'
    OR provider_event_id LIKE 'fd_var_%'
    OR provider_event_id LIKE 'fd_zero_%'
    OR provider_event_id LIKE 'fd_pause_%'
    OR provider_event_id LIKE 'fd_upsert_dup_%'
    OR provider_event_id LIKE 'fm_%'
    OR provider_event_id LIKE 'ev_test_%'
    OR provider_event_id LIKE 'bulk_%'
    OR provider_event_id LIKE 'cross_%'
    OR provider_event_id LIKE 'outage_%'
    OR provider_event_id LIKE 'race_%'
    OR provider_event_id LIKE 'gap_%'
    OR provider_event_id LIKE 'stampede_%'
    OR provider_event_id LIKE 'client_replay_%'
    OR message ~* '^(Match event #[0-9]+ occurred\\.|Telemetry point [0-9]+|Early event [0-9]+|Missed event [0-9]+|Outage event [0-9]+|Historical event [0-9]+|Live concurrent event [0-9]+ during replay|Seq [0-9]+ (live )?event|Stampede commentary seq [0-9]+|Pre-pause event via Redis|Degraded event during pause|Post-unpause restored event|Event [0-9]+|First attempt on target|Second event|First score|Duplicate event ID with score update|Bayern 1st goal|Dortmund equalizer|Bayern winner)$'
    OR message ILIKE '%benchmark%'
    OR message ILIKE '%load test%'
    OR message ILIKE '%load-test%'
  )
`;

export async function findSuspectedTestData(client, { since = null, until = null, matchIds = null } = {}) {
  const matchParams = [];
  let matchSql = SUSPECTED_TEST_MATCHES_SQL;

  if (since) {
    matchParams.push(since);
    matchSql += ` AND created_at >= $${matchParams.length}::timestamptz`;
  }
  if (until) {
    matchParams.push(until);
    matchSql += ` AND created_at <= $${matchParams.length}::timestamptz`;
  }
  if (matchIds && matchIds.length > 0) {
    matchParams.push(matchIds);
    matchSql += ` AND id = ANY($${matchParams.length}::int[])`;
  }
  matchSql += ' ORDER BY id ASC';

  const matchRes = await client.query(matchSql, matchParams);
  const suspectedMatchIds = matchRes.rows.map((r) => Number(r.id));

  const commentaryParams = [suspectedMatchIds];
  let commentarySql = SUSPECTED_TEST_COMMENTARY_SQL;

  if (since) {
    commentaryParams.push(since);
    commentarySql += ` AND created_at >= $${commentaryParams.length}::timestamptz`;
  }
  if (until) {
    commentaryParams.push(until);
    commentarySql += ` AND created_at <= $${commentaryParams.length}::timestamptz`;
  }
  if (matchIds && matchIds.length > 0) {
    commentaryParams.push(matchIds);
    commentarySql += ` AND match_id = ANY($${commentaryParams.length}::int[])`;
  }
  commentarySql += ' ORDER BY id ASC';

  const commentaryRes = await client.query(commentarySql, commentaryParams);

  const matchReasonCounts = {};
  for (const row of matchRes.rows) {
    matchReasonCounts[row.match_reason] = (matchReasonCounts[row.match_reason] || 0) + 1;
  }

  const commentaryReasonCounts = {};
  const referencedMatchIds = new Set();
  for (const row of commentaryRes.rows) {
    commentaryReasonCounts[row.commentary_reason] =
      (commentaryReasonCounts[row.commentary_reason] || 0) + 1;
    referencedMatchIds.add(Number(row.match_id));
  }

  const suspectedMatchIdSet = new Set(suspectedMatchIds);
  const otherMatchIdsWithTestCommentary = [...referencedMatchIds]
    .filter((id) => !suspectedMatchIdSet.has(id))
    .sort((a, b) => a - b);

  // Optional window-only check if --since / --until provided (all rows created in that window)
  let windowSummary = null;
  if (since || until) {
    const wParams = [];
    const clauses = [];
    if (since) {
      wParams.push(since);
      clauses.push(`created_at >= $${wParams.length}::timestamptz`);
    }
    if (until) {
      wParams.push(until);
      clauses.push(`created_at <= $${wParams.length}::timestamptz`);
    }
    const whereClause = clauses.join(' AND ');
    const wMatches = await client.query(
      `SELECT id FROM matches WHERE ${whereClause} ORDER BY id ASC`,
      wParams
    );
    const wCommentary = await client.query(
      `SELECT id FROM commentary WHERE ${whereClause} ORDER BY id ASC`,
      wParams
    );
    windowSummary = {
      since,
      until,
      matchesCount: wMatches.rows.length,
      matchIds: wMatches.rows.map((r) => Number(r.id)),
      commentaryCount: wCommentary.rows.length,
      commentaryIds: wCommentary.rows.map((r) => Number(r.id)),
    };
  }

  const [{ rows: totalMatchRows }, { rows: totalCommentaryRows }] = await Promise.all([
    client.query('SELECT COUNT(*)::int AS total FROM matches'),
    client.query('SELECT COUNT(*)::int AS total FROM commentary'),
  ]);

  return {
    totals: {
      matches: totalMatchRows[0].total,
      commentary: totalCommentaryRows[0].total,
    },
    suspectedMatches: {
      count: suspectedMatchIds.length,
      byReason: matchReasonCounts,
      ids: suspectedMatchIds,
    },
    suspectedCommentary: {
      count: commentaryRes.rows.length,
      byReason: commentaryReasonCounts,
      ids: commentaryRes.rows.map((r) => Number(r.id)),
      otherMatchIdsWithTestCommentary,
    },
    windowSummary,
  };
}
