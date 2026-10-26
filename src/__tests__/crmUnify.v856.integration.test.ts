// BF_SERVER_v856_CRM_UNIFY - the shared CRM against real Postgres (baseline + migrations): the migration twice,
// tag normalisation in SQL matching the TypeScript rules, the company repair, the lists, company people (a partner
// typed into the application), duplicates + both merges, and clean-up with undo. Silos stay apart.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import crmRoutes from "../routes/crm.js";
import { normalizeTag } from "../modules/crmUnify/tags.js";

const MIGRATION = "migrations/2026_10_25_v856_crm_unify.sql";
const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID();
const token = jwt.sign({ sub: ADMIN, id: ADMIN, role: "Admin", tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const company = randomUUID();
const dupCompany = randomUUID();
const ksCompany = randomUUID();
const sean = randomUUID();
const seanDup = randomUUID();
const bea = randomUUID();
const ksContact = randomUUID();
const appId = `app-v856-${tag}`;
const contacts = [sean, seanDup, bea, ksContact];
const companies = [company, dupCompany, ksCompany];

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/crm", crmRoutes);
  return a;
}
const get = (path: string, silo = "BF") => request(app()).get(path).set("Authorization", `Bearer ${token}`).set("X-Silo", silo);
const post = (path: string, body: object, silo = "BF") => request(app()).post(path).set("Authorization", `Bearer ${token}`).set("X-Silo", silo).send(body);

describe("v856 one CRM (real Postgres)", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO users (id, email, active, role, first_name, last_name, silo, silos) VALUES ($1, $2, true, 'Admin', 'Pat', 'Admin', 'BF', ARRAY['BF','SLF','KS'])`,
      [ADMIN, `admin-${tag}@example.com`],
    );
    await pool.query(`INSERT INTO companies (id, name, silo, website) VALUES ($1, $2, 'BF', 'pokeprod-${tag}.com'), ($3, $4, 'BF', NULL), ($5, $6, 'KS', NULL)`,
      [company, `Poke Prod ${tag} LLC`, dupCompany, `POKE PROD ${tag.toUpperCase()}`, ksCompany, `Poke Prod ${tag} LLC`]);
    await pool.query(
      `INSERT INTO contacts (id, name, email, phone, silo, tags, company_name) VALUES
         ($1, 'Unknown (application started)', $5, '323-898-2498', 'BF', ARRAY['Contact form','Lender','lender','application_started'], NULL),
         ($2, 'Sean Dwyer', $6, '+13238982498', 'BF', ARRAY['Active'], NULL),
         ($3, 'BEA BROWN', $7, NULL, 'BF', '{}', $8),
         ($4, 'Kay Keystone', $9, NULL, 'KS', '{}', NULL)`,
      [sean, seanDup, bea, ksContact, `Sean.Dwyer-${tag}@Gmail.com`, `sean.dwyer-${tag}@gmail.com`, `bea-${tag}@example.com`, `Poke Prod ${tag} LLC`, `kay-${tag}@example.com`],
    );
    await pool.query(
      `INSERT INTO applications (id, name, silo, status, contact_id, company_id, created_at, updated_at, metadata)
       VALUES ($1, $2, 'BF', 'RECEIVED', $3, $4, now(), now(), $5::jsonb)`,
      [appId, `Poke Prod ${tag} LLC`, sean, company, JSON.stringify({
        applicant: { firstName: "sean", lastName: "dwyer", partnerFirstName: "Elizabeth", partnerLastName: "Cullen", partnerEmail: `pokecullen-${tag}@gmail.com`, partnerPhone: "(310) 663-1364" },
        business: { legalName: `Poke Prod ${tag} LLC`, address: "341 N Orange Dr", city: "Los Angeles", state: "CA", postalCode: "90036", businessStructure: "S Corporation" },
      })],
    );
    await pool.query(`INSERT INTO application_form_responses (application_id, doc_type, data) VALUES ($1, 'professional_advisors', $2::jsonb)`,
      [appId, JSON.stringify({ advisors: { cpa: { firm: "Numbers LLP", contact: "Ann Count", email: `ann-${tag}@numbers.ca`, phone: "403-555-0100" } } })]);
    // The migration twice: the company repair and the tag clean-up run on the data above, and it is safe to repeat.
    await pool.query(readFileSync(MIGRATION, "utf8"));
    await pool.query(readFileSync(MIGRATION, "utf8"));
  });

  afterAll(async () => {
    const clean = (sql: string, params: unknown[]) => pool.query(sql, params).catch((e) => console.warn("cleanup", String(e)));
    await clean("DELETE FROM application_form_responses WHERE application_id = $1", [appId]);
    await clean("DELETE FROM applications WHERE id = $1", [appId]);
    await clean("DELETE FROM crm_company_people WHERE company_id = ANY($1::uuid[])", [companies]);
    await clean("DELETE FROM contact_merges WHERE survivor_id = ANY($1::uuid[])", [contacts]);
    await clean("DELETE FROM company_merges WHERE survivor_id = ANY($1::uuid[])", [companies]);
    await clean("DELETE FROM crm_ai_summaries WHERE entity_id = ANY($1::uuid[])", [[...contacts, ...companies]]);
    await clean("DELETE FROM crm_cleanup_batches WHERE created_by = $1", [ADMIN]);
    await clean("DELETE FROM crm_tag_definitions WHERE created_by = $1", [ADMIN]);
    await clean("DELETE FROM contacts WHERE id = ANY($1::uuid[]) OR email ILIKE $2", [contacts, `%${tag}%`]);
    await clean("DELETE FROM companies WHERE id = ANY($1::uuid[])", [companies]);
    await clean("DELETE FROM users WHERE id = $1", [ADMIN]);
  });

  it("bf_norm_tag() in SQL gives the same answers as normalizeTag()", async () => {
    const samples = ["Contact form", " LENDER ", "Account/Book Keeper", "Accountant/advisor", "booked-call", "Re--ferrer!!", "  ", "VIP Client",
      "Lawyer/advisor", "Insurance/advisor", "A/R Credit Insurance/advisor", "A/R Credit Insurance", "country:CA"];
    const r = await pool.query(`SELECT bf_norm_tag(x) AS n FROM unnest($1::text[]) WITH ORDINALITY AS t(x, i) ORDER BY i`, [samples]);
    expect(r.rows.map((x) => x.n)).toEqual(samples.map(normalizeTag));
  });

  it("the migration normalised tags and linked the contact to its application's company", async () => {
    const [c] = (await pool.query(`SELECT tags, company_id::text, company_name FROM contacts WHERE id = $1`, [sean])).rows;
    expect(c.tags).toEqual(["application_started", "contact_form", "lender"]);
    expect(c.company_id).toBe(company);
    expect(c.company_name).toBe(`Poke Prod ${tag} LLC`);
    const [b] = (await pool.query(`SELECT company_id::text FROM contacts WHERE id = $1`, [bea])).rows;
    expect(b.company_id).toBe(company); // matched by its company text (one company with that name in BF)
  });

  it("the contacts list shows the company and filters by tag and untagged; KS stays apart", async () => {
    const r = await get(`/api/crm/contacts?q=${tag}&pageSize=50`);
    expect(r.status).toBe(200);
    const row = r.body.data.find((x: any) => x.id === sean);
    expect(row.company_name).toBe(`Poke Prod ${tag} LLC`);
    const lenders = await get(`/api/crm/contacts?q=${tag}&tags=Lender`);
    expect(lenders.body.data.map((x: any) => x.id)).toEqual([sean]);
    const untagged = await get(`/api/crm/contacts?q=${tag}&tags=__none__`);
    expect(untagged.body.data.map((x: any) => x.id).sort()).toEqual([bea].sort());
    const ks = await get(`/api/crm/contacts?q=${tag}`, "KS");
    expect(ks.body.data.map((x: any) => x.id)).toEqual([ksContact]);
  });

  it("tags: apply and remove (Active included); system tags refused; silo tags", async () => {
    expect((await post("/api/crm/unified/tags/apply", { entity: "contact", ids: [sean, bea], add: ["Broker"] })).body.updated).toBe(2);
    expect((await post("/api/crm/unified/tags/apply", { entity: "contact", ids: [seanDup], remove: ["active"] })).body.updated).toBe(1);
    expect((await pool.query(`SELECT tags FROM contacts WHERE id = $1`, [seanDup])).rows[0].tags).toEqual([]);
    expect((await post("/api/crm/unified/tags/apply", { entity: "contact", ids: [bea], remove: ["contact_form"] })).status).toBe(400);
    expect((await post("/api/crm/unified/tags/apply", { entity: "company", ids: [company], add: ["Lender"] })).body.updated).toBe(1);
    expect((await post("/api/crm/unified/tags/definitions", { label: `Film ${tag}` }, "SLF")).status).toBe(201);
    const slf = await get("/api/crm/unified/tags", "SLF");
    expect(slf.body.data.custom.map((t: any) => t.slug)).toContain(`film_${tag}`);
    const bf = await get("/api/crm/unified/tags", "BF");
    expect(bf.body.data.custom.map((t: any) => t.slug)).not.toContain(`film_${tag}`);
    const companiesTagged = await get(`/api/crm/companies?q=${tag}&tags=lender`);
    expect(companiesTagged.body.data.map((x: any) => x.id)).toEqual([company]);
  });

  it("company people: applicant, the partner typed into the application, the advisor and the other contact", async () => {
    const r = await get(`/api/crm/unified/companies/${company}/people`);
    expect(r.status).toBe(200);
    const g = r.body.data.groups;
    expect(g.primary.map((p: any) => p.contactId)).toEqual([sean]);
    expect(g.partners).toEqual([expect.objectContaining({ name: "Elizabeth Cullen", email: `pokecullen-${tag}@gmail.com`, phone: "(310) 663-1364" })]);
    expect(g.advisors).toEqual([expect.objectContaining({ name: "Ann Count", role: "accountant" })]);
    expect(g.other.map((p: any) => p.contactId)).toContain(bea);
    // Add by hand with a role, then remove; both audited.
    expect((await post(`/api/crm/unified/companies/${company}/people`, { role: "lawyer", contact: { name: "Larry Law", email: `larry-${tag}@law.ca` } })).status).toBe(201);
    const after = await get(`/api/crm/unified/companies/${company}/people`);
    const larry = after.body.data.groups.advisors.find((p: any) => p.name === "Larry Law");
    expect(larry).toMatchObject({ role: "lawyer", source: "association" });
    expect((await post(`/api/crm/unified/companies/${company}/people/remove`, { key: larry.key, contactId: larry.contactId, email: larry.email })).status).toBe(200);
    const gone = await get(`/api/crm/unified/companies/${company}/people`);
    expect(gone.body.data.people.find((p: any) => p.name === "Larry Law")).toBeUndefined();
    const audit = await pool.query(`SELECT event_action FROM audit_events WHERE actor_user_id = $1 AND target_id = $2 ORDER BY created_at`, [ADMIN, company]);
    expect(audit.rows.map((x) => x.event_action)).toEqual(expect.arrayContaining(["crm.company_person_added", "crm.company_person_removed"]));
  });

  it("company details fall back to the application and save to the company record", async () => {
    const r = await get(`/api/crm/unified/companies/${company}/details`);
    const f = (k: string) => r.body.data.fields.find((x: any) => x.key === k);
    expect(f("address")).toMatchObject({ value: "341 N Orange Dr", source: "application" });
    expect(f("domain").value).toBe(`pokeprod-${tag}.com`);
    const saved = await request(app()).patch(`/api/crm/unified/companies/${company}/details`).set("Authorization", `Bearer ${token}`).send({ address: "341 N Orange Dr", employees: "12" });
    expect(saved.status).toBe(200);
    const [co] = (await pool.query(`SELECT address_street, employee_count, number_of_employees FROM companies WHERE id = $1`, [company])).rows;
    expect(co).toEqual({ address_street: "341 N Orange Dr", employee_count: 12, number_of_employees: 12 });
  });

  it("duplicates: banner + list; contact merge keeps chosen values and deletes the loser; company merge too", async () => {
    const banner = await get(`/api/crm/unified/duplicates/contact/${sean}`);
    expect(banner.body.data.candidates).toEqual([expect.objectContaining({ id: seanDup, reasons: expect.arrayContaining(["Same email", "Same phone"]) })]);
    const groups = await get("/api/crm/unified/duplicates?entity=contact");
    expect(groups.body.data.groups.some((g: any) => g.ids.includes(sean) && g.ids.includes(seanDup))).toBe(true);
    const merged = await post("/api/crm/unified/merge/contact", { survivorId: sean, loserIds: [seanDup], fields: { name: "Sean Dwyer" } });
    expect(merged.status).toBe(200);
    expect((await pool.query(`SELECT name FROM contacts WHERE id = $1`, [sean])).rows[0].name).toBe("Sean Dwyer");
    expect((await pool.query(`SELECT 1 FROM contacts WHERE id = $1`, [seanDup])).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM contact_merges WHERE survivor_id = $1 AND loser_id = $2`, [sean, seanDup])).rowCount).toBe(1);

    const coDup = await get(`/api/crm/unified/duplicates/company/${company}`);
    expect(coDup.body.data.candidates.map((x: any) => x.id)).toEqual([dupCompany]); // the KS company is never offered
    const coMerged = await post("/api/crm/unified/merge/company", { survivorId: company, loserIds: [dupCompany], fields: { name: `Poke Prod ${tag} LLC` } });
    expect(coMerged.status).toBe(200);
    expect((await pool.query(`SELECT 1 FROM companies WHERE id = $1`, [dupCompany])).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM companies WHERE id = $1`, [ksCompany])).rowCount).toBe(1);
  });

  it("clean-up: proposes, applies only what was ticked, and undoes the batch", async () => {
    const scan = await get("/api/crm/unified/cleanup/scan?entity=contact");
    const mine = scan.body.data.changes.filter((c: any) => c.entityId === bea);
    expect(mine).toEqual([expect.objectContaining({ field: "name", before: "BEA BROWN", after: "Bea Brown" })]);
    const applied = await post("/api/crm/unified/cleanup/apply", { changes: mine });
    expect(applied.body.data.applied).toBe(1);
    expect((await pool.query(`SELECT name FROM contacts WHERE id = $1`, [bea])).rows[0].name).toBe("Bea Brown");
    const undone = await post(`/api/crm/unified/cleanup/batches/${applied.body.data.batchId}/undo`, {});
    expect(undone.body.data.restored).toBe(1);
    expect((await pool.query(`SELECT name FROM contacts WHERE id = $1`, [bea])).rows[0].name).toBe("BEA BROWN");
    expect((await post(`/api/crm/unified/cleanup/batches/${applied.body.data.batchId}/undo`, {})).status).toBe(409);
  });
});

// BF_SERVER_v856_CRM_UNIFY - Todd's second round: people from applications become contacts, roles, the contact panel,
// collapsed drafts, one call task, company activity, the company column, merge chains and the duplicate rules.
describe("v856 people, roles, drafts and merges (real Postgres)", () => {
  const t2 = randomUUID().slice(0, 8);
  const voss = randomUUID();
  const firmA = randomUUID();
  const firmB = randomUUID();
  const bigA = randomUUID();
  const bigB = randomUUID();
  const brandon = randomUUID();
  const anthony = randomUUID();
  const todd1 = randomUUID();
  const todd2 = randomUUID();
  const w1 = randomUUID();
  const w2 = randomUUID();
  const w3 = randomUUID();
  const slfReal = randomUUID();
  const slfPh = randomUUID();
  const loner = randomUUID();
  const appSub = `app-v856b-${t2}`;
  const drafts = [`app-v856b-${t2}-d1`, `app-v856b-${t2}-d2`];
  const appAllen = `app-v856b-${t2}-allen`;
  const myContacts = [brandon, anthony, todd1, todd2, w1, w2, w3, slfReal, slfPh, loner];
  const myCompanies = [voss, firmA, firmB, bigA, bigB];

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO users (id, email, active, role, first_name, last_name, silo, silos) VALUES ($1, $2, true, 'Admin', 'Pat', 'Admin', 'BF', ARRAY['BF','SLF','KS'])
       ON CONFLICT (id) DO NOTHING`,
      [ADMIN, `admin-${tag}@example.com`],
    );
    await pool.query(
      `INSERT INTO companies (id, name, silo) VALUES ($1, $2, 'BF'), ($3, $4, 'BF'), ($5, $6, 'BF'), ($7, $8, 'BF'), ($9, $10, 'BF')`,
      [voss, `Voss Events ${t2}, Inc.`, firmA, `Firm A ${t2}`, firmB, `Firm B ${t2}`, bigA, `${t2} Big Brokerage`, bigB, `${t2} Big Broker`],
    );
    await pool.query(
      `INSERT INTO contacts (id, name, email, phone, silo, company_id, role, status, merged_into_id) VALUES
         ($1, $11, $12, '587-555-0141', 'BF', $13, 'unknown', 'prospect', NULL),
         ($2, $14, $15, NULL, 'BF', NULL, 'unknown', 'prospect', NULL),
         ($3, 'Todd Werboweski', $16, NULL, 'BF', $17, 'unknown', 'prospect', NULL),
         ($4, 'Todd Werboweski', $18, NULL, 'BF', $19, 'unknown', 'prospect', NULL),
         ($5, $20, $21, NULL, 'BF', NULL, 'unknown', 'archived', $6),
         ($6, $20, $22, NULL, 'BF', NULL, 'unknown', 'prospect', NULL),
         ($7, $20, $23, NULL, 'BF', NULL, 'unknown', 'prospect', NULL),
         ($8, $24, NULL, '780-555-0177', 'SLF', NULL, 'unknown', 'prospect', NULL),
         ($9, 'Unknown (application started)', NULL, '+17805550177', 'SLF', NULL, 'unknown', 'prospect', NULL),
         ($10, $25, $26, NULL, 'BF', NULL, 'unknown', 'prospect', NULL)`,
      [brandon, anthony, todd1, todd2, w1, w2, w3, slfReal, slfPh, loner,
        `Brandon Voss ${t2}`, `brandon-${t2}@example.com`, voss,
        `Anthony Allen ${t2}`, `anthony-${t2}@example.com`,
        `todd1-${t2}@example.com`, firmA, `todd2-${t2}@example.com`, firmB,
        `Walter De Kruyff ${t2}`, `walter1-${t2}@example.com`, `walter2-${t2}@example.com`, `walter3-${t2}@example.com`,
        `Rae Real ${t2}`, `Lone Drafter ${t2}`, `loner-${t2}@example.com`],
    );
    // Brandon: one submitted application filed with no company (his own record points at Voss Events), a partner and a
    // guarantor typed into it, a lawyer on the advisors form, and two abandoned drafts from restarting the wizard.
    await pool.query(
      `INSERT INTO applications (id, name, silo, status, contact_id, company_id, created_at, updated_at, submitted_at, requested_amount, product_category, metadata)
       VALUES ($1, $2, 'BF', 'RECEIVED', $3, NULL, now() - interval '3 days', now(), now() - interval '2 days', 250000, 'Media', $4::jsonb)`,
      [appSub, `Voss Events ${t2}, Inc.`, brandon, JSON.stringify({
        applicant: { firstName: "Brandon", lastName: "Voss", partnerFirstName: "Liz", partnerLastName: `Partner${t2}`, partnerEmail: `liz-${t2}@example.com`, partnerPhone: "(310) 555-0164" },
        guarantors: [{ firstName: "Gus", lastName: `Guarantor${t2}`, email: `gus-${t2}@example.com` }],
      })],
    );
    for (const d of drafts) {
      await pool.query(
        `INSERT INTO applications (id, name, silo, status, contact_id, created_at, updated_at, metadata)
         VALUES ($1, 'Draft', 'BF', 'RECEIVED', $2, now() - interval '5 days', now() - interval '4 days', '{}'::jsonb)`,
        [d, brandon],
      );
    }
    await pool.query(
      `INSERT INTO applications (id, name, silo, status, contact_id, business_legal_name, created_at, updated_at, metadata)
       VALUES ($1, 'Allen', 'BF', 'RECEIVED', $2, $3, now(), now(), '{}'::jsonb)`,
      [appAllen, anthony, `Allen Capital Funding ${t2}`],
    );
    for (const a of [appSub, ...drafts]) {
      await pool.query(
        `INSERT INTO application_stage_events (id, application_id, from_stage, to_stage, trigger, triggered_by, created_at)
         VALUES ($1, $2, NULL, 'Received', 'application_created', 'system', now()), ($3, $2, NULL, 'Received', 'application_created', 'system', now())`,
        [randomUUID(), a, randomUUID()],
      );
    }
    await pool.query(`INSERT INTO application_form_responses (application_id, doc_type, data) VALUES ($1, 'professional_advisors', $2::jsonb)`,
      [appSub, JSON.stringify({ advisors: { attorney: { firm: `Lawyers ${t2} LLP`, contact: `Larry Law${t2}`, email: `larry-${t2}@law.ca` } } })]);
    await pool.query(`INSERT INTO crm_notes (body, contact_id, silo) VALUES ($1, $2, 'BF')`, [`Called Brandon ${t2}`, brandon]);
    // Six copies of the call task for Brandon (who submitted) and two for someone who never did.
    for (let i = 0; i < 6; i++) {
      await pool.query(`INSERT INTO tasks (silo, title, type, priority, assignee_user_id, contact_id, source) VALUES ('BF', 'Call: started an application, did not finish', 'CALL', 'HIGH', $1, $2, 'WORKFLOW')`, [ADMIN, brandon]);
    }
    for (let i = 0; i < 2; i++) {
      await pool.query(`INSERT INTO tasks (silo, title, type, priority, assignee_user_id, contact_id, source, created_at) VALUES ('BF', 'Call: started an application, did not finish', 'CALL', 'HIGH', $1, $2, 'WORKFLOW', now() - ($3 || ' minutes')::interval)`, [ADMIN, loner, String(10 - i)]);
    }
    await pool.query(readFileSync(MIGRATION, "utf8"));
    const { syncApplicationPeople } = await import("../modules/crmUnify/peopleSync.js");
    await syncApplicationPeople(pool, appSub);
    await syncApplicationPeople(pool, appSub); // a second run adds nothing
  });

  afterAll(async () => {
    const clean = (sql: string, params: unknown[]) => pool.query(sql, params).catch((e) => console.warn("cleanup", String(e)));
    const apps = [appSub, appAllen, ...drafts];
    await clean("DELETE FROM application_stage_events WHERE application_id = ANY($1::text[])", [apps]);
    await clean("DELETE FROM application_form_responses WHERE application_id = ANY($1::text[])", [apps]);
    await clean("DELETE FROM application_contacts WHERE application_id = ANY($1::text[])", [apps]);
    await clean("DELETE FROM applications WHERE id = ANY($1::text[])", [apps]);
    await clean("DELETE FROM tasks WHERE contact_id = ANY($1::uuid[])", [myContacts]);
    await clean("DELETE FROM crm_notes WHERE contact_id = ANY($1::uuid[])", [myContacts]);
    await clean("DELETE FROM contacts WHERE id = ANY($1::uuid[]) OR email ILIKE $2", [myContacts, `%${t2}%`]);
    await clean("DELETE FROM companies WHERE id = ANY($1::uuid[]) OR name ILIKE $2", [myCompanies, `%${t2}%`]);
    await clean("DELETE FROM users WHERE id = $1", [ADMIN]);
  });

  it("partners, guarantors and advisors became contacts, tagged and linked (once)", async () => {
    const liz = await pool.query(`SELECT id, tags, role, company_id FROM contacts WHERE email = $1 AND silo = 'BF'`, [`liz-${t2}@example.com`]);
    expect(liz.rowCount).toBe(1);
    expect(liz.rows[0]).toMatchObject({ role: "partner", company_id: voss });
    expect(liz.rows[0].tags).toContain("partner");
    expect((await pool.query(`SELECT 1 FROM application_contacts WHERE application_id = $1 AND contact_id = $2 AND role = 'partner'`, [appSub, liz.rows[0].id])).rowCount).toBe(1);
    const gus = await pool.query(`SELECT tags FROM contacts WHERE email = $1`, [`gus-${t2}@example.com`]);
    expect(gus.rows[0].tags).toContain("guarantor");
    const larry = await pool.query(
      `SELECT c.id, c.tags, co.name AS firm FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE c.email = $1`, [`larry-${t2}@law.ca`]);
    expect(larry.rows[0]).toMatchObject({ firm: `Lawyers ${t2} LLP` });
    expect(larry.rows[0].tags).toEqual(["lawyer"]);
    const link = await pool.query(`SELECT detail FROM crm_contact_links WHERE contact_id = $1 AND related_contact_id = $2`, [brandon, larry.rows[0].id]);
    expect(link.rows).toEqual([{ detail: "Lawyer" }]);
    const related = await get(`/api/crm/unified/contacts/${brandon}/related`);
    expect(related.body.data).toEqual([expect.objectContaining({ contactId: larry.rows[0].id, direction: "advisor", detail: "Lawyer", company: `Lawyers ${t2} LLP` })]);
  });

  it("the company lists the applicant as Primary applicant, with partners, guarantor and advisor", async () => {
    const r = await get(`/api/crm/unified/companies/${voss}/people`);
    expect(r.status).toBe(200);
    const g = r.body.data.groups;
    expect(g.primary.map((p: any) => p.contactId)).toEqual([brandon]);
    expect(g.partners.map((p: any) => p.email)).toEqual([`liz-${t2}@example.com`]);
    expect(g.guarantors.map((p: any) => p.email)).toEqual([`gus-${t2}@example.com`]);
    expect(g.advisors).toEqual([expect.objectContaining({ email: `larry-${t2}@law.ca`, role: "lawyer", detail: "Lawyer" })]);
    expect(g.other).toEqual([]);
    expect((await pool.query(`SELECT role, is_primary_applicant FROM contacts WHERE id = $1`, [brandon])).rows[0]).toEqual({ role: "applicant", is_primary_applicant: true });
  });

  it("contact panel: the submitted application with partners and a link; drafts collapsed everywhere", async () => {
    const r = await get(`/api/crm/unified/contacts/${brandon}/applications`);
    expect(r.body.data.drafts).toBe(2);
    expect(r.body.data.applications).toEqual([expect.objectContaining({
      id: appSub, amount: 250000, product: "Media", submitted: true, link: `/applications/${appSub}`,
      partners: expect.arrayContaining([expect.objectContaining({ name: `Liz Partner${t2}`, role: "partner" }), expect.objectContaining({ role: "guarantor" })]),
    })]);
    const stages = await get(`/api/crm/contacts/${brandon}/stage-events`);
    expect(stages.body.data.map((e: any) => e.application_id)).toEqual([appSub]); // two writes deduped, drafts dropped
    const journey = await get(`/api/crm/contacts/${brandon}/journey`);
    expect(journey.body.data.applications.map((a: any) => a.id)).toEqual([appSub]);
    expect(journey.body.data.draftsCollapsed).toBe(2);
  });

  it("call tasks: copies closed and none left open after a submit; drafts no longer eligible", async () => {
    const open = async (id: string) => (await pool.query(`SELECT count(*)::int AS n FROM tasks WHERE contact_id = $1 AND status <> 'COMPLETED'`, [id])).rows[0].n;
    expect(await open(brandon)).toBe(0);
    expect(await open(loner)).toBe(1);
    const eligible = await pool.query(`SELECT id FROM applications WHERE id = ANY($1::text[]) AND abandon_task_created_at IS NULL`, [drafts]);
    expect(eligible.rowCount).toBe(0);
  });

  it("the company timeline shows its people's activity", async () => {
    const r = await get(`/api/crm/companies/${voss}/timeline`);
    expect(r.body.data.some((x: any) => x.kind === "note" && x.body === `Called Brandon ${t2}` && x.contact_name === `Brandon Voss ${t2}`)).toBe(true);
  });

  it("the contacts list company column falls back to the application's business name", async () => {
    const r = await get(`/api/crm/contacts?search=${encodeURIComponent(`Anthony Allen ${t2}`)}`);
    expect(r.body.data.map((c: any) => c.company_name)).toEqual([`Allen Capital Funding ${t2}`]);
  });

  it("duplicates: two Todd Werboweski at different companies, and Big Brokerage vs Big Broker; merge end to end", async () => {
    const banner = await get(`/api/crm/unified/duplicates/contact/${todd1}`);
    expect(banner.body.data.candidates).toEqual([expect.objectContaining({ id: todd2, reasons: ["Same name"] })]);
    const preview = await get(`/api/crm/unified/merge/contact/preview?ids=${todd1},${todd2}`);
    expect(preview.body.data.fields.find((f: any) => f.key === "email").values.map((v: any) => v.value)).toEqual([`todd1-${t2}@example.com`, `todd2-${t2}@example.com`]);
    const merged = await post("/api/crm/unified/merge/contact", { survivorId: todd1, loserIds: [todd2], fields: { email: `todd2-${t2}@example.com` } });
    expect(merged.status).toBe(200);
    expect((await pool.query(`SELECT email, secondary_email FROM contacts WHERE id = $1`, [todd1])).rows[0]).toEqual({ email: `todd2-${t2}@example.com`, secondary_email: `todd1-${t2}@example.com` });
    expect((await pool.query(`SELECT 1 FROM contacts WHERE id = $1`, [todd2])).rowCount).toBe(0);

    const co = await get(`/api/crm/unified/duplicates/company/${bigA}`);
    expect(co.body.data.candidates).toEqual([expect.objectContaining({ id: bigB, reasons: ["Similar name"] })]);
    const coMerged = await post("/api/crm/unified/merge/company", { survivorId: bigA, loserIds: [bigB] });
    expect(coMerged.status).toBe(200);
    expect((await pool.query(`SELECT 1 FROM companies WHERE id = $1`, [bigB])).rowCount).toBe(0);
  });

  it("merge chains: a merged record is never offered, sends staff to the survivor, and merges land on the survivor", async () => {
    const old = await get(`/api/crm/contacts/${w1}/duplicate-candidates`);
    expect(old.body.data).toEqual([]);
    const banner = await get(`/api/crm/unified/duplicates/contact/${w1}`);
    expect(banner.body.data).toMatchObject({ count: 0, mergedInto: w2 });
    const live = await get(`/api/crm/unified/duplicates/contact/${w2}`);
    expect(live.body.data.candidates.map((c: any) => c.id)).toEqual([w3]); // the merged copy is not offered
    expect((await get(`/api/crm/unified/contacts/${w1}/survivor`)).body.data).toMatchObject({ id: w2, merged: true });
    const res = await post("/api/crm/unified/merge/contact", { survivorId: w1, loserIds: [w3] });
    expect(res.status).toBe(200);
    expect(res.body.data.survivorId).toBe(w2);
    expect((await pool.query(`SELECT 1 FROM contacts WHERE id = $1`, [w3])).rowCount).toBe(0);
    const archived = await pool.query(`UPDATE contacts SET status = 'archived' WHERE id = $1 RETURNING id`, [w2]);
    expect(archived.rowCount).toBe(1);
    const refused = await post("/api/crm/unified/merge/contact", { survivorId: w2, loserIds: [w1] });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Restore it before merging");
  });

  it("placeholder copies are suggested with the real record as survivor and merged in one go", async () => {
    const plan = await post("/api/crm/unified/duplicates/merge-placeholders", { dryRun: true }, "SLF");
    expect(plan.body.data.plan).toContainEqual(expect.objectContaining({ survivorId: slfReal, loserIds: [slfPh] }));
    const groups = await get("/api/crm/unified/duplicates?entity=contact", "SLF");
    const mine = groups.body.data.groups.find((g: any) => g.ids.includes(slfReal));
    expect(mine).toMatchObject({ survivorId: slfReal, placeholders: 1 });
    const done = await post("/api/crm/unified/duplicates/merge-placeholders", {}, "SLF");
    expect(done.body.data.merged).toBeGreaterThanOrEqual(1);
    expect((await pool.query(`SELECT 1 FROM contacts WHERE id = $1`, [slfPh])).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM contacts WHERE id = $1`, [slfReal])).rowCount).toBe(1);
  });
});
