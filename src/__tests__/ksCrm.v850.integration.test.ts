// BF_SERVER_v850_KS_CRM - the KS-Ops ingest and the Keystone pipeline against real Postgres (baseline + migrations):
// key auth, idempotency, forward-only stages, matching by email / phone / company_code, the timeline, and KS records
// staying out of BF lists (and BF records out of KS).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import ksCrmRoutes from "../routes/ksCrm.js";
import crmRoutes from "../routes/crm.js";
import { loadCrmTimeline } from "../routes/crm/timeline.js";

const MIGRATION = "migrations/2026_10_23_v850_ks_crm.sql";
const KEY = "ks-ops-" + "x".repeat(40);
const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID();
const STAFF = randomUUID();
const MARKETING_KS = randomUUID();
const token = (role: string, id: string) => jwt.sign({ sub: id, id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET));
const email = `ada-${tag}@example.com`;
const phoneDigits = `403555${String(Math.floor(1000 + Math.random() * 8999))}`;
const bfContact = randomUUID();
const touchedContacts = new Set<string>();
const touchedCompanies = new Set<string>();

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/ks/crm", ksCrmRoutes);
  a.use("/api/crm", crmRoutes);
  return a;
}
const push = (body: object, key = KEY) => request(app()).post("/api/ks/crm/upsert").set("X-KS-Ops-Key", key).send(body);
const remember = (r: { body: { contact_id?: string | null; company_id?: string | null } }) => {
  if (r.body.contact_id) touchedContacts.add(r.body.contact_id);
  if (r.body.company_id) touchedCompanies.add(r.body.company_id);
};

