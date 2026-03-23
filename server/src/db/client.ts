import { Pool } from 'pg';
import { config } from '../../../src/config';

const connectionString = config.db.url;

if (!connectionString) {
  throw new Error('DATABASE_URL is not defined');
}

export const dbClient = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});
