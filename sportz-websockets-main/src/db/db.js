import 'dotenv/config';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

const isTestEnv = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
if (isTestEnv) {
  if (!process.env.TEST_DATABASE_URL && (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('b4adhcjq'))) {
    process.env.DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/sportz_test';
  } else if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  }
}

if (!process.env.DATABASE_URL) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

if (isTestEnv && process.env.DATABASE_URL) {
  try {
    const parsed = new URL(process.env.DATABASE_URL);
    if (parsed.host === 'ep-blue-meadow-b4adhcjq-pooler.c-6.us-east-2.aws.neon.tech' || parsed.host.includes('b4adhcjq')) {
      throw new Error(
        `🚨 [SAFETY GUARD REFUSAL] Refusing to execute tests against production database host: "${parsed.host}". ` +
        `Tests must run against local Docker Postgres (127.0.0.1:5433) or an isolated test database.`
      );
    }
  } catch (e) {
    if (e.message.includes('SAFETY GUARD REFUSAL')) throw e;
  }
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not defined');
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool);
