import pg from 'pg';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});
pool.on('error', (e) => console.error(JSON.stringify({ level: 'error', msg: 'pg pool error', error: e.message })));

export async function migrate() {
  const sql = fs.readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
  await pool.query(sql);
}

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
