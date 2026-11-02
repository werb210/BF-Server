// BF_SERVER_v873_LENDER_API - /api/lender-connections (ported from KS-server #53 without the plan gate).
// Admin (Lenders > lender > Connection tab):
//   GET    /connectors                         the connector types, what each can do, their settings and credentials,
//                                             the Merchant Growth field map and what to ask Merchant Growth for
//   GET    /field-keys                         Boreal values a field map can use
//   GET    /                                   every connection (no credentials)
//   GET    /lenders/:lenderId                  one lender's connection, its webhook address and saved-credential hints
//   PUT    /lenders/:lenderId                  { connector, enabled, submit_by_api, email_fallback, poll_enabled,
//                                               poll_interval_minutes, config, status_map, secrets?: { key: value } }
//                                             (a blank secret keeps the saved one; null removes it)
//   POST   /lenders/:lenderId/webhook-address  a new webhook address secret (the old address stops working)
//   POST   /lenders/:lenderId/test             the connector's harmless test call
//   DELETE /lenders/:lenderId                  removes the connection (the submission log stays)
//   GET    /log                                ?lender_id=&status=&limit= the submission log, newest first
// Staff (the application's Lenders tab; record access is checked by the registry guard):
//   GET    /applications/:appId                each connected lender: connection state, submission, status timeline,
//                                             synced offers, conditions and document requests
//   POST   /applications/:appId/lenders/:lenderId/submit     Submit by API
//   POST   /applications/:appId/lenders/:lenderId/sync       read the status from the lender now
//   GET    /applications/:appId/lenders/:lenderId/files      package files that can be sent to the lender
//   POST   /applications/:appId/lenders/:lenderId/documents  { category, filename } sends one package file
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { actorId, auditFor, type Q } from "../settingsPack/common.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { scopedRequest } from "../visibility/scopedDb.js";
import { CONNECTORS, connectorFor, isConnectorKind } from "../lenderConnectors/registry.js";
import { SOURCE_KEYS, isBucket, normaliseStatus, type StatusMapEntry } from "../lenderConnectors/mapping.js";
import { BUCKET_LABELS, LENDER_BUCKETS } from "../lenderConnectors/types.js";
import { lenderHttp } from "../lenderConnectors/http.js";
import {
  credentialsKeyConfigured, hintFor, loadConnectionByLender, newWebhookToken, openSecrets, publicConnection, sealSecrets, CONNECTION_COLS,
} from "../lenderConnectors/store.js";
import { MERCHANT_GROWTH_FIELDS, MERCHANT_GROWTH_PRESET, MERCHANT_GROWTH_REQUESTS, MERCHANT_GROWTH_STATUS_MAP, MERCHANT_GROWTH_GUESSED_STATUSES } from "../lenderConnectors/connectors/merchantGrowth.js";
import { HERON_BASE_URL } from "../lenderConnectors/connectors/heron.js";
import { submitByApiToLender, usableConnection } from "../lenderConnectors/submit.js";
import { loadSubmission, syncSubmission } from "../lenderConnectors/poll.js";
import { logEvent } from "../lenderConnectors/sync.js";
import { PIPELINE_STATES } from "../modules/applications/pipelineState.js";

const router = Router();
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.OPS] })];
const admin = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const writeLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: rateLimitKeyFromRequest });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const db = () => pool as unknown as Q;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const serverUrl = () => String(process.env.PUBLIC_BASE_URL || "https://server.boreal.financial").replace(/\/+$/, "");

/** The audit log entry for a lender API action (actor, ip and browser included). */
const auditRequest = (req: any, _area: string, action: string, targetType: string, targetId: string, metadata: Record<string, unknown>) =>
  auditFor(req, `lender_api_${action}`, metadata, { type: targetType, id: targetId });

function webhookAddress(connectionId: string, token: string | undefined): string | null {
  return token ? `${serverUrl()}/api/lender-webhooks/${connectionId}/${token}` : null;
}

