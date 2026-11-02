// BF_SERVER_v865_KS_MARKETING - /api/ks/marketing: KS-Ops's Keystone prospect marketing and the Keystone CRM (silo KS).
//   GET  /api/ks/marketing/contacts?since=ISO&limit=500   Keystone CRM contacts changed since `since` (X-KS-Ops-Key),
//        so KS-Ops can market to prospects staff added in the CRM: email, name, company, stage, country/province and
//        the marketing opt-out flag. Oldest change first; KS-Ops keeps the cursor.
//   POST /api/ks/marketing/events  { email, contact?: { name, company, phone }, events: [{ key, type, at, summary }] }
//        Keystone marketing activity (sent, opened, clicked, bounced, unsubscribed, replied, sequence stopped, consent
//        recorded) written to the Keystone contact's timeline, once per key. A contact that does not exist yet is
//        created in the Keystone CRM as a lead. An unsubscribe, hard bounce or spam report sets marketing_opt_out.
// Only silo KS is ever read or written. Same key as the CRM ingest (KS_OPS_CRM_KEY, 32+ characters).
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { createContact } from "../services/contacts.js";
import { KS_OPS_KEY_MIN_LENGTH, opsKeyMatches } from "./ksCrm.js";

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OPT_OUT_EVENTS = new Set(["unsubscribed", "email_bounced", "suppressed"]);
export const KS_MARKETING_EVENT_TYPES = [
  "email_sent", "email_opened", "email_clicked", "email_bounced", "unsubscribed", "suppressed", "replied",
  "sequence_stopped", "consent_changed",
] as const;

const limiter = rateLimit({
  windowMs: 60_000,
  keyGenerator: rateLimitKeyFromRequest,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited" },
});

function keyProblem(req: any): { status: number; error: string } | null {
  const expected = String(process.env.KS_OPS_CRM_KEY ?? "").trim();
  if (!expected || expected.length < KS_OPS_KEY_MIN_LENGTH) return { status: 503, error: "ks_crm_not_configured" };
  const header = req.header("x-ks-ops-key");
  const provided = String(Array.isArray(header) ? header[0] : header ?? "").trim();
  if (!provided || !opsKeyMatches(provided, expected)) return { status: 401, error: "invalid_ops_key" };
  return null;
}

router.use(limiter);
router.use((req: any, res: any, next: any) => {
  const p = keyProblem(req);
  if (p) return res.status(p.status).json({ error: p.error });
  return next();
});

router.get("/contacts", safeHandler(async (req: any, res: any) => {
  const sinceRaw = typeof req.query.since === "string" ? new Date(req.query.since) : new Date(0);
  const since = Number.isNaN(sinceRaw.getTime()) ? new Date(0) : sinceRaw;
  const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 1000);
  const { rows } = await pool.query(
    `SELECT c.id::text AS id, lower(trim(c.email)) AS email, c.name, c.phone, c.job_title,
            coalesce(co.name, c.company_name) AS company_name,
            coalesce(c.ks_stage, co.ks_stage) AS ks_stage,
            c.address_country AS country, c.address_state AS province_state,
            c.marketing_opt_out, c.updated_at
       FROM contacts c
       LEFT JOIN companies co ON co.id = c.company_id AND co.silo = 'KS'
      WHERE c.silo = 'KS' AND c.merged_into_id IS NULL AND coalesce(c.status, '') <> 'archived'
        AND coalesce(c.email, '') LIKE '%@%' AND c.updated_at > $1
      ORDER BY c.updated_at ASC, c.id
      LIMIT $2`,
    [since, limit],
  );
  res.json({ ok: true, contacts: rows });
}));

type MarketingEvent = { key: string; type: string; at: string; summary: string };

