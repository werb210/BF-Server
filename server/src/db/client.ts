import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

export const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 10000,
  query_timeout: 10000,
  idleTimeoutMillis: 30000
});

export async function testDb() {
  const start = Date.now();

  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();

    console.log('DB OK in', Date.now() - start, 'ms');
  } catch (err) {
    console.error('DB FAIL', err);
    process.exit(1);
  }
}
