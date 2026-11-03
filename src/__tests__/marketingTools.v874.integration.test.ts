// BF_SERVER_v874_MARKETING_TOOLS - the marketing tools against real Postgres: the migration (twice), lead scores per
// silo, the website kit end to end (a lead in the kit's silo, consent only when ticked, the wrong website refused), the
// A/B subject test through the campaign ledger, and the campaign report's funded-deal attribution. Every assertion is
// scoped to this test's own rows; the one setting it writes (its silo's website kit) is put back afterwards.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const { sendOne, notifyAllStaff, emitAutomationEvent } = vi.hoisted(() => ({ sendOne: vi.fn(), notifyAllStaff: vi.fn(), emitAutomationEvent: vi.fn() }));
vi.mock("../services/sendgridService.js", async (orig) => ({ ...(await orig<any>()), sendOne }));
vi.mock("../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff }));
vi.mock("../modules/automation/automationEngine.js", async (orig) => ({ ...(await orig<any>()), emitAutomationEvent }));

import { pool } from "../db.js";
import { rerunMigration } from "./helpers/rerunMigration.js"; // BF_SERVER_v886_MIGRATION_RERUN
import { markReady } from "../startupState.js";
import { deps } from "../system/deps.js";
import { clearVisibilityCache } from "../visibility/scope.js";
import { clearStaffUserCache, dbStaffUserLoader, resetStaffUserLoader, setStaffUserLoader } from "../auth/staffUserState.js";
import leadScoreRoutes from "../routes/leadScores.js";
import { websiteKitAdminRoutes, websiteKitPublicRoutes } from "../routes/websiteKit.js";
import campaignReportRoutes from "../marketing/campaignReport.js";
import { runCampaignEmailJob } from "../marketing/campaignRunner.js";

const MIGRATION = "migrations/2026_11_15_v874_marketing_tools.sql";
const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID();
const BF_HOT = randomUUID(), BI_ONE = randomUUID();
const JOB = randomUUID();
const people = Array.from({ length: 6 }, () => randomUUID());
const APP = randomUUID();
const KIT_KEY = "website_kit:SLF";
const ORIGIN = `https://partner-${tag}.example.ca`;
const tok = (id: string, role: string) => `Bearer ${jwt.sign({ sub: id, id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET))}`;
let savedKit: unknown = undefined;
let kitContacts: string[] = [];

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/lead-scores", leadScoreRoutes);
  a.use("/api/website-kit", websiteKitAdminRoutes);
  a.use("/api/kit", websiteKitPublicRoutes);
  // The report is mounted inside the marketing router in production (auth + marketing access); here a signed-in Admin.
  a.use("/api/marketing", (req: any, _res, next) => { req.user = { role: "Admin", userId: ADMIN }; next(); }, campaignReportRoutes);
  return a;
}