async function lenderOr404(req: any, res: any): Promise<{ id: string; name: string; submission_email: string | null } | null> {
  const id = String(req.params.lenderId ?? "");
  if (!UUID_RE.test(id)) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
  const r = await pool.query(`SELECT id::text AS id, name, submission_email FROM lenders WHERE id::text = $1 LIMIT 1`, [id]);
  if (!r.rows[0]) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
  return r.rows[0];
}

// ── catalogue ────────────────────────────────────────────────────────────────
router.get("/connectors", ...admin, safeHandler(async (_req: any, res: any) => {
  res.json({
    ok: true,
    credentials_key_configured: credentialsKeyConfigured(),
    buckets: LENDER_BUCKETS.map((b) => ({ key: b, label: BUCKET_LABELS[b] })),
    stages: PIPELINE_STATES,
    connectors: Object.values(CONNECTORS).map((c) => ({
      kind: c.kind, label: c.label, description: c.description, capabilities: c.capabilities, availability: c.availability,
      secret_fields: c.secretFields, default_status_map: c.defaultStatusMap({}),
    })),
    heron: { base_url: HERON_BASE_URL },
    merchant_growth: {
      preset: MERCHANT_GROWTH_PRESET, fields: MERCHANT_GROWTH_FIELDS, status_map: MERCHANT_GROWTH_STATUS_MAP,
      guessed_statuses: MERCHANT_GROWTH_GUESSED_STATUSES, requests: MERCHANT_GROWTH_REQUESTS,
    },
  });
}));

router.get("/field-keys", ...admin, safeHandler(async (_req: any, res: any) => {
  res.json({ ok: true, keys: SOURCE_KEYS, hints: ['"field:<label>" for any lender package field', '"=<text>" for a fixed value'] });
}));

router.get("/", ...admin, safeHandler(async (_req: any, res: any) => {
  const r = await pool.query(`SELECT ${CONNECTION_COLS}, l.name AS lender_name FROM lender_connections c JOIN lenders l ON l.id = c.lender_id ORDER BY l.name`);
  res.json({ ok: true, connections: r.rows.map((row: any) => ({ ...publicConnection(row), lender_name: row.lender_name })) });
}));

