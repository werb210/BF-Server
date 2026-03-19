import { Pool } from 'pg';

let pool: Pool | null = null;

export function getDb() {
  if (!process.env.DATABASE_URL) {
    if (process.env.NODE_ENV === 'test') {
      return null;
    }
    throw new Error('DATABASE_URL is required');
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
  }

  return pool;
}