describe("v850 Keystone CRM (real Postgres)", () => {
  beforeAll(async () => {
    await pool.query(readFileSync(MIGRATION, "utf8"));
    await pool.query(readFileSync(MIGRATION, "utf8")); // safe to run again
    process.env.KS_OPS_CRM_KEY = KEY;
    await pool.query(
      `INSERT INTO users (id, email, active, role, first_name, last_name, silo, silos) VALUES
         ($1, $2, true, 'Admin', 'Pat', 'Admin', 'BF', ARRAY['BF']),
         ($3, $4, true, 'Staff', 'Sam', 'Staff', 'BF', ARRAY['BF','BI']),
         ($5, $6, true, 'Marketing', 'Andy', 'Marketing', 'BF', ARRAY['BF','BI','KS'])`,
      [ADMIN, `admin-${tag}@example.com`, STAFF, `staff-${tag}@example.com`, MARKETING_KS, `mkt-${tag}@example.com`],
    );
    // A BF contact with the same phone: KS matching must never pick it up.
    await pool.query(`INSERT INTO contacts (id, name, email, phone, silo) VALUES ($1, 'Bea BF', $2, $3, 'BF')`, [bfContact, `bea-${tag}@example.com`, `+1${phoneDigits}`]);
  });

  afterAll(async () => {
    delete process.env.KS_OPS_CRM_KEY;
    const clean = (sql: string, params: unknown[]) => pool.query(sql, params).catch((e) => console.warn("cleanup", String(e)));
    const contacts = [...touchedContacts, bfContact];
    const companies = [...touchedCompanies];
    await clean("DELETE FROM crm_notes WHERE contact_id = ANY($1::uuid[]) OR company_id = ANY($2::uuid[])", [contacts, companies]);
    await clean("DELETE FROM ks_crm_refs WHERE external_id LIKE $1", [`%${tag}%`]);
    await clean("DELETE FROM ks_crm_timeline_keys WHERE dedupe_key LIKE $1", [`%${tag}%`]);
    await clean("DELETE FROM contacts WHERE id = ANY($1::uuid[])", [contacts]);
    await clean("DELETE FROM companies WHERE id = ANY($1::uuid[])", [companies]);
    await clean("DELETE FROM users WHERE id = ANY($1::uuid[])", [[ADMIN, STAFF, MARKETING_KS]]);
  });

  it("refuses a wrong key and 400s a bad body", async () => {
    expect((await push({ source: "demo_signup", external_id: "x" }, "wrong")).status).toBe(401);
    const bad = await push({ source: "nope", external_id: "" });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.source).toBeTruthy();
  });

  it("a demo sign-up becomes a KS lead, its events go on the timeline once, and repeats are idempotent", async () => {
    const body = {
      source: "demo_signup", external_id: `demo-${tag}`, stage: "lead",
      contact: { name: "Ada Lovelace", email: email.toUpperCase(), phone: `+1 (${phoneDigits.slice(0, 3)}) ${phoneDigits.slice(3, 6)}-${phoneDigits.slice(6)}`, title: "Owner" },
      note: "Wants 5 seats",
      events: [
        { type: "demo_opened", at: "2026-10-23T10:00:00Z", summary: "Opened the demo" },
        { type: "demo_step", at: "2026-10-23T10:05:00Z", summary: "Step 1" },
      ],
    };
    const first = await push(body);
    expect(first.status).toBe(200);
    remember(first);
    expect(first.body).toMatchObject({ ok: true, company_id: null, stage: "lead" });
    const contactId = first.body.contact_id as string;
    expect(contactId).not.toBe(bfContact);

    const again = await push(body);
    expect(again.status).toBe(200);
    expect(again.body.contact_id).toBe(contactId);
    const [row] = (await pool.query(`SELECT silo, email, job_title, ks_stage FROM contacts WHERE id = $1`, [contactId])).rows;
    expect(row).toEqual({ silo: "KS", email, job_title: "Owner", ks_stage: "lead" });
    const notes = (await pool.query(`SELECT body, silo FROM crm_notes WHERE contact_id = $1 ORDER BY created_at`, [contactId])).rows;
    expect(notes.map((n) => n.body)).toEqual([
      "Keystone demo opened: Opened the demo",
      "Keystone demo step: Step 1",
      "Keystone demo sign-up: Wants 5 seats",
    ]);
    expect(notes.every((n) => n.silo === "KS")).toBe(true);
    // The CRM timeline for the KS silo shows them; the BF timeline does not.
    expect((await loadCrmTimeline(true, contactId, "KS")).length).toBeGreaterThanOrEqual(3);
    expect((await loadCrmTimeline(true, contactId, "BF")).filter((e: any) => String(e.body ?? e.summary ?? "").includes("Keystone"))).toEqual([]);

    // Concurrent duplicates still make one contact.
    const burst = await Promise.all([1, 2, 3].map(() => push({ ...body, events: [{ type: "demo_step", at: "2026-10-23T10:06:00Z", summary: "Step 2" }] })));
    expect(new Set(burst.map((r) => r.body.contact_id))).toEqual(new Set([contactId]));
    const [ref] = (await pool.query(`SELECT demo_steps, demo_opened_at FROM ks_crm_refs WHERE source = 'demo_signup' AND external_id = $1`, [`demo-${tag}`])).rows;
    expect(ref.demo_steps).toBe(2);
    expect(new Date(ref.demo_opened_at).toISOString()).toBe("2026-10-23T10:00:00.000Z");
  });

  it("stages move forward only; staff can set lost and an automatic update never leaves it", async () => {
    const ext = `demo-${tag}`;
    const up = await push({ source: "demo_signup", external_id: ext, stage: "demo_finished" });
    expect(up.body.stage).toBe("demo_finished");
    const back = await push({ source: "demo_signup", external_id: ext, stage: "demo_started" });
    expect(back.body.stage).toBe("demo_finished");
    const contactId = up.body.contact_id as string;

    const moved = await request(app()).patch("/api/ks/crm/pipeline/stage").set("Authorization", `Bearer ${token("Admin", ADMIN)}`)
      .send({ kind: "contact", id: contactId, stage: "lost" });
    expect(moved.status).toBe(200);
    expect((await push({ source: "demo_signup", external_id: ext, stage: "paying" })).body.stage).toBe("lost");
    const notes = (await pool.query(`SELECT body FROM crm_notes WHERE contact_id = $1 AND body LIKE 'Keystone stage:%' ORDER BY created_at`, [contactId])).rows.map((r) => r.body);
    expect(notes).toEqual([
      "Keystone stage: Lead -> Demo finished (automatic, from the demo sign-up)",
      "Keystone stage: Demo finished -> Lost (moved by Pat Admin)",
    ]);
    // Staff can bring it back by hand.
    await request(app()).patch("/api/ks/crm/pipeline/stage").set("Authorization", `Bearer ${token("Admin", ADMIN)}`)
      .send({ kind: "contact", id: contactId, stage: "demo_finished" }).expect(200);
  });

  it("a licensee becomes a KS company matched by company_code, linked to the contact found by phone", async () => {
    const lic = await push({
      source: "licensee", external_id: `lic-${tag}`, stage: "signed_up",
      contact: { name: "Ada Lovelace", email: null, phone: phoneDigits },
      company: { name: `Acme Roofing ${tag}`, company_code: `ACME${tag}`, plan: "pro", seats: 5, status: "active" },
    });
    expect(lic.status).toBe(200);
    remember(lic);
    const demo = (await pool.query(`SELECT contact_id::text FROM ks_crm_refs WHERE source = 'demo_signup' AND external_id = $1`, [`demo-${tag}`])).rows[0].contact_id;
    expect(lic.body.contact_id).toBe(demo); // matched by phone (last 10 digits), not the BF contact with the same number
    const companyId = lic.body.company_id as string;
    const [c] = (await pool.query(`SELECT company_id::text, company_name FROM contacts WHERE id = $1`, [demo])).rows;
    expect(c).toEqual({ company_id: companyId, company_name: `Acme Roofing ${tag}` });

    // Stripe confirms payment: same company by code even with a new name, stage Paying.
    const paid = await push({ source: "website_signup", external_id: `web-${tag}`, stage: "paying", company: { name: `Acme Roofing Ltd ${tag}`, company_code: `acme${tag}`, seats: 7 } });
    expect(paid.body).toMatchObject({ company_id: companyId, stage: "paying", contact_id: null });
    const [co] = (await pool.query(`SELECT silo, name, ks_stage, ks_plan, ks_seats, ks_status FROM companies WHERE id = $1`, [companyId])).rows;
    expect(co).toEqual({ silo: "KS", name: `Acme Roofing Ltd ${tag}`, ks_stage: "paying", ks_plan: "pro", ks_seats: 7, ks_status: "active" });

    const board = await request(app()).get("/api/ks/crm/pipeline").query({ q: tag }).set("Authorization", `Bearer ${token("Admin", ADMIN)}`);
    expect(board.status).toBe(200);
    const card = board.body.cards.find((x: any) => x.id === companyId);
    expect(card).toMatchObject({ kind: "company", stage: "paying", contact_id: demo, plan: "pro", seats: 7, demo_steps: 2, silo: "KS" });
    expect(board.body.cards.find((x: any) => x.id === demo)).toBeUndefined(); // shown under its company
  });

  it("KS records stay out of BF lists and BF records out of KS; only KS-allowed staff see the pipeline", async () => {
    const asAdmin = (silo: string) => request(app()).get("/api/crm/contacts").query({ q: tag }).set("Authorization", `Bearer ${token("Admin", ADMIN)}`).set("X-Silo", silo);
    const bf = await asAdmin("BF");
    const ks = await asAdmin("KS");
    expect(bf.status).toBe(200);
    const ids = (r: any) => (r.body.data ?? r.body.items ?? r.body).map((x: any) => x.id);
    expect(ids(bf)).not.toContain([...touchedContacts][0]);
    expect(ids(ks)).toContain([...touchedContacts][0]);
    expect((ks.body.data ?? []).every((x: any) => x.silo === "KS")).toBe(true);
    const bfByPhone = await request(app()).get("/api/crm/contacts").query({ q: phoneDigits }).set("Authorization", `Bearer ${token("Admin", ADMIN)}`).set("X-Silo", "KS");
    expect(ids(bfByPhone)).not.toContain(bfContact);

    expect((await request(app()).get("/api/ks/crm/pipeline").set("Authorization", `Bearer ${token("Staff", STAFF)}`)).status).toBe(403);
    expect((await request(app()).get("/api/ks/crm/pipeline").set("Authorization", `Bearer ${token("Marketing", MARKETING_KS)}`)).status).toBe(200);
    // A Marketing user with KS in their silo access reads the KS CRM with X-Silo: KS.
    const mk = await request(app()).get("/api/crm/contacts").query({ q: tag }).set("Authorization", `Bearer ${token("Marketing", MARKETING_KS)}`).set("X-Silo", "KS");
    expect(ids(mk)).toContain([...touchedContacts][0]);
    // A KS task is accepted by the tasks CHECK now.
    const t = await pool.query(`INSERT INTO tasks (silo, title, type, priority, assignee_user_id, contact_id, source) VALUES ('KS', 'Call Ada', 'CALL', 'NONE', $1, $2, 'MANUAL') RETURNING id`, [ADMIN, [...touchedContacts][0]]);
    await pool.query(`DELETE FROM tasks WHERE id = $1`, [t.rows[0].id]);
  });
});
