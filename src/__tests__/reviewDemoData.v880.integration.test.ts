// BF_SERVER_v880_REVIEW_DEMO - the store reviewer's account opens with sample data, against the real schema and the
// real client routes. Seeding twice creates nothing new; every row is in silo TEST; the client portal endpoints
// return the applications, stages, offers, documents and messages the reviewer is meant to see.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db.js";
import { deps } from "../system/deps.js";
import { ensureReviewDemoData, REVIEW_DEMO_BUSINESS } from "../services/reviewDemoData.js";

const SECRET = process.env.JWT_SECRET || "ci-integration-secret-min-10";
// A number of this run's own, so parallel runs on the shared database never meet.
const digits = "403" + String(Math.floor(1e6 + Math.random() * 8e6));
const phone = "+1" + digits;
const clientToken = jwt.sign({ sub: "client:" + phone, role: "client", phone, tokenVersion: 0, isClient: true }, SECRET, { algorithm: "HS256" });

let contactId = "";
let equipmentId = "";
let workingCapitalId = "";

const counts = async () => {
  const r = await pool.query(
    `SELECT (SELECT count(*)::int FROM contacts c WHERE right(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'),10) = $1) AS contacts,
            (SELECT count(*)::int FROM applications WHERE contact_id = $2::uuid) AS applications,
            (SELECT count(*)::int FROM offers WHERE application_id IN (SELECT id FROM applications WHERE contact_id = $2::uuid)) AS offers,
            (SELECT count(*)::int FROM documents WHERE application_id IN (SELECT id FROM applications WHERE contact_id = $2::uuid)) AS documents,
            (SELECT count(*)::int FROM communications_messages WHERE contact_id = $2::uuid) AS messages`,
    [digits, contactId],
  );
  return r.rows[0];
};

const get = (path: string) => request(createApp()).get(path).set("Authorization", "Bearer " + clientToken);

