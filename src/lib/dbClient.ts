import { Pool } from 'pg';
import { ENV } from '../server/config/env.compat';
import { canExecute, recordFailure } from './circuitBreaker';
import { retry } from './retry';

export const dbClient = new Pool({
  connectionString: ENV.DATABASE_URL,
});

export async function testDbConnection(): Promise<boolean> {
  if (!canExecute()) {
    return false;
  }

  try {
    const start = Date.now();
    await retry(() => dbClient.query('SELECT 1'));
    const duration = Date.now() - start;

    if (duration > 500) {
      console.warn(`Slow DB query: ${duration}ms`);
    }

    return true;
  } catch {
    recordFailure();
    return false;
  }
}

/**
 * Typed query helper (replaces broken spread version)
 */
export function query(text: string, params?: any[]) {
  return dbClient.query(text, params);
}

// backward compatibility
export const pool = dbClient;
