import { testDbConnection } from '../lib/dbClient';

export async function assertDatabaseHealthy() {
  try {
    const result = await testDbConnection();
    console.log('DB OK:', result);
  } catch (err) {
    console.error('DB CONNECTION FAILED:', err);
    throw new Error('DATABASE_CONNECTION_FAILED');
  }
}
