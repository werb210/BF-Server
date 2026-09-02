import crypto from "node:crypto";
import { Router, urlencoded } from "express";
import twilio from "twilio";
import { pool } from "../db.js";
import { twilioWebhookValidation } from "../middleware/twilioWebhookValidation.js";
import { getWatchCallProvider } from "./provider.js";
import { allowedLine, watchAuth, watchError } from "./security.js";

const router = Router();
const normalizeE164 = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (/^\+[1-9]\d{7,14}$/.test(value)) return value;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
};
const present = (r: any) => ({ callId: r.id, status: r.status, version: r.version,
  updatedAt: r.updated_at, error: r.error_code ? { code: r.error_code } : null });

router.post("/calls", watchAuth, async (req: any, res) => {
  const key = req.header("idempotency-key")?.trim();
  if (!key || key.length > 200) return watchError(req, res, 400, "invalid_request", "Idempotency-Key is required");
  const destination = normalizeE164(req.body?.destination);
  if (!destination) return watchError(req, res, 400, "invalid_destination", "Destination must be a valid E.164 number");
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "callbackNumber"))
    return watchError(req, res, 400, "invalid_request", "Callback number is server controlled");
  const requestedLine = String(req.body?.line || "").toUpperCase();
  const line = allowedLine(req, requestedLine);
  if (!line) return watchError(req, res, ["BF", "BI", "SLF"].includes(requestedLine) ? 403 : 400,
    ["BF", "BI", "SLF"].includes(requestedLine) ? "forbidden" : "invalid_request", "Line is invalid or not permitted");
  const contactId = typeof req.body?.contactId === "string" && /^[0-9a-f-]{36}$/i.test(req.body.contactId) ? req.body.contactId : null;
  const callback = await pool.query(`SELECT verified_callback_number,callback_verified_at FROM users WHERE id=$1`, [req.watch.staffUserId]);
  const callbackNumber = normalizeE164(callback.rows[0]?.verified_callback_number);
  if (!callbackNumber || !callback.rows[0]?.callback_verified_at)
    return watchError(req, res, 409, "callback_not_verified", "A verified cellular callback number is required");
  const requestHash = crypto.createHash("sha256").update(JSON.stringify({ destination, line, contactId })).digest("hex");
  const inserted = await pool.query(
    `INSERT INTO watch_call_bridges(staff_user_id,device_id,destination,callback_number,line,contact_id,status,idempotency_key,request_hash)
     VALUES($1,$2,$3,$4,$5,$6,'requesting',$7,$8) ON CONFLICT(staff_user_id,idempotency_key) DO NOTHING RETURNING *`,
    [req.watch.staffUserId, req.watch.deviceId, destination, callbackNumber, line, contactId, key, requestHash]);
  if (!inserted.rows[0]) {
    const prior = await pool.query(`SELECT * FROM watch_call_bridges WHERE staff_user_id=$1 AND idempotency_key=$2`, [req.watch.staffUserId, key]);
    if (prior.rows[0]?.request_hash !== requestHash) return watchError(req, res, 409, "conflict", "Idempotency key was already used for another request");
    return res.json(present(prior.rows[0]));
  }
  const call = inserted.rows[0];
  try {
    const providerSid = await getWatchCallProvider().createCallback({ callId: call.id, callbackNumber });
    const updated = await pool.query(
      `UPDATE watch_call_bridges SET provider_call_sid=$2,status='waitingForCallback',version=version+1,updated_at=now()
       WHERE id=$1 RETURNING *`, [call.id, providerSid]);
    return res.status(201).json(present(updated.rows[0]));
  } catch {
    await pool.query(`UPDATE watch_call_bridges SET status='failed',error_code='provider_unavailable',version=version+1,updated_at=now(),ended_at=now() WHERE id=$1`, [call.id]);
    return watchError(req, res, 503, "provider_unavailable", "Calling provider is temporarily unavailable", true);
  }
});

router.get("/calls/:callId", watchAuth, async (req: any, res) => {
  const found = await pool.query(`SELECT * FROM watch_call_bridges WHERE id=$1 AND staff_user_id=$2`, [req.params.callId, req.watch.staffUserId]);
  if (!found.rows[0]) return watchError(req, res, 404, "not_found", "Call was not found");
  return res.json(present(found.rows[0]));
});

router.delete("/calls/:callId", watchAuth, async (req: any, res) => {
  const found = await pool.query(`SELECT * FROM watch_call_bridges WHERE id=$1 AND staff_user_id=$2`, [req.params.callId, req.watch.staffUserId]);
  const call = found.rows[0];
  if (!call) return watchError(req, res, 404, "not_found", "Call was not found");
  if (["ended", "failed"].includes(call.status)) return res.json(present(call));
  try {
    if (call.provider_call_sid) await getWatchCallProvider().cancel(call.provider_call_sid);
  } catch { return watchError(req, res, 503, "provider_unavailable", "Provider could not cancel the call", true); }
  const updated = await pool.query(
    `UPDATE watch_call_bridges SET status='ended',version=version+1,updated_at=now(),ended_at=now()
     WHERE id=$1 AND status NOT IN ('ended','failed') RETURNING *`, [call.id]);
  return res.json(present(updated.rows[0] || call));
});

// Twilio-authenticated endpoints. Destination is loaded from the database and is
// never accepted from provider/client request parameters.
router.post("/provider/:callId/twiml", urlencoded({ extended: false }), twilioWebhookValidation, async (req, res) => {
  const found = await pool.query(`SELECT destination FROM watch_call_bridges WHERE id=$1 AND status NOT IN ('ended','failed')`, [req.params.callId]);
  if (!found.rows[0]) return res.status(404).type("text/xml").send("<Response><Hangup/></Response>");
  await pool.query(`UPDATE watch_call_bridges SET status='bridging',version=version+1,updated_at=now() WHERE id=$1 AND status IN ('requesting','waitingForCallback')`, [req.params.callId]);
  const response = new twilio.twiml.VoiceResponse();
  (response.dial() as any).number(found.rows[0].destination);
  return res.type("text/xml").send(response.toString());
});

router.post("/provider/:callId/status", urlencoded({ extended: false }), twilioWebhookValidation, async (req, res) => {
  const statusMap: Record<string, string> = { initiated: "waitingForCallback", ringing: "ringing", "in-progress": "connected", completed: "ended", busy: "failed", failed: "failed", "no-answer": "failed", canceled: "ended" };
  const next = statusMap[String(req.body?.CallStatus || "")];
  if (next) await pool.query(
    `UPDATE watch_call_bridges SET status=$2,version=version+1,updated_at=now(),
      ended_at=CASE WHEN $2 IN ('ended','failed') THEN now() ELSE ended_at END
     WHERE id=$1 AND status NOT IN ('ended','failed')
       AND CASE status WHEN 'requesting' THEN 1 WHEN 'waitingForCallback' THEN 2 WHEN 'bridging' THEN 3
         WHEN 'ringing' THEN 4 WHEN 'connected' THEN 5 ELSE 6 END
         <= CASE $2 WHEN 'requesting' THEN 1 WHEN 'waitingForCallback' THEN 2 WHEN 'bridging' THEN 3
         WHEN 'ringing' THEN 4 WHEN 'connected' THEN 5 ELSE 6 END`, [req.params.callId, next]);
  return res.status(204).send();
});

export default router;
