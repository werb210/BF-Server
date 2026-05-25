// BF_SERVER_BLOCK_53_v1 -- client mini-portal voice token endpoint.
// Identity scheme: `client-<applicationId>`. This lets the TwiML
// webhook distinguish client-initiated calls from staff-initiated
// calls and route the former to staff via <Dial><Client>...</Client>.
//
// Auth: matches the other /api/client/* endpoints (which are roles:[]
// in routeRegistry, so accept the client OTP JWT or no JWT). We do
// not require auth here for parity with /api/client/messages. The
// identity is derived from the applicationId path parameter, which
// the client already knows.
import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { generateVoiceToken } from "../telephony/services/tokenService.js";

const router = Router();

router.get("/token", async (req: Request, res: Response) => {
  // Optional applicationId; if missing, anonymous identity
  const applicationIdRaw = typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : "";
  let identity: string;
  if (applicationIdRaw) {
    if (!/^[A-Za-z0-9._\-:]{6,128}$/.test(applicationIdRaw)) {
      return res.status(400).json({ error: "invalid applicationId" });
    }
    identity = `client-${applicationIdRaw}`;
  } else {
    // Anonymous landing-page caller
    const rand = crypto.randomBytes(4).toString("hex");
    identity = `client-anon-${rand}`;
  }

  const missingEnv = ["TWILIO_ACCOUNT_SID", "TWILIO_API_KEY", "TWILIO_API_SECRET", "TWILIO_VOICE_APP_SID"].filter((k) => !process.env[k]);
  if (missingEnv.length > 0) {
    return res.status(503).json({ error: "telephony_not_configured", missing: missingEnv });
  }

  // Count available staff so client UI can show "no advisors" guidance.
  // Same predicate as the TwiML handler: status=available, heartbeat <5min, twilio_identity present.
  let agentsAvailable = false;
  try {
    const { pool } = await import("../db.js");
    const r = await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM staff_presence
         WHERE status='available'
           AND last_heartbeat > now() - interval '5 minutes'
           AND twilio_identity IS NOT NULL`
    );
    agentsAvailable = Number(r.rows[0]?.n ?? 0) > 0;
  } catch {
    // Fail open: assume agents available; the call will go to voicemail if not.
    agentsAvailable = true;
  }

  try {
    const token = generateVoiceToken(identity);
    return res.status(200).json({ token, identity, agents_available: agentsAvailable });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "token_generation_failed" });
  }
});

export default router;
