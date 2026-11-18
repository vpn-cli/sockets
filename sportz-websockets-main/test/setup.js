import { URL } from 'url';

const PROD_HOST = 'ep-blue-meadow-b4adhcjq-pooler.c-6.us-east-2.aws.neon.tech';
const LOCAL_TEST_DB = 'postgresql://postgres:postgres@127.0.0.1:5433/sportz_test';

// 1. If DATABASE_URL is not explicitly set for tests or points to production,
// redirect tests to local Docker Postgres.
if (!process.env.TEST_DATABASE_URL && (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes('b4adhcjq'))) {
    process.env.DATABASE_URL = LOCAL_TEST_DB;
} else if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// 2. Strict Production Guard: Refuse to execute tests against production database
export function checkProductionDatabaseGuard(dbUrl = process.env.DATABASE_URL) {
    if (!dbUrl) return;
    try {
        const parsed = new URL(dbUrl);
        if (parsed.host === PROD_HOST || parsed.host.includes('b4adhcjq')) {
            throw new Error(
                `🚨 [SAFETY GUARD REFUSAL] Refusing to execute tests against production database host: "${parsed.host}". ` +
                `Tests must run against local Docker Postgres (127.0.0.1:5433) or an isolated test database.`
            );
        }
    } catch (err) {
        if (err.message.includes('SAFETY GUARD REFUSAL')) {
            throw err;
        }
    }
}

checkProductionDatabaseGuard(process.env.DATABASE_URL);
