import { pool } from '../db';
import { deps } from './deps';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 100;

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function initDependencies(): Promise<void> {
  // always reset before attempting init
  deps.db.ready = false;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // this should hit your DB ping
      await pool.query('SELECT 1');

      // CRITICAL: mutate the SAME shared object reference
      deps.db.ready = true;

      return;
    } catch {
      // keep it explicitly false during retries
      deps.db.ready = false;

      if (attempt < MAX_RETRIES) {
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  // final state after all retries exhausted
  deps.db.ready = false;

  // do NOT throw — tests expect server to stay alive
}
