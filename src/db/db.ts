import { Pool } from 'pg';

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

db.on('connect', () => {
  console.log('Postgres connected');
});

db.on('error', (err) => {
  console.error('Postgres error', err);
});
