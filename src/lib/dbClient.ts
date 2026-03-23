import { Pool } from 'pg';
import { ENV } from '../config/env';

export const dbClient = new Pool({
  connectionString: ENV.DATABASE_URL,
});

export async function testDbConnection(): Promise<boolean> {
  try {
    await dbClient.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
