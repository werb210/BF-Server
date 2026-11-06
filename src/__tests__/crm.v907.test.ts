// BF_SERVER_v907_CRM - partial mass delete, work email -> company, "find more sources", and ignoring a clean-up proposal.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", () => ({ pool: { query: queryMock }, db: { query: queryMock }, runQuery: queryMock }));

import crmRoutes from "../routes/crm.js";
import { companyNameFromDomain, linkContactToCompanyByEmail, workEmailDomain } from "../services/crm/companyFromEmail.js";
import { findMoreSources, normalizeMoreSources } from "../modules/crmUnify/aiSummary.js";
import { ignoreKey, scanCleanup } from "../modules/crmUnify/cleanup.js";

const C1 = "11111111-aaaa-4aaa-8aaa-000000000001";
const C2 = "11111111-aaaa-4aaa-8aaa-000000000002";
const C3 = "11111111-aaaa-4aaa-8aaa-000000000003";
const ADMIN = "99999999-9999-4999-8999-999999999999";
const token = () => jwt.sign({ sub: ADMIN, id: ADMIN, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
function server() {
  const a = express();
  a.use(express.json());
  a.use("/api/crm", crmRoutes);
  return a;
}

beforeEach(() => { queryMock.mockReset(); });

describe("companies mass delete (v907)", () => {
  it("deletes the deletable companies and reports the others with the reason", async () => {
    queryMock.mockImplementation(answerBySql([
      [/SELECT id FROM companies WHERE id = ANY/, (_s: string, p?: unknown[]) => ({ rows: (p![0] as string[]).map((id) => ({ id })) })],
      [/FROM retention_applications/, { rows: [] }],
      [/has_applications/, { rows: [{ id: C1, has_applications: true, has_contacts: true }, { id: C2, has_applications: false, has_contacts: true }, { id: C3, has_applications: false, has_contacts: false }] }],
      [/SELECT id::text AS id, COALESCE\(NULLIF\(name, ''\), id::text\) AS name FROM companies/, { rows: [{ id: C1, name: "Acme Ltd" }, { id: C2, name: "Beta Inc" }] }],
      [/DELETE FROM companies/, { rows: [], rowCount: 1 }],
    ]));
    const r = await request(server()).post("/api/crm/companies/bulk-delete").set("Authorization", `Bearer ${token()}`).send({ ids: [C1, C2, C3] });
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(1);
    expect(r.body.skipped).toEqual([
      { id: C1, name: "Acme Ltd", reason: "has applications" },
      { id: C2, name: "Beta Inc", reason: "has contacts (delete or move them first)" },
    ]);
    const [del] = callsMatching(queryMock, /DELETE FROM companies/);
    expect((del![1] as unknown[])[0]).toEqual([C3]);
  });
  it("still answers fk_protected when none can be deleted", async () => {
    queryMock.mockImplementation(answerBySql([
      [/SELECT id FROM companies WHERE id = ANY/, { rows: [{ id: C1 }] }],
      [/has_applications/, { rows: [{ id: C1, has_applications: true, has_contacts: false }] }],
    ]));
    const r = await request(server()).post("/api/crm/companies/bulk-delete").set("Authorization", `Bearer ${token()}`).send({ ids: [C1] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "fk_protected", protectedIds: [C1] });
    expect(callsMatching(queryMock, /DELETE FROM companies/)).toHaveLength(0);
  });
});

describe("work email -> company (v907)", () => {
  it("skips free email providers", () => {
    for (const e of ["a@gmail.com", "b@hotmail.com", "c@outlook.com", "d@icloud.com", "e@yahoo.com", "bad"]) expect(workEmailDomain(e)).toBeNull();
    expect(workEmailDomain("Jane@Acme-Steel.CA")).toBe("acme-steel.ca");
    expect(companyNameFromDomain("acme-steel.ca")).toBe("Acme Steel");
  });
  it("attaches to the company with that domain or website", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM contacts WHERE id::text = \$1/, { rows: [{ id: C1, email: "jane@acme.ca", company_id: null, silo: "BF", owner_id: null }] }],
      [/SELECT id::text AS id FROM companies/, { rows: [{ id: C2 }] }],
    ]));
    expect(await linkContactToCompanyByEmail({ query: queryMock }, C1)).toEqual({ company_id: C2, created: false, domain: "acme.ca" });
    expect(callsMatching(queryMock, /INSERT INTO companies/)).toHaveLength(0);
    expect(callsMatching(queryMock, /UPDATE contacts SET company_id/)[0]![1]).toEqual([C1, C2]);
  });
  it("creates the company when there is none, and leaves a contact with a company alone", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM contacts WHERE id::text = \$1/, { rows: [{ id: C1, email: "jane@acme.ca", company_id: null, silo: "BF", owner_id: null }] }],
      [/INSERT INTO companies/, { rows: [{ id: C3 }] }],
    ]));
    expect(await linkContactToCompanyByEmail({ query: queryMock }, C1)).toEqual({ company_id: C3, created: true, domain: "acme.ca" });
    expect(callsMatching(queryMock, /INSERT INTO companies/)[0]![1]).toEqual(["Acme", "https://acme.ca", "acme.ca", "BF", null]);
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql([[/FROM contacts WHERE id::text = \$1/, { rows: [{ id: C1, email: "jane@acme.ca", company_id: C2, silo: "BF" }] }]]));
    expect(await linkContactToCompanyByEmail({ query: queryMock }, C1)).toBeNull();
  });
});

