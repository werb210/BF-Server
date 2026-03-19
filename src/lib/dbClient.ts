import { Pool } from 'pg';

let _pool: Pool | null = null;

function createPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  return new Pool({
    connectionString: process.env.DATABASE_URL,
  });
}

// Primary access (lazy)
export function getDb(): Pool {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      if (process.env.NODE_ENV === 'test') {
        return null as any;
      }
      throw new Error('DATABASE_URL is required');
    }
    _pool = createPool();
  }
  return _pool;
}

// BACKWARD COMPAT: pool.query()
export const pool = {
  query: (...args: any[]) => {
    const db = getDb();
    if (!db) throw new Error('DB not available in test mode');
    return (db as any).query(...args as any);
  },
};

// BACKWARD COMPAT: health check
export async function testDbConnection(): Promise<boolean> {
  try {
    const db = getDb();
    if (!db) return true;
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
