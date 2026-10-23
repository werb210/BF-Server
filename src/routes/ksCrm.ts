// BF_SERVER_v850_KS_CRM - /api/ks/crm
//   POST  /api/ks/crm/upsert          KS-Ops pushes demo sign-ups, website sign-ups and licensees (X-KS-Ops-Key)
//   GET   /api/ks/crm/pipeline        the Keystone pipeline board (staff: Admin, or KS in their silo access)
//   PATCH /api/ks/crm/pipeline/stage  staff move a card { kind: "contact" | "company", id, stage }
// Contacts, companies, notes, tasks, calls, SMS and email for Keystone use the ordinary /api/crm and
// /api/communications routes with X-Silo: KS, exactly like BF.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { pool } from "../db.js";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import {
  canUseKsCrm,
  isKsStage,
  KS_STAGE_LABELS,
  KS_STAGES,
  listKsPipeline,
  parseKsUpsert,
  setKsStage,
  upsertKsCrm,
} from "../modules/ks/ksCrm.js";

const router = Router();

export const KS_OPS_KEY_MIN_LENGTH = 32;

let warnedShortKey = false;
function configuredKey(): string | null {
  const key = String(process.env.KS_OPS_CRM_KEY ?? "").trim();
  if (!key) return null;
  if (key.length < KS_OPS_KEY_MIN_LENGTH) {
    if (!warnedShortKey) {
      warnedShortKey = true;
      console.error(`[ks-crm] KS_OPS_CRM_KEY is shorter than ${KS_OPS_KEY_MIN_LENGTH} characters - the ingest stays off`);
    }
    return null;
  }
  return key;
}

/** Constant-time: both sides are hashed first, so neither the content nor the length leaks. */
export function opsKeyMatches(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b) && provided.length === expected.length;
}

/** "First Last" (or the email) of the staff member moving a card, for the timeline note. */
async function staffDisplayName(userId: unknown): Promise<string | null> {
  if (typeof userId !== "string" || !/^[0-9a-f-]{36}$/i.test(userId)) return null;
  const r = await pool.query(
    `SELECT nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '') AS name, email FROM users WHERE id = $1`,
    [userId],
  );
  return r.rows[0]?.name ?? r.rows[0]?.email ?? null;
}

const ingestLimiter = rateLimit({
  windowMs: 60_000,
  keyGenerator: rateLimitKeyFromRequest, // Azure sends ip:port; the library default rejects it
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "rate_limited" },
});

router.post("/upsert", ingestLimiter, safeHandler(async (req: any, res: any) => {
  const expected = configuredKey();
  if (!expected) return res.status(503).json({ error: "ks_crm_not_configured" });
  const header = req.header("x-ks-ops-key");
  const provided = String(Array.isArray(header) ? header[0] : header ?? "").trim();
  if (!provided || !opsKeyMatches(provided, expected)) return res.status(401).json({ error: "invalid_ops_key" });

  const parsed = parseKsUpsert(req.body);
  if (!parsed.ok) return res.status(400).json({ error: "validation_error", errors: parsed.errors });

  const client = await pool.connect();
  let result;
  try {
    await client.query("BEGIN");
    result = await upsertKsCrm(client, parsed.value);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr: unknown) => {
      console.error("[ks-crm] rollback failed", rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr));
    });
    throw err;
  } finally {
    client.release();
  }

  // Same automation hook as a contact created in the CRM by hand (fire and forget; it logs its own failures).
  if (result.created.contact && result.contact_id) {
    void import("../modules/automation/automationEngine.js")
      .then((m) => m.emitAutomationEvent("contact.created", { silo: "KS", contactId: result.contact_id!, data: { source: `ks_ops:${parsed.value.source}` } }))
      .catch((err: unknown) => console.warn("[ks-crm] automation emit failed", err instanceof Error ? err.message : String(err)));
  }
  return res.status(200).json({ ok: true, contact_id: result.contact_id, company_id: result.company_id, stage: result.stage });
}));

// Staff side.
router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.CRM_READ]));
router.use((req: any, res: any, next: any) => {
  if (!canUseKsCrm(req.user)) return res.status(403).json({ error: "ks_access_required" });
  return next();
});

router.get("/pipeline", safeHandler(async (req: any, res: any) => {
  const search = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : null;
  const cards = await listKsPipeline(pool, { search });
  res.json({
    ok: true,
    silo: "KS",
    stages: KS_STAGES.map((key) => ({ key, label: KS_STAGE_LABELS[key] })),
    cards,
  });
}));

router.patch("/pipeline/stage", requireCapability([CAPABILITIES.CRM_WRITE]), safeHandler(async (req: any, res: any) => {
  const kind = req.body?.kind;
  const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
  const stage = req.body?.stage;
  const errors: Record<string, string> = {};
  if (kind !== "contact" && kind !== "company") errors.kind = "must be contact or company";
  if (!/^[0-9a-f-]{36}$/i.test(id)) errors.id = "must be a UUID";
  if (!isKsStage(stage)) errors.stage = "must be one of " + KS_STAGES.join(", ");
  if (Object.keys(errors).length) return res.status(400).json({ error: "validation_error", errors });
  const staffName = await staffDisplayName(req.user?.userId ?? req.user?.id);
  const out = await setKsStage(pool, kind, id, stage, staffName);
  if (!out) return res.status(404).json({ error: "not_found" });
  return res.json({ ok: true, ...out, silo: "KS" });
}));

export default router;
