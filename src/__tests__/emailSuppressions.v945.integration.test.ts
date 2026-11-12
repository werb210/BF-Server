// BF_SERVER_v945_EMAIL_SUPPRESSIONS - a contact created with, or changed to, a suppressed address is opted out at once
// (real Postgres).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import { rerunMigration } from "./helpers/rerunMigration.js";

const IDS = ["f2600000-0000-4000-8000-000000000001", "f2600000-0000-4000-8000-000000000002", "f2600000-0000-4000-8000-000000000003", "f2600000-0000-4000-8000-000000000004"];
const SQL = readFileSync("migrations/2026_12_01_v945_email_suppressions.sql", "utf8");
const optedOut = async (id: string) => (await pool.query(`SELECT marketing_opt_out FROM contacts WHERE id = $1`, [id])).rows[0]?.marketing_opt_out;
async function cleanup() {
  await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [IDS]);
  await pool.query(`DELETE FROM email_suppressions WHERE email LIKE '%@suppress-v945.test'`);
}

describe("suppressed addresses stay suppressed (real Postgres)", () => {
  beforeAll(async () => {
    await rerunMigration(pool, SQL);
    await cleanup();
    await pool.query(`INSERT INTO contacts (id, name, email, silo, marketing_opt_out) VALUES ($1, 'Already Out', 'already@suppress-v945.test', 'BF', true)`, [IDS[3]]);
    await rerunMigration(pool, SQL); // safe to run again, and carries forward contacts already opted out
    await pool.query(`INSERT INTO email_suppressions (email, reason) VALUES ('gone@suppress-v945.test', 'unsubscribe') ON CONFLICT DO NOTHING`);
  });
  afterAll(async () => { await cleanup().catch((e) => console.warn("cleanup", String(e))); });

  it("carries forward addresses that were already opted out", async () => {
    const r = await pool.query(`SELECT source FROM email_suppressions WHERE email = 'already@suppress-v945.test'`);
    expect(r.rows[0]?.source).toBe("backfill");
  });

  it("opts out a new contact imported with a suppressed address, primary or secondary", async () => {
    await pool.query(`INSERT INTO contacts (id, name, email, silo) VALUES ($1, 'Imported Again', ' Gone@suppress-v945.test ', 'BF')`, [IDS[0]]);
    await pool.query(`INSERT INTO contacts (id, name, email, secondary_email, silo) VALUES ($1, 'Second Address', 'fine@suppress-v945.test', 'gone@suppress-v945.test', 'BI')`, [IDS[1]]);
    expect(await optedOut(IDS[0]!)).toBe(true);
    expect(await optedOut(IDS[1]!)).toBe(true);
  });

  it("leaves other addresses and Keystone prospects alone, and lets staff opt someone back in", async () => {
    await pool.query(`INSERT INTO contacts (id, name, email, silo) VALUES ($1, 'Keystone Prospect', 'gone@suppress-v945.test', 'KS')`, [IDS[2]]);
    expect(await optedOut(IDS[2]!)).toBe(false);
    await pool.query(`UPDATE contacts SET marketing_opt_out = false, name = 'Asked To Rejoin' WHERE id = $1`, [IDS[0]]);
    expect(await optedOut(IDS[0]!)).toBe(false);
    // Changing a contact's address to a suppressed one opts them out.
    await pool.query(`UPDATE contacts SET email = 'other@suppress-v945.test', secondary_email = NULL, marketing_opt_out = false WHERE id = $1`, [IDS[1]]);
    expect(await optedOut(IDS[1]!)).toBe(false);
    await pool.query(`UPDATE contacts SET email = 'gone@suppress-v945.test' WHERE id = $1`, [IDS[1]]);
    expect(await optedOut(IDS[1]!)).toBe(true);
  });
});
