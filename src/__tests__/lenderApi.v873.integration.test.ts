// BF_SERVER_v873_LENDER_API - lender API connections against real Postgres: the migration (twice), saving a connection
// with encrypted credentials (Admin only), the webhook (address secret + HMAC), status / offers / conditions landing on
// the file, polling through a stubbed lender, the stage move to Offer, the notification to the assigned staff, the
// lender's condition on the funding conditions checklist, a funded deal's balance on its Active Contract, and record
// visibility on the file's Lender API panel. Every assertion is scoped to this test's own rows.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import { rerunMigration } from "./helpers/rerunMigration.js"; // BF_SERVER_v886_MIGRATION_RERUN
import { clearVisibilityCache } from "../visibility/scope.js";
import { markReady } from "../startupState.js";
import { deps } from "../system/deps.js";
import lenderConnectionsRoutes from "../routes/lenderConnections.js";
import lenderWebhooksRoutes from "../routes/lenderWebhooks.js";
import { Router } from "express";
import { recordGuard } from "../visibility/recordGuard.js";
import { RECORD_GUARDED_MOUNTS } from "../routes/routeRegistry.js";
import { clearStaffUserCache, dbStaffUserLoader, resetStaffUserLoader, setStaffUserLoader } from "../auth/staffUserState.js";
import { setLenderHttpForTests } from "../lenderConnectors/http.js";
import { pollDue } from "../lenderConnectors/poll.js";
import type { Q } from "../settingsPack/common.js";

const MIGRATION = "migrations/2026_11_14_v873_lender_api.sql";
const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID(), STAFF = randomUUID();
const LENDER = randomUUID();
const APP = randomUUID();
const CONTRACT = randomUUID();
const tok = (id: string, role: string) => `Bearer ${jwt.sign({ sub: id, id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET))}`;
const savedKey = process.env.LENDER_CREDENTIALS_ENCRYPTION_KEY;


function app() {
  const a = express();
  a.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
  a.use("/api/lender-connections", Router().use(recordGuard(RECORD_GUARDED_MOUNTS["/lender-connections"]!, { requireFirst: true }), lenderConnectionsRoutes));
  a.use("/api/lender-webhooks", lenderWebhooksRoutes);
  return a;
}

