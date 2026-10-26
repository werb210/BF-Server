// BF_SERVER_v856_CRM_UNIFY - the /api/crm/unified routes and the CRM list changes, behind a real staff token, with
// the database faked by SQL content.
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, type SqlRule } from "../../__tests__/helpers/answerBySql.js";
import { mountRouter, staffToken } from "../../__tests__/helpers/staffRouterApp.js";

const h = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), brief: vi.fn(), background: vi.fn() }));
vi.mock("../../db.js", async () => ({
  ...(await vi.importActual<any>("../../db.js")),
  pool: { query: h.query, connect: async () => ({ query: h.query, release: h.release }) },
  dbQuery: h.query,
}));
vi.mock("../../modules/automation/automationEngine.js", async () => ({
  ...(await vi.importActual<any>("../../modules/automation/automationEngine.js")),
  emitAutomationEvent: async () => undefined,
}));
vi.mock("../../services/crm/contactBrief.js", async () => ({
  ...(await vi.importActual<any>("../../services/crm/contactBrief.js")),
  contactBrief: h.brief,
  companyBrief: h.brief,
  companyBackground: h.background,
}));

const CONTACT = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const COMPANY = "22222222-2222-4222-8222-222222222222";

async function app() {
  return mountRouter((await import("../crm.js")).default, "/api/crm");
}
const auth = (role: "Admin" | "Staff" = "Admin") => ({ Authorization: `Bearer ${staffToken(role)}` });
function db(rules: SqlRule[]) {
  h.query.mockImplementation(answerBySql(rules));
}

beforeEach(() => {
  h.query.mockReset();
  h.release.mockReset();
  h.brief.mockReset();
  h.background.mockReset();
  db([]);
});
afterEach(() => vi.restoreAllMocks());

