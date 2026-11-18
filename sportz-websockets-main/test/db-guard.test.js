import { describe, it, expect } from 'vitest';
import {
  LOCAL_TEST_DB_URL,
  assertSafeTestDatabaseUrl,
  configureBenchmarkDatabase,
} from '../src/db/guard.js';

describe('Strict Test & Benchmark Database Guard', () => {
  const PROD_URL =
    'postgresql://neondb_owner:secret@ep-blue-meadow-b4adhcjq-pooler.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require';
  const REMOTE_NON_PROD_URL =
    'postgresql://user:pass@ep-staging-branch-12345.us-east-2.aws.neon.tech/sportz_staging?sslmode=require';
  const LOCAL_127_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/sportz_test';
  const LOCALHOST_URL = 'postgresql://postgres:postgres@localhost:5433/sportz_test';

  it('allows 127.0.0.1 by default', () => {
    const res = assertSafeTestDatabaseUrl(LOCAL_127_URL, { allowRemote: false });
    expect(res.safe).toBe(true);
    expect(res.hostname).toBe('127.0.0.1');
    expect(res.isRemote).toBe(false);
  });

  it('allows localhost by default', () => {
    const res = assertSafeTestDatabaseUrl(LOCALHOST_URL, { allowRemote: false });
    expect(res.safe).toBe(true);
    expect(res.hostname).toBe('localhost');
    expect(res.isRemote).toBe(false);
  });

  it('refuses ANY non-local host by default (even non-production remote hosts)', () => {
    expect(() =>
      assertSafeTestDatabaseUrl(REMOTE_NON_PROD_URL, { allowRemote: false })
    ).toThrowError(/SAFETY GUARD REFUSAL.*non-local database host/);

    expect(() =>
      assertSafeTestDatabaseUrl('postgresql://u:p@10.0.0.5:5432/testdb', { allowRemote: false })
    ).toThrowError(/SAFETY GUARD REFUSAL.*non-local database host/);

    expect(() =>
      assertSafeTestDatabaseUrl('postgresql://u:p@db.example.com:5432/testdb', { allowRemote: false })
    ).toThrowError(/SAFETY GUARD REFUSAL.*non-local database host/);
  });

  it('allows a non-production remote host ONLY when ALLOW_REMOTE_TEST_DB=true', () => {
    const res = assertSafeTestDatabaseUrl(REMOTE_NON_PROD_URL, { allowRemote: true });
    expect(res.safe).toBe(true);
    expect(res.isRemote).toBe(true);
    expect(res.hostname).toBe('ep-staging-branch-12345.us-east-2.aws.neon.tech');
  });

  it('NEVER allows the production Neon host, even when ALLOW_REMOTE_TEST_DB=true', () => {
    expect(() =>
      assertSafeTestDatabaseUrl(PROD_URL, { allowRemote: false })
    ).toThrowError(/SAFETY GUARD REFUSAL.*production database host/);

    expect(() =>
      assertSafeTestDatabaseUrl(PROD_URL, { allowRemote: true })
    ).toThrowError(/SAFETY GUARD REFUSAL.*production database host/);
  });

  it('refuses missing or malformed DATABASE_URL values', () => {
    expect(() => assertSafeTestDatabaseUrl('', { allowRemote: false })).toThrowError(
      /SAFETY GUARD REFUSAL/
    );
    expect(() => assertSafeTestDatabaseUrl('not-a-valid-url', { allowRemote: true })).toThrowError(
      /SAFETY GUARD REFUSAL/
    );
  });

  it('configureBenchmarkDatabase defaults to local port 5433 and blocks remote hosts unless allowed', () => {
    const freshEnv = {};
    const info = configureBenchmarkDatabase(freshEnv);
    expect(freshEnv.SPORTZ_BENCHMARK).toBe('1');
    expect(freshEnv.DATABASE_URL).toBe(LOCAL_TEST_DB_URL);
    expect(info.host).toBe('127.0.0.1:5433');

    // Refuses explicit remote host without ALLOW_REMOTE_TEST_DB=true
    expect(() =>
      configureBenchmarkDatabase({ DATABASE_URL: REMOTE_NON_PROD_URL })
    ).toThrowError(/SAFETY GUARD REFUSAL/);

    // Refuses production host even with ALLOW_REMOTE_TEST_DB=true
    expect(() =>
      configureBenchmarkDatabase({
        DATABASE_URL: PROD_URL,
        ALLOW_REMOTE_TEST_DB: 'true',
      })
    ).toThrowError(/SAFETY GUARD REFUSAL.*production database host/);

    // Allows non-production remote host when ALLOW_REMOTE_TEST_DB=true
    const remoteInfo = configureBenchmarkDatabase({
      DATABASE_URL: REMOTE_NON_PROD_URL,
      ALLOW_REMOTE_TEST_DB: 'true',
    });
    expect(remoteInfo.isRemote).toBe(true);
  });
});