describe("find more sources (v907)", () => {
  it("keeps public https pages and only public LinkedIn profiles", () => {
    const r = normalizeMoreSources({
      sources: [
        { label: "LinkedIn", url: "https://www.linkedin.com/in/jane-doe", detail: "CFO at Acme" },
        { label: "Login", url: "https://www.linkedin.com/feed/" },
        { label: "Team", url: "https://acme.ca/team" },
        { label: "Dup", url: "https://acme.ca/team/" },
        { label: "Plain", url: "http://insecure.example" },
      ],
      photo_url: "https://acme.ca/img/jane.jpg",
    });
    expect(r.sources.map((s) => s.url)).toEqual(["https://www.linkedin.com/in/jane-doe", "https://acme.ca/team"]);
    expect(r.photoUrl).toBe("https://acme.ca/img/jane.jpg");
    expect(normalizeMoreSources({ photo_url: "https://media.licdn.com/x.jpg" }).photoUrl).toBeNull();
  });
  it("adds the new pages to the saved summary's sources", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM contacts c LEFT JOIN companies co/, { rows: [{ name: "Jane Doe", job_title: "CFO", email: "jane@acme.ca", company: "Acme", website: "acme.ca" }] }],
      [/FROM crm_ai_summaries/, { rows: [{ summary: "s", business: null, sources: [{ type: "website", label: "acme.ca", url: "https://acme.ca/" }], generated_at: new Date() }] }],
    ]));
    const search = vi.fn(async () => ({ sources: [{ label: "LinkedIn", url: "https://www.linkedin.com/in/jane-doe" }] }));
    const out = await findMoreSources({ query: queryMock }, { search }, "BF", "contact", C1);
    expect(search.mock.calls[0]![0]).toContain('"Jane Doe", CFO at "Acme"');
    expect(out!.summary!.sources.map((s) => s.url)).toEqual(["https://acme.ca/", "https://www.linkedin.com/in/jane-doe"]);
    expect(callsMatching(queryMock, /UPDATE crm_ai_summaries SET sources/)).toHaveLength(1);
  });
});

describe("clean-up ignore (v907)", () => {
  it("an ignored proposal is not proposed again", async () => {
    queryMock.mockImplementation(answerBySql([
      [/FROM crm_cleanup_ignores/, { rows: [{ id: C1, field: "name", after_value: "Jane Doe" }] }],
      [/FROM contacts c/, { rows: [{ id: C1, name: "JANE DOE", first_name: null, last_name: null, email: "JANE@ACME.CA" }] }],
    ]));
    const changes = await scanCleanup({ query: queryMock }, "BF", "contact");
    expect(changes.some((c) => c.field === "name")).toBe(false);
    expect(changes.some((c) => c.field === "email")).toBe(true);
    expect(ignoreKey({ entityId: C1, field: "name", after: "Jane Doe" })).toBe(`${C1}|name|Jane Doe`);
  });
});