describe("v880 store-review sample data", () => {
  beforeAll(async () => {
    deps.db.ready = true;
    (deps.db as any).client = pool;
    process.env.REVIEW_LOGIN_PHONE = phone;
    process.env.REVIEW_LOGIN_CODE = "246810";
    delete process.env.REVIEW_DEMO_ADVISOR_USER_ID;
  });

  afterAll(async () => {
    const clean = (sql: string, params: unknown[]) => pool.query(sql, params).catch((e) => console.warn("cleanup", String(e)));
    const ids = [equipmentId, workingCapitalId].filter(Boolean);
    await clean("DELETE FROM communications_messages WHERE contact_id::text = $1", [contactId]);
    await clean("DELETE FROM fraud_queue WHERE application_id = ANY($1::text[])", [ids]);
    await clean("DELETE FROM application_contacts WHERE application_id = ANY($1::text[])", [ids]);
    await clean("DELETE FROM applications WHERE id = ANY($1::text[])", [ids]);
    await clean("DELETE FROM contacts WHERE id::text = $1", [contactId]);
    delete process.env.REVIEW_LOGIN_PHONE;
    delete process.env.REVIEW_LOGIN_CODE;
  });

  it("does nothing for any other number", async () => {
    expect(await ensureReviewDemoData("+14035550101")).toEqual({ seeded: false, reason: "not_review_phone" });
  });

  it("seeds once; a second sign-in creates nothing new", async () => {
    const first = await ensureReviewDemoData(phone);
    if (!first.seeded) throw new Error("expected seeding");
    expect(first.created).toEqual(["contact", "equipment", "working_capital"]);
    contactId = first.contactId;
    equipmentId = first.applications.equipment;
    workingCapitalId = first.applications.working_capital;
    const before = await counts();
    expect(before).toEqual({ contacts: 1, applications: 2, offers: 3, documents: 8, messages: 6 });

    const second = await ensureReviewDemoData(digits);
    if (!second.seeded) throw new Error("expected seeding");
    expect(second.created).toEqual([]);
    expect(second.contactId).toBe(contactId);
    expect(second.applications).toEqual(first.applications);
    expect(await counts()).toEqual(before);
  });

  it("keeps every row in silo TEST, tagged store_review, with nothing left for the workers", async () => {
    const c = await pool.query("SELECT silo, tags, email, company_name, sms_opt_out FROM contacts WHERE id = $1::uuid", [contactId]);
    expect(c.rows[0]).toMatchObject({ silo: "TEST", email: "review@example.com", company_name: REVIEW_DEMO_BUSINESS, sms_opt_out: true });
    expect(c.rows[0].tags).toEqual(expect.arrayContaining(["store_review", "review_demo"]));
    const apps = await pool.query(
      "SELECT silo, metadata->>'store_review' AS sr, metadata->>'review_demo' AS rd, funded_at FROM applications WHERE contact_id = $1::uuid",
      [contactId],
    );
    expect(apps.rows).toHaveLength(2);
    for (const a of apps.rows) expect(a).toMatchObject({ silo: "TEST", sr: "true", rd: "true", funded_at: null });
    const msgs = await pool.query("SELECT DISTINCT silo FROM communications_messages WHERE contact_id = $1::uuid", [contactId]);
    expect(msgs.rows).toEqual([{ silo: "TEST" }]);
    const fq = await pool.query("SELECT count(*)::int AS n FROM fraud_queue WHERE application_id = ANY($1::text[]) AND done_at = 'infinity'", [[equipmentId, workingCapitalId]]);
    expect(fq.rows[0].n).toBe(2);
    const docs = await pool.query("SELECT count(*)::int AS n FROM documents WHERE application_id = ANY($1::text[]) AND tamper_scanned_at IS NULL", [[equipmentId, workingCapitalId]]);
    expect(docs.rows[0].n).toBe(0);
  });

  it("lists both applications for the review phone", async () => {
    const res = await get("/api/client/applications/by-phone");
    expect(res.status).toBe(200);
    const ids = (res.body.applications as Array<{ id: string }>).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining([equipmentId, workingCapitalId]));
    const mine = (res.body.applications as any[]).filter((a) => a.id === equipmentId || a.id === workingCapitalId);
    expect(mine[0]).toMatchObject({ id: equipmentId, pipeline_state: "Offer", business_name: REVIEW_DEMO_BUSINESS, product_category: "EQUIPMENT", signature_needed: false });
    expect(mine[1]).toMatchObject({ id: workingCapitalId, pipeline_state: "Funded", product_category: "WORKING_CAPITAL" });
    expect(Number(mine[0].requested_amount)).toBe(85000);
    expect(Number(mine[1].requested_amount)).toBe(50000);
  });

  it("returns the stage of each application", async () => {
    const a = await get("/api/client/application-stage?applicationId=" + equipmentId);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ found: true, pipeline_state: "Offer" });
    expect(a.body.metadata.business.name).toBe(REVIEW_DEMO_BUSINESS);
    const b = await get("/api/client/application-stage?applicationId=" + workingCapitalId);
    expect(b.body).toMatchObject({ found: true, pipeline_state: "Funded" });
    const s = await get("/api/client/application/" + equipmentId + "/status");
    expect(s.status).toBe(200);
    expect(s.body.status.pipelineState).toBe("Offer");
    expect(s.body.status.applicant).toMatchObject({ firstName: "Alex", lastName: "Morgan" });
    expect(Object.keys(s.body.status.documents)).toHaveLength(4);
  });

  it("shows the two lender offers on application A", async () => {
    const res = await get("/api/client/offers?applicationId=" + equipmentId);
    expect(res.status).toBe(200);
    const items = res.body.items as any[];
    expect(items).toHaveLength(2);
    expect(items.every((o) => o.status === "pending" && Number(o.amount) === 85000)).toBe(true);
    expect(items.filter((o) => o.recommended)).toHaveLength(1);
    expect(items.every((o) => new Date(o.expiry_date).getTime() > Date.now())).toBe(true);
    const funded = await get("/api/client/offers?applicationId=" + workingCapitalId);
    expect((funded.body.items as any[]).map((o) => o.status)).toEqual(["accepted"]);
  });

  it("shows the documents as received, with nothing outstanding or rejected", async () => {
    for (const id of [equipmentId, workingCapitalId]) {
      const needed = await get("/api/client/documents-needed/needed?applicationId=" + id);
      expect(needed.status).toBe(200);
      expect(needed.body.stillNeeded).toEqual([]);
      expect(needed.body.rejected).toEqual([]);
      expect(needed.body.required).toHaveLength(4);
      const rejected = await get("/api/client/rejected-documents?applicationId=" + id);
      expect(rejected.body.items).toEqual([]);
      const ac = await get("/api/client/documents-needed/action-center?applicationId=" + id);
      expect(ac.status).toBe(200);
      expect(ac.body.outstandingCount).toBe(0);
    }
    const pq = await get("/api/client/applications/" + equipmentId + "/product-questions");
    expect(pq.status).toBe(200);
    expect(pq.body.missing).toEqual([]);
  });

  it("shows the advisor's messages in the thread", async () => {
    const res = await get("/api/client/messages?applicationId=" + equipmentId);
    expect(res.status).toBe(200);
    const rows = res.body.data as Array<{ direction: string; staff_name: string | null; body: string }>;
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.direction === "outbound" && r.staff_name === "Boreal Financial Advisor")).toBe(true);
    expect(rows[2].body).toMatch(/two lenders have made offers/);
    const b = await get("/api/client/messages?applicationId=" + workingCapitalId);
    expect((b.body.data as any[]).map((r) => r.direction)).toEqual(["outbound", "inbound", "outbound"]);
    const advisor = await get("/api/client/advisor?applicationId=" + equipmentId);
    expect(advisor.status).toBe(200);
  });
});
