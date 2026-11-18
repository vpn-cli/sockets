import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './db.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations() {
    console.log('[Drizzle] Applying migrations from ./drizzle...');
    await migrate(db, { migrationsFolder: path.resolve(__dirname, '../../drizzle') });
    console.log('✅ [Drizzle] Migrations applied successfully.');
    await pool.end();
}

runMigrations().catch((err) => {
    console.error('❌ [Drizzle] Migration failed:', err);
    process.exit(1);
});
