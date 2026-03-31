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
  idleTimeoutMillis: 30000,
  max: 10
});

pool.on('error', (err) => {
  console.error('Unexpected PG error', err);
});

export async function testDbConnection() {
  try {
    const client = await pool.connect();
    console.log('DB CONNECTED');
    client.release();
  } catch (err) {
    console.error('DB CONNECTION FAILED:', err);
    process.exit(1);
  }
}
