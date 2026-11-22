// Applies server/db/migrations/*.sql in order, once each, inside a transaction, under a lock (so two server
// instances starting together don't both migrate). Runs at server start; also `npm run migrate`.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export async function migrate(pool, log = console.log) {
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock(74253)');
    await c.query('create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await c.query('select version from schema_migrations')).rows.map((r) => r.version));
    const files = (await readdir(DIR)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(DIR + f, 'utf8');
      await c.query('begin');
      try {
        await c.query(sql);
        await c.query('insert into schema_migrations (version) values ($1)', [f]);
        await c.query('commit');
        log(`[db] applied ${f}`);
      } catch (e) { await c.query('rollback'); throw new Error(`migration ${f} failed: ${e.message}`); }
    }
  } finally {
    await c.query('select pg_advisory_unlock(74253)').catch(() => {});
    c.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { pool } = await import('./pool.js');
  if (!pool) { console.error('DATABASE_URL is not set'); process.exit(1); }
  await migrate(pool);
  await pool.end();
}
