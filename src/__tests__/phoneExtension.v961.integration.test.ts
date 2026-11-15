// BF_SERVER_v961_PHONE_EXTENSION - against a real Postgres: an extension written on the end of a number is moved to its
// own column however the number arrives, an ordinary number is left alone, and lender reps get the same.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import { rerunMigration } from "./helpers/rerunMigration.js";

const ids: string[] = []; const lender = randomUUID();
async function contact(phone: string | null, ext: string | null = null) {
  const id = randomUUID(); ids.push(id);
  await pool.query(`INSERT INTO contacts (id, name, phone, phone_extension, silo, created_at, updated_at) VALUES ($1, 'Sample Person', $2, $3, 'BF', now(), now())`, [id, phone, ext]);
  return id;
}
const read = async (id: string) => (await pool.query(`SELECT phone, phone_extension FROM contacts WHERE id = $1`, [id])).rows[0];

beforeAll(async () => {
  await rerunMigration(pool as any, readFileSync("migrations/2026_12_08_v960_lender_reps.sql", "utf8"));
  await rerunMigration(pool as any, readFileSync("migrations/2026_12_09_v961_phone_extension.sql", "utf8"));
  await pool.query(`INSERT INTO lenders (id, name, country) VALUES ($1, 'Sample Lender Ext', 'CA')`, [lender]);
});
afterAll(async () => {
  await pool.query(`DELETE FROM lender_reps WHERE lender_id = $1`, [lender]);
  await pool.query(`DELETE FROM lenders WHERE id = $1`, [lender]);
  await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [ids]);
});

describe("phone extensions", () => {
  it.each([
    ["(213) 555-0142 x106", "(213) 555-0142", "106"],
    ["213-555-0142 ext. 22", "213-555-0142", "22"],
    ["+12135550142,Extension 7", "+12135550142", "7"],
    ["2135550142 #4410", "2135550142", "4410"],
  ])("moves the extension out of %s", async (typed, phone, ext) => {
    expect(await read(await contact(typed))).toEqual({ phone, phone_extension: ext });
  });

  it("leaves an ordinary number alone and keeps an extension given on its own", async () => {
    expect(await read(await contact("(403) 555-0199"))).toEqual({ phone: "(403) 555-0199", phone_extension: null });
    expect(await read(await contact("(403) 555-0199", "x 305"))).toEqual({ phone: "(403) 555-0199", phone_extension: "305" });
    expect(await read(await contact(null))).toEqual({ phone: null, phone_extension: null });
  });

  it("splits on an edit as well, and an emptied extension is cleared", async () => {
    const id = await contact("(403) 555-0199");
    await pool.query(`UPDATE contacts SET phone = '403 555 0199 x9' WHERE id = $1`, [id]);
    expect(await read(id)).toEqual({ phone: "403 555 0199", phone_extension: "9" });
    await pool.query(`UPDATE contacts SET phone_extension = '' WHERE id = $1`, [id]);
    expect((await read(id)).phone_extension).toBeNull();
  });

  it("does the same for a lender rep", async () => {
    const { saveRep, listReps } = await import("../services/lenders/lenderReps.js");
    await saveRep(lender, { name: "Pat Sample", position: null, email: "pat@lender-ext.example", phone: "(213) 555-0142 x106" }, "tester");
    expect((await listReps(lender))[0]).toMatchObject({ phone: "(213) 555-0142", phone_extension: "106" });
  });
});
