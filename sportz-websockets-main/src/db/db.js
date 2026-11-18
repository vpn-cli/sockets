import './bootstrap-env.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { assertSafeTestDatabaseUrl, isTestOrBenchmarkEnv } from './guard.js';

if (isTestOrBenchmarkEnv()) {
  assertSafeTestDatabaseUrl(process.env.DATABASE_URL, {
    context:
      process.env.SPORTZ_BENCHMARK === '1' || process.env.BENCHMARK_BYPASS_ARCJET === '1'
        ? 'benchmarks'
        : 'tests',
  });
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not defined');
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool);
