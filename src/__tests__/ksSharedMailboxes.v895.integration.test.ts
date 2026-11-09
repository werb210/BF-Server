// BF_SERVER_v895_KS_INBOX - Keystone's four shared mailboxes, in silo KS only, against real Postgres.
// Reads only; runs the migration again to prove it adds nothing the second time.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";

const MIGRATION = "migrations/2026_11_20_v895_ks_shared_mailboxes.sql";
const KS = ["accounting@keystonecrm.online", "app@keystonecrm.online", "info@keystonecrm.online", "sales@keystonecrm.online", "support@keystonecrm.online"]; // BF_SERVER_v915_KS_APP_MAILBOX - app@ added

describe("Keystone shared mailboxes", () => {
  it("are in silo KS, never in BF, and the migration is safe to run twice", async () => {
    await pool.query(readFileSync(MIGRATION, "utf8"));
    await pool.query(readFileSync(MIGRATION, "utf8"));
    const ks = await pool.query(
      `SELECT LOWER(address) AS address, count(*)::int AS n FROM shared_mailbox_settings
        WHERE silo = 'KS' AND LOWER(address) LIKE '%@keystonecrm.online' GROUP BY 1 ORDER BY 1`);
    expect(ks.rows.map((r) => r.address)).toEqual(KS);
    expect(ks.rows.every((r) => r.n === 1)).toBe(true);
    const bf = await pool.query(`SELECT 1 FROM shared_mailbox_settings WHERE silo <> 'KS' AND LOWER(address) LIKE '%@keystonecrm.online'`);
    expect(bf.rows).toEqual([]);
  });
});
