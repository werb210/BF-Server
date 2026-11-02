// BF_SERVER_v875_INTEGRATIONS - batch 8 against real Postgres: the migration (twice); outgoing webhooks captured by the
// row triggers for the endpoint's own silo only (contacts, applications and stage changes, documents, offers, funded),
// delivered as one signed batch and logged; API keys with per-area permissions on the public API in the key's silo,
// last-used, revoke and the audit log; and the Microsoft sign-in hand-off giving a strong single sign-on session with
// a refresh token. Every assertion is scoped to this test's own rows (other files write in parallel); no shared
// setting is changed.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const { emitAutomationEvent } = vi.hoisted(() => ({ emitAutomationEvent: vi.fn() }));
vi.mock("../modules/automation/automationEngine.js", async (orig) => ({ ...(await orig<any>()), emitAutomationEvent }));

import { pool } from "../db.js";
import { markReady } from "../startupState.js";
import { deps } from "../system/deps.js";
import { dbStaffUserLoader, setStaffUserLoader } from "../auth/staffUserState.js";
import webhookEndpointsRoutes, { setWebhookResolverForTests } from "../routes/webhookEndpoints.js";
import apiKeysRoutes from "../routes/apiKeys.js";
import ssoRoutes from "../routes/authSso.js";
import { createPublicApiRouter } from "../publicApi/router.js";
import { runDueDeliveries, type TransportRequest } from "../outboundWebhooks/deliver.js";
import { verifySignature, SIGNATURE_HEADER } from "../outboundWebhooks/signing.js";

const MIGRATION = "migrations/2026_11_16_v875_integrations.sql";
const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID();
const SLF_CONTACT = randomUUID(), BF_CONTACT = randomUUID(), OFFER = randomUUID();
const APP = `app-${tag}`, BF_APP = `app-bf-${tag}`, DOC = `doc-${tag}`;
const tok = (id: string, role: string) => `Bearer ${jwt.sign({ sub: id, id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET))}`;
const admin = (r: request.Test, silo = "SLF") => r.set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", silo);
let endpointId = "";
let secret = "";

function app() {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use("/api/webhook-endpoints", webhookEndpointsRoutes);
  a.use("/api/api-keys", apiKeysRoutes);
  a.use("/api/auth/sso", ssoRoutes);
  a.use("/api/open/v1", createPublicApiRouter());
  return a;
}

