// BF_SERVER_v944_FRAUD_AUTO_HOLD - moving a file to Fraud places a legal hold in its silo and notifies that silo's
// Admins (real Postgres).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import { rerunMigration } from "./helpers/rerunMigration.js";

const APP = "f2500000-0000-4000-8000-000000000001";
const ADMIN_BF = "f2500000-0000-4000-8000-0000000000a1";
const ADMIN_SLF = "f2500000-0000-4000-8000-0000000000a2";

async function cleanup() {
  await pool.query(`DELETE FROM notifications WHERE ref_id = $1`, [APP]);
  await pool.query(`DELETE FROM applications WHERE id = $1`, [APP]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ADMIN_BF, ADMIN_SLF]]);
  await pool.query(`BEGIN; ALTER TABLE legal_holds DISABLE TRIGGER ks_legal_holds_no_delete;
    DELETE FROM legal_holds WHERE target_id = '${APP}';
    ALTER TABLE legal_holds ENABLE TRIGGER ks_legal_holds_no_delete; COMMIT;`);
}
const holds = async () => (await pool.query(`SELECT reason, silo, released_at FROM legal_holds WHERE target_id = $1 ORDER BY placed_at`, [APP])).rows;

describe("Fraud places an automatic legal hold (real Postgres)", () => {
  beforeAll(async () => {
    await rerunMigration(pool, readFileSync("migrations/2026_10_24_v855_retention.sql", "utf8"));
    await rerunMigration(pool, readFileSync("migrations/2026_11_30_v944_fraud_auto_hold.sql", "utf8"));
    await rerunMigration(pool, readFileSync("migrations/2026_11_30_v944_fraud_auto_hold.sql", "utf8")); // safe to run again
    await cleanup();
    await pool.query(`INSERT INTO users (id, email, role, active, silo) VALUES ($1, 'fraud-admin-bf@test.local', 'Admin', true, 'BF'), ($2, 'fraud-admin-slf@test.local', 'Admin', true, 'SLF')`, [ADMIN_BF, ADMIN_SLF]);
    await pool.query(`INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, silo) VALUES ($1, 'Fraudulent Co', now(), now(), 'Received', 'RECEIVED', 'BF')`, [APP]);
  });
  afterAll(async () => { await cleanup().catch((e) => console.warn("cleanup", String(e))); });

  it("holds the file in its silo and tells that silo's Admins when it enters Fraud", async () => {
    expect(await holds()).toHaveLength(0);
    await pool.query(`UPDATE applications SET pipeline_state = 'Fraud' WHERE id = $1`, [APP]);
    const h = await holds();
    expect(h).toHaveLength(1);
    expect(h[0].reason).toMatch(/^Fraud - automatic/);
    expect(h[0].silo).toBe("BF");
    // Other tests may leave Admins behind; only this test's two are checked.
    const n = await pool.query(`SELECT user_id::text AS user_id, type FROM notifications WHERE ref_id = $1 AND user_id = ANY($2::uuid[])`, [APP, [ADMIN_BF, ADMIN_SLF]]);
    expect(n.rows).toEqual([{ user_id: ADMIN_BF, type: "fraud_legal_hold" }]);
  });

  it("keeps the hold when the file leaves Fraud, and never doubles it", async () => {
    await pool.query(`UPDATE applications SET pipeline_state = 'Hold' WHERE id = $1`, [APP]);
    await pool.query(`UPDATE applications SET pipeline_state = 'Fraud' WHERE id = $1`, [APP]);
    const h = await holds();
    expect(h).toHaveLength(1);
    expect(h[0].released_at).toBeNull();
  });
});