describe("tags", () => {
  it("lists core, silo and system tags with the tags in use, merged after normalising", async () => {
    db([
      [/FROM crm_tag_definitions/, { rows: [{ slug: "vip", label: "VIP" }] }],
      [/unnest\(coalesce\(c\.tags/, { rows: [{ tag: "Lender", contacts: 2, companies: 0 }, { tag: "lender", contacts: 1, companies: 1 }, { tag: "Contact form", contacts: 4, companies: 0 }] }],
    ]);
    const r = await request(await app()).get("/api/crm/unified/tags").set(auth()).set("X-Silo", "SLF");
    expect(r.status).toBe(200);
    expect(r.body.data.core.map((t: any) => t.slug)).toEqual(["lender", "broker", "lawyer", "accountant", "referrer", "active", "insurance", "ar_credit_insurance"]);
    expect(r.body.data.custom).toEqual([{ slug: "vip", label: "VIP", kind: "custom" }]);
    expect(r.body.data.inUse).toEqual(expect.arrayContaining([
      { tag: "lender", label: "Lender", kind: "core", contacts: 3, companies: 1 },
      { tag: "contact_form", label: "contact_form", kind: "system", contacts: 4, companies: 0 },
    ]));
    expect(callsMatching(h.query, /FROM crm_tag_definitions/)[0]![1]).toEqual(["SLF"]);
  });

  it("adds and removes tags in bulk (Active included), normalised, in the request's silo", async () => {
    db([[/UPDATE contacts\s+SET tags = bf_norm_tags/, { rows: [], rowCount: 2 }]]);
    const r = await request(await app()).post("/api/crm/unified/tags/apply").set(auth("Admin")).set("X-Silo", "KS")
      .send({ entity: "contact", ids: [CONTACT, OTHER, "junk"], remove: ["Active"] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ updated: 2, added: [], removed: ["active"] });
    const call = callsMatching(h.query, /UPDATE contacts\s+SET tags/)[0]!;
    expect(call[1]).toEqual([[CONTACT, OTHER], [], ["active"], "KS"]);
  });

  it("refuses to add or remove a system tag by hand", async () => {
    const r = await request(await app()).post("/api/crm/unified/tags/apply").set(auth()).send({ entity: "company", ids: [COMPANY], add: ["application_started"] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("system_tag");
    expect(callsMatching(h.query, /UPDATE companies/)).toHaveLength(0);
  });

  it("only an Admin edits the silo tag list", async () => {
    expect((await request(await app()).post("/api/crm/unified/tags/definitions").set(auth("Staff")).send({ label: "VIP" })).status).toBe(403);
    const ok = await request(await app()).post("/api/crm/unified/tags/definitions").set(auth("Admin")).set("X-Silo", "BF").send({ label: "Insurance agent" });
    expect(ok.status).toBe(201);
    expect(callsMatching(h.query, /INSERT INTO crm_tag_definitions/)[0]![1]).toEqual(["BF", "insurance_agent", "Insurance agent", expect.anything()]);
    expect((await request(await app()).post("/api/crm/unified/tags/definitions").set(auth()).send({ label: "Lender" })).status).toBe(409);
  });
});

describe("CRM lists", () => {
  it("contacts: company name from the linked company, tags any-of and untagged", async () => {
    db([[/count\(\*\)::int AS total/, { rows: [{ total: 0 }] }], [/information_schema\.columns/, { rows: ["company_name", "company_id", "lead_status", "tags", "owner_id", "status"].map((column_name) => ({ column_name })) }]]);
    const r = await request(await app()).get("/api/crm/contacts?tags=Lender,__none__").set(auth());
    expect(r.status).toBe(200);
    const list = callsMatching(h.query, /FROM contacts c\s+LEFT JOIN companies co/).find((c) => /LIMIT \$/.test(String(c[0])))!;
    expect(String(list[0])).toContain("coalesce(nullif(btrim(co.name), ''), nullif(btrim(c.company_name), ''),");
    expect(String(list[0])).toContain("FROM applications a2 WHERE a2.contact_id = c.id"); // then the application's business name
    expect(String(list[0])).toContain("bf_norm_tag(t) = ANY(");
    expect(list[1]).toEqual(expect.arrayContaining([["lender"], expect.arrayContaining(["application_started", "contact_form"])]));
  });
  it("companies: the same tag filter", async () => {
    db([[/count\(\*\)::int AS total/, { rows: [{ total: 0 }] }]]);
    const r = await request(await app()).get("/api/crm/companies?tags=__none__").set(auth());
    expect(r.status).toBe(200);
    const list = callsMatching(h.query, /FROM companies co/)[0]!;
    expect(String(list[0])).toContain("NOT EXISTS (SELECT 1 FROM unnest(coalesce(co.tags");
  });
});

describe("company people", () => {
  it("groups everyone linked to the company, including partners typed into the application", async () => {
    db([
      [/SELECT 1 FROM companies WHERE id/, { rows: [{ "?column?": 1 }], rowCount: 1 }],
      [/FROM applications a\s+WHERE a\.silo = \$2\s+AND \(a\.company_id/, { rows: [{ id: "app-1", contact_id: CONTACT, metadata: { applicant: { partnerFirstName: "Elizabeth", partnerLastName: "Cullen", partnerEmail: "pokecullen@gmail.com" } } }] }],
      [/FROM contacts c\s+WHERE c\.silo = \$2/, { rows: [{ id: CONTACT, name: "Sean Dwyer", email: "pokedwyer@gmail.com", phone: "+13238982498", is_app_primary: true }] }],
      [/FROM application_form_responses/, { rows: [{ application_id: "app-1", data: { advisors: { cpa: { contact: "Ann Count", email: "ann@numbers.ca" } } } }] }],
    ]);
    const r = await request(await app()).get(`/api/crm/unified/companies/${COMPANY}/people`).set(auth());
    expect(r.status).toBe(200);
    const g = r.body.data.groups;
    expect(g.primary).toEqual([expect.objectContaining({ name: "Sean Dwyer", contactId: CONTACT })]);
    expect(g.partners).toEqual([expect.objectContaining({ name: "Elizabeth Cullen", email: "pokecullen@gmail.com", source: "application" })]);
    expect(g.advisors).toEqual([expect.objectContaining({ name: "Ann Count", role: "accountant" })]);
  });

  it("adds a person with a role (creating the contact) and audits it; removing is audited too", async () => {
    db([
      [/SELECT id, name FROM companies/, { rows: [{ id: COMPANY, name: "Poke Prod LLC" }] }],
      [/INSERT INTO contacts/, { rows: [{ id: OTHER }] }],
      [/SELECT 1 FROM companies WHERE id/, { rows: [{}], rowCount: 1 }],
    ]);
    const add = await request(await app()).post(`/api/crm/unified/companies/${COMPANY}/people`).set(auth("Staff"))
      .send({ role: "lawyer", contact: { name: "Larry Law", email: "Larry@Law.CA" } });
    expect(add.status).toBe(201);
    expect(callsMatching(h.query, /INSERT INTO crm_company_people /)[0]![1]).toEqual(["BF", COMPANY, OTHER, "lawyer", expect.anything()]);
    expect(callsMatching(h.query, /insert into audit_events/).map((c) => (c[1] as unknown[])[4])).toContain("crm.company_person_added");
    const rm = await request(await app()).post(`/api/crm/unified/companies/${COMPANY}/people/remove`).set(auth("Staff")).send({ contactId: OTHER, email: "larry@law.ca" });
    expect(rm.status).toBe(200);
    expect(callsMatching(h.query, /INSERT INTO crm_company_people_hidden/).map((c) => (c[1] as unknown[])[1])).toEqual([`contact:${OTHER}`, "email:larry@law.ca"]);
    expect(callsMatching(h.query, /UPDATE contacts SET company_id = NULL/)).toHaveLength(1);
    expect(callsMatching(h.query, /insert into audit_events/).map((c) => (c[1] as unknown[])[4])).toContain("crm.company_person_removed");
  });

  it("refuses an unknown role", async () => {
    const r = await request(await app()).post(`/api/crm/unified/companies/${COMPANY}/people`).set(auth()).send({ role: "boss", contactId: CONTACT });
    expect(r.status).toBe(400);
  });
});

describe("company details", () => {
  it("edits write the company record and keep old columns in step", async () => {
    db([[/UPDATE companies SET/, { rows: [], rowCount: 1 }], [/FROM companies co LEFT JOIN users/, { rows: [{ id: COMPANY, name: "Poke Prod LLC", city: "LA" }] }]]);
    const r = await request(await app()).patch(`/api/crm/unified/companies/${COMPANY}/details`).set(auth()).send({ province: "CA" });
    expect(r.status).toBe(200);
    const upd = callsMatching(h.query, /UPDATE companies SET/)[0]!;
    expect(String(upd[0])).toContain(`"address_state" = $3, "province" = $4, "region" = $5`);
    expect(upd[1]).toEqual([COMPANY, "BF", "CA", "CA", "CA"]);
  });
});

describe("duplicates, merge and clean-up", () => {
  it("the banner counts candidates and leaves dismissed pairs out", async () => {
    db([
      [/WITH me AS/, { rows: [{ id: OTHER, name: "Sean Dwyer", m_email: true, m_phone: false, m_name: false }, { id: "44444444-4444-4444-8444-444444444444", name: "S Dwyer", m_email: false, m_phone: true, m_name: false }] }],
      [/FROM crm_duplicate_dismissals/, { rows: [{ a: CONTACT, b: "44444444-4444-4444-8444-444444444444" }] }],
    ]);
    const r = await request(await app()).get(`/api/crm/unified/duplicates/contact/${CONTACT}`).set(auth());
    expect(r.body.data).toEqual({ count: 1, candidates: [expect.objectContaining({ id: OTHER, reasons: ["Same email"] })] });
  });

  it("company merge re-points references, keeps the chosen values and deletes the loser", async () => {
    db([
      [/SELECT \* FROM companies WHERE id = ANY/, { rows: [{ id: COMPANY, name: "Poke Prod", phone: null, tags: ["lender"] }, { id: OTHER, name: "POKE PROD LLC", phone: "+13106631364", tags: ["Active"] }] }],
      [/information_schema\.columns/, { rows: [{ table_name: "applications" }, { table_name: "contacts" }] }],
      [/UPDATE "applications" SET company_id/, { rows: [], rowCount: 1 }],
    ]);
    const r = await request(await app()).post("/api/crm/unified/merge/company").set(auth())
      .send({ survivorId: COMPANY, loserIds: [OTHER], fields: { name: "POKE PROD LLC", phone: "+1999" } });
    expect(r.status).toBe(200);
    expect(r.body.data.moved).toMatchObject({ applications: 1 });
    const upd = callsMatching(h.query, /UPDATE companies SET "name"/)[0]!;
    expect(upd[1]).toEqual(expect.arrayContaining([COMPANY, "POKE PROD LLC", "+13106631364", ["active", "lender"]]));
    expect(callsMatching(h.query, /DELETE FROM companies WHERE id = ANY/)[0]![1]).toEqual([[OTHER], "BF"]);
    expect(callsMatching(h.query, /COMMIT/)).toHaveLength(1);
  });

  it("clean-up applies only valid ticked changes, keeps before-images, and can be undone", async () => {
    const BATCH = "55555555-5555-4555-8555-555555555555";
    db([
      [/INSERT INTO crm_cleanup_batches/, { rows: [{ id: BATCH }] }],
      [/UPDATE contacts SET "email"/, { rows: [{ id: CONTACT }], rowCount: 1 }],
      [/SELECT id, undone_at FROM crm_cleanup_batches/, { rows: [{ id: BATCH, undone_at: null }] }],
      [/FROM crm_cleanup_changes WHERE batch_id/, { rows: [{ entity: "contact", entity_id: CONTACT, field: "email", before_value: "A@X.com", after_value: "a@x.com" }] }],
    ]);
    const r = await request(await app()).post("/api/crm/unified/cleanup/apply").set(auth("Staff")).send({ changes: [
      { entity: "contact", entityId: CONTACT, field: "email", before: "A@X.com", after: "a@x.com", reason: "Capitals in email" },
      { entity: "contact", entityId: CONTACT, field: "silo", before: "BF", after: "BI" },
    ] });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ batchId: BATCH, applied: 1 });
    expect(callsMatching(h.query, /INSERT INTO crm_cleanup_changes/)[0]![1]).toEqual([BATCH, "contact", CONTACT, "email", "A@X.com", "a@x.com", "Capitals in email"]);
    expect(callsMatching(h.query, /UPDATE contacts SET "silo"/)).toHaveLength(0);
    const u = await request(await app()).post(`/api/crm/unified/cleanup/batches/${BATCH}/undo`).set(auth("Staff"));
    expect(u.status).toBe(200);
    const back = callsMatching(h.query, /UPDATE contacts SET "email"/).pop()!;
    expect(back[1]).toEqual(["A@X.com", CONTACT, "BF", "a@x.com"]);
  });
});

describe("AI summary and Keystone licensee", () => {
  it("generates with sources, caches it, and skips free email providers", async () => {
    h.brief.mockResolvedValue("Background: films.\n- Next: call");
    db([[/FROM contacts c LEFT JOIN companies co ON co\.id = c\.company_id\s+WHERE c\.id/, { rows: [{ email: "pokedwyer@gmail.com", website: null, applications: 2, notes: 0, calls: 1 }] }]]);
    const r = await request(await app()).post(`/api/crm/unified/ai-summary/contact/${CONTACT}`).set(auth());
    expect(r.status).toBe(200);
    expect(r.body.data.summary).toContain("Background");
    expect(r.body.data.sources[0]).toMatchObject({ type: "website", status: "skipped" });
    expect(r.body.data.sources).toEqual(expect.arrayContaining([expect.objectContaining({ type: "applications", detail: "2" }), expect.objectContaining({ type: "calls", detail: "1" })]));
    expect(h.background).not.toHaveBeenCalled();
    expect(callsMatching(h.query, /INSERT INTO crm_ai_summaries/)).toHaveLength(1);
  });
  it("reads the company website from a work email domain", async () => {
    h.brief.mockResolvedValue("ok");
    h.background.mockResolvedValue("Allen Capital Funding arranges film finance.");
    db([[/FROM contacts c LEFT JOIN companies co/, { rows: [{ email: "Tony@AllenCapFunding.com", website: null }] }]]);
    const r = await request(await app()).post(`/api/crm/unified/ai-summary/contact/${CONTACT}`).set(auth());
    expect(h.background).toHaveBeenCalledWith("allencapfunding.com");
    expect(r.body.data).toMatchObject({ business: "Allen Capital Funding arranges film finance." });
    expect(r.body.data.sources[0]).toMatchObject({ type: "website", label: "allencapfunding.com", status: "used" });
  });
  it("Keystone licensee card only in the KS silo", async () => {
    db([[/FROM contacts c\s+LEFT JOIN companies co ON co\.id = c\.company_id AND co\.silo = 'KS'/, { rows: [{ id: CONTACT, company_stage: "paying", ks_plan: "Growth", ks_seats: 3, ks_status: "active", demo_steps: 4 }] }]]);
    const bf = await request(await app()).get(`/api/crm/unified/contacts/${CONTACT}/ks-licensee`).set(auth()).set("X-Silo", "BF");
    expect(bf.body.data).toBeNull();
    const ks = await request(await app()).get(`/api/crm/unified/contacts/${CONTACT}/ks-licensee`).set(auth()).set("X-Silo", "KS");
    expect(ks.body.data).toMatchObject({ plan: "Growth", seats: 3, status: "active", payment: { status: "Paying" }, demo: { steps: 4 } });
  });
});
