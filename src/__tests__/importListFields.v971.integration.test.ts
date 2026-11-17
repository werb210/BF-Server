// BF_SERVER_v971_IMPORT_LIST_FIELDS - the extended contact and company imports against the real schema.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { pool } from "../db.js";
import { bearer, STAFF_USER_ID } from "./helpers/staffToken.js";

vi.mock("../modules/automation/automationEngine.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitAutomationEvent: vi.fn(async () => undefined),
}));

const tag = "v971-" + Math.floor(Math.random() * 1e9);
const company = `Sample Lender ${tag}`;
const person = `Pat ${tag}`;

async function app() {
  const { default: crm } = await import("../routes/crm.js");
  const a = express(); a.use(express.json()); a.use("/api/crm", crm);
  a.use((err: any, _req: any, res: any, _next: any) => res.status(500).json({ error: String(err?.message ?? err) }));
  return a;
}

describe("prospect-list import on the real schema", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO users (id, email, role, active) VALUES ($1, $2, 'Admin', true) ON CONFLICT (id) DO NOTHING`, [STAFF_USER_ID, `staff-${tag}@example.com`]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM contacts WHERE company_name = $1`, [company]).catch((e) => console.warn("cleanup", String(e)));
    await pool.query(`DELETE FROM companies WHERE name = $1`, [company]).catch((e) => console.warn("cleanup", String(e)));
  });

  it("imports the company, then the person linked to it, and a second import updates rather than duplicates", async () => {
    const a = await app();
    const co = await request(a).post("/api/crm/companies/import").set("Authorization", bearer("Admin")).set("X-Silo", "BI").send({ rows: [{
      name: company, website: "https://lender.test", address_city: "Austin", address_state: "Texas", employee_count: 140, tags: "Priority A; US lender list", custom_fields: { sba_7a_loans_12m: 212 },
    }] });
    expect(co.body).toMatchObject({ created: 1 });

    const row = { name: person, company_name: company, phone: "(555) 010-0101", mobile: "(555) 010-0102", tags: ["US lender list", "Do not call: mobile"],
      address_city: "Austin", address_state: "Texas", sms_opt_out: true, custom_fields: { import_source: "List A" } };
    const first = await request(a).post("/api/crm/contacts/import").set("Authorization", bearer("Admin")).set("X-Silo", "BI").send({ rows: [row] });
    expect(first.body).toMatchObject({ created: 1, updated: 0 });
    const again = await request(a).post("/api/crm/contacts/import").set("Authorization", bearer("Admin")).set("X-Silo", "BI").send({ rows: [{ ...row, tags: ["Second tag"] }] });
    expect(again.body).toMatchObject({ created: 0, updated: 1 });
    await request(a).post("/api/crm/contacts/import").set("Authorization", bearer("Admin")).set("X-Silo", "BI").send({ rows: [{ ...row, email: `pat.${tag}@lender.test` }] });

    const c = await pool.query(`SELECT c.*, co.name AS co_name, co.custom_fields AS co_custom, co.employee_count FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE c.company_name = $1`, [company]);
    expect(c.rows).toHaveLength(1);
    const r = c.rows[0];
    expect(r.silo).toBe("BI");
    expect(r.email).toBe(`pat.${tag}@lender.test`);
    expect(r.secondary_phone).toContain("0102");
    expect(r.address_state).toBe("Texas");
    expect(r.sms_opt_out).toBe(true);
    expect([...r.tags].sort()).toEqual(["Do not call: mobile", "Second tag", "US lender list"]);
    expect(r.custom_fields).toMatchObject({ import_source: "List A" });
    expect(r.co_name).toBe(company);
    expect(r.co_custom).toMatchObject({ sba_7a_loans_12m: 212 });
    expect(Number(r.employee_count)).toBe(140);
  });
});
