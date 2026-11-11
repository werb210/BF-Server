// BF_SERVER_v872_DEAL_TOOLS - batch 5 against real Postgres (baseline + migrations): the migration twice; a quote built
// from a lender offer with sales tax on a ticked fee, sent, viewed and accepted by the client (the offer staged like its
// own Accept button); ID verification by manual review and by a signed vendor webhook that fraud check 8 reads; the
// weighted commission forecast per rep and team against goals; payment links from Checkout to paid, processing and
// failed on the file and the timeline, and the fee payments report. Record visibility applies throughout.
//
// Parallel-safe: other test files share this database. No shared setting is written (the stage probabilities and the
// ID-check settings are read, never changed); restrictions are set on this file's own people only; every row is this
// file's own and the expectations are scoped to it. Stripe and the ID vendor are stubbed at the edge.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express, { Router } from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import { clearVisibilityCache } from "../visibility/scope.js";
import { recordGuard } from "../visibility/recordGuard.js";
import { clearStaffUserCache, dbStaffUserLoader, resetStaffUserLoader, setStaffUserLoader } from "../auth/staffUserState.js";
import { markReady } from "../startupState.js";
import { deps } from "../system/deps.js";
import { RECORD_GUARDED_MOUNTS } from "../routes/routeRegistry.js";
import { loadCrmTimeline } from "../routes/crm/timeline.js";
import kycRoutes from "../routes/kyc.js";
import clientKycRoutes from "../routes/clientKyc.js";
import forecastRoutes from "../routes/forecast.js";
import paymentsRoutes, { setPaymentSendDepsForTests } from "../routes/payments.js";
import { handleWebhook } from "../kyc/service.js";
import { onfidoProvider, type BinaryFetch } from "../kyc/providers/onfido.js";
import { manualProvider } from "../kyc/providers/index.js";
import { currentMonth, loadProbabilities } from "../forecast/forecast.js";
import { clearStripeAccountCache, setStripeFetchForTests, signStripePayload } from "../payments/stripe.js";
import { runFraudChecks } from "../fraud/engine.js";
import { fraudProviders } from "../fraud/providers/index.js";
import { listResults } from "../fraud/store.js";

const MIGRATION = "migrations/2026_11_13_v872_deal_tools.sql";
const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID(), S1 = randomUUID(), S2 = randomUUID(), TEAM = randomUUID();
const PEOPLE = [ADMIN, S1, S2];
const C1 = randomUUID(), C2 = randomUUID();
const A1 = randomUUID(), A2 = randomUUID(), A3 = randomUUID(), A4 = randomUUID();
const APPS = [A1, A2, A3, A4];
const OFFER = randomUUID();
const PHONE = `587555${String(Math.floor(Math.random() * 9000) + 1000)}`;
const tok = (id: string, role: string) => `Bearer ${jwt.sign({ sub: id, id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET))}`;
const client = (phone = PHONE) => `Bearer ${jwt.sign({ sub: `client-${tag}`, role: "Client", phone }, String(process.env.JWT_SECRET))}`;
const guarded = (mount: string, router: Router) => Router().use(recordGuard(RECORD_GUARDED_MOUNTS[mount]!, { requireFirst: true }), router);

function app() {
  const a = express();
  a.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
  a.use("/api/kyc", guarded("/kyc", kycRoutes));
  a.use("/api/client/kyc", clientKycRoutes);
  a.use("/api/forecast", guarded("/forecast", forecastRoutes));
  a.use("/api/payments", paymentsRoutes);
  return a;
}
const http = () => request(app());
const fresh = () => { clearStaffUserCache(); clearVisibilityCache(); };
const savedEnv: Record<string, string | undefined> = {};
const month = currentMonth();
const day = (d: number) => `${month}-${String(d).padStart(2, "0")}`;

