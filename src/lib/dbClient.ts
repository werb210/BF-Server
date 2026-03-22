import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not defined');
}

export const dbClient = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

export async function testDbConnection(): Promise<boolean> {
  try {
    const client = await dbClient.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch {
    return false;
  }
}
