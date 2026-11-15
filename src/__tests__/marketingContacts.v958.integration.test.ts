// BF_SERVER_v958_MARKETING_CONTACTS - against a real Postgres: a contact who unsubscribes stops being a marketing
// contact, cannot be put back while unsubscribed, and campaigns only reach marketing contacts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { readFileSync } from "node:fs";
import { rerunMigration } from "./helpers/rerunMigration.js";
import { EMAIL_BLAST_ELIGIBLE_SQL } from "../services/marketingSendRunner.js";

const a = randomUUID(); const b = randomUUID();
const tag = "v958-" + Math.floor(Math.random() * 1e6);

beforeAll(async () => {
  await rerunMigration(pool as any, readFileSync("migrations/2026_12_06_v958_marketing_contacts.sql", "utf8"));
  for (const id of [a, b]) {
    await pool.query(`INSERT INTO contacts (id, silo, name, email) VALUES ($1, 'BF', $2, $3)`, [id, "Test " + tag, `${id}@example.com`]);
  }
});
afterAll(async () => { await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [[a, b]]); });

const flag = async (id: string) => (await pool.query(`SELECT marketing_contact AS m FROM contacts WHERE id = $1`, [id])).rows[0]?.m;

describe("marketing contacts", () => {
  it("a new contact is a marketing contact", async () => {
    expect(await flag(a)).toBe(true);
  });
  it("unsubscribing removes the contact from the marketing contacts", async () => {
    await pool.query(`UPDATE contacts SET marketing_opt_out = true WHERE id = $1`, [a]);
    expect(await flag(a)).toBe(false);
  });
  it("an unsubscribed contact cannot be made a marketing contact again", async () => {
    await pool.query(`UPDATE contacts SET marketing_contact = true WHERE id = $1`, [a]);
    expect(await flag(a)).toBe(false);
  });
  it("campaign emails reach only marketing contacts", async () => {
    await pool.query(`UPDATE contacts SET marketing_contact = false WHERE id = $1`, [b]);
    const r = await pool.query(`SELECT c.id::text AS id FROM contacts c WHERE c.id = ANY($1::uuid[]) AND ${EMAIL_BLAST_ELIGIBLE_SQL}`, [[a, b]]);
    expect(r.rows).toEqual([]);
    await pool.query(`UPDATE contacts SET marketing_contact = true WHERE id = $1`, [b]);
    const again = await pool.query(`SELECT c.id::text AS id FROM contacts c WHERE c.id = ANY($1::uuid[]) AND COALESCE(c.marketing_contact, true)`, [[a, b]]);
    expect(again.rows.map((x: any) => x.id)).toEqual([b]);
  });
});
