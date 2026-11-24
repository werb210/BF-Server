// BF_SERVER_v921_SHARED_PHONE - an office main line on many contacts is not a duplicate reason on its own (real Postgres).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { contactDuplicates, duplicateGroups } from "../modules/crmUnify/duplicates.js";

const tag = randomUUID().slice(0, 8);
const n = () => String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
const MAIN = `+1416${n()}`;
const PAIR = `+1403${n()}`;
const main = Array.from({ length: 6 }, () => randomUUID());
const pair = [randomUUID(), randomUUID()];
const all = [...main, ...pair];

describe("v921 shared office phone (real Postgres)", () => {
  beforeAll(async () => {
    for (const [i, id] of main.entries()) {
      await pool.query(`INSERT INTO contacts (id, name, email, phone, silo) VALUES ($1, $2, $3, $4, 'SLF')`,
        [id, `Main${tag} Person${i} Surname${i}`, `main${i}-${tag}@example.com`, MAIN]);
    }
    await pool.query(`INSERT INTO contacts (id, name, email, phone, silo) VALUES ($1, $2, $3, $4, 'SLF'), ($5, $6, $7, $8, 'SLF')`,
      [pair[0], `Pair${tag} Alpha One`, `pa-${tag}@example.com`, PAIR, pair[1], "Unknown (application started)", `pb-${tag}@example.com`, PAIR]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [all]).catch((e) => console.warn("cleanup", String(e)));
  });

  it("the Find duplicates page groups the 2-person number but not the 6-person main line", async () => {
    const groups = await duplicateGroups(pool as any, "SLF", "contact", 5000);
    const mine = groups.filter((g) => g.ids.some((id) => all.includes(id)));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.ids.slice().sort()).toEqual(pair.slice().sort());
    expect(mine[0]!.reasons).toEqual(["Same phone"]);
  });

  it("the contact banner agrees", async () => {
    expect((await contactDuplicates(pool as any, main[0]!, "SLF")).filter((c) => all.includes(c.id))).toEqual([]);
    expect((await contactDuplicates(pool as any, pair[0]!, "SLF")).map((c) => c.id)).toEqual([pair[1]]);
  });

  // BF_SERVER_DUP_NAMES_v2
  it("names: a shared first letter is not the same person; nicknames and initials still are", async () => {
    const q = async (a: string, b: string) => (await pool.query(`SELECT bf_same_person_name($1, $2) AS v`, [a, b])).rows[0].v;
    expect(await q("Dolly Myerson", "Dylan Myerson")).toBe(false);
    expect(await q("Mike Cotic", "MICHAEL COTIC")).toBe(true);
    expect(await q("J Smith", "John Smith")).toBe(true);
    expect(await q("Mike Cotic", "Mike Jones")).toBe(false);
  });
});
