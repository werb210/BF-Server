import crypto from "node:crypto";
import { Router } from "express";
import { pool } from "../db.js";
import { watchAuth, watchError } from "./security.js";
import { getWatchCallProvider } from "./provider.js";
import { encryptWatchPushToken } from "./pushTokenCrypto.js";

const router = Router();
router.use(watchAuth);

async function owned(req: any) {
  if (req.params.deviceId !== req.watch.deviceId) return null;
  const found = await pool.query(`SELECT id,staff_user_id,revoked_at FROM watch_devices WHERE id=$1 AND staff_user_id=$2`,
    [req.params.deviceId, req.watch.staffUserId]);
  return found.rows[0] || null;
}

router.put("/:deviceId", async (req: any, res) => {
  if (!await owned(req)) return watchError(req, res, 403, "forbidden", "Device does not belong to this session");
  const appVersion = typeof req.body?.appVersion === "string" ? req.body.appVersion.trim().slice(0, 40) : null;
  const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 100) : null;
  if (req.body?.platform !== undefined && req.body.platform !== "watchos")
    return watchError(req, res, 400, "invalid_request", "Platform must be watchos");
  const result = await pool.query(
    `UPDATE watch_devices SET app_version=COALESCE($2,app_version),name=COALESCE($3,name),updated_at=now(),last_seen_at=now()
      WHERE id=$1 AND revoked_at IS NULL RETURNING id AS "deviceId",platform,application,app_version AS "appVersion",
      created_at AS "createdAt",updated_at AS "updatedAt",last_seen_at AS "lastSeenAt",revoked_at AS "revokedAt"`,
    [req.params.deviceId, appVersion, name]);
  return res.json(result.rows[0]);
});

router.put("/:deviceId/push-token", async (req: any, res) => {
  if (!await owned(req)) return watchError(req, res, 403, "forbidden", "Device does not belong to this session");
  const { pushType, token, environment } = req.body || {};
  if (pushType !== "standard" || typeof token !== "string" || !/^[A-Fa-f0-9]{32,}$/.test(token) || !["sandbox", "production"].includes(environment))
    return watchError(req, res, 400, "invalid_request", "A standard APNs token and valid environment are required");
  await pool.query(
    `INSERT INTO watch_push_registrations(device_id,token_hash,token_ciphertext,push_type,environment)
     VALUES($1,$2,$3,'standard',$4) ON CONFLICT(device_id) DO UPDATE SET token_hash=$2,token_ciphertext=$3,
     push_type='standard',environment=$4,updated_at=now()`,
    [req.params.deviceId, crypto.createHash("sha256").update(token).digest("hex"), encryptWatchPushToken(token), environment]);
  return res.json({ registered: true, pushType: "standard", environment });
});

router.delete("/:deviceId/push-token", async (req: any, res) => {
  if (!await owned(req)) return watchError(req, res, 403, "forbidden", "Device does not belong to this session");
  await pool.query(`DELETE FROM watch_push_registrations WHERE device_id=$1`, [req.params.deviceId]);
  return res.status(204).send();
});

router.put("/:deviceId/standalone-routing", async (req: any, res) => {
  if (!await owned(req)) return watchError(req, res, 403, "forbidden", "Device does not belong to this session");
  if (typeof req.body?.enabled !== "boolean" || Object.prototype.hasOwnProperty.call(req.body || {}, "callbackNumber"))
    return watchError(req, res, 400, "invalid_request", "enabled must be boolean");
  const callback = await pool.query(
    `SELECT verified_callback_number,callback_verified_at FROM users WHERE id=$1`, [req.watch.staffUserId]);
  const verified = Boolean(callback.rows[0]?.verified_callback_number && callback.rows[0]?.callback_verified_at);
  if (req.body.enabled && !verified) return watchError(req, res, 409, "callback_not_verified", "A verified cellular callback number is required");
  await pool.query(`UPDATE watch_devices SET standalone_routing_enabled=$2,updated_at=now() WHERE id=$1`,
    [req.params.deviceId, req.body.enabled]);
  return res.json({ enabled: req.body.enabled, verifiedCallback: verified });
});

router.delete("/:deviceId/session", async (req: any, res) => {
  if (!await owned(req)) return watchError(req, res, 403, "forbidden", "Device does not belong to this session");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const calls = await client.query(`SELECT provider_call_sid FROM watch_call_bridges WHERE device_id=$1 AND status NOT IN ('ended','failed') FOR UPDATE`, [req.params.deviceId]);
    for (const call of calls.rows) if (call.provider_call_sid) await getWatchCallProvider().cancel(call.provider_call_sid);
    await client.query(`UPDATE watch_call_bridges SET status='ended',version=version+1,ended_at=now(),updated_at=now() WHERE device_id=$1 AND status NOT IN ('ended','failed')`, [req.params.deviceId]);
    await client.query(`UPDATE watch_sessions SET revoked_at=COALESCE(revoked_at,now()),updated_at=now() WHERE device_id=$1`, [req.params.deviceId]);
    await client.query(`DELETE FROM watch_push_registrations WHERE device_id=$1`, [req.params.deviceId]);
    await client.query(`UPDATE watch_devices SET revoked_at=COALESCE(revoked_at,now()),standalone_routing_enabled=false,updated_at=now() WHERE id=$1`, [req.params.deviceId]);
    await client.query("COMMIT");
    return res.status(204).send();
  } catch { await client.query("ROLLBACK"); return watchError(req, res, 503, "provider_unavailable", "Unable to safely revoke device", true); }
  finally { client.release(); }
});

export default router;
