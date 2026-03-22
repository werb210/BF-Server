import { testDbConnection } from '../lib/dbClient';

export async function dbHealth() {
  const ok = await testDbConnection();
  return { db: ok ? 'ok' : 'fail' };
}