describe("v873 lender API connections (real Postgres)", () => {
  beforeAll(async () => {
    markReady();
    deps.db.client = pool;
    deps.db.ready = true;
    setStaffUserLoader(dbStaffUserLoader, { cache: false });
    await rerunMigration(pool, readFileSync(MIGRATION, "utf8"));
    await rerunMigration(pool, readFileSync(MIGRATION, "utf8")); // safe to run again
    process.env.LENDER_CREDENTIALS_ENCRYPTION_KEY = "c".repeat(64);
    for (const [id, role] of [[ADMIN, "Admin"], [STAFF, "Staff"]]) {
      await pool.query(`INSERT INTO users (id, email, active, role, first_name, last_name) VALUES ($1, $2, true, $3, 'L', 'Api')`, [id, `${role.toLowerCase()}-${tag}@example.com`, role]);
    }
    await pool.query(`INSERT INTO lenders (id, name, country, submission_method, submission_email) VALUES ($1, $2, 'CA', 'email', 'deals@lender.example')`, [LENDER, `Lender ${tag}`]);
    await pool.query(
      `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, owner_user_id, silo, submitted_at, requested_amount)
       VALUES ($1, $2, now(), now(), 'Off to Lender', 'RECEIVED', $3, 'BF', now(), 70000)`, [APP, `LenderApi ${tag}`, STAFF],
    );
  });

  afterAll(async () => {
    setLenderHttpForTests(null);
    await pool.query(`DELETE FROM funding_conditions WHERE application_id = $1`, [APP]);
    // Balances are append-only (a trigger); skip triggers for this one session only, never for the shared database.
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`DELETE FROM active_contract_balances WHERE contract_id = $1`, [CONTRACT]);
      await c.query("COMMIT");
    } finally {
      c.release();
    }
    await pool.query(`DELETE FROM crm_timeline_events WHERE application_id = $1`, [APP]);
    await pool.query(`DELETE FROM active_contracts WHERE id = $1`, [CONTRACT]);
    await pool.query(`DELETE FROM lender_api_events WHERE lender_id = $1`, [LENDER]);
    await pool.query(`DELETE FROM lender_api_conditions WHERE lender_id = $1`, [LENDER]);
    await pool.query(`DELETE FROM lender_api_submissions WHERE lender_id = $1`, [LENDER]);
    await pool.query(`DELETE FROM lender_connections WHERE lender_id = $1`, [LENDER]);
    await pool.query(`DELETE FROM offers WHERE lender_id = $1`, [LENDER]);
    await pool.query(`DELETE FROM notifications WHERE application_id = $1`, [APP]);
    await pool.query(`DELETE FROM application_stage_events WHERE application_id = $1`, [APP]);
    await pool.query(`DELETE FROM applications WHERE id = $1`, [APP]);
    await pool.query(`DELETE FROM lenders WHERE id = $1`, [LENDER]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[ADMIN, STAFF]]);
    resetStaffUserLoader();
    if (savedKey === undefined) delete process.env.LENDER_CREDENTIALS_ENCRYPTION_KEY; else process.env.LENDER_CREDENTIALS_ENCRYPTION_KEY = savedKey;
  });

  it("saves a connection with encrypted credentials; staff cannot change it", async () => {
    clearStaffUserCache();
    clearVisibilityCache();
    const body = {
      connector: "generic_rest", enabled: true, submit_by_api: true, email_fallback: true, poll_enabled: true, poll_interval_minutes: 15,
      config: {
        base_url: "https://api.lender.example", auth: { type: "bearer" },
        submit: { path: "/apps", field_map: { name: "company" }, external_id_path: "id" },
        status: { path: "/apps/{{external_id}}", status_path: "state", offers_path: "offers", conditions_path: "stips" },
        webhook: { signature: "hmac_sha256_hex", signature_header: "X-Sig", external_id_path: "deal_id", status_path: "state" },
      },
      status_map: { "approved": { bucket: "offer", stage: "Offer" } },
      secrets: { api_key: "live-key-1234", webhook_secret: "whsec" },
    };
    const denied = await request(app()).put(`/api/lender-connections/lenders/${LENDER}`).set("Authorization", tok(STAFF, "Staff")).send(body);
    expect(denied.status).toBe(403);
    const r = await request(app()).put(`/api/lender-connections/lenders/${LENDER}`).set("Authorization", tok(ADMIN, "Admin")).send(body);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain("live-key-1234");
    expect(r.body.connection.secret_hints.api_key).toBe("ends 1234");
    expect(r.body.connection.webhook_url).toMatch(new RegExp(`/api/lender-webhooks/${r.body.connection.id}/[A-Za-z0-9_-]{20,}$`));
    const row = (await pool.query(`SELECT secrets_encrypted FROM lender_connections WHERE lender_id = $1`, [LENDER])).rows[0];
    expect(row.secrets_encrypted).toMatch(/^v1\./);
    expect(row.secrets_encrypted).not.toContain("live-key-1234");
    const audit = await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE event_type = 'lender_api_connection_created' AND target_id = $1`, [LENDER]);
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });

  it("refuses to switch on a lender still awaiting API docs", async () => {
    const r = await request(app()).put(`/api/lender-connections/lenders/${LENDER}`).set("Authorization", tok(ADMIN, "Admin"))
      .send({ connector: "merchant_growth", enabled: true, config: {}, status_map: {} });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/API documentation/);
  });

  it("takes a signed webhook, then a poll brings the offer and conditions, moves the file to Offer and tells the owner", async () => {
    await pool.query(
      `INSERT INTO lender_api_submissions (application_id, lender_id, connection_id, connector, status, external_id, submitted_at, next_poll_at)
       SELECT $1, $2, id, 'generic_rest', 'submitted', 'D-77', now(), now() + interval '1 hour' FROM lender_connections WHERE lender_id = $2`, [APP, LENDER],
    );
    const conn = await request(app()).get(`/api/lender-connections/lenders/${LENDER}`).set("Authorization", tok(ADMIN, "Admin"));
    const url = new URL(conn.body.connection.webhook_url);
    const payload = JSON.stringify({ deal_id: "D-77", state: "In underwriting" });
    const unsigned = await request(app()).post(url.pathname).set("Content-Type", "application/json").send(payload);
    expect(unsigned.status).toBe(401);
    const signed = await request(app()).post(url.pathname).set("Content-Type", "application/json")
      .set("X-Sig", createHmac("sha256", "whsec").update(payload).digest("hex")).send(payload);
    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({ applied: 1 });

    // The webhook asked for an immediate poll; the stubbed lender reports an approval with an offer and a stip.
    setLenderHttpForTests(async (req) => {
      expect(req.url).toBe("https://api.lender.example/apps/D-77");
      expect(req.headers?.Authorization).toBe("Bearer live-key-1234");
      return { status: 200, headers: {}, text: JSON.stringify({ state: "Approved", offers: [{ id: "OF1", amount: 60000, term: "12 months", rate: "1.28" }], stips: [{ id: "ST1", description: "Void cheque", document_type: "void_check", status: "open" }] }) };
    });
    expect(await pollDue(pool as unknown as Q)).toBeGreaterThanOrEqual(1);

    const sub = (await pool.query(`SELECT lender_status, bucket, next_poll_at FROM lender_api_submissions WHERE application_id = $1`, [APP])).rows[0];
    expect(sub).toMatchObject({ lender_status: "Approved", bucket: "offer" });
    expect(sub.next_poll_at).not.toBeNull();
    const offer = (await pool.query(`SELECT amount, term, rate_factor, status FROM offers WHERE lender_id = $1 AND lender_external_id = 'OF1'`, [LENDER])).rows;
    expect(offer).toHaveLength(1);
    expect(Number(offer[0].amount)).toBe(60000);
    const cond = (await pool.query(`SELECT kind, status FROM lender_api_conditions WHERE application_id = $1`, [APP])).rows;
    expect(cond).toEqual([{ kind: "document_request", status: "open" }]);
    const stage = (await pool.query(`SELECT pipeline_state FROM applications WHERE id = $1`, [APP])).rows[0].pipeline_state;
    expect(stage).toBe("Offer");
    const notes = (await pool.query(`SELECT type FROM notifications WHERE application_id = $1 AND user_id = $2`, [APP, STAFF])).rows.map((r) => r.type);
    expect(notes).toEqual(expect.arrayContaining(["lender_status", "lender_offer", "lender_conditions"]));

    // A second poll with the same answer adds nothing new.
    await pool.query(`UPDATE lender_api_submissions SET next_poll_at = now() WHERE application_id = $1`, [APP]);
    await pollDue(pool as unknown as Q);
    expect((await pool.query(`SELECT count(*)::int AS n FROM offers WHERE lender_id = $1`, [LENDER])).rows[0].n).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM lender_api_conditions WHERE application_id = $1`, [APP])).rows[0].n).toBe(1);

    const view = await request(app()).get(`/api/lender-connections/applications/${APP}`).set("Authorization", tok(STAFF, "Staff"));
    expect(view.status).toBe(200);
    const l = view.body.lenders.find((x: any) => x.lender_id === LENDER);
    expect(l.submission).toMatchObject({ external_id: "D-77", bucket: "offer" });
    expect(l.events.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["webhook_received", "status_changed", "offer_received", "condition_added", "stage_moved"]));
    expect(l.offers).toHaveLength(1);

    // The lender's document request is on the funding conditions checklist once (v865), however often it is polled.
    const checklist = (await pool.query(`SELECT title, owner, status, source, requires_document FROM funding_conditions WHERE application_id = $1`, [APP])).rows;
    expect(checklist).toEqual([{ title: "Void cheque", owner: "staff", status: "open", source: "lender_api", requires_document: true }]);
  });

  it("clears the checklist item when the lender reports the condition satisfied", async () => {
    setLenderHttpForTests(async () => ({ status: 200, headers: {}, text: JSON.stringify({ state: "Approved", stips: [{ id: "ST1", description: "Void cheque", document_type: "void_check", status: "received" }] }) }));
    await pool.query(`UPDATE lender_api_submissions SET next_poll_at = now() WHERE application_id = $1`, [APP]);
    await pollDue(pool as unknown as Q);
    const row = (await pool.query(`SELECT status, cleared_at FROM funding_conditions WHERE application_id = $1`, [APP])).rows[0];
    expect(row.status).toBe("cleared");
    expect(row.cleared_at).not.toBeNull();
  });

  it("keeps polling a funded deal and records the lender's balance on the Active Contract (v866), then stops when it closes", async () => {
    await pool.query(
      `INSERT INTO active_contracts (id, silo, application_id, lender_id, lender_name, original_amount, status, funded_at)
       VALUES ($1, 'BF', $2, $3, $4, 60000, 'active', CURRENT_DATE - 30)`, [CONTRACT, APP, LENDER, `Lender ${tag}`]);
    setLenderHttpForTests(async () => ({ status: 200, headers: {}, text: JSON.stringify({ state: "Funded", outstanding: "55,250.00", as_of: "2026-10-30" }) }));
    await pool.query(
      `UPDATE lender_connections SET config = jsonb_set(config, '{status}', config->'status' || '{"balance_path":"outstanding","balance_as_of_path":"as_of"}'::jsonb)
        WHERE lender_id = $1`, [LENDER]);
    await pool.query(`UPDATE lender_api_submissions SET next_poll_at = now() WHERE application_id = $1`, [APP]);
    await pollDue(pool as unknown as Q);
    const sub = (await pool.query(`SELECT bucket, next_poll_at FROM lender_api_submissions WHERE application_id = $1`, [APP])).rows[0];
    expect(sub.bucket).toBe("funded");
    expect(sub.next_poll_at).not.toBeNull();
    expect(new Date(sub.next_poll_at).getTime() - Date.now()).toBeGreaterThan(23 * 3600_000); // once a day
    const bal = (await pool.query(`SELECT balance, as_of::text AS as_of, source FROM active_contract_balances WHERE contract_id = $1`, [CONTRACT])).rows;
    expect(bal).toEqual([{ balance: "55250.00", as_of: "2026-10-30", source: "lender_portal" }]);
    // The same report again is not recorded twice.
    await pool.query(`UPDATE lender_api_submissions SET next_poll_at = now() WHERE application_id = $1`, [APP]);
    await pollDue(pool as unknown as Q);
    expect((await pool.query(`SELECT count(*)::int AS n FROM active_contract_balances WHERE contract_id = $1`, [CONTRACT])).rows[0].n).toBe(1);
    // Paid out: polling stops.
    await pool.query(`UPDATE active_contracts SET status = 'paid_out' WHERE id = $1`, [CONTRACT]);
    await pool.query(`UPDATE lender_api_submissions SET next_poll_at = now() WHERE application_id = $1`, [APP]);
    await pollDue(pool as unknown as Q);
    expect((await pool.query(`SELECT next_poll_at FROM lender_api_submissions WHERE application_id = $1`, [APP])).rows[0].next_poll_at).toBeNull();
  });

  it("hides the file's Lender API panel from staff restricted to their own records", async () => {
    const OTHER = randomUUID();
    // Visibility set on this one person only (a role-wide setting would reach other files' tests).
    await pool.query(`INSERT INTO users (id, email, active, role, first_name, last_name, record_visibility) VALUES ($1, $2, true, 'Staff', 'O', 'Ther', 'own')`,
      [OTHER, `other-${tag}@example.com`]);
    try {
      clearStaffUserCache();
      clearVisibilityCache();
      const hidden = await request(app()).get(`/api/lender-connections/applications/${APP}`).set("Authorization", tok(OTHER, "Staff"));
      expect(hidden.status).toBe(404);
      const submit = await request(app()).post(`/api/lender-connections/applications/${APP}/lenders/${LENDER}/submit`).set("Authorization", tok(OTHER, "Staff"));
      expect(submit.status).toBe(404);
      const owner = await request(app()).get(`/api/lender-connections/applications/${APP}`).set("Authorization", tok(STAFF, "Staff"));
      expect(owner.status).toBe(200);
    } finally {
      await pool.query(`DELETE FROM users WHERE id = $1`, [OTHER]);
      clearVisibilityCache();
    }
  });
});