function parseEvents(body: any): { ok: true; email: string; contact: { name: string | null; company: string | null; phone: string | null }; events: MarketingEvent[] } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) errors.email = "must be a valid email";
  const c = body?.contact && typeof body.contact === "object" ? body.contact : {};
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  const events: MarketingEvent[] = [];
  if (!Array.isArray(body?.events) || body.events.length === 0) errors.events = "must be a non-empty list";
  else if (body.events.length > 50) errors.events = "at most 50 events";
  else {
    body.events.forEach((e: any, i: number) => {
      const key = text(e?.key, 200);
      const at = typeof e?.at === "string" ? new Date(e.at) : null;
      if (!key) errors[`events.${i}.key`] = "is required";
      else if (typeof e?.type !== "string" || !(KS_MARKETING_EVENT_TYPES as readonly string[]).includes(e.type)) errors[`events.${i}.type`] = "is not a known marketing event";
      else if (!at || Number.isNaN(at.getTime())) errors[`events.${i}.at`] = "must be an ISO-8601 date";
      else events.push({ key, type: e.type, at: at.toISOString(), summary: text(e?.summary, 1000) ?? e.type.replace(/_/g, " ") });
    });
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, email, contact: { name: text(c.name, 200), company: text(c.company, 200), phone: text(c.phone, 40) }, events };
}

router.post("/events", safeHandler(async (req: any, res: any) => {
  const parsed = parseEvents(req.body);
  if (!parsed.ok) return res.status(400).json({ error: "validation_error", errors: parsed.errors });
  const client = await pool.connect();
  let contactId: string;
  let created = false;
  let added = 0;
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ks_marketing:${parsed.email}`]);
    const found = await client.query(
      `SELECT id::text AS id FROM contacts
        WHERE silo = 'KS' AND merged_into_id IS NULL AND coalesce(status, '') <> 'archived'
          AND (lower(trim(coalesce(email, ''))) = $1 OR lower(trim(coalesce(secondary_email, ''))) = $1)
        ORDER BY (lower(trim(coalesce(email, ''))) = $1) DESC, created_at ASC LIMIT 1`,
      [parsed.email],
    );
    if (found.rows[0]) contactId = found.rows[0].id;
    else {
      const full = parsed.contact.name ?? parsed.email.split("@")[0]!;
      const parts = full.split(/\s+/);
      const row = await createContact(client as any, {
        first_name: parts[0]!, last_name: parts.slice(1).join(" "), email: parsed.email, phone: parsed.contact.phone,
        role: "other", is_primary_applicant: false, company_id: null, silo: "KS", owner_id: null,
      });
      contactId = String(row.id);
      created = true;
      await client.query(
        `UPDATE contacts SET company_name = coalesce(company_name, $2), ks_stage = coalesce(ks_stage, 'lead'), ks_stage_changed_at = coalesce(ks_stage_changed_at, now()) WHERE id = $1`,
        [contactId, parsed.contact.company],
      );
    }
    let optOut = false;
    for (const e of parsed.events) {
      const claim = await client.query(
        `INSERT INTO ks_crm_timeline_keys (dedupe_key) VALUES ($1) ON CONFLICT (dedupe_key) DO NOTHING RETURNING dedupe_key`,
        [`mkt:${e.key}`],
      );
      if (!claim.rows[0]) continue;
      const note = await client.query(
        `INSERT INTO crm_notes (body, contact_id, company_id, silo, created_at, updated_at)
         VALUES ($1, $2::uuid, NULL, 'KS', $3::timestamptz, now()) RETURNING id::text AS id`,
        [`Keystone marketing: ${e.summary}`.slice(0, 5000), contactId, e.at],
      );
      await client.query(`UPDATE ks_crm_timeline_keys SET crm_note_id = $2::uuid WHERE dedupe_key = $1`, [`mkt:${e.key}`, note.rows[0]?.id ?? null]);
      added++;
      if (OPT_OUT_EVENTS.has(e.type)) optOut = true;
    }
    if (optOut) await client.query(`UPDATE contacts SET marketing_opt_out = true, updated_at = now() WHERE id = $1 AND silo = 'KS'`, [contactId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr: unknown) => {
      console.error("[ks-marketing] rollback failed", rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr));
    });
    throw err;
  } finally {
    client.release();
  }
  return res.json({ ok: true, contact_id: contactId, created, added });
}));

export default router;
