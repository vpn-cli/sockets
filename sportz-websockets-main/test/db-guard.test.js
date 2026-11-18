import { describe, it, expect } from 'vitest';
import { checkProductionDatabaseGuard } from './setup.js';

describe('Production Database Guard', () => {
    it('refuses to run when pointing to production Neon host', () => {
        const prodUrl = 'postgresql://neondb_owner:secret@ep-blue-meadow-b4adhcjq-pooler.c-6.us-east-2.aws.neon.tech/neondb?sslmode=require';
        expect(() => checkProductionDatabaseGuard(prodUrl)).toThrowError(/SAFETY GUARD REFUSAL/);
    });

    it('allows local Docker Postgres connection string', () => {
        const localUrl = 'postgresql://postgres:postgres@127.0.0.1:5433/sportz_test';
        expect(() => checkProductionDatabaseGuard(localUrl)).not.toThrow();
    });
});
