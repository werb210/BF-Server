import { canExecute, recordFailure } from './circuitBreaker.js';
import { retry } from './retry.js';
import { dbClient } from '../platform/dbClient.js';
export { dbClient };
export async function testDbConnection() {
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
    }
    catch {
        recordFailure();
        return false;
    }
}
export function query(text, params) {
    return dbClient.query(text, params);
}
export const pool = dbClient;
