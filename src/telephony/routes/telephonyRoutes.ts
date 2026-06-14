import express, { type Request, type Response } from "express";
import { v4 as uuid } from "uuid";
import { auth } from "../../middleware/auth.js";
import { generateVoiceToken } from "../services/tokenService.js";
import { pool } from "../../db.js";
import { recomputePresence, setManualBusy } from "../../modules/presence/presenceService.js";

const router = express.Router();
const HEARTBEAT_MIN_INTERVAL_MS = 25_000;
const lastPresenceHeartbeatByUser = new Map<string, number>();

function isTwilioEnabled(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_VOICE_APP_SID &&
    process.env.TWILIO_API_KEY &&
    process.env.TWILIO_API_SECRET,
  );
}

const REQUIRED_VOICE_TOKEN_ENV = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY",
  "TWILIO_API_SECRET",
  "TWILIO_VOICE_APP_SID",
] as const;

function getMissingVoiceTokenEnv(): string[] {
  return REQUIRED_VOICE_TOKEN_ENV.filter((key) => {
    const value = process.env[key];
    return typeof value !== "string" || value.trim().length === 0;
  });
}

// ── Voice token ──────────────────────────────────────────────────────────────
router.get("/token", auth, async (req: any, res: Response) => {
  const missingEnv = getMissingVoiceTokenEnv();
  if (missingEnv.length > 0) {
    return res.status(503).json({
      success: false,
      error: "telephony_not_configured",
      message: "Missing required Twilio env vars for voice token generation",
      missing: missingEnv,
    });
  }
  const identity: string = req.user?.userId || req.user?.id || req.user?.sub || uuid();
  try {
    const token = generateVoiceToken(identity);
    const userResult = await pool.query<{ outbound_caller_id: string | null }>(`SELECT outbound_caller_id FROM users WHERE id = $1 LIMIT 1`, [identity]).catch(() => ({ rows: [] as any[] }));
    const userOutbound = userResult.rows[0]?.outbound_caller_id ?? null;
    const envOutbound = process.env.TWILIO_DEFAULT_OUTBOUND_CALLER_ID ?? null;
    const outboundCallerId = userOutbound ?? envOutbound;
    const missingOutboundCallerId = !outboundCallerId;
    // Upsert presence on token fetch — means the browser is alive
    await pool.query(
      `INSERT INTO staff_presence (user_id, twilio_identity, status, last_heartbeat, updated_at)
       VALUES ($1, $2, 'available', now(), now())
       ON CONFLICT (user_id) DO UPDATE
         -- BF_SERVER_PRESENCE_AUTO_BUSY_v1 — bump heartbeat/identity only; the
         -- recompute below derives status from reasons + hours.
         SET twilio_identity = $2, last_heartbeat = now(), updated_at = now()`,
      [identity, identity]
    ).catch(() => {}); // non-fatal
    await recomputePresence(identity).catch(() => {});
    return res.status(200).json({ success: true, data: { token, identity, outbound_caller_id: outboundCallerId, missing_outbound_caller_id: missingOutboundCallerId } });
  } catch {
    return res.status(500).json({ success: false, error: "token_generation_failed" });
  }
});

// ── Presence ─────────────────────────────────────────────────────────────────
// BF_SERVER_BLOCK_v144_TELEPHONY_AUTH_v1 — was unauthed; leaks staff online status.
router.get("/presence", auth, async (_req: Request, res: Response) => {
  try {
    // Return staff online in last 5 minutes
    const result = await pool.query<{ user_id: string; status: string; twilio_identity: string | null }>(
      `SELECT user_id, status, twilio_identity FROM staff_presence
       WHERE last_heartbeat > now() - interval '5 minutes'
         AND status != 'offline'`
    );
    res.json({ staff: result.rows });
  } catch {
    res.json({ staff: [] });
  }
});