describe("v872 deal tools (real Postgres)", () => {
  beforeAll(async () => {
    markReady();
    deps.db.client = pool;
    deps.db.ready = true;
    setStaffUserLoader(dbStaffUserLoader, { cache: false });
    const sql = readFileSync(MIGRATION, "utf8");
    await pool.query(sql);
    await pool.query(sql); // safe to run again
    for (const [id, role, first] of [[ADMIN, "Admin", "Ada"], [S1, "Staff", "Sam"], [S2, "Staff", "Sue"]]) {
      await pool.query(
        `INSERT INTO users (id, email, active, is_active, status, role, first_name, last_name, silo, silos)
         VALUES ($1, $2, true, true, 'ACTIVE', $3, $4, 'V872', 'BF', ARRAY['BF'])`,
        [id, `${first.toLowerCase()}-${tag}@example.com`, role, first],
      );
    }
    await pool.query(`INSERT INTO sales_teams (id, name) VALUES ($1, $2)`, [TEAM, `West ${tag}`]);
    await pool.query(`INSERT INTO sales_team_members (team_id, user_id) VALUES ($1, $2)`, [TEAM, S1]);
    const contact = `INSERT INTO contacts (id, name, first_name, last_name, email, phone, owner_id, silo, sms_consent, consent_basis, consent_at)
                     VALUES ($1, $2, $3, 'V872', $4, $5, $6, 'BF', true, 'express', now())`;
    await pool.query(contact, [C1, `Jane ${tag}`, "Jane", `jane-${tag}@example.com`, PHONE, S1]);
    await pool.query(contact, [C2, `Gus ${tag}`, "Gus", `gus-${tag}@example.com`, "+14035550199", S2]);
    const ins = `INSERT INTO applications (id, name, business_legal_name, created_at, updated_at, pipeline_state, status, contact_id, owner_user_id, silo, submitted_at,
                                          requested_amount, funded_amount, funded_at, metadata)
                 VALUES ($1, $2, $2, now(), now(), $3, 'RECEIVED', $4, $5, 'BF', now(), $6, $7, $8, '{}'::jsonb)`;
    await pool.query(ins, [A1, `Quote Co ${tag}`, "Offer", C1, S1, 100000, null, null]);
    await pool.query(ins, [A2, `Funded Co ${tag}`, "Accepted", C1, S1, 50000, 50000, `${day(2)}T18:00:00Z`]);
    await pool.query(ins, [A3, `Other Co ${tag}`, "In Review", C2, S2, 200000, null, null]);
    await pool.query(ins, [A4, `Fee Co ${tag}`, "Off to Lender", C1, S1, 80000, null, null]);
    await pool.query(`INSERT INTO offers (id, application_id, lender_name, amount, rate_factor, term, payment_frequency, status) VALUES ($1, $2, 'Northern Capital', 75000, '1.28', '9 months', 'Weekly', 'pending')`, [OFFER, A1]);
    await pool.query(`INSERT INTO report_goals (user_id, month, funding_target, commission_target) VALUES ($1, $2::date, 200000, 4000)`, [S1, `${month}-01`]);
    for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "PUBLIC_BASE_URL"]) savedEnv[k] = process.env[k];
    process.env.STRIPE_SECRET_KEY = "sk_test_v872";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_v872";
    process.env.PUBLIC_BASE_URL = "https://server.example";
    fresh();
  });

  afterAll(async () => {
    const clean = (sql: string, params: unknown[] = []) => pool.query(sql, params).catch((e) => console.warn("cleanup", String(e)));
    setStripeFetchForTests(null);
    setPaymentSendDepsForTests(null);
    clearStripeAccountCache();
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await clean(`DELETE FROM payment_links WHERE application_id = ANY($1::text[]) OR contact_id = ANY($2::uuid[])`, [APPS, [C1, C2]]);
    await clean(`DELETE FROM stripe_webhook_events WHERE event_id LIKE $1`, [`evt_${tag}%`]);
    await clean(`DELETE FROM quotes WHERE application_id = ANY($1::text[])`, [APPS]);
    await clean(`DELETE FROM kyc_verifications WHERE application_id = ANY($1::text[])`, [APPS]);
    for (const t of ["fraud_check_results", "fraud_queue", "document_fingerprints"]) await clean(`DELETE FROM ${t} WHERE application_id = ANY($1::text[])`, [APPS]);
    await clean(`DELETE FROM document_versions WHERE document_id IN (SELECT id FROM documents WHERE application_id = ANY($1::text[]))`, [APPS]);
    await clean(`DELETE FROM documents WHERE application_id = ANY($1::text[])`, [APPS]);
    await clean(`DELETE FROM notifications WHERE application_id = ANY($1::text[]) OR user_id = ANY($2::uuid[])`, [APPS, PEOPLE]);
    await clean(`DELETE FROM communications_messages WHERE application_id::text = ANY($1::text[])`, [APPS]);
    await clean(`DELETE FROM client_notifications WHERE application_id = ANY($1::text[])`, [APPS]);
    await clean(`DELETE FROM crm_timeline_events WHERE contact_id = ANY($1::uuid[])`, [[C1, C2]]);
    await clean(`DELETE FROM offers WHERE id = $1`, [OFFER]);
    await clean(`DELETE FROM report_goals WHERE user_id = ANY($1::uuid[])`, [PEOPLE]);
    await clean(`DELETE FROM applications WHERE id = ANY($1::text[])`, [APPS]);
    await clean(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [[C1, C2]]);
    await clean(`DELETE FROM sales_teams WHERE id = $1`, [TEAM]);
    await clean(`DELETE FROM audit_events WHERE actor_user_id = ANY($1::uuid[])`, [PEOPLE]);
    await clean(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [PEOPLE]);
    resetStaffUserLoader();
  });

  describe("ID verification", () => {
    it("staff send a request (manual review without a vendor); the applicant uploads ID and selfie; staff approve", async () => {
      const view = await http().get(`/api/kyc/applications/${A4}`).set("Authorization", tok(S1, "Staff"));
      expect(view.status).toBe(200);
      expect(view.body.people[0]).toMatchObject({ contact_id: C1, role: "applicant" });
      expect(view.body.provider).toMatchObject({ key: "manual", configured: true }); // no ID vendor is set up in tests
      const sent = await http().post(`/api/kyc/applications/${A4}/requests`).set("Authorization", tok(S1, "Staff")).send({});
      expect(sent.status).toBe(201);
      const vid = sent.body.verification.id;
      const cta = await pool.query(`SELECT cta_action FROM communications_messages WHERE application_id::text = $1`, [A4]);
      expect(cta.rows.map((r: any) => r.cta_action)).toContain("id_verify");

      expect((await http().get(`/api/client/kyc/applications/${A4}`).set("Authorization", client("4035550000"))).status).toBe(403);
      const mine = await http().get(`/api/client/kyc/applications/${A4}`).set("Authorization", client());
      expect(mine.body).toMatchObject({ enabled: true, verifications: [{ id: vid, status: "requested", mode: "upload" }] });
      expect((await http().post(`/api/client/kyc/verifications/${vid}/start`).set("Authorization", client())).body).toMatchObject({ ok: true, mode: "upload" });
      const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
      const up = await http().post(`/api/client/kyc/verifications/${vid}/upload`).set("Authorization", client())
        .attach("id_front", jpg, { filename: "front.jpg", contentType: "image/jpeg" })
        .attach("selfie", jpg, { filename: "me.jpg", contentType: "image/jpeg" });
      expect(up.status).toBe(200);
      expect(up.body).toEqual({ ok: true, status: "review" });
      const docs = await pool.query(`SELECT category FROM documents WHERE application_id = $1`, [A4]);
      expect(docs.rows.map((d: any) => d.category)).toEqual(["Identity verification", "Identity verification"]);
      const ok = await http().post(`/api/kyc/verifications/${vid}/decision`).set("Authorization", tok(S1, "Staff")).send({ decision: "approved", note: "Matches" });
      expect(ok.status).toBe(200);
      expect(ok.body.verification).toMatchObject({ status: "approved", decision_source: "staff" });
      expect((await http().get(`/api/kyc/verifications/${vid}/id-details?full=1`).set("Authorization", tok(S1, "Staff"))).status).toBe(403);
    });

    it("a signed vendor webhook lands the result encrypted and stores the images; fraud check 8 reads it", async () => {
      const run = `run-${tag}`;
      const vid = randomUUID();
      await pool.query(
        `INSERT INTO kyc_verifications (id, application_id, contact_id, person_role, provider, status, vendor_session_id, vendor_applicant_id)
         VALUES ($1, $2, $3, 'guarantor', 'onfido', 'in_progress', $4, 'appl-1')`, [vid, A3, C2, run]);
      const routes: Record<string, any> = {
        [`/workflow_runs/${run}`]: { id: run, status: "declined", applicant_id: "appl-1", reasons: ["document_tampered"] },
        "/checks": { checks: [{ report_ids: ["rep-doc"] }] },
        "/reports/rep-doc": { name: "document", result: "consider", sub_result: "suspected", properties: { document_numbers: [{ value: "X99887766" }], date_of_birth: "1970-01-01" } },
        "/documents?": { documents: [{ id: "d1", side: "front", file_type: "jpg" }] },
        "/documents/d1/download": {},
        "/live_photos?": { live_photos: [] },
      };
      const f: BinaryFetch = (async (url: string) => {
        const path = url.replace(/^https:\/\/api\.ca\.onfido\.com\/v3\.6/, "");
        const key = Object.keys(routes).find((k) => path.startsWith(k));
        return { ok: Boolean(key), status: key ? 200 : 404, json: async () => (key ? routes[key] : {}), arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 9, 0xff, 0xd9]).buffer, headers: { get: () => "image/jpeg" } };
      }) as BinaryFetch;
      const env = { ONFIDO_API_TOKEN: "t", ONFIDO_WORKFLOW_ID: "w", ONFIDO_WEBHOOK_TOKEN: "hook", NODE_ENV: "test" } as any;
      const providers = { onfido: onfidoProvider(env, f), manual: manualProvider() };
      const storage = { put: async (x: any) => ({ blobName: `k/${x.filename}`, url: `https://blob/${x.filename}`, hash: "h", sizeBytes: x.buffer.length }) };
      const body = { payload: { resource_type: "workflow_run", action: "workflow_run.completed", object: { id: run } } };
      const raw = Buffer.from(JSON.stringify(body));
      const sig = createHmac("sha256", "hook").update(raw).digest("hex");
      expect((await handleWebhook("onfido", raw, { "x-sha2-signature": "0".repeat(64) }, body, { providers, storage })).status).toBe(401);
      expect(await handleWebhook("onfido", raw, { "x-sha2-signature": sig }, body, { providers, storage })).toMatchObject({ status: 200, outcome: "processed" });
      expect((await handleWebhook("onfido", raw, { "x-sha2-signature": sig }, body, { providers, storage })).outcome).toBe("duplicate");
      const row = (await pool.query(`SELECT * FROM kyc_verifications WHERE id = $1`, [vid])).rows[0];
      expect(row.status).toBe("declined");
      expect(row.document_ids).toHaveLength(1);
      expect(JSON.stringify(row)).not.toContain("X99887766");
      expect(row.pii_enc).toBeTruthy();
      const reveal = await http().get(`/api/kyc/verifications/${vid}/id-details`).set("Authorization", tok(S2, "Staff"));
      expect(reveal.body.details.document_number).toBe("*****7766");
      const full = await http().get(`/api/kyc/verifications/${vid}/id-details?full=1`).set("Authorization", tok(ADMIN, "Admin"));
      expect(full.body.details.document_number).toBe("X99887766");

      await runFraudChecks(pool as any, A3, { providers: fraudProviders({ NODE_ENV: "test" } as any), loadFile: async () => null });
      const f8 = (await listResults(pool as any, A3)).find((r) => r.check_key === "fraud_8");
      expect(f8?.status).toBe("red");
      expect(JSON.stringify(f8?.reasons)).toContain("idv_declined");
    });
  });

  describe("forecast", () => {
    it("staff set a file's close date and category; only Admins change the stage chances", async () => {
      expect((await http().put(`/api/forecast/stages`).set("Authorization", tok(S1, "Staff")).send({ stages: { Offer: 50 } })).status).toBe(403);
      expect((await http().put(`/api/forecast/stages`).set("Authorization", tok(ADMIN, "Admin")).send({ stages: { Offer: 101 } })).status).toBe(400);
      expect((await http().put(`/api/forecast/applications/${A1}`).set("Authorization", tok(S1, "Staff")).send({ forecast_category: "maybe" })).status).toBe(400);
      const probs = await loadProbabilities(pool as any);
      const f = await http().put(`/api/forecast/applications/${A1}`).set("Authorization", tok(S1, "Staff")).send({ expected_close_date: day(20), forecast_category: "commit" });
      expect(f.status).toBe(200);
      expect(f.body).toMatchObject({ expected_close_date: day(20), forecast_category: "commit", probability: probs.Offer, effective_category: "commit" });
      await http().put(`/api/forecast/applications/${A3}`).set("Authorization", tok(ADMIN, "Admin")).send({ expected_close_date: day(25), forecast_category: "pipeline" });
      await http().put(`/api/forecast/applications/${A4}`).set("Authorization", tok(ADMIN, "Admin")).send({ forecast_category: "omit" });
      const stages = await http().get(`/api/forecast/stages`).set("Authorization", tok(S1, "Staff"));
      expect(stages.body.stages.find((s: any) => s.stage === "Offer").probability).toBe(probs.Offer);
    });

    it("per rep, team and total against goals; staff see only their own", async () => {
      const probs = await loadProbabilities(pool as any);
      const r = await http().get(`/api/forecast?granularity=month&periods=2`).set("Authorization", tok(ADMIN, "Admin"));
      expect(r.status).toBe(200);
      const sam = r.body.reps.find((x: any) => x.user_id === S1);
      // funded 50,000 x 2% = 1,000 closed; open 100,000 x 2% = 2,000 committed at the Offer stage's chance; A4 omitted
      expect(sam.periods[0]).toMatchObject({ closed: 1000, commit: 3000, best_case: 3000, pipeline: 3000, weighted: Math.round(1000 + 2000 * probs.Offer! / 100), goal_commission: 4000 });
      const sue = r.body.reps.find((x: any) => x.user_id === S2);
      expect(sue.periods[0]).toMatchObject({ commit: 0, pipeline: 4000, weighted: Math.round(4000 * probs["In Review"]! / 100) });
      expect(r.body.teams.find((t: any) => t.team_id === TEAM).periods[0]).toMatchObject({ closed: 1000, commit: 3000 });
      expect(r.body.deals.find((d: any) => d.id === A4)).toMatchObject({ category: "omit" });

      const own = await http().get(`/api/forecast?user_id=${S2}`).set("Authorization", tok(S1, "Staff"));
      expect(own.body.own).toBe(true);
      expect(own.body.reps.map((x: any) => x.user_id)).toEqual([S1]);
      expect(own.body.teams).toEqual([]);
      const team = await http().get(`/api/forecast?team_id=${TEAM}`).set("Authorization", tok(ADMIN, "Admin"));
      expect(team.body.reps.map((x: any) => x.user_id)).toEqual([S1]);
    });
  });

  describe("payment links", () => {
    const stripeCalls: Array<{ url: string; body: string }> = [];
    beforeAll(() => {
      clearStripeAccountCache();
      setStripeFetchForTests(async (url, init) => {
        stripeCalls.push({ url, body: String(init?.body ?? "") });
        if (url.endsWith("/account")) return new Response(JSON.stringify({ id: "acct_boreal", business_profile: { name: "Boreal Financial" }, country: "CA", default_currency: "cad", charges_enabled: true, capabilities: { card_payments: "active", acss_debit_payments: "active" } }), { status: 200 });
        if (url.endsWith("/checkout/sessions")) return new Response(JSON.stringify({ id: `cs_${tag}_${stripeCalls.length}`, url: `https://checkout.stripe.com/c/${tag}`, expires_at: Math.floor(Date.now() / 1000) + 3600 }), { status: 200 });
        return new Response(JSON.stringify({ error: { message: "unexpected" } }), { status: 400 });
      });
      setPaymentSendDepsForTests({ email: async () => ({ ok: true }), sms: async () => ({ ok: true }) });
    });

    const event = (id: string, type: string, object: Record<string, unknown>) => {
      const payload = JSON.stringify({ id: `evt_${tag}_${id}`, type, data: { object } });
      return { payload, sig: signStripePayload(payload, "whsec_v872") };
    };
    const post = (e: { payload: string; sig: string }) =>
      http().post("/api/payments/stripe/webhook").set("Content-Type", "application/json").set("Stripe-Signature", e.sig).send(e.payload);

    it("Admins see the set-up; staff send a card + bank debit link from a file, by email and text", async () => {
      const s = await http().get("/api/payments/settings").set("Authorization", tok(ADMIN, "Admin"));
      expect(s.body).toMatchObject({ configured: true, livemode: false, account: { acss_debit_enabled: true }, webhook_url: "https://server.example/api/payments/stripe/webhook" });
      expect((await http().get("/api/payments/settings").set("Authorization", tok(S1, "Staff"))).status).toBe(403);
      const bad = await http().post("/api/payments/links").set("Authorization", tok(S1, "Staff")).send({ application_id: A4, amount: "0" });
      expect(bad.status).toBe(400);
      const r = await http().post("/api/payments/links").set("Authorization", tok(S1, "Staff"))
        .send({ application_id: A4, amount: "1,600.00", description: "Broker fee", methods: ["card", "acss_debit"], send: { email: true, sms: true } });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ link: { status: "open", amount: 1600, contact_id: C1, application_id: A4 }, sent: ["email", "sms"] });
      const list = await http().get(`/api/payments/links?application_id=${A4}`).set("Authorization", tok(S1, "Staff"));
      expect(list.body.links).toHaveLength(1);
    });

    it("the client's link opens Stripe Checkout; a card payment is paid on the file and the timeline", async () => {
      const link = (await pool.query(`SELECT * FROM payment_links WHERE application_id = $1`, [A4])).rows[0];
      const open = await http().get(`/api/payments/pay/${link.token}`).redirects(0);
      expect(open.status).toBe(303);
      expect(open.headers.location).toBe(`https://checkout.stripe.com/c/${tag}`);
      expect(decodeURIComponent(stripeCalls.find((c) => c.url.endsWith("/checkout/sessions"))!.body)).toContain("payment_method_types[1]=acss_debit");
      expect((await http().post("/api/payments/stripe/webhook").set("Content-Type", "application/json").set("Stripe-Signature", "t=1,v1=00").send("{}")).status).toBe(400);
      const paid = event("paid", "checkout.session.completed", { id: link.checkout_session_id, metadata: { boreal_payment_link: link.id }, payment_status: "paid", amount_total: 160000, payment_intent: "pi_1" });
      expect((await post(paid)).body).toMatchObject({ ok: true, handled: true });
      expect((await post(paid)).body).toMatchObject({ ok: true, duplicate: true });
      const row = (await pool.query(`SELECT status, payment_method_type, quickbooks_status FROM payment_links WHERE id = $1`, [link.id])).rows[0];
      expect(row.status).toBe("paid");
      expect(row.payment_method_type).toBe("card");
      expect(["not_applicable", "recorded", "retrying"]).toContain(row.quickbooks_status);
      const tl = await loadCrmTimeline(true, C1, "BF");
      expect(tl.map((t: any) => t.title)).toEqual(expect.arrayContaining(["Payment link sent: $1,600.00", "Payment received: $1,600.00"]));
      const note = await pool.query(`SELECT title FROM notifications WHERE user_id = $1 AND ref_table = 'payment_links'`, [S1]);
      expect(note.rows.map((n: any) => n.title)).toContain("Payment received: $1,600.00");
      const done = await http().get(`/api/payments/pay/${link.token}`).redirects(0);
      expect(done.status).toBe(200);
      expect(done.text).toContain("Already paid");
    });

    it("a bank debit is processing, then fails (open to retry); the fee payments report counts this file's links", async () => {
      const r = await http().post("/api/payments/links").set("Authorization", tok(S1, "Staff")).send({ contact_id: C1, amount: 500, description: "Admin fee", methods: ["acss_debit"] });
      expect(r.status).toBe(201);
      const id = r.body.link.id;
      await post(event("proc", "checkout.session.completed", { id: "cs_x", metadata: { boreal_payment_link: id }, payment_status: "unpaid", payment_intent: "pi_2" }));
      expect((await pool.query(`SELECT status FROM payment_links WHERE id = $1`, [id])).rows[0].status).toBe("processing");
      await post(event("fail", "checkout.session.async_payment_failed", { id: "cs_x", metadata: { boreal_payment_link: id } }));
      expect((await pool.query(`SELECT status FROM payment_links WHERE id = $1`, [id])).rows[0].status).toBe("failed");
      const tl = await loadCrmTimeline(true, C1, "BF");
      expect(tl.map((t: any) => t.title)).toEqual(expect.arrayContaining(["Bank debit authorized: $500.00", "Payment failed: $500.00"]));
      const cancel = await http().post(`/api/payments/links/${id}/cancel`).set("Authorization", tok(S1, "Staff"));
      expect(cancel.body.link.status).toBe("cancelled");

      const rep = await http().get("/api/payments/report?days=30").set("Authorization", tok(ADMIN, "Admin"));
      expect(rep.status).toBe(200);
      expect(rep.body.paid.count).toBeGreaterThanOrEqual(1);
      expect(rep.body.paid.amount).toBeGreaterThanOrEqual(1600);
      expect((await http().get("/api/payments/report").set("Authorization", tok(S1, "Staff"))).status).toBe(403);
    });
  });
});
