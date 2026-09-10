// BF_SERVER_BLOCK_53_v1 -- client mini-portal voice token endpoint.
// Identity scheme: `client-<applicationId>`. This lets the TwiML
// webhook distinguish client-initiated calls from staff-initiated
// calls and route the former to staff via <Dial><Client>...</Client>.
//
// Auth: an applicationId identity REQUIRES a valid client OTP token whose
// phone is on that application (BF_SERVER_CLIENT_VOICE_OWNERSHIP_v1). The
// anonymous landing-page path below stays open - it asserts nothing about
// who is calling.
import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { generateVoiceToken } from "../telephony/services/tokenService.js";

const router = Router();

// BF_SERVER_CLIENT_VOICE_OWNERSHIP_v1
// Mirrors the ownership predicate in src/routes/client/index.ts: membership is
// application_contacts (applicant + partner + guarantor) UNION the legacy
// applications.contact_id, so a partner on a joint file is not locked out.
// Unlike that guard, this one FAILS CLOSED - a voice identity is an assertion
// of who you are to a human being, not a read of your own file.
async function callerOwnsApplication(req: Request, applicationId: string): Promise<boolean> {
  const auth = req.headers?.authorization;
  if (!auth || typeof auth !== "string" || !auth.startsWith("Bearer ")) return false;
  const secret = process.env.JWT_SECRET;
  if (!secret) return false;

  let phone10 = "";
  try {
    const jwt = (await import("jsonwebtoken")).default;
    const decoded = jwt.verify(auth.slice(7), secret) as Record<string, unknown>;
    phone10 = String(typeof decoded.phone === "string" ? decoded.phone : "")
      .replace(/[^0-9]/g, "")
      .slice(-10);
  } catch {
    return false;
  }
  if (!phone10) return false;

  try {
    const { pool } = await import("../db.js");
    const r = await pool.query<{ n: string }>(
      `WITH app_phones AS (
         SELECT right(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'),10) AS p10
           FROM application_contacts ac
           JOIN contacts c ON c.id = ac.contact_id
          WHERE ac.application_id::text = ($1)::text
         UNION
         SELECT right(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'),10) AS p10
           FROM applications a
           JOIN contacts c ON c.id = a.contact_id
          WHERE a.id::text = ($1)::text
       )
       SELECT COUNT(*)::text AS n FROM app_phones WHERE p10 = $2`,
      [applicationId, phone10],
    );
    return Number(r.rows[0]?.n ?? 0) > 0;
  } catch (err: any) {
    console.error("client_voice_ownership_check_failed", { message: err?.message || String(err) });
    return false;
  }
}


router.get("/token", async (req: Request, res: Response) => {
  // Optional applicationId; if missing, anonymous identity
  const applicationIdRaw = typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : "";
  let identity: string;
  if (applicationIdRaw) {
    if (!/^[A-Za-z0-9._\-:]{6,128}$/.test(applicationIdRaw)) {
      return res.status(400).json({ error: "invalid applicationId" });
    }
    // BF_SERVER_CLIENT_VOICE_OWNERSHIP_v1
    // This route is mounted outside src/routes/client/index.ts, so the guard
    // there - written to stop a client pivoting to an application that is not
    // theirs - never sees this request. Without the check below, any known or
    // guessed application UUID mints a Twilio identity for that applicant, and
    // BF_SERVER_CLIENT_APP_CALLER_v1 now renders that as their real name on
    // the staff incoming-call toast.
    const owns = await callerOwnsApplication(req, applicationIdRaw);
    if (!owns) {
      return res.status(403).json({ error: "not_your_application" });
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
