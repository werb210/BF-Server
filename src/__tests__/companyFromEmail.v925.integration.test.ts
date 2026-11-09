// BF_SERVER_v925_COMPANY_FROM_EMAIL - link or create the company from the email domain (real Postgres).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { linkCompaniesFromEmail } from "../crm/companyFromEmail.js";

const t = randomUUID().slice(0, 8);
const existingCo = randomUUID();
const cMatch = randomUUID(), cNew = randomUUID(), cFree = randomUUID(), cNamed = randomUUID();
const contacts = [cMatch, cNew, cFree, cNamed];

describe("v925 company from email", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO companies (id, name, domain, silo) VALUES ($1, $2, $3, 'SLF')`, [existingCo, `Acme${t} Ltd`, `acme${t}.com`]);
    const q = `INSERT INTO contacts (id, name, email, silo, company_name) VALUES ($1, $2, $3, 'SLF', $4)`;
    await pool.query(q, [cMatch, `Match ${t}`, `pat@acme${t}.com`, null]);
    await pool.query(q, [cNew, `New ${t}`, `kat@sign-now${t}.com`, null]);
    await pool.query(q, [cFree, `Free ${t}`, `free${t}@gmail.com`, null]);
    await pool.query(q, [cNamed, `Named ${t}`, `lee@lee${t}.ca`, `Lee${t} Holdings Inc`]);
  });
  afterAll(async () => {
    const ids = (await pool.query(`SELECT company_id FROM contacts WHERE id = ANY($1::uuid[])`, [contacts])).rows.map((r: any) => r.company_id).filter(Boolean);
    await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [contacts]).catch((e) => console.warn("cleanup", String(e)));
    await pool.query(`DELETE FROM companies WHERE id = ANY($1::uuid[])`, [[existingCo, ...ids]]).catch((e) => console.warn("cleanup", String(e)));
  });

  it("links to the matching company, creates the missing ones, skips free mail", async () => {
    await linkCompaniesFromEmail(pool as any, 5000);
    const rows = Object.fromEntries((await pool.query(
      `SELECT c.id::text AS id, c.company_id::text AS company_id, co.name, co.domain FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE c.id = ANY($1::uuid[])`,
      [contacts])).rows.map((r: any) => [r.id, r]));
    expect(rows[cMatch].company_id).toBe(existingCo);
    expect(rows[cNew].name).toBe(`Sign Now${t}`);
    expect(rows[cNew].domain).toBe(`sign-now${t}.com`);
    expect(rows[cFree].company_id).toBeNull();
    expect(rows[cNamed].name).toBe(`Lee${t} Holdings Inc`);
  });

  it("is safe to run again (no duplicates)", async () => {
    const before = (await pool.query(`SELECT count(*)::int AS n FROM companies WHERE domain LIKE $1`, [`%${t}%`])).rows[0].n;
    await linkCompaniesFromEmail(pool as any, 5000);
    expect((await pool.query(`SELECT count(*)::int AS n FROM companies WHERE domain LIKE $1`, [`%${t}%`])).rows[0].n).toBe(before);
  });
});
