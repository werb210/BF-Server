import crypto from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../db.js";
import { auth } from "../middleware/auth.js";
import { hashWatchSecret, issueWatchAccessToken, newWatchSecret, watchError } from "./security.js";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js"; // BF_SERVER_AZURE_XFF_PORT_v183

const router = Router();
// BF_SERVER_AZURE_XFF_PORT_v183 - this was the only limiter in the repo with no
// keyGenerator. The library default validates req.ip, Azure hands it
// "199.119.235.200:52995", and it threw ERR_ERL_INVALID_IP_ADDRESS on the watch
// enrollment and link routes.
const limiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: rateLimitKeyFromRequest,
  handler: (req, res) => watchError(req, res, 429, "rate_limited", "Too many authentication attempts", true) });

// BF_SERVER_WATCH_CODE_TTL_v342
// Five minutes was right when the only delivery was WCSession transferUserInfo:
// a single fire-and-forget message, sent while both apps were awake, arriving in
// seconds or never. boreal-dialer-ios v341 replaced that with a durable
// application context, which the system holds and delivers whenever the Watch
// NEXT becomes available - minutes or hours later, including after the Watch app
// is installed for the first time. That is the case the old window could never
// cover, and it is exactly the case that matters: the phone mints a code before
// the Watch app exists, and the code has to survive until it does.
//
// Why 24 hours is safe here: the code is single-use (used_at is set inside the
// same transaction that consumes it), stored only as a hash, mintable only with
// a staff bearer token, and the link route is rate limited to 10 attempts a
// minute against a 100,000,000 space. Lengthening the window does not widen a
// guessing attack in any practical sense; it removes a race the client cannot
// win on its own.
const ENROLLMENT_CODE_TTL_MS = 24 * 60 * 60_000;

// The authenticated iPhone requests a single-use enrollment code.
router.post("/enrollment", auth, limiter, async (req: any, res) => {
  const staffUserId = req.user?.userId || req.user?.id || req.user?.sub;
  if (!staffUserId || String(req.user?.role || "").toLowerCase() === "client")
    return watchError(req, res, 403, "forbidden", "Staff authentication required");
  const code = crypto.randomInt(0, 100_000_000).toString().padStart(8, "0");
  const expiresAt = new Date(Date.now() + ENROLLMENT_CODE_TTL_MS); // BF_SERVER_WATCH_CODE_TTL_v342
  await pool.query(`INSERT INTO watch_link_codes(staff_user_id,code_hash,expires_at) VALUES($1,$2,$3)`,
    [staffUserId, hashWatchSecret(code), expiresAt]);
  return res.status(201).json({ oneTimeCode: code, expiresAt: expiresAt.toISOString() });
});

router.post("/link", limiter, async (req, res) => {
  const code = typeof req.body?.oneTimeCode === "string" ? req.body.oneTimeCode.trim() : "";
  const device = req.body?.device;
  if (!/^\d{8}$/.test(code) || device?.platform !== "watchos")
    return watchError(req, res, 400, "invalid_request", "A valid enrollment code and watchOS device are required");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const linked = await client.query(
      `UPDATE watch_link_codes SET used_at=now() WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now()
       RETURNING staff_user_id`, [hashWatchSecret(code)]);
    if (!linked.rows[0]) {
      const known = await client.query(`SELECT expires_at,used_at FROM watch_link_codes WHERE code_hash=$1 LIMIT 1`, [hashWatchSecret(code)]);
      await client.query("ROLLBACK");
      if (known.rows[0] && !known.rows[0].used_at && new Date(known.rows[0].expires_at).getTime() <= Date.now())
        return watchError(req, res, 401, "expired_code", "Enrollment code has expired");
      return watchError(req, res, 401, "unauthenticated", "Enrollment code is invalid or already used");
    }
    const created = await client.query(
      `INSERT INTO watch_devices(staff_user_id,name) VALUES($1,$2) RETURNING id`,
      [linked.rows[0].staff_user_id, typeof device.name === "string" ? device.name.slice(0, 100) : null]);
    const sessionId = crypto.randomUUID();
    const refreshToken = newWatchSecret();
    await client.query(
      `INSERT INTO watch_sessions(id,device_id,refresh_token_hash,expires_at,refresh_expires_at)
       VALUES($1,$2,$3,now()+interval '15 minutes',now()+interval '30 days')`,
      [sessionId, created.rows[0].id, hashWatchSecret(refreshToken)]);
    await client.query("COMMIT");
    const access = issueWatchAccessToken(linked.rows[0].staff_user_id, created.rows[0].id, sessionId);
    return res.status(201).json({ ...access, expiresAt: access.expiresAt.toISOString(), refreshToken, deviceId: created.rows[0].id });
  } catch (error) {
    await client.query("ROLLBACK");
    return watchError(req, res, 503, "server_unavailable", "Unable to link Watch", true);
  } finally { client.release(); }
});

router.post("/refresh", limiter, async (req, res) => {
  const oldToken = typeof req.body?.refreshToken === "string" ? req.body.refreshToken : "";
  if (!oldToken) return watchError(req, res, 400, "invalid_request", "Refresh token is required");
  const nextToken = newWatchSecret();
  const rotated = await pool.query(
    `UPDATE watch_sessions s SET refresh_token_hash=$2, rotated_at=now(), updated_at=now(), expires_at=now()+interval '15 minutes'
       FROM watch_devices d WHERE s.device_id=d.id AND s.refresh_token_hash=$1 AND s.revoked_at IS NULL
       AND s.refresh_expires_at>now() AND d.revoked_at IS NULL
       RETURNING s.id,s.device_id,d.staff_user_id,s.expires_at`,
    [hashWatchSecret(oldToken), hashWatchSecret(nextToken)]);
  const row = rotated.rows[0];
  if (!row) return watchError(req, res, 401, "unauthenticated", "Refresh token is invalid, expired, or revoked");
  const access = issueWatchAccessToken(row.staff_user_id, row.device_id, row.id);
  return res.json({ ...access, expiresAt: access.expiresAt.toISOString(), refreshToken: nextToken, deviceId: row.device_id });
});

export default router;