router.post("/presence", auth, async (req: any, res: Response) => {
  const status = req.body?.status;
  if (!["available", "busy", "offline"].includes(status)) {
    return res.status(400).json({ error: "status must be available, busy, or offline" });
  }
  const userId = req.user?.userId || req.user?.id;
  if (!userId) return res.status(401).json({ error: "unauthorized" });
  // BF_SERVER_PRESENCE_AUTO_BUSY_v1 — topbar toggle sets the manual_busy reason.
  const manualBusy = status === "busy";
  await pool.query(
    `INSERT INTO staff_presence (user_id, status, manual_busy, last_heartbeat, updated_at)
     VALUES ($1, 'available', $2, now(), now())
     ON CONFLICT (user_id) DO UPDATE SET manual_busy = $2, last_heartbeat = now(), updated_at = now()`,
    [userId, manualBusy]
  ).catch(() => {});
  await setManualBusy(userId, manualBusy).catch(() => {});
  res.json({ ok: true, status });
});

// Heartbeat — client should call no more than once every 30 seconds to keep presence alive.
router.post("/presence/heartbeat", auth, async (req: any, res: Response) => {
  const userId = req.user?.userId || req.user?.id;
  if (!userId) return res.status(401).json({ error: "unauthorized" });

  const now = Date.now();
  const lastHeartbeatAt = lastPresenceHeartbeatByUser.get(userId) ?? 0;
  if (now - lastHeartbeatAt < HEARTBEAT_MIN_INTERVAL_MS) {
    return res.json({ ok: true, throttled: true });
  }
  lastPresenceHeartbeatByUser.set(userId, now);

  await pool.query(
    // BF_SERVER_PRESENCE_AUTO_BUSY_v1 — bump heartbeat; recompute derives status.
    `UPDATE staff_presence SET last_heartbeat = now() WHERE user_id = $1`,
    [userId]
  ).catch(() => {});
  await recomputePresence(userId).catch(() => {});
  res.json({ ok: true });
});

// ── Call status / log ─────────────────────────────────────────────────────────
router.get("/call-status", auth, async (_req, res) => {
  const result = await pool.query(
    `SELECT id, phone_number, direction, status, duration_seconds, created_at
     FROM call_logs ORDER BY created_at DESC LIMIT 50`
  ).catch(() => ({ rows: [] }));
  res.json({ calls: result.rows });
});

// BF_SERVER_BLOCK_v144_TELEPHONY_AUTH_v1 — was unauthed.
router.post("/call-status", auth, (_req: Request, res: Response) => { res.json({ updated: true }); });

// ── Outbound call ─────────────────────────────────────────────────────────────
router.post("/outbound-call", auth, async (req: any, res: Response) => {
  const { to, contactId, applicationId } = req.body ?? {};
  if (!to) return res.status(400).json({ error: "to is required" });
  if (!isTwilioEnabled()) return res.status(503).json({ error: "Telephony not configured" });

  // BF_SERVER_BLOCK_v326_OUTBOUND_CALL_FROM_ENV_FALLBACK_v1
  // Same env-var-name mismatch as v325 (which fixed it in
  // /api/communications/sms). Pre-fix this read:
  //   TWILIO_FROM_NUMBER ?? TWILIO_PHONE_NUMBER ?? TWILIO_CALLER_ID
  // None of TWILIO_FROM_NUMBER or TWILIO_CALLER_ID are recognized in
  // src/config/schema.ts -- only TWILIO_PHONE, TWILIO_FROM, TWILIO_NUMBER,
  // TWILIO_PHONE_NUMBER are validated. So if the operator set their
  // outbound caller ID under TWILIO_FROM / TWILIO_PHONE / TWILIO_NUMBER
  // (the most common Twilio naming conventions), this endpoint 503'd
  // "TWILIO_FROM_NUMBER not set" and staff "Call client" buttons in
  // the pipeline / CRM / drawer all failed silently because the UI's
  // catch swallows the 503.
  // Match v325's fallback chain exactly so the same env var works for
  // both outbound voice and outbound SMS.
  const from = process.env.TWILIO_FROM_NUMBER
    ?? process.env.TWILIO_PHONE_NUMBER
    ?? process.env.TWILIO_FROM
    ?? process.env.TWILIO_PHONE
    ?? process.env.TWILIO_NUMBER
    ?? process.env.TWILIO_CALLER_ID;
  if (!from) return res.status(503).json({ error: "Twilio FROM number not set (set TWILIO_PHONE_NUMBER or TWILIO_FROM or TWILIO_PHONE)" });

  try {
    const { default: twilio } = await import("twilio");
    const client: any = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
    const call = await client.calls.create({
      to,
      from,
      url: `${process.env.PUBLIC_BASE_URL ?? "https://server.boreal.financial"}/api/webhooks/twilio/voice/twiml`,
      statusCallback: `${process.env.PUBLIC_BASE_URL ?? "https://server.boreal.financial"}/api/webhooks/twilio/voice`,
      statusCallbackMethod: "POST",
    });
    // Log the call.
    // BF_SERVER_BLOCK_BI_ROUND5_B_v1 -- include silo so BI silo
    // outbound calls log as silo='BI' instead of falling through
    // to the column default 'BF'. Source: resolveSiloFromRequest
    // (X-Silo header / ?silo / allowlist / user primary).
    const staffId = req.user?.userId;
    const { resolveSiloFromRequest } = await import("../../middleware/silo.js");
    const silo = resolveSiloFromRequest(req);
    await pool.query(
      `INSERT INTO call_logs (id, phone_number, from_number, to_number, twilio_call_sid,
         direction, status, staff_user_id, crm_contact_id, application_id, silo, created_at, started_at)
       VALUES (gen_random_uuid(), $1, $2, $1, $3, 'outbound', 'initiated', $4, $5, $6, $7, now(), now())
       ON CONFLICT DO NOTHING`,
      [to, from, call.sid, staffId ?? null, contactId ?? null, applicationId ?? null, silo]
    ).catch(() => {});
    res.json({ success: true, callSid: call.sid });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "call_failed" });
  }
});

