import express, { type Request, type Response } from "express";
import { v4 as uuid } from "uuid";
import { auth } from "../../middleware/auth.js";
import { generateVoiceToken } from "../services/tokenService.js";
import { pool } from "../../db.js";

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
    // Upsert presence on token fetch — means the browser is alive
    await pool.query(
      `INSERT INTO staff_presence (user_id, twilio_identity, status, last_heartbeat, updated_at)
       VALUES ($1, $2, 'available', now(), now())
       ON CONFLICT (user_id) DO UPDATE
         SET twilio_identity = $2, last_heartbeat = now(), updated_at = now()`,
      [identity, identity]
    ).catch(() => {}); // non-fatal
    return res.status(200).json({ success: true, data: { token, identity } });
  } catch {
    return res.status(500).json({ success: false, error: "token_generation_failed" });
  }
});

// ── Presence ─────────────────────────────────────────────────────────────────
router.get("/presence", async (_req: Request, res: Response) => {
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
  await pool.query(
    `INSERT INTO staff_presence (user_id, status, last_heartbeat, updated_at)
     VALUES ($1, $2, now(), now())
     ON CONFLICT (user_id) DO UPDATE SET status = $2, last_heartbeat = now(), updated_at = now()`,
    [userId, status]
  ).catch(() => {});
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
    `UPDATE staff_presence SET last_heartbeat = now() WHERE user_id = $1`,
    [userId]
  ).catch(() => {});
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

router.post("/call-status", (_req, res) => { res.json({ updated: true }); });

// ── Outbound call ─────────────────────────────────────────────────────────────
router.post("/outbound-call", auth, async (req: any, res: Response) => {
  const { to, contactId, applicationId } = req.body ?? {};
  if (!to) return res.status(400).json({ error: "to is required" });
  if (!isTwilioEnabled()) return res.status(503).json({ error: "Telephony not configured" });

  const from = process.env.TWILIO_FROM_NUMBER ??
               process.env.TWILIO_PHONE_NUMBER ??
               process.env.TWILIO_CALLER_ID;
  if (!from) return res.status(503).json({ error: "TWILIO_FROM_NUMBER not set" });

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
    // Log the call
    const staffId = req.user?.userId;
    await pool.query(
      `INSERT INTO call_logs (id, phone_number, from_number, to_number, twilio_call_sid,
         direction, status, staff_user_id, crm_contact_id, application_id, created_at, started_at)
       VALUES (gen_random_uuid(), $1, $2, $1, $3, 'outbound', 'initiated', $4, $5, $6, now(), now())
       ON CONFLICT DO NOTHING`,
      [to, from, call.sid, staffId ?? null, contactId ?? null, applicationId ?? null]
    ).catch(() => {});
    res.json({ success: true, callSid: call.sid });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "call_failed" });
  }
});

export default router;
