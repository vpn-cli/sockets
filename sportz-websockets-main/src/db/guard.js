import { URL } from 'url';

export const LOCAL_TEST_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:5433/sportz_test';

const PROD_HOSTS = new Set([
  'ep-blue-meadow-b4adhcjq-pooler.c-6.us-east-2.aws.neon.tech',
]);

const ALLOWED_LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

export function isTestOrBenchmarkEnv(env = process.env) {
  return Boolean(
    env.VITEST ||
    env.NODE_ENV === 'test' ||
    env.SPORTZ_BENCHMARK === '1' ||
    env.SPORTZ_BENCHMARK === 'true' ||
    env.BENCHMARK_BYPASS_ARCJET === '1'
  );
}

export function isProductionHost(hostname, env = process.env) {
  if (!hostname) return false;
  const normalized = hostname.toLowerCase();
  if (PROD_HOSTS.has(normalized) || normalized.includes('b4adhcjq')) {
    return true;
  }
  if (env.PROD_DATABASE_HOST && normalized === env.PROD_DATABASE_HOST.toLowerCase()) {
    return true;
  }
  return false;
}

export function isAllowedLocalHost(hostname) {
  if (!hostname) return false;
  return ALLOWED_LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Strict database safety guard for tests and benchmarks.
 * - Allows ONLY localhost / 127.0.0.1 by default.
 * - Refuses ANY other host unless ALLOW_REMOTE_TEST_DB=true is explicitly set.
 * - NEVER allows the production database host, even when ALLOW_REMOTE_TEST_DB=true.
 */
export function assertSafeTestDatabaseUrl(
  dbUrl = process.env.DATABASE_URL,
  {
    allowRemote = process.env.ALLOW_REMOTE_TEST_DB === 'true',
    context = 'tests/benchmarks',
    env = process.env,
  } = {}
) {
  if (!dbUrl || typeof dbUrl !== 'string') {
    throw new Error(
      `🚨 [SAFETY GUARD REFUSAL] DATABASE_URL is missing for ${context}. ` +
      `Expected local test database (${LOCAL_TEST_DB_URL}).`
    );
  }

  let parsed;
  try {
    parsed = new URL(dbUrl);
  } catch {
    throw new Error(
      `🚨 [SAFETY GUARD REFUSAL] Invalid DATABASE_URL format for ${context}; refusing to proceed.`
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  // 1. Production host is NEVER allowed, even with ALLOW_REMOTE_TEST_DB=true
  if (isProductionHost(hostname, env)) {
    throw new Error(
      `🚨 [SAFETY GUARD REFUSAL] Refusing to execute ${context} against production database host: "${parsed.hostname}". ` +
      `The production host is strictly forbidden even when ALLOW_REMOTE_TEST_DB=true.`
    );
  }

  // 2. Only localhost / 127.0.0.1 allowed unless ALLOW_REMOTE_TEST_DB=true
  if (!isAllowedLocalHost(hostname)) {
    if (!allowRemote) {
      throw new Error(
        `🚨 [SAFETY GUARD REFUSAL] Refusing to execute ${context} against non-local database host: "${parsed.hostname}". ` +
        `Only localhost or 127.0.0.1 is allowed by default. ` +
        `Set ALLOW_REMOTE_TEST_DB=true to explicitly allow a non-production remote test database.`
      );
    }
    return { safe: true, hostname, host: parsed.host, isRemote: true };
  }

  return { safe: true, hostname, host: parsed.host, isRemote: false };
}

/**
 * Configures process.env for tests or benchmarks:
 * - Uses TEST_DATABASE_URL if provided.
 * - Otherwise defaults DATABASE_URL to local Docker Postgres on port 5433 if unset.
 * - Enforces assertSafeTestDatabaseUrl immediately.
 */
export function configureTestOrBenchmarkDatabase({
  context = 'tests',
  markBenchmark = false,
  env = process.env,
} = {}) {
  if (markBenchmark) {
    env.SPORTZ_BENCHMARK = '1';
  }

  if (env.TEST_DATABASE_URL) {
    env.DATABASE_URL = env.TEST_DATABASE_URL;
  } else if (!env.DATABASE_URL) {
    env.DATABASE_URL = LOCAL_TEST_DB_URL;
  }

  return assertSafeTestDatabaseUrl(env.DATABASE_URL, {
    allowRemote: env.ALLOW_REMOTE_TEST_DB === 'true',
    context,
    env,
  });
}

export function configureBenchmarkDatabase(env = process.env) {
  return configureTestOrBenchmarkDatabase({
    context: 'benchmarks',
    markBenchmark: true,
    env,
  });
}
