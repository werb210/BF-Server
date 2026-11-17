// BF_SERVER_v974_CRM_SORT_ALL_COLUMNS - the contact list sorts by Tags and by Marketing, on the real schema.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { pool } from "../db.js";
import { bearer, STAFF_USER_ID } from "./helpers/staffToken.js";

const tag = "v974-" + Math.floor(Math.random() * 1e9);
async function app() {
  const { default: crm } = await import("../routes/crm.js");
  const a = express(); a.use(express.json()); a.use("/api/crm", crm);
  a.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: String(err?.message ?? err) }));
  return a;
}
const names = (body: any): string[] => (body?.contacts ?? body?.data ?? body?.items ?? body ?? []).map((c: any) => String(c.name)).filter((n: string) => n.includes(tag));

describe("sorting the contact list by every column", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO users (id, email, role, active) VALUES ($1, $2, 'Admin', true) ON CONFLICT (id) DO NOTHING`, [STAFF_USER_ID, `staff-${tag}@example.com`]);
    const add = (name: string, tags: string[], marketing: boolean, email: string | null) => pool.query(
      `INSERT INTO contacts (name, silo, tags, marketing_contact, email) VALUES ($1, 'KS', $2, $3, $4)`, [`${name} ${tag}`, tags, marketing, email]);
    await add("One", ["zebra"], true, `one.${tag}@example.com`);
    await add("Two", ["apple", "mango"], false, `two.${tag}@example.com`);
    await add("Three", [], true, null);
  });
  afterAll(async () => { await pool.query(`DELETE FROM contacts WHERE name LIKE $1`, [`% ${tag}`]); });

  it("Tags: A to Z with untagged last; Marketing: No before Yes when ascending", async () => {
    const a = await app();
    const get = (sort: string) => request(a).get(`/api/crm/contacts?sort=${sort}&q=${tag}&pageSize=50`).set("Authorization", bearer("Admin")).set("X-Silo", "KS");
    const byTags = await get("tags:asc");
    expect(byTags.status).toBe(200);
    expect(names(byTags.body)).toEqual([`Two ${tag}`, `One ${tag}`, `Three ${tag}`]);
    const byMarketing = await get("marketing_contact:asc");
    expect(names(byMarketing.body)[0]).toBe(`Two ${tag}`);
    expect(names((await get("marketing_contact:desc")).body).at(-1)).toBe(`Two ${tag}`);
  });

  it("the marketing summary says how many marketing contacts have no email address", async () => {
    const a = await app();
    const before = await request(a).get("/api/crm/contacts/marketing-summary").set("Authorization", bearer("Admin")).set("X-Silo", "KS");
    expect(before.body.no_email).toBeGreaterThanOrEqual(1);
    expect(before.body.marketing).toBeGreaterThanOrEqual(before.body.no_email);
  });
});
