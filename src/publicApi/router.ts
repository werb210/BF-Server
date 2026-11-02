// BF_SERVER_v875_API_KEYS (ported from KS-server #35, plan gate removed) - the versioned public REST API, mounted at
// /api/open/v1.
//
// Authentication: `Authorization: Bearer bf_live_...` (an API key an Admin created in Settings > API keys). Every
// request is checked in this order: address rate limit -> key (hashed, revoked keys refused) -> the key's own
// requests-per-minute limit -> the permission the endpoint needs (contacts:read, applications:write ...). Errors are
// JSON: { error: { code, message } }. A key only ever reads and writes its own silo's records (BF, BI or SLF). Every
// change made with a key is written to the audit log with the key's id and prefix. GET /openapi.json needs no key.
import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../db.js";
import { ROLES } from "../auth/roles.js";
import { clientIpFromRequest, rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { isAppError } from "../middleware/errors.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import type { Q } from "../settingsPack/common.js";
import { authenticateApiKey, hasScope, touchApiKey, type ApiKeyRow, type ApiScope } from "../apiKeys/keys.js";
import { createContact } from "../services/contacts.js";
import { transitionPipelineState } from "../modules/applications/applications.service.js";
import { emitAutomationEvent } from "../modules/automation/automationEngine.js";
import { openApiDocument } from "./openapi.js";
import { API_STAGES, isApiStage } from "./stages.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const defaultDb = () => pool as unknown as Q;

type Deps = { db: () => Q };

export function apiError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { code, message } });
}

export function pageParams(query: Record<string, unknown>): { limit: number; offset: number } | { error: string } {
  const rawLimit = query.limit;
  const rawOffset = query.offset;
  const limit = rawLimit === undefined || rawLimit === "" ? 25 : Number(rawLimit);
  const offset = rawOffset === undefined || rawOffset === "" ? 0 : Number(rawOffset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { error: "limit must be a whole number from 1 to 100." };
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) return { error: "offset must be a whole number of 0 or more." };
  return { limit, offset };
}

/** Rows were fetched with limit + 1: trims the extra row and says where the next page starts. */
export function paged<T>(rows: T[], limit: number, offset: number) {
  const more = rows.length > limit;
  return { data: more ? rows.slice(0, limit) : rows, pagination: { limit, offset, next_offset: more ? offset + limit : null } };
}

function str(v: unknown, max = 200): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

declare module "express-serve-static-core" {
  interface Request { apiKey?: ApiKeyRow }
}

const siloOf = (req: Request) => String(req.apiKey?.silo ?? "BF").toUpperCase();
const ownerOf = (req: Request) => (req.apiKey?.created_by && UUID.test(req.apiKey.created_by) ? req.apiKey.created_by : null);

/** The permission an endpoint needs; 403 insufficient_scope without it. */
export function requireScope(scope: ApiScope) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (hasScope(req.apiKey?.scopes, scope)) return next();
    return apiError(res, 403, "insufficient_scope", `This API key does not have the ${scope} permission. An Admin can add it in Settings > API keys.`);
  };
}

/** Audit-logs a change made with a key (never fails the request: the change already happened). */
async function auditWrite(req: Request, action: string, target: { type: string; id: string }, metadata: Record<string, unknown> = {}) {
  try {
    await recordAuditEvent({
      action: `api_${action}`,
      actorUserId: ownerOf(req),
      targetUserId: null,
      targetType: target.type,
      targetId: target.id,
      ip: clientIpFromRequest(req) || null,
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300) || null,
      success: true,
      metadata: { via: "api_key", api_key_id: req.apiKey?.id ?? null, key_prefix: req.apiKey?.key_prefix ?? null, silo: siloOf(req), ...metadata },
    });
  } catch (err) {
    console.error("[public-api] audit write failed", { action, message: (err as Error)?.message });
  }
}

