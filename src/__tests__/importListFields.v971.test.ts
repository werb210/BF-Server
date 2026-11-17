// BF_SERVER_v971_IMPORT_LIST_FIELDS - prospect-list imports: tags, mobile, address, research fields, and matching a
// person with no email by name and company.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { answerBySql } from "./helpers/answerBySql.js";
import { bearer } from "./helpers/staffToken.js";

const h = vi.hoisted(() => ({ q: vi.fn() }));
vi.mock("../db.js", async (importOriginal) => {
  const real: any = await importOriginal();
  const query = (sql: unknown, params?: unknown[]) => h.q(sql, params);
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { ...real, pool, db: pool, default: pool, runQuery: query, dbQuery: query, query };
});
vi.mock("../modules/automation/automationEngine.js", () => ({
  emitAutomationEvent: vi.fn(async () => undefined), runAutomations: vi.fn(async () => undefined),
  defaultDeps: vi.fn(async () => ({ query: vi.fn(async () => ({ rows: [] })) })), runDue: vi.fn(async () => 0),
  runEnrollment: vi.fn(async () => "completed"), buildContext: vi.fn(async () => ({})),
}));

const CONTACT_COLS = ["id", "first_name", "last_name", "name", "email", "phone", "company_name", "job_title", "lead_status", "silo", "owner_id", "updated_at",
  "secondary_phone", "address_street", "address_city", "address_state", "address_zip", "address_country", "company_id", "tags", "custom_fields", "sms_opt_out", "marketing_contact", "merged_into_id"];
const COMPANY_COLS = ["id", "name", "website", "phone", "silo", "owner_id", "tags", "custom_fields", "address_street", "address_city", "address_state", "address_zip", "address_country", "employee_count", "updated_at"];

async function app() {
  const { default: crm } = await import("../routes/crm.js");
  const a = express(); a.use(express.json()); a.use("/api/crm", crm); return a;
}
const calls = () => h.q.mock.calls as Array<[string, unknown[]]>;
const find = (re: RegExp) => calls().filter(([sql]) => re.test(String(sql)));

beforeEach(() => {
  h.q.mockReset();
  h.q.mockImplementation(answerBySql([
    [/FROM information_schema\.columns[\s\S]*'contacts'/, { rows: CONTACT_COLS.map((column_name) => ({ column_name })) }],
    [/FROM information_schema\.columns[\s\S]*'companies'/, { rows: COMPANY_COLS.map((column_name) => ({ column_name })) }],
    [/SELECT id FROM companies WHERE silo = \$1 AND lower\(name\)/, (_s: string, p?: unknown[]) => (String(p?.[1]) === "Sample Capital" ? { rows: [{ id: "co-1" }] } : { rows: [] })],
    [/FROM contacts WHERE silo = \$1 AND COALESCE\(email, ''\) = ''/, (_s: string, p?: unknown[]) => (String(p?.[1]) === "Pat Known" ? { rows: [{ id: "ct-pat", name: "Pat Known" }] } : { rows: [] })],
    [/FROM contacts WHERE silo = \$1 AND lower\(email\) = lower\(\$2\)/, { rows: [] }],
    [/INSERT INTO contacts/, { rows: [{ id: "ct-new" }] }],
  ]));
});

describe("importing a prospect list", () => {
  it("keeps the tags, mobile, address, research fields and do-not-text mark on a new contact, linked to its company", async () => {
    const res = await request(await app()).post("/api/crm/contacts/import").set("Authorization", bearer("Admin")).set("X-Silo", "BI").send({ rows: [{
      name: "Sam Sample", company_name: "Sample Capital", phone: "(555) 010-0101", mobile: "(555) 010-0102", tags: ["Broker list Nov 2026", "Do not call: mobile"],
      address_city: "Calgary", address_state: "Alberta", sms_opt_out: true, custom_fields: { import_source: "List A", "Bad Key": "x", empty: " " },
    }] });
    expect(res.body).toMatchObject({ created: 1, updated: 0 });
    const [sql, params] = find(/INSERT INTO contacts/)[0]!;
    for (const col of ["secondary_phone", "address_city", "address_state", "company_id", "tags", "custom_fields", "sms_opt_out"]) expect(sql).toContain(col);
    expect(params).toContain("(555) 010-0102");
    expect(params).toContain("co-1");
    expect(params).toContainEqual(["Broker list Nov 2026", "Do not call: mobile"]);
    expect(params).toContain(JSON.stringify({ import_source: "List A" }));
  });
  it("a person with no email already on file is updated, not duplicated", async () => {
    const res = await request(await app()).post("/api/crm/contacts/import").set("Authorization", bearer("Admin")).send({ rows: [{ name: "Pat Known", company_name: "Sample Capital", tags: "A; B" }] });
    expect(res.body).toMatchObject({ created: 0, updated: 1 });
    expect(find(/INSERT INTO contacts/)).toHaveLength(0);
    const [sql, params] = find(/UPDATE contacts SET/)[0]!;
    expect(sql).toContain("DISTINCT unnest");
    expect(params).toContainEqual(["A", "B"]);
    expect(params?.[params.length - 1]).toBe("ct-pat");
  });
  it("a later copy of the list with the email fills it in on the same person", async () => {
    await request(await app()).post("/api/crm/contacts/import").set("Authorization", bearer("Admin")).send({ rows: [{ name: "Pat Known", company_name: "Sample Capital", email: "pat@sample.test" }] });
    const [, params] = find(/UPDATE contacts SET email = \$2 WHERE id = \$1/)[0]!;
    expect(params).toEqual(["ct-pat", "pat@sample.test"]);
  });
  it("a file with only the basic columns imports exactly as before", async () => {
    await request(await app()).post("/api/crm/contacts/import").set("Authorization", bearer("Admin")).send({ rows: [{ email: "plain@sample.test", first_name: "Plain" }] });
    const [sql] = find(/INSERT INTO contacts/)[0]!;
    for (const col of ["secondary_phone", "tags", "custom_fields", "sms_opt_out", "company_id"]) expect(sql).not.toContain(col);
  });
  it("companies keep website, phone, address, head count and research fields", async () => {
    const res = await request(await app()).post("/api/crm/companies/import").set("Authorization", bearer("Admin")).send({ rows: [{
      name: "New Lender Bank", website: "https://newlender.test", address_state: "Texas", employee_count: "140", tags: "Priority A", custom_fields: { sba_7a_loans_12m: 212 },
    }] });
    expect(res.body).toMatchObject({ created: 1 });
    const [sql, params] = find(/INSERT INTO companies/)[0]!;
    for (const col of ["website", "address_state", "employee_count", "custom_fields"]) expect(sql).toContain(col);
    expect(params).toContain(140);
    expect(params).toContain(JSON.stringify({ sba_7a_loans_12m: 212 }));
  });
});