// BF_SERVER_BLOCK_v695_QUICK_CALL_v1 — staff quick-call slots for the dialer.
// GET returns callable staff (with their twilio identity + presence) plus the
// caller's saved 3 picks; PUT saves the caller's picks (staff user ids).
router.get("/quick-call", auth, async (req: any, res: Response) => {
  const userId = req.user?.userId || req.user?.id;
  if (!userId) return res.status(401).json({ error: "unauthorized" });
  const staff = await pool.query(
    `SELECT u.id AS user_id,
            NULLIF(trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')), '') AS name,
            u.email,
            u.profile_image_url,
            sp.twilio_identity AS identity,
            (sp.status = 'available' AND sp.last_heartbeat > now() - interval '5 minutes') AS online
       FROM users u
       LEFT JOIN staff_presence sp ON sp.user_id = u.id
      -- BF_SERVER_BLOCK_v825_QUICKCALL_MATCH_TEAM_LIST: use the EXACT filter as /api/team/users
      -- (listStaffUsers) so quick-call shows the same staff. The old v788 query also tested the
      -- legacy u.active / u.disabled columns, which wrongly excluded staff (e.g. Caden) whose
      -- legacy active=false even though is_active=true and status=ACTIVE.
      WHERE COALESCE(u.is_active, true) = true
        AND u.deleted_at IS NULL
        AND u.role IN ('Admin', 'Staff', 'Ops', 'Marketing')
        AND u.id <> $1
      ORDER BY name NULLS LAST, u.email`,
    [userId],
  );
  const me = await pool.query(
    `SELECT coalesce(quick_call_slots, '[]'::jsonb) AS slots FROM users WHERE id = $1`,
    [userId],
  );
  res.json({
    staff: staff.rows.map((r: any) => ({
      userId: r.user_id,
      name: r.name || r.email,
      identity: r.identity ?? null,
      avatarUrl: r.profile_image_url ?? null,
      online: !!r.online,
    })),
    slots: Array.isArray(me.rows[0]?.slots) ? me.rows[0].slots : [],
  });
});

router.put("/quick-call", auth, async (req: any, res: Response) => {
  const userId = req.user?.userId || req.user?.id;
  if (!userId) return res.status(401).json({ error: "unauthorized" });
  const slots = Array.isArray(req.body?.slots)
    ? req.body.slots.filter((x: unknown) => typeof x === "string").slice(0, 3)
    : [];
  await pool.query(`UPDATE users SET quick_call_slots = $2::jsonb WHERE id = $1`, [userId, JSON.stringify(slots)]);
  res.json({ ok: true, slots });
});

export default router;
