import { canExecute, recordFailure } from './circuitBreaker';
import { retry } from './retry';
import { dbClient } from '../platform/dbClient';

export { dbClient };

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

export function query(text: string, params?: unknown[]) {
  return dbClient.query(text, params);
}

export const pool = dbClient;
