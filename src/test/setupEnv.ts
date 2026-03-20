import dotenv from 'dotenv';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env.test');

dotenv.config({ path: envPath });

const required = [
  'JWT_SECRET',
  'DATABASE_URL',
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`);
  }
}

console.log('[TEST ENV LOADED]');
