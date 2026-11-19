// The database connection pool, from DATABASE_URL. Unset in development: the app then runs without storing
// anything (as before). Production requires it (server/index.js refuses to start without it).
// Cloud SQL on Cloud Run: postgresql://USER:PASS@/sakhi?host=/cloudsql/PROJECT:REGION:INSTANCE
import pg from 'pg';

const url = process.env.DATABASE_URL;
export const pool = url ? new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX || 10), idleTimeoutMillis: 30_000 }) : null;
pool?.on('error', (e) => console.error('[db] idle client error', e.message));