describe("v874 marketing tools (real Postgres)", () => {
  beforeAll(async () => {
    markReady();
    deps.db.client = pool;
    deps.db.ready = true;
    setStaffUserLoader(dbStaffUserLoader, { cache: false });
    await rerunMigration(pool, readFileSync(MIGRATION, "utf8"));
    await rerunMigration(pool, readFileSync(MIGRATION, "utf8")); // safe to run again
    savedKit = (await pool.query(`SELECT value FROM boreal_settings WHERE key = $1`, [KIT_KEY])).rows[0]?.value;
    await pool.query(`INSERT INTO users (id, email, active, role, first_name, last_name) VALUES ($1, $2, true, 'Admin', 'M', 'Tools')`, [ADMIN, `admin-${tag}@example.com`]);
    await pool.query(
      `INSERT INTO contacts (id, name, email, phone, job_title, tags, silo) VALUES
         ($1, 'Hot Lead', $3, '403-555-0101', 'Owner', ARRAY['website_form'], 'BF'),
         ($2, 'BI Lead', $4, '403-555-0102', NULL, '{}', 'BI')`,
      [BF_HOT, BI_ONE, `hot-${tag}@example.com`, `bi-${tag}@example.com`],
    );
    await pool.query(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) SELECT $1, 'email_open', '{}'::jsonb FROM generate_series(1, 3)`, [BF_HOT]);
    for (const [i, id] of people.entries()) {
      await pool.query(
        `INSERT INTO contacts (id, name, email, tags, silo, sms_consent, consent_basis, consent_at) VALUES ($1, $2, $3, ARRAY[$4], 'BI', true, 'express', now())`,
        [id, `Person ${i}`, `p${i}-${tag}@example.com`, `ab-${tag}`],
      );
    }
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM campaign_sends WHERE job_id = $1`, [JOB]);
    await pool.query(`DELETE FROM marketing_send_jobs WHERE id = $1`, [JOB]);
    await pool.query(`DELETE FROM applications WHERE id = $1`, [APP]);
    const all = [BF_HOT, BI_ONE, ...people, ...kitContacts];
    await pool.query(`DELETE FROM lead_scores WHERE contact_id = ANY($1::uuid[])`, [all]);
    await pool.query(`DELETE FROM crm_timeline_events WHERE contact_id = ANY($1::uuid[])`, [all]);
    await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [all]);
    await pool.query(`DELETE FROM companies WHERE name = $1`, [`Kit Co ${tag}`]);
    await pool.query(`DELETE FROM website_kit_forms WHERE name = $1`, [`Quote ${tag}`]);
    if (savedKit === undefined) await pool.query(`DELETE FROM boreal_settings WHERE key = $1`, [KIT_KEY]);
    else await pool.query(`UPDATE boreal_settings SET value = $2::jsonb WHERE key = $1`, [KIT_KEY, JSON.stringify(savedKit)]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [ADMIN]);
    resetStaffUserLoader();
  });

  it("scores a silo's own contacts with that silo's rules", async () => {
    clearStaffUserCache();
    clearVisibilityCache();
    const bf = await request(app()).post("/api/lead-scores/lookup").set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "BF").send({ contact_ids: [BF_HOT, BI_ONE] });
    expect(bf.status).toBe(200);
    expect(Object.keys(bf.body.scores)).toEqual([BF_HOT]);
    // phone 10 + owner 10 + website_form tag 10 + 3 opens x 2 = 36
    expect(bf.body.scores[BF_HOT]).toMatchObject({ score: 36, rules_points: 30, engagement_points: 6, grade: "cold" });
    const stored = await pool.query(`SELECT silo, score FROM lead_scores WHERE contact_id = $1`, [BF_HOT]);
    expect(stored.rows[0]).toEqual({ silo: "BF", score: 36 });
    const bi = await request(app()).post("/api/lead-scores/lookup").set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "BI").send({ contact_ids: [BF_HOT, BI_ONE] });
    expect(Object.keys(bi.body.scores)).toEqual([BI_ONE]);
  });

  it("turns a website kit form into a lead in the kit's silo, with consent only when the box was ticked", async () => {
    const admin = (r: request.Test) => r.set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "SLF");
    const first = await admin(request(app()).get("/api/website-kit"));
    expect(first.status).toBe(200);
    const key = first.body.settings.key as string;
    expect(key).toMatch(/^[a-f0-9]{24}$/);
    await admin(request(app()).put("/api/website-kit/settings")).send({ allowed_origins: [ORIGIN] }).expect(200);
    const made = await admin(request(app()).post("/api/website-kit/forms")).send({ name: `Quote ${tag}`, tag: "partner page" });
    expect(made.status).toBe(201);
    const formId = made.body.form.id as string;
    expect(made.body.form).toMatchObject({ silo: "SLF", tag: "partner_page" });

    const js = await request(app()).get(`/api/kit/${key}/kit.js`);
    expect(js.text).toContain(formId);

    const post = (origin: string, body: unknown) => request(app()).post(`/api/kit/${key}/forms/${formId}`).set("Origin", origin).set("Content-Type", "text/plain").send(JSON.stringify(body));
    const email = `kit-${tag}@example.com`;
    expect((await post("https://elsewhere.example.com", { fields: { full_name: "Kit Lead", email } })).status).toBe(403);
    const ok = await post(ORIGIN, { fields: { full_name: "Kit Lead", email, company: `Kit Co ${tag}` }, consent: true, consentText: "something else" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, contact: "created" });
    const c = (await pool.query(`SELECT id::text AS id, silo, tags, consent_basis, consent_source, consent_text, company_id FROM contacts WHERE lower(email) = $1`, [email])).rows;
    kitContacts.push(...c.map((x) => x.id));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ silo: "SLF", consent_basis: "express", consent_source: "website_kit_form" });
    expect(c[0].consent_text).toBe("I agree to receive calls, texts and emails from Site Level Financial about my inquiry. I can unsubscribe at any time.");
    expect(c[0].tags).toEqual(expect.arrayContaining(["website_form", "partner_page"]));
    expect(c[0].company_id).toBeTruthy();
    expect(notifyAllStaff.mock.calls.at(-1)?.[0]).toMatchObject({ silo: "SLF", refId: c[0].id });

    const noConsentEmail = `kit2-${tag}@example.com`;
    expect((await post(ORIGIN, { fields: { full_name: "No Box", email: noConsentEmail }, consent: false })).status).toBe(200);
    const c2 = (await pool.query(`SELECT id::text AS id, consent_basis, sms_consent FROM contacts WHERE lower(email) = $1`, [noConsentEmail])).rows;
    kitContacts.push(...c2.map((x) => x.id));
    expect(c2[0].consent_basis).toBeNull();
    expect(c2[0].sms_consent ?? false).toBe(false);
    const count = await pool.query(`SELECT submissions FROM website_kit_forms WHERE id = $1`, [formId]);
    expect(count.rows[0].submissions).toBe(2);
  });

  it("runs an A/B subject test through the campaign ledger, and the report credits the funded deal", async () => {
    sendOne.mockReset();
    sendOne.mockResolvedValue({ ok: true, status: 202 });
    await pool.query(
      `INSERT INTO marketing_send_jobs (id, channel, silo, tag, payload, status, total) VALUES ($1, 'email', 'BI', NULL, $2, 'running', 6)`,
      [JOB, JSON.stringify({ subject: `A ${tag}`, html: "<p>Hi</p>", tags: [`ab-${tag}`], ab: { subjectB: `B ${tag}`, testPercent: 50, waitHours: 2, phase: "test" } })],
    );
    const job = (await pool.query(`SELECT id::text AS id, silo, tag, payload FROM marketing_send_jobs WHERE id = $1`, [JOB])).rows[0];
    const test = await runCampaignEmailJob(pool, job);
    expect(test).toMatchObject({ status: "waiting", sent: 3 });
    const ledger = await pool.query(`SELECT id, variant, silo FROM campaign_sends WHERE job_id = $1`, [JOB]);
    expect(ledger.rows).toHaveLength(3);
    expect(new Set(ledger.rows.map((r) => r.silo))).toEqual(new Set(["BI"]));
    // Every B email is opened (as the SendGrid webhook would record through cs_id): B wins.
    await pool.query(`UPDATE campaign_sends SET opened_at = now() WHERE job_id = $1 AND variant = 'B'`, [JOB]);
    const second = await runCampaignEmailJob(pool, { ...job, payload: { ...job.payload, ...test.payloadPatch } });
    expect(second).toMatchObject({ status: "done", sent: 6 });
    expect((second.payloadPatch!.ab as any).winner).toBe("B");
    expect(sendOne.mock.calls.slice(3).every((c) => c[0].subject === `B ${tag}`)).toBe(true);
    await pool.query(`UPDATE marketing_send_jobs SET status = 'done', finished_at = now(), payload = payload || $2::jsonb WHERE id = $1`, [JOB, JSON.stringify(second.payloadPatch)]);

    // One person applies after the email and is funded.
    await pool.query(
      `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, contact_id, silo, funded_at, funded_amount)
       VALUES ($1, $2, now() + interval '1 minute', now(), 'Funded', 'RECEIVED', $3, 'BI', now(), 125000)`,
      [APP, `Ab ${tag}`, people[0]],
    );
    const r = await request(app()).get("/api/marketing/campaign-report?days=7").set("X-Silo", "BI");
    expect(r.status).toBe(200);
    const mine = r.body.campaigns.find((c: any) => c.id === JOB);
    expect(mine).toMatchObject({ channel: "email", sent: 6, applications: 1, funded: 1, funded_amount: 125000 });
    expect(mine.opened).toBeGreaterThanOrEqual(1);
    const bf = await request(app()).get("/api/marketing/campaign-report?days=7").set("X-Silo", "BF");
    expect(bf.body.campaigns.find((c: any) => c.id === JOB)).toBeUndefined();
  });
});