export function createPublicApiRouter(deps: Deps = { db: defaultDb }): Router {
  const router = Router();

  router.get("/openapi.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(openApiDocument());
  });

  // Before the key is looked up: caps how fast one address can try keys at all.
  router.use(rateLimit({
    windowMs: 60_000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyFromRequest,
    handler: (_req, res) => { apiError(res, 429, "rate_limited", "Too many requests from this address. Slow down and retry."); },
  }));

  router.use(safeHandler(async (req: Request, res: Response, next: NextFunction) => {
    const header = String(req.headers.authorization ?? "");
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m) return apiError(res, 401, "unauthorized", "Send your API key as: Authorization: Bearer bf_live_...");
    const auth = await authenticateApiKey(deps.db(), m[1]!);
    if (!auth.ok) {
      return apiError(res, 401, auth.reason === "revoked" ? "api_key_revoked" : "invalid_api_key",
        auth.reason === "revoked" ? "This API key has been revoked." : "This API key is not valid.");
    }
    req.apiKey = auth.key;
    try {
      await touchApiKey(deps.db(), auth.key.id, clientIpFromRequest(req) || null);
    } catch (err) {
      logWarnSwallowed(err, "publicApi/router.ts:touchApiKey");
    }
    next();
  }));

  // Each key's own limit (Settings > API keys), counted per key.
  router.use(rateLimit({
    windowMs: 60_000,
    limit: (req: Request) => Math.max(1, Number(req.apiKey?.rate_limit_per_minute ?? 120) || 120),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `api_key:${req.apiKey?.id ?? rateLimitKeyFromRequest(req)}`,
    handler: (req, res) => { apiError(res, 429, "rate_limited", `This key is limited to ${req.apiKey?.rate_limit_per_minute ?? 120} requests a minute. Retry after the Retry-After seconds.`); },
  }));

  router.get("/me", (req: Request, res: Response) => {
    const k = req.apiKey!;
    res.json({ data: { name: k.name, silo: k.silo, scopes: k.scopes, rate_limit_per_minute: k.rate_limit_per_minute, key_prefix: k.key_prefix } });
  });

  // ---- contacts -------------------------------------------------------------------------------------------------
  const CONTACT_COLS = `c.id::text AS id, c.first_name, c.last_name, c.name, c.email, c.phone, c.company_id::text AS company_id,
    COALESCE(co.name, c.company_name) AS company_name, c.job_title, c.lead_status, c.lifecycle_stage,
    COALESCE(c.tags, '{}'::text[]) AS tags, c.owner_id::text AS owner_id, COALESCE(c.custom_fields, '{}'::jsonb) AS custom_fields,
    c.created_at, c.updated_at`;
  const CONTACT_FROM = `FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
    WHERE c.silo = $1 AND c.merged_into_id IS NULL AND COALESCE(c.status, 'active') <> 'archived'`;
  const findContact = async (silo: string, id: string) =>
    (await deps.db().query(`SELECT ${CONTACT_COLS} ${CONTACT_FROM} AND c.id = $2::uuid LIMIT 1`, [silo, id])).rows[0] ?? null;

  router.get("/contacts", requireScope("contacts:read"), safeHandler(async (req: Request, res: Response) => {
    const p = pageParams(req.query as Record<string, unknown>);
    if ("error" in p) return apiError(res, 400, "invalid_request", p.error);
    const params: unknown[] = [siloOf(req)];
    let where = "";
    const q = str(req.query.q, 100);
    if (q) { params.push(`%${q}%`); where += ` AND (c.name ILIKE $${params.length} OR c.email ILIKE $${params.length})`; }
    const email = str(req.query.email, 200);
    if (email) { params.push(email.toLowerCase()); where += ` AND lower(c.email) = $${params.length}`; }
    params.push(p.limit + 1, p.offset);
    const r = await deps.db().query(
      `SELECT ${CONTACT_COLS} ${CONTACT_FROM}${where} ORDER BY c.created_at DESC, c.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(paged(r.rows, p.limit, p.offset));
  }));

  router.get("/contacts/:id", requireScope("contacts:read"), safeHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const row = UUID.test(id) ? await findContact(siloOf(req), id) : null;
    if (!row) return apiError(res, 404, "not_found", "No contact with that id.");
    res.json({ data: row });
  }));

  router.post("/contacts", requireScope("contacts:write"), safeHandler(async (req: Request, res: Response) => {
    const silo = siloOf(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const first = str(b.first_name, 100);
    const last = str(b.last_name, 100);
    if (!first || !last) return apiError(res, 400, "invalid_request", "first_name and last_name are required.");
    const email = str(b.email, 200);
    if (email && !EMAIL.test(email)) return apiError(res, 400, "invalid_request", "email is not an email address.");
    const companyId = str(b.company_id, 64);
    if (companyId) {
      if (!UUID.test(companyId)) return apiError(res, 400, "invalid_request", "company_id must be a company id.");
      const co = await deps.db().query(`SELECT 1 FROM companies WHERE id = $1::uuid AND silo = $2 LIMIT 1`, [companyId, silo]);
      if (!co.rows[0]) return apiError(res, 400, "invalid_request", "company_id does not match a company.");
    }
    const row = await createContact(pool, {
      first_name: first, last_name: last, email, phone: str(b.phone, 40), company_id: companyId, silo, owner_id: ownerOf(req),
    });
    const jobTitle = str(b.job_title, 120);
    if (jobTitle) await deps.db().query(`UPDATE contacts SET job_title = $1 WHERE id = $2::uuid`, [jobTitle, row.id]);
    void emitAutomationEvent("contact.created", { silo, contactId: String(row.id), data: { source: "api" } });
    await auditWrite(req, "contact_created", { type: "contact", id: String(row.id) });
    res.status(201).json({ data: (await findContact(silo, String(row.id))) ?? row });
  }));

  router.patch("/contacts/:id", requireScope("contacts:write"), safeHandler(async (req: Request, res: Response) => {
    const silo = siloOf(req);
    const id = String(req.params.id ?? "");
    const current = UUID.test(id) ? await findContact(silo, id) : null;
    if (!current) return apiError(res, 404, "not_found", "No contact with that id.");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [id, silo];
    const put = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    for (const [field, max] of [["first_name", 100], ["last_name", 100], ["phone", 40], ["job_title", 120], ["lead_status", 60]] as const) {
      if (b[field] !== undefined) put(field, str(b[field], max));
    }
    if (b.email !== undefined) {
      const email = str(b.email, 200);
      if (email && !EMAIL.test(email)) return apiError(res, 400, "invalid_request", "email is not an email address.");
      put("email", email);
    }
    if (!sets.length) return apiError(res, 400, "invalid_request", "Send at least one of first_name, last_name, email, phone, job_title, lead_status.");
    if (b.first_name !== undefined || b.last_name !== undefined) {
      const first = b.first_name !== undefined ? str(b.first_name, 100) : current.first_name;
      const last = b.last_name !== undefined ? str(b.last_name, 100) : current.last_name;
      put("name", `${first ?? ""} ${last ?? ""}`.trim() || null);
    }
    await deps.db().query(`UPDATE contacts SET ${sets.join(", ")}, updated_at = now() WHERE id = $1::uuid AND silo = $2`, params);
    await auditWrite(req, "contact_updated", { type: "contact", id }, { fields: Object.keys(b).filter((k) => b[k] !== undefined) });
    res.json({ data: await findContact(silo, id) });
  }));

  // ---- companies ------------------------------------------------------------------------------------------------
  const COMPANY_COLS = `id::text AS id, name, legal_name, dba_name, website, email, phone, industry, city, province, country,
    COALESCE(custom_fields, '{}'::jsonb) AS custom_fields, created_at, updated_at`;
  const COMPANY_FIELDS = [["name", 200], ["legal_name", 200], ["website", 300], ["email", 200], ["phone", 40], ["industry", 120],
    ["city", 120], ["province", 60], ["country", 60]] as const;
  const findCompany = async (silo: string, id: string) =>
    (await deps.db().query(`SELECT ${COMPANY_COLS} FROM companies WHERE silo = $1 AND id = $2::uuid LIMIT 1`, [silo, id])).rows[0] ?? null;

  router.get("/companies", requireScope("companies:read"), safeHandler(async (req: Request, res: Response) => {
    const p = pageParams(req.query as Record<string, unknown>);
    if ("error" in p) return apiError(res, 400, "invalid_request", p.error);
    const params: unknown[] = [siloOf(req)];
    let where = "";
    const q = str(req.query.q, 100);
    if (q) { params.push(`%${q}%`); where += ` AND (name ILIKE $${params.length} OR legal_name ILIKE $${params.length})`; }
    params.push(p.limit + 1, p.offset);
    const r = await deps.db().query(
      `SELECT ${COMPANY_COLS} FROM companies WHERE silo = $1${where} ORDER BY created_at DESC, id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(paged(r.rows, p.limit, p.offset));
  }));

  router.get("/companies/:id", requireScope("companies:read"), safeHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    const row = UUID.test(id) ? await findCompany(siloOf(req), id) : null;
    if (!row) return apiError(res, 404, "not_found", "No company with that id.");
    res.json({ data: row });
  }));

  router.post("/companies", requireScope("companies:write"), safeHandler(async (req: Request, res: Response) => {
    const silo = siloOf(req);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = str(b.name, 200);
    if (!name) return apiError(res, 400, "invalid_request", "name is required.");
    const email = str(b.email, 200);
    if (email && !EMAIL.test(email)) return apiError(res, 400, "invalid_request", "email is not an email address.");
    const id = randomUUID();
    const cols = ["id", "silo", "owner_id"];
    const params: unknown[] = [id, silo, ownerOf(req)];
    for (const [field, max] of COMPANY_FIELDS) {
      const v = str(b[field], max);
      if (v !== null) { cols.push(field); params.push(v); }
    }
    await deps.db().query(
      `INSERT INTO companies (${cols.join(", ")}, created_at, updated_at) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}, now(), now())`,
      params,
    );
    await auditWrite(req, "company_created", { type: "company", id });
    res.status(201).json({ data: await findCompany(silo, id) });
  }));

  router.patch("/companies/:id", requireScope("companies:write"), safeHandler(async (req: Request, res: Response) => {
    const silo = siloOf(req);
    const id = String(req.params.id ?? "");
    if (!UUID.test(id) || !(await findCompany(silo, id))) return apiError(res, 404, "not_found", "No company with that id.");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [id, silo];
    for (const [field, max] of COMPANY_FIELDS) {
      if (b[field] === undefined) continue;
      const v = str(b[field], max);
      if (field === "name" && !v) return apiError(res, 400, "invalid_request", "name cannot be empty.");
      if (field === "email" && v && !EMAIL.test(v)) return apiError(res, 400, "invalid_request", "email is not an email address.");
      params.push(v); sets.push(`${field} = $${params.length}`);
    }
    if (!sets.length) return apiError(res, 400, "invalid_request", `Send at least one of ${COMPANY_FIELDS.map(([f]) => f).join(", ")}.`);
    await deps.db().query(`UPDATE companies SET ${sets.join(", ")}, updated_at = now() WHERE id = $1::uuid AND silo = $2`, params);
    await auditWrite(req, "company_updated", { type: "company", id }, { fields: Object.keys(b).filter((k) => b[k] !== undefined) });
    res.json({ data: await findCompany(silo, id) });
  }));

  // ---- applications ---------------------------------------------------------------------------------------------
  const APP_COLS = `id::text AS id, name, pipeline_state AS stage, business_legal_name, requested_amount, product_category,
    company_id::text AS company_id, contact_id::text AS contact_id, lender_id::text AS lender_id, submitted_at,
    funded_amount, funded_at, COALESCE(custom_fields, '{}'::jsonb) AS custom_fields, created_at, updated_at`;
  const appId = (v: unknown) => { const s = String(v ?? "").trim(); return s && s.length <= 100 ? s : ""; };
  async function findApp(silo: string, id: string) {
    if (!id) return null;
    const r = await deps.db().query(`SELECT ${APP_COLS} FROM applications WHERE silo = $1 AND id::text = $2 LIMIT 1`, [silo, id]);
    return r.rows[0] ?? null;
  }

  router.get("/applications", requireScope("applications:read"), safeHandler(async (req: Request, res: Response) => {
    const p = pageParams(req.query as Record<string, unknown>);
    if ("error" in p) return apiError(res, 400, "invalid_request", p.error);
    const params: unknown[] = [siloOf(req)];
    let where = "";
    const stage = str(req.query.stage, 60);
    if (stage) { params.push(stage); where += ` AND pipeline_state = $${params.length}`; }
    params.push(p.limit + 1, p.offset);
    const r = await deps.db().query(
      `SELECT ${APP_COLS} FROM applications WHERE silo = $1${where} ORDER BY created_at DESC, id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(paged(r.rows, p.limit, p.offset));
  }));

  router.get("/applications/:id", requireScope("applications:read"), safeHandler(async (req: Request, res: Response) => {
    const app = await findApp(siloOf(req), appId(req.params.id));
    if (!app) return apiError(res, 404, "not_found", "No application with that id.");
    res.json({ data: app });
  }));

  router.patch("/applications/:id/stage", requireScope("applications:write"), safeHandler(async (req: Request, res: Response) => {
    const silo = siloOf(req);
    const id = appId(req.params.id);
    const stage = (req.body ?? {}).stage;
    if (!isApiStage(stage)) return apiError(res, 400, "invalid_request", `stage must be one of: ${API_STAGES.join(", ")}.`);
    const app = await findApp(silo, id);
    if (!app) return apiError(res, 404, "not_found", "No application with that id.");
    await transitionPipelineState({
      applicationId: id,
      nextState: stage as any,
      actorUserId: ownerOf(req),
      actorRole: ROLES.ADMIN,
      trigger: "api",
      reason: `api_key:${req.apiKey?.key_prefix ?? ""}`,
      ip: clientIpFromRequest(req) || undefined,
      userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300) || undefined,
    });
    await auditWrite(req, "application_stage_changed", { type: "application", id }, { from: app.stage, to: stage });
    res.json({ data: await findApp(silo, id) });
  }));

  // ---- notes ----------------------------------------------------------------------------------------------------
  const NOTE_COLS = `n.id::text AS id, n.application_id::text AS application_id, n.body, n.owner_id::text AS owner_id,
    COALESCE(NULLIF(trim(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), u.email) AS owner_name,
    n.created_at, n.updated_at`;

  router.get("/applications/:id/notes", requireScope("notes:read"), safeHandler(async (req: Request, res: Response) => {
    const silo = siloOf(req);
    const p = pageParams(req.query as Record<string, unknown>);
    if ("error" in p) return apiError(res, 400, "invalid_request", p.error);
    const id = appId(req.params.id);
    if (!(await findApp(silo, id))) return apiError(res, 404, "not_found", "No application with that id.");
    const r = await deps.db().query(
      `SELECT ${NOTE_COLS} FROM crm_notes n LEFT JOIN users u ON u.id = n.owner_id
        WHERE n.application_id = $1 AND n.silo = $2 AND n.is_deleted = false
        ORDER BY n.created_at DESC, n.id LIMIT $3 OFFSET $4`,
      [id, silo, p.limit + 1, p.offset],
    );
    res.json(paged(r.rows, p.limit, p.offset));
  }));

  router.post("/applications/:id/notes", requireScope("notes:write"), safeHandler(async (req: Request, res: Response) => {
    const silo = siloOf(req);
    const id = appId(req.params.id);
    const body = String((req.body ?? {}).body ?? "").trim();
    if (!body) return apiError(res, 400, "invalid_request", "body is required.");
    if (body.length > 10_000) return apiError(res, 400, "invalid_request", "body is too long (10,000 characters at most).");
    if (!(await findApp(silo, id))) return apiError(res, 404, "not_found", "No application with that id.");
    const ins = await deps.db().query(
      `INSERT INTO crm_notes (body, owner_id, application_id, silo, mentions, created_at, updated_at)
       VALUES ($1, $2, $3, $4, '{}', now(), now()) RETURNING id::text AS id`,
      [body, ownerOf(req), id, silo],
    );
    const noteId = String(ins.rows[0]?.id ?? "");
    await auditWrite(req, "note_added", { type: "application", id }, { note_id: noteId });
    const r = await deps.db().query(
      `SELECT ${NOTE_COLS} FROM crm_notes n LEFT JOIN users u ON u.id = n.owner_id WHERE n.id::text = $1 LIMIT 1`,
      [noteId],
    );
    res.status(201).json({ data: r.rows[0] ?? { id: noteId, application_id: id, body } });
  }));

  // ---- offers ---------------------------------------------------------------------------------------------------
  router.get("/applications/:id/offers", requireScope("offers:read"), safeHandler(async (req: Request, res: Response) => {
    const silo = siloOf(req);
    const p = pageParams(req.query as Record<string, unknown>);
    if ("error" in p) return apiError(res, 400, "invalid_request", p.error);
    const id = appId(req.params.id);
    if (!(await findApp(silo, id))) return apiError(res, 404, "not_found", "No application with that id.");
    const r = await deps.db().query(
      `SELECT id::text AS id, application_id, lender_id::text AS lender_id, lender_name, amount, rate_factor, term, payment_frequency,
              expiry_date, status, recommended, created_at, updated_at
         FROM offers WHERE application_id = $1 AND COALESCE(is_archived, false) = false
        ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`,
      [id, p.limit + 1, p.offset],
    );
    res.json(paged(r.rows, p.limit, p.offset));
  }));

  // ---- lenders --------------------------------------------------------------------------------------------------
  const LENDER_COLS = `id::text AS id, name, active, website, phone, email, country, region, city, contact_name, contact_email,
    contact_phone, created_at, updated_at`;

  router.get("/lenders", requireScope("lenders:read"), safeHandler(async (req: Request, res: Response) => {
    const p = pageParams(req.query as Record<string, unknown>);
    if ("error" in p) return apiError(res, 400, "invalid_request", p.error);
    const params: unknown[] = [siloOf(req)];
    let where = "";
    if (req.query.active === "true" || req.query.active === "false") { params.push(req.query.active === "true"); where += ` AND active = $${params.length}`; }
    params.push(p.limit + 1, p.offset);
    const r = await deps.db().query(
      `SELECT ${LENDER_COLS} FROM lenders WHERE COALESCE(silo, 'BF') = $1${where} ORDER BY lower(name), id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(paged(r.rows, p.limit, p.offset));
  }));

  router.get("/lenders/:id", requireScope("lenders:read"), safeHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id ?? "");
    if (!UUID.test(id)) return apiError(res, 404, "not_found", "No lender with that id.");
    const r = await deps.db().query(`SELECT ${LENDER_COLS} FROM lenders WHERE COALESCE(silo, 'BF') = $1 AND id = $2::uuid LIMIT 1`, [siloOf(req), id]);
    if (!r.rows[0]) return apiError(res, 404, "not_found", "No lender with that id.");
    res.json({ data: r.rows[0] });
  }));

  router.use((_req, res) => apiError(res, 404, "not_found", "No such endpoint. See /api/open/v1/openapi.json."));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isAppError(err)) {
      const status = (err as any).status ?? 400;
      return apiError(res, status, String((err as any).code ?? "error"), String((err as any).message ?? "Request failed."));
    }
    console.error("[public-api] request failed", (err as Error)?.message ?? String(err));
    return apiError(res, 500, "server_error", "Something went wrong. Try again.");
  });

  return router;
}

export default createPublicApiRouter();