describe("v875 integrations (real Postgres)", () => {
  beforeAll(async () => {
    markReady();
    deps.db.client = pool;
    deps.db.ready = true;
    setStaffUserLoader(dbStaffUserLoader, { cache: false });
    setWebhookResolverForTests(async () => [{ address: "54.86.10.20", family: 4 }]);
    await pool.query(readFileSync(MIGRATION, "utf8"));
    await pool.query(readFileSync(MIGRATION, "utf8")); // safe to run again
    await pool.query(`INSERT INTO users (id, email, active, role, first_name, last_name, silo, silos) VALUES ($1, $2, true, 'Admin', 'Int', 'Admin', 'BF', ARRAY['BF','SLF'])`,
      [ADMIN, `admin-${tag}@example.com`]);
  });

  afterAll(async () => {
    setWebhookResolverForTests(null);
    await pool.query(`DELETE FROM webhook_endpoints WHERE created_by = $1`, [ADMIN]);
    await pool.query(`DELETE FROM api_keys WHERE created_by = $1`, [ADMIN]);
    await pool.query(`DELETE FROM documents WHERE id = $1`, [DOC]);
    await pool.query(`DELETE FROM offers WHERE id = $1`, [OFFER]);
    await pool.query(`DELETE FROM crm_notes WHERE application_id = ANY($1::text[])`, [[APP, BF_APP]]);
    await pool.query(`DELETE FROM applications WHERE id = ANY($1::text[])`, [[APP, BF_APP]]);
    await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[]) OR lower(email) = $2`, [[SLF_CONTACT, BF_CONTACT], `api-${tag}@example.com`]);
    await pool.query(`DELETE FROM staff_refresh_tokens WHERE user_id = $1`, [ADMIN]);
    await pool.query(`DELETE FROM user_sessions WHERE user_id = $1`, [ADMIN]);
    await pool.query(`DELETE FROM sso_login_handoffs WHERE user_id = $1`, [ADMIN]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [ADMIN]);
  });

  it("captures the endpoint's own silo's events and delivers them as one signed batch", async () => {
    const made = await admin(request(app()).post("/api/webhook-endpoints")).send({
      url: "https://hooks.zapier.com/hooks/catch/123/abc/",
      events: ["contact.created", "application.created", "application.stage_changed", "document.uploaded", "offer.created", "deal.funded"],
      batch_size: 20,
      description: `int-${tag}`,
    });
    expect(made.status).toBe(201);
    expect(made.body.endpoint).toMatchObject({ silo: "SLF", batch_size: 20, status: "active" });
    endpointId = made.body.endpoint.id;
    secret = made.body.secret;
    expect(secret).toMatch(/^whsec_/);
    // Another silo does not see it.
    const bfList = await admin(request(app()).get("/api/webhook-endpoints"), "BF");
    expect(bfList.body.endpoints.map((e: any) => e.id)).not.toContain(endpointId);
    expect((await admin(request(app()).patch(`/api/webhook-endpoints/${endpointId}`), "BF").send({ status: "paused" })).status).toBe(404);

    await pool.query(`INSERT INTO contacts (id, name, email, silo) VALUES ($1, 'SLF Hook', $3, 'SLF'), ($2, 'BF Hook', $4, 'BF')`,
      [SLF_CONTACT, BF_CONTACT, `slf-${tag}@example.com`, `bf-${tag}@example.com`]);
    await pool.query(`INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, silo, contact_id) VALUES
      ($1, 'SLF Hook App', now(), now(), 'Received', 'RECEIVED', 'SLF', $2), ($3, 'BF Hook App', now(), now(), 'Received', 'RECEIVED', 'BF', $4)`,
      [APP, SLF_CONTACT, BF_APP, BF_CONTACT]);
    await pool.query(`UPDATE applications SET pipeline_state = 'In Review' WHERE id = ANY($1::text[])`, [[APP, BF_APP]]);
    await pool.query(`INSERT INTO documents (id, application_id, created_at, document_type, filename, storage_key) VALUES ($1, $2, now(), 'bank_statements', 'march.pdf', 'secret/key')`, [DOC, APP]);
    await pool.query(`INSERT INTO offers (id, application_id, lender_name, amount, status) VALUES ($1, $2, 'Example Lender', 100000, 'pending')`, [OFFER, APP]);
    await pool.query(`UPDATE applications SET funded_at = now(), funded_amount = 95000 WHERE id = $1`, [APP]);
    await pool.query(`UPDATE applications SET funded_amount = 96000 WHERE id = $1`, [APP]); // funded fires once

    const mine = await pool.query(
      `SELECT event_type, object_id, silo, payload FROM webhook_deliveries WHERE endpoint_id = $1 AND object_id = ANY($2::text[]) ORDER BY created_at, event_type`,
      [endpointId, [SLF_CONTACT, BF_CONTACT, APP, BF_APP, DOC, OFFER]],
    );
    expect(mine.rows.map((r) => `${r.event_type}:${r.object_id}`).sort()).toEqual([
      `application.created:${APP}`, `application.stage_changed:${APP}`, `contact.created:${SLF_CONTACT}`, `deal.funded:${APP}`,
      `document.uploaded:${DOC}`, `offer.created:${OFFER}`,
    ].sort());
    expect(mine.rows.every((r) => r.silo === "SLF")).toBe(true);
    const stage = mine.rows.find((r) => r.event_type === "application.stage_changed");
    expect(stage.payload.extra).toEqual({ from_stage: "Received", to_stage: "In Review" });
    expect(JSON.stringify(mine.rows.find((r) => r.event_type === "document.uploaded").payload)).not.toContain("secret/key");

    // Send what is due (other files may add their own rows to this endpoint meanwhile: only ours are checked).
    const sent: TransportRequest[] = [];
    const transport = async (req: TransportRequest) => { sent.push(req); return { status: 200, body: "ok" }; };
    for (let i = 0; i < 10; i += 1) {
      const left = await pool.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1 AND object_id = ANY($2::text[]) AND status IN ('pending', 'sending')`, [endpointId, [SLF_CONTACT, APP, DOC, OFFER]]);
      if (!left.rows[0].n) break;
      await runDueDeliveries(pool as any, { transport });
    }
    const states = await pool.query(`SELECT DISTINCT status FROM webhook_deliveries WHERE endpoint_id = $1 AND object_id = ANY($2::text[])`, [endpointId, [SLF_CONTACT, APP, DOC, OFFER]]);
    expect(states.rows.map((r) => r.status)).toEqual(["succeeded"]);
    const batch = sent.find((s) => s.body.includes(SLF_CONTACT))!;
    expect(Array.isArray(JSON.parse(batch.body))).toBe(true);
    expect(batch.headers["X-Webhook-Event"]).toBe("batch");
    expect(verifySignature(secret, batch.headers[SIGNATURE_HEADER]!, batch.body)).toEqual({ ok: true });
    const types = sent.flatMap((s) => { const b = JSON.parse(s.body); return (Array.isArray(b) ? b : [b]); })
      .filter((e: any) => [SLF_CONTACT, APP, DOC, OFFER].includes(e.data.object.id)).map((e: any) => e.type);
    expect(new Set(types)).toEqual(new Set(["contact.created", "application.created", "application.stage_changed", "document.uploaded", "offer.created", "deal.funded"]));

    // Paused: nothing more is captured for it.
    expect((await admin(request(app()).patch(`/api/webhook-endpoints/${endpointId}`)).send({ status: "paused" })).body.endpoint.status).toBe("paused");
    await pool.query(`UPDATE contacts SET name = 'SLF Hook 2' WHERE id = $1`, [SLF_CONTACT]);
    const after = await pool.query(`SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1 AND object_id = $2 AND event_type = 'contact.updated'`, [endpointId, SLF_CONTACT]);
    expect(after.rows[0].n).toBe(0);

    // The log and a resend (same event id).
    const log = await admin(request(app()).get(`/api/webhook-endpoints/${endpointId}/deliveries?event=offer.created`));
    const offerDelivery = log.body.deliveries.find((d: any) => d.object_id === OFFER);
    expect(offerDelivery).toMatchObject({ status: "succeeded", attempts: 1 });
    expect((await admin(request(app()).post(`/api/webhook-endpoints/deliveries/${offerDelivery.id}/resend`))).status).toBe(409); // paused
  });

  it("API keys: per-area permissions in the key's silo, last used, revoke and the audit log", async () => {
    const made = await admin(request(app()).post("/api/api-keys")).send({ name: `Int ${tag}`, scopes: ["contacts:write", "applications:write"], rate_limit_per_minute: 30 });
    expect(made.status).toBe(201);
    expect(made.body.data.key).toMatchObject({ silo: "SLF", scopes: ["contacts:read", "contacts:write", "applications:read", "applications:write"], rate_limit_per_minute: 30 });
    expect(made.body.data.key.key_hash).toBeUndefined();
    const key = made.body.data.secret as string;
    const stored = await pool.query(`SELECT key_hash FROM api_keys WHERE id = $1`, [made.body.data.key.id]);
    expect(stored.rows[0].key_hash).not.toContain(key.slice(-10));
    const bearer = (r: request.Test) => r.set("Authorization", `Bearer ${key}`);

    const one = await bearer(request(app()).get(`/api/open/v1/contacts?email=slf-${tag}@example.com`));
    expect(one.status).toBe(200);
    expect(one.body.data.map((c: any) => c.id)).toEqual([SLF_CONTACT]);
    expect((await bearer(request(app()).get(`/api/open/v1/contacts/${BF_CONTACT}`))).status).toBe(404); // BF record, SLF key
    expect((await bearer(request(app()).get("/api/open/v1/lenders"))).body.error.code).toBe("insufficient_scope");

    const created = await bearer(request(app()).post("/api/open/v1/contacts")).send({ first_name: "Api", last_name: "Person", email: `api-${tag}@example.com` });
    expect(created.status).toBe(201);
    const row = await pool.query(`SELECT silo, owner_id::text AS owner_id FROM contacts WHERE id = $1`, [created.body.data.id]);
    expect(row.rows[0]).toEqual({ silo: "SLF", owner_id: ADMIN });

    const moved = await bearer(request(app()).patch(`/api/open/v1/applications/${APP}/stage`)).send({ stage: "Documents Required" });
    expect(moved.status).toBe(200);
    expect(moved.body.data.stage).toBe("Documents Required");
    expect((await bearer(request(app()).patch(`/api/open/v1/applications/${BF_APP}/stage`)).send({ stage: "Documents Required" })).status).toBe(404);

    const used = await pool.query(`SELECT last_used_at FROM api_keys WHERE id = $1`, [made.body.data.key.id]);
    expect(used.rows[0].last_used_at).not.toBeNull();
    const audits = await pool.query(`SELECT event_action AS action FROM audit_events WHERE metadata->>'api_key_id' = $1 OR (target_id = $1 AND event_action LIKE 'api_key_%')`, [made.body.data.key.id]);
    expect(audits.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["api_key_created", "api_contact_created", "api_application_stage_changed"]));

    // Another silo cannot revoke it; its own silo can, and then it stops working at once.
    expect((await admin(request(app()).delete(`/api/api-keys/${made.body.data.key.id}`), "BF")).status).toBe(404);
    expect((await admin(request(app()).delete(`/api/api-keys/${made.body.data.key.id}`))).status).toBe(200);
    const after = await bearer(request(app()).get("/api/open/v1/contacts"));
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("api_key_revoked");
  });

  it("Microsoft sign-in hand-off: one use, a strong single sign-on session and a refresh token", async () => {
    const code = `code-${randomUUID()}`;
    await pool.query(`INSERT INTO sso_login_handoffs (code_hash, user_id, provider, email, expires_at) VALUES ($1, $2, 'microsoft', $3, now() + interval '1 minute')`,
      [createHash("sha256").update(code, "utf8").digest("hex"), ADMIN, `admin-${tag}@example.com`]);
    const ex = await request(app()).post("/api/auth/sso/exchange").send({ code });
    expect(ex.status).toBe(200);
    const claims = jwt.decode(ex.body.data.token) as Record<string, any>;
    expect(claims.sub).toBe(ADMIN);
    const session = await pool.query(`SELECT method, strong FROM user_sessions WHERE id::text = $1`, [claims.ksid]);
    expect(session.rows[0]).toEqual({ method: "sso", strong: true });
    const refresh = await pool.query(`SELECT count(*)::int AS n FROM staff_refresh_tokens WHERE user_id = $1 AND ksid = $2`, [ADMIN, claims.ksid]);
    expect(refresh.rows[0].n).toBe(1);
    expect(typeof ex.body.data.refreshToken).toBe("string");
    expect((await request(app()).post("/api/auth/sso/exchange").send({ code })).status).toBe(401);
  });
});
