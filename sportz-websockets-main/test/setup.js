import {
  assertSafeTestDatabaseUrl,
  configureTestOrBenchmarkDatabase,
} from '../src/db/guard.js';

export const checkProductionDatabaseGuard = assertSafeTestDatabaseUrl;

configureTestOrBenchmarkDatabase({ context: 'tests' });