router.get("/lenders/:lenderId", ...admin, safeHandler(async (req: any, res: any) => {
  const lender = await lenderOr404(req, res);
  if (!lender) return;
  const c = await loadConnectionByLender(db(), lender.id);
  if (!c) return res.json({ ok: true, lender, connection: null, credentials_key_configured: credentialsKeyConfigured() });
  const secrets = openSecrets(c.secrets_encrypted);
  const counts = await pool.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'submitted')::int AS submitted,
            count(*) FILTER (WHERE status IN ('failed','retrying'))::int AS failing
       FROM lender_api_submissions WHERE lender_id::text = $1`, [lender.id],
  );
  res.json({
    ok: true, lender, credentials_key_configured: credentialsKeyConfigured(),
    connection: { ...publicConnection(c), webhook_url: webhookAddress(c.id, secrets.webhook_url_token), submissions: counts.rows[0] ?? null },
  });
}));

function cleanStatusMap(raw: unknown): { ok: true; map: Record<string, StatusMapEntry> } | { ok: false; error: string } {
  const out: Record<string, StatusMapEntry> = {};
  for (const [k, v] of Object.entries(obj(raw)).slice(0, 200)) {
    const key = normaliseStatus(k);
    if (!key || key.length > 120) continue;
    const e = obj(v);
    if (!isBucket(e.bucket)) return { ok: false, error: `Choose what "${k}" means.` };
    const stage = e.stage === null || e.stage === undefined || e.stage === "" ? null : String(e.stage);
    if (stage && !(PIPELINE_STATES as readonly string[]).includes(stage)) return { ok: false, error: `"${stage}" is not a pipeline stage.` };
    out[key] = { bucket: e.bucket, stage };
  }
  return { ok: true, map: out };
}

router.put("/lenders/:lenderId", ...admin, writeLimiter, safeHandler(async (req: any, res: any) => {
  const lender = await lenderOr404(req, res);
  if (!lender) return;
  const body = obj(req.body);
  const existing = await loadConnectionByLender(db(), lender.id);
  const kind = body.connector ?? existing?.connector;
  if (!isConnectorKind(kind)) return res.status(400).json({ ok: false, error: "Choose a connection type." });
  const connector = connectorFor(kind)!;
  const config = body.config !== undefined ? obj(body.config) : (existing?.config ?? {});
  if (JSON.stringify(config).length > 50_000) return res.status(400).json({ ok: false, error: "The settings are too large." });
  const enabled = body.enabled !== undefined ? body.enabled === true : (existing?.enabled ?? false);
  if (enabled && connector.availability !== "available") {
    return res.status(400).json({ ok: false, error: "This connection cannot be switched on until the lender gives us its API documentation. Packages keep going by email." });
  }
  const problems = connector.validateConfig(config);
  if (enabled && problems.length) return res.status(400).json({ ok: false, error: problems[0], problems });
  const sm = cleanStatusMap(body.status_map !== undefined ? body.status_map : (existing?.status_map ?? {}));
  if (!sm.ok) return res.status(400).json({ ok: false, error: sm.error });
  const pollMinutes = Math.min(1440, Math.max(5, Math.floor(Number(body.poll_interval_minutes ?? existing?.poll_interval_minutes ?? 30)) || 30));

  // Credentials: merge the typed ones over the saved ones; a blank keeps, null removes.
  const incoming = obj(body.secrets);
  const saved0 = openSecrets(existing?.secrets_encrypted);
  // Switching to another connection type drops the old type's credentials (they belong to another API).
  const secrets: Record<string, string> = existing && existing.connector !== kind
    ? (saved0.webhook_url_token ? { webhook_url_token: saved0.webhook_url_token } : {})
    : saved0;
  const allowed = new Set(connector.secretFields.map((f) => f.key));
  let secretsChanged = Boolean(existing && existing.connector !== kind);
  for (const [k, v] of Object.entries(incoming)) {
    if (!allowed.has(k)) continue;
    if (v === null) { delete secrets[k]; secretsChanged = true; continue; }
    const val = String(v ?? "");
    if (!val.trim()) continue;
    if (val.length > 10_000) return res.status(400).json({ ok: false, error: "A credential is too long." });
    secrets[k] = k === "private_key" ? val : val.trim();
    secretsChanged = true;
  }
  if (!secrets.webhook_url_token) { secrets.webhook_url_token = newWebhookToken(); secretsChanged = true; }
  if (secretsChanged && !credentialsKeyConfigured()) {
    return res.status(409).json({ ok: false, error: "lender_credentials_key_missing", message: "Credentials cannot be stored safely yet: the server's LENDER_CREDENTIALS_ENCRYPTION_KEY setting is missing. Ask Todd to add it in Azure." });
  }
  const hints = Object.fromEntries(Object.entries(secrets).filter(([k]) => k !== "webhook_url_token").map(([k, v]) => [k, hintFor(v)]));
  const sealed = credentialsKeyConfigured() ? sealSecrets(secrets) : (existing?.secrets_encrypted ?? null);
  const missingRequired = connector.secretFields.filter((f) => f.required && !secrets[f.key]).map((f) => f.label);
  if (enabled && missingRequired.length) return res.status(400).json({ ok: false, error: `Enter: ${missingRequired.join(", ")}.` });

  const r = await pool.query(
    `INSERT INTO lender_connections (id, lender_id, connector, enabled, submit_by_api, email_fallback, poll_enabled, poll_interval_minutes, config,
                                     secrets_encrypted, secret_hints, status_map, created_by, updated_by, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12, $12, now(), now())
     ON CONFLICT (lender_id) DO UPDATE
       SET connector = EXCLUDED.connector, enabled = EXCLUDED.enabled, submit_by_api = EXCLUDED.submit_by_api, email_fallback = EXCLUDED.email_fallback,
           poll_enabled = EXCLUDED.poll_enabled, poll_interval_minutes = EXCLUDED.poll_interval_minutes, config = EXCLUDED.config,
           secrets_encrypted = EXCLUDED.secrets_encrypted, secret_hints = EXCLUDED.secret_hints, status_map = EXCLUDED.status_map,
           updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING id::text AS id`,
    [lender.id, kind, enabled, body.submit_by_api !== undefined ? body.submit_by_api === true : (existing?.submit_by_api ?? true),
      body.email_fallback !== undefined ? body.email_fallback === true : (existing?.email_fallback ?? true),
      body.poll_enabled !== undefined ? body.poll_enabled === true : (existing?.poll_enabled ?? true), pollMinutes,
      JSON.stringify(config), sealed, JSON.stringify(hints), JSON.stringify(sm.map), actorId(req)],
  );
  await auditRequest(req, "lender_api", existing ? "connection_updated" : "connection_created", "lender", lender.id, {
    connector: kind, enabled, credentials_changed: secretsChanged ? Object.keys(incoming).filter((k) => allowed.has(k)) : [],
  });
  const saved = await loadConnectionByLender(db(), lender.id);
  res.json({
    ok: true, problems,
    connection: saved ? { ...publicConnection(saved), webhook_url: webhookAddress(String(r.rows[0]?.id ?? saved.id), secrets.webhook_url_token) } : null,
  });
}));

router.post("/lenders/:lenderId/webhook-address", ...admin, writeLimiter, safeHandler(async (req: any, res: any) => {
  const lender = await lenderOr404(req, res);
  if (!lender) return;
  const c = await loadConnectionByLender(db(), lender.id);
  if (!c) return res.status(404).json({ ok: false, error: "not_found" });
  if (!credentialsKeyConfigured()) return res.status(409).json({ ok: false, error: "lender_credentials_key_missing" });
  const secrets = { ...openSecrets(c.secrets_encrypted), webhook_url_token: newWebhookToken() };
  await pool.query(`UPDATE lender_connections SET secrets_encrypted = $2, updated_by = $3, updated_at = now() WHERE id::text = $1`, [c.id, sealSecrets(secrets), actorId(req)]);
  await auditRequest(req, "lender_api", "webhook_address_rotated", "lender", lender.id, {});
  res.json({ ok: true, webhook_url: webhookAddress(c.id, secrets.webhook_url_token) });
}));

router.post("/lenders/:lenderId/test", ...admin, writeLimiter, safeHandler(async (req: any, res: any) => {
  const lender = await lenderOr404(req, res);
  if (!lender) return;
  const c = await loadConnectionByLender(db(), lender.id);
  if (!c) return res.status(404).json({ ok: false, error: "not_found" });
  const connector = connectorFor(c.connector);
  const problems = connector ? connector.validateConfig(c.config ?? {}) : ["Unknown connection type."];
  let out: { ok: boolean; message: string };
  if (!connector) out = { ok: false, message: "Unknown connection type." };
  else if (problems.length && connector.availability === "available") out = { ok: false, message: problems[0]! };
  else if (!connector.testConnection) out = { ok: true, message: "This connection has no test call." };
  else {
    try {
      out = await connector.testConnection({ config: c.config ?? {}, secrets: openSecrets(c.secrets_encrypted), http: lenderHttp() });
    } catch (err) {
      out = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
  await pool.query(`UPDATE lender_connections SET last_test_at = now(), last_test_ok = $2, last_test_message = $3 WHERE id::text = $1`, [c.id, out.ok, out.message.slice(0, 500)]);
  await auditRequest(req, "lender_api", "connection_tested", "lender", lender.id, { ok: out.ok });
  res.json({ ok: true, test: out });
}));

router.delete("/lenders/:lenderId", ...admin, writeLimiter, safeHandler(async (req: any, res: any) => {
  const lender = await lenderOr404(req, res);
  if (!lender) return;
  const r = await pool.query(`DELETE FROM lender_connections WHERE lender_id::text = $1 RETURNING id`, [lender.id]);
  if (!r.rows.length) return res.status(404).json({ ok: false, error: "not_found" });
  await pool.query(`UPDATE lender_api_submissions SET next_poll_at = NULL, next_retry_at = NULL, status = CASE WHEN status = 'retrying' THEN 'failed' ELSE status END WHERE lender_id::text = $1`, [lender.id]);
  await auditRequest(req, "lender_api", "connection_deleted", "lender", lender.id, {});
  res.json({ ok: true });
}));

router.get("/log", ...admin, scopedRequest, safeHandler(async (req: any, res: any) => {
  // The silo the Admin is working in (the topbar), and only files they may see (record visibility).
  const params: unknown[] = [resolveSiloFromRequest(req)];
  const where: string[] = ["a.silo = $1"];
  const lenderId = String(req.query.lender_id ?? "");
  if (UUID_RE.test(lenderId)) { params.push(lenderId); where.push(`s.lender_id::text = $${params.length}`); }
  const status = String(req.query.status ?? "");
  if (/^[a-z_]{1,30}$/.test(status)) { params.push(status); where.push(`s.status = $${params.length}`); }
  params.push(Math.min(500, Math.max(1, Number(req.query.limit ?? 200) || 200)));
  const r = await pool.query(
    `SELECT s.id::text AS id, s.application_id, a.name AS application_name, s.lender_id::text AS lender_id, l.name AS lender_name, s.connector,
            s.status, s.external_id, s.lender_status, s.bucket, s.attempts, s.last_error, s.submitted_at, s.last_synced_at, s.next_retry_at, s.updated_at
       FROM lender_api_submissions s JOIN lenders l ON l.id = s.lender_id JOIN applications a ON a.id::text = s.application_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY s.updated_at DESC LIMIT $${params.length}`, params,
  );
  res.json({ ok: true, submissions: r.rows });
}));

// ── the application's Lenders tab ────────────────────────────────────────────
router.get("/applications/:appId", ...staff, safeHandler(async (req: any, res: any) => {
  const appId = String(req.params.appId ?? "");
  const conns = await pool.query(
    `SELECT c.lender_id::text AS lender_id, l.name AS lender_name, c.connector, c.enabled, c.submit_by_api, c.email_fallback
       FROM lender_connections c JOIN lenders l ON l.id = c.lender_id`,
  );
  const subs = await pool.query(
    `SELECT s.id::text AS id, s.lender_id::text AS lender_id, l.name AS lender_name, s.connector, s.status, s.external_id, s.lender_status,
            s.lender_status_label, s.bucket, s.attempts, s.last_error, s.warnings, s.funded_amount, s.commission_amount, s.submitted_at,
            s.last_synced_at, s.next_retry_at, s.next_poll_at
       FROM lender_api_submissions s JOIN lenders l ON l.id = s.lender_id WHERE s.application_id = $1`, [appId],
  );
  const events = await pool.query(
    `SELECT e.id::text AS id, e.lender_id::text AS lender_id, e.kind, e.source, e.status, e.detail, e.created_at
       FROM lender_api_events e WHERE e.application_id = $1 ORDER BY e.created_at DESC LIMIT 300`, [appId],
  );
  const conditions = await pool.query(
    `SELECT id::text AS id, lender_id::text AS lender_id, external_id, kind, description, document_type, status, first_seen_at, updated_at
       FROM lender_api_conditions WHERE application_id = $1 ORDER BY first_seen_at`, [appId],
  );
  const offers = await pool.query(
    `SELECT id::text AS id, lender_id::text AS lender_id, lender_name, amount, rate_factor, term, payment_frequency, expiry_date, status, notes, created_at
       FROM offers WHERE application_id = $1 AND lender_external_id IS NOT NULL AND coalesce(is_archived, false) = false ORDER BY created_at`, [appId],
  );
  const lenders = conns.rows.map((c: any) => {
    const connector = connectorFor(c.connector);
    return {
      lender_id: c.lender_id, lender_name: c.lender_name, connector: c.connector, connector_label: connector?.label ?? c.connector,
      enabled: c.enabled, submit_by_api: c.submit_by_api, email_fallback: c.email_fallback,
      availability: connector?.availability ?? "unknown", capabilities: connector?.capabilities ?? null,
      can_submit: c.enabled && connector?.availability === "available" && Boolean(connector?.capabilities.submit),
      submission: subs.rows.find((s: any) => s.lender_id === c.lender_id) ?? null,
      events: events.rows.filter((e: any) => e.lender_id === c.lender_id),
      conditions: conditions.rows.filter((x: any) => x.lender_id === c.lender_id),
      offers: offers.rows.filter((o: any) => o.lender_id === c.lender_id),
    };
  });
  // Submissions whose connection was removed still show their history.
  for (const s of subs.rows as any[]) {
    if (lenders.some((l) => l.lender_id === s.lender_id)) continue;
    lenders.push({
      lender_id: s.lender_id, lender_name: s.lender_name, connector: s.connector, connector_label: connectorFor(s.connector)?.label ?? s.connector,
      enabled: false, submit_by_api: false, email_fallback: false, availability: "removed", capabilities: null, can_submit: false, submission: s,
      events: events.rows.filter((e: any) => e.lender_id === s.lender_id), conditions: conditions.rows.filter((x: any) => x.lender_id === s.lender_id),
      offers: offers.rows.filter((o: any) => o.lender_id === s.lender_id),
    });
  }
  res.json({ ok: true, buckets: Object.fromEntries(LENDER_BUCKETS.map((b) => [b, BUCKET_LABELS[b]])), lenders });
}));

const SUBMIT_REASONS: Record<string, string> = {
  no_connection: "This lender has no API connection.",
  connection_off: "This lender's API connection is switched off.",
  awaiting_lender_api_docs: "This lender has not given us its API documentation yet; send the package by email.",
  connector_cannot_submit: "This lender's API cannot take submissions.",
  application_not_signed: "The client has not signed the application yet.",
  dispatch_in_progress: "Another send for this file is running. Try again in a minute.",
  lender_not_found: "Lender not found.",
  api_submit_failed: "The lender's API did not take the package.",
  dispatch_failed: "The package could not be built or sent.",
};

router.post("/applications/:appId/lenders/:lenderId/submit", ...staff, writeLimiter, safeHandler(async (req: any, res: any) => {
  const appId = String(req.params.appId ?? "");
  const lenderId = String(req.params.lenderId ?? "");
  if (!UUID_RE.test(lenderId)) return res.status(404).json({ ok: false, error: "not_found" });
  const out = await submitByApiToLender(pool, appId, lenderId, actorId(req));
  await auditRequest(req, "lender_api", "submit_by_api", "application", appId, { lender_id: lenderId, ok: out.ok, reason: out.ok ? null : out.reason });
  if (out.ok) return res.json({ ok: true, external_id: out.externalId, warnings: out.warnings });
  res.status(out.reason === "dispatch_in_progress" ? 409 : 422).json({ ok: false, reason: out.reason, message: SUBMIT_REASONS[out.reason] ?? out.reason, detail: out.detail ?? null });
}));

router.post("/applications/:appId/lenders/:lenderId/sync", ...staff, writeLimiter, safeHandler(async (req: any, res: any) => {
  const appId = String(req.params.appId ?? "");
  const lenderId = String(req.params.lenderId ?? "");
  if (!UUID_RE.test(lenderId)) return res.status(404).json({ ok: false, error: "not_found" });
  const sub = await loadSubmission(db(), appId, lenderId);
  if (!sub) return res.status(404).json({ ok: false, error: "not_submitted", message: "Nothing has been sent to this lender by API yet." });
  const out = await syncSubmission(db(), sub, "staff");
  if (!out.ok) return res.status(422).json({ ok: false, error: "sync_failed", message: out.error });
  res.json({ ok: true, result: out.result });
}));

router.get("/applications/:appId/lenders/:lenderId/files", ...staff, safeHandler(async (req: any, res: any) => {
  const appId = String(req.params.appId ?? "");
  const { loadPackageInputs } = await import("../services/lenders/loadPackageInputs.js");
  const inp = await loadPackageInputs({ pool, applicationId: appId });
  const files = [
    ...(inp.additionalSignedDocs ?? []).map((d) => ({ category: "Signed documents", filename: d.filename, size: d.content.length })),
    ...(inp.documents ?? []).flatMap((g) => g.files.map((f) => ({ category: g.category, filename: f.filename, size: f.content.length }))),
  ];
  res.json({ ok: true, files });
}));

router.post("/applications/:appId/lenders/:lenderId/documents", ...staff, writeLimiter, safeHandler(async (req: any, res: any) => {
  const appId = String(req.params.appId ?? "");
  const lenderId = String(req.params.lenderId ?? "");
  if (!UUID_RE.test(lenderId)) return res.status(404).json({ ok: false, error: "not_found" });
  const body = obj(req.body);
  const sub = await loadSubmission(db(), appId, lenderId);
  if (!sub?.external_id) return res.status(422).json({ ok: false, message: "Send the package to this lender by API first." });
  const usable = await usableConnection(db(), lenderId);
  if (usable.reason !== null || !usable.connection) return res.status(422).json({ ok: false, message: SUBMIT_REASONS[usable.reason ?? ""] ?? usable.reason });
  const connection = usable.connection;
  const connector = connectorFor(connection.connector)!;
  if (!connector.capabilities.upload || !connector.uploadDocument) return res.status(422).json({ ok: false, message: "This lender's API does not take extra documents." });
  const { loadPackageInputs } = await import("../services/lenders/loadPackageInputs.js");
  const inp = await loadPackageInputs({ pool, applicationId: appId, recipientLenderId: lenderId, recipientLenderName: sub.lender_name });
  const all = [
    ...(inp.additionalSignedDocs ?? []).map((d) => ({ category: "Signed documents", filename: d.filename, content: d.content })),
    ...(inp.documents ?? []).flatMap((g) => g.files.map((f) => ({ category: g.category, filename: f.filename, content: f.content }))),
  ];
  const file = all.find((f) => f.filename === String(body.filename ?? "") && (!body.category || f.category === String(body.category)));
  if (!file) return res.status(404).json({ ok: false, message: "That file is not in this application's package." });
  const contentType = /\.pdf$/i.test(file.filename) ? "application/pdf" : "application/octet-stream";
  let out;
  try {
    out = await connector.uploadDocument({ config: connection.config ?? {}, secrets: openSecrets(connection.secrets_encrypted), http: lenderHttp() }, sub.external_id, { ...file, contentType });
  } catch (err) {
    out = { ok: false as const, error: err instanceof Error ? err.message : String(err), retryable: true };
  }
  await logEvent(db(), {
    submissionId: sub.id, applicationId: appId, lenderId, kind: out.ok ? "document_uploaded" : "document_upload_failed", source: "staff",
    detail: out.ok ? `${file.filename} sent to ${sub.lender_name}.` : out.error, createdBy: actorId(req), data: { filename: file.filename, category: file.category },
  });
  await auditRequest(req, "lender_api", "document_sent", "application", appId, { lender_id: lenderId, filename: file.filename, ok: out.ok });
  if (!out.ok) return res.status(422).json({ ok: false, message: out.error });
  res.json({ ok: true });
}));

export default router;
