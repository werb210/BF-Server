import { testDbConnection } from '../lib/dbClient';

export async function dbHealth() {
  const ok = await testDbConnection();
  return { db: ok ? 'ok' : 'fail' };
}

export async function assertDatabaseHealthy(): Promise<void> {
  const ok = await testDbConnection();
  if (!ok) {
    throw new Error('database_not_healthy');
  }
}
