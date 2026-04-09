import { runQuery } from "../db.js";
export async function pushDeadLetter(payload) {
    try {
        await runQuery(`
      INSERT INTO failed_jobs (type, data, error, created_at)
      VALUES ($1, $2::jsonb, $3, NOW())
      `, [payload.type, JSON.stringify(payload.data), payload.error]);
    }
    catch (err) {
        console.error("FAILED TO WRITE DEAD LETTER", err);
    }
}
