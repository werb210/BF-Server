import crypto from "node:crypto";
import { Router, urlencoded } from "express";
import twilio from "twilio";
import { pool } from "../db.js";
import { twilioWebhookValidation } from "../middleware/twilioWebhookValidation.js";
import { getWatchCallProvider } from "./provider.js";
import { allowedLine, watchAuth, watchError } from "./security.js";
import { safeHandler } from "../middleware/safeHandler.js"; // BF_SERVER_v789_SAFE_HANDLERS
import { getBaseUrl } from "../voice/twilioClient.js"; // BF_SERVER_v820_WATCH_CALLS
import { SCREEN_GATHER_TIMEOUT_SECONDS, contactForPhone, spokenNumber } from "../voice/watchCellFallback.js"; // BF_SERVER_v820_WATCH_CALLS

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

router.post("/calls", watchAuth, safeHandler(async (req: any, res) => {
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
  } catch (err) {
    // BF_SERVER_WATCH_CALL_ERRORS_v370 - say which problem it is. "Temporarily
    // unavailable" hid a missing caller ID and Twilio rejections alike.
    const raw = err instanceof Error ? err.message : String(err);
    const notConfigured = raw === "provider_not_configured";
    const code = notConfigured ? "provider_not_configured" : "provider_unavailable";
    const message = notConfigured
      ? "No outbound caller ID is configured on the server (TWILIO_CALLER_ID)"
      : `Calling provider rejected the call: ${raw.slice(0, 160)}`;
    console.warn("[watch_call_failed]", { callId: call.id, code, raw: raw.slice(0, 300) });
    await pool.query(`UPDATE watch_call_bridges SET status='failed',error_code=$2,version=version+1,updated_at=now(),ended_at=now() WHERE id=$1`, [call.id, code]);
    return watchError(req, res, 503, code, message, !notConfigured);
  }
}));

router.get("/calls/:callId", watchAuth, safeHandler(async (req: any, res) => {
  const found = await pool.query(`SELECT * FROM watch_call_bridges WHERE id=$1 AND staff_user_id=$2`, [req.params.callId, req.watch.staffUserId]);
  if (!found.rows[0]) return watchError(req, res, 404, "not_found", "Call was not found");
  return res.json(present(found.rows[0]));
}));

router.delete("/calls/:callId", watchAuth, safeHandler(async (req: any, res) => {
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
}));

// Twilio-authenticated endpoints. Destination is loaded from the database and is
// never accepted from provider/client request parameters.
// BF_SERVER_v820_WATCH_CALLS - the staff cell answers first. If it went to the cell's voicemail, bridging straight
// away connected the client to the staff member's voicemail greeting. The cell leg is now screened: "Boreal call to
// {contact}. Press 1 to connect." Only a 1 bridges to the destination; anything else / silence hangs up and the
// bridge is marked failed (callback_not_accepted).
router.post("/provider/:callId/twiml", urlencoded({ extended: false }), twilioWebhookValidation, safeHandler(async (req, res) => {
  const found = await pool.query(`SELECT destination,contact_id FROM watch_call_bridges WHERE id=$1 AND status NOT IN ('ended','failed')`, [req.params.callId]);
  if (!found.rows[0]) return res.status(404).type("text/xml").send("<Response><Hangup/></Response>");
  const label = await destinationLabel(found.rows[0].contact_id, found.rows[0].destination);
  const response: any = new twilio.twiml.VoiceResponse(); // BF_SERVER_v820_WATCH_CALLS - local twilio typings omit gather/hangup
  const gather = response.gather({
    input: ["dtmf"], numDigits: 1, timeout: SCREEN_GATHER_TIMEOUT_SECONDS, actionOnEmptyResult: true,
    action: `${getBaseUrl()}/api/telephony/watch/provider/${encodeURIComponent(req.params.callId)}/accept`, method: "POST",
  } as any);
  gather.say({ voice: "Polly.Joanna" }, `Boreal call to ${label}. Press 1 to connect.`);
  response.hangup();
  return res.type("text/xml").send(response.toString());
}));

router.post("/provider/:callId/accept", urlencoded({ extended: false }), twilioWebhookValidation, safeHandler(async (req, res) => {
  const response: any = new twilio.twiml.VoiceResponse(); // BF_SERVER_v820_WATCH_CALLS - local twilio typings omit gather/hangup
  const digits = String(req.body?.Digits ?? "").trim();
  if (digits !== "1") {
    await pool.query(
      `UPDATE watch_call_bridges SET status='failed',error_code='callback_not_accepted',version=version+1,updated_at=now(),ended_at=now()
        WHERE id=$1 AND status NOT IN ('ended','failed')`, [req.params.callId]);
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }
  const found = await pool.query(`SELECT destination FROM watch_call_bridges WHERE id=$1 AND status NOT IN ('ended','failed')`, [req.params.callId]);
  if (!found.rows[0]) return res.status(404).type("text/xml").send("<Response><Hangup/></Response>");
  await pool.query(`UPDATE watch_call_bridges SET status='bridging',version=version+1,updated_at=now() WHERE id=$1 AND status IN ('requesting','waitingForCallback','ringing')`, [req.params.callId]);
  // BF_SERVER_v821_DIALER - the bridge was a bare <Dial><Number>: never recorded, so a Watch call never reached the AI
  // summary. Record it like a conference call: a call record (wb_<bridge id>) with the staff leg under this cell
  // call's CallSid, the notice to both sides (the client hears it on answer, before being connected), dual channel.
  const destination = String(found.rows[0].destination);
  const rec = await openBridgeRecord(req.params.callId, destination, String(req.body?.CallSid ?? "").trim() || null);
  const { recordingDialAttrs, consentUrl, RECORDING_NOTICE } = await import("../voice/recordedDial.js");
  if (rec) response.say({ voice: "Polly.Joanna" }, RECORDING_NOTICE);
  const dial = response.dial({ ...recordingDialAttrs(rec) } as any) as any;
  if (rec) dial.number({ url: consentUrl(), method: "POST" }, destination);
  else dial.number(destination);
  return res.type("text/xml").send(response.toString());
}));

// BF_SERVER_v821_DIALER - the call record a bridge's recording is filed under. Null = not recorded (logged).
async function openBridgeRecord(bridgeId: string, destination: string, cellCallSid: string | null): Promise<string | null> {
  const { openCallRecord, bridgeRecordName } = await import("../voice/recordedDial.js");
  let staffUserId: string | null = null;
  let contactId: string | null = null;
  let line = "BF";
  try {
    const r = await pool.query(`SELECT staff_user_id::text AS staff_user_id, contact_id::text AS contact_id, line FROM watch_call_bridges WHERE id=$1`, [bridgeId]);
    staffUserId = r.rows[0]?.staff_user_id ?? null;
    contactId = r.rows[0]?.contact_id ?? null;
    line = r.rows[0]?.line || "BF";
  } catch (err) {
    console.warn("[watch_call] bridge record lookup failed", { message: err instanceof Error ? err.message : String(err) });
  }
  if (!contactId) contactId = (await contactForPhone(pool, destination))?.id ?? null;
  return openCallRecord(pool, {
    friendlyName: bridgeRecordName(bridgeId), direction: "outbound", silo: line, contactId, createdByUserId: staffUserId,
    participants: [{ kind: "staff", identity: staffUserId, callSid: cellCallSid }, { kind: "pstn", phone: destination }],
  });
}

// BF_SERVER_v820_WATCH_CALLS - what the screen names: the CRM contact, else the contact matching the number, else digits.
async function destinationLabel(contactId: unknown, destination: string): Promise<string> {
  if (typeof contactId === "string" && contactId) {
    try {
      const r = await pool.query(
        `SELECT NULLIF(TRIM(COALESCE(NULLIF(TRIM(name), ''), TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')))), '') AS name
           FROM contacts WHERE id::text=$1 LIMIT 1`, [contactId]);
      if (r.rows[0]?.name) return String(r.rows[0].name);
    } catch (err) {
      console.warn("[watch_call] contact name lookup failed", { message: err instanceof Error ? err.message : String(err) });
    }
  }
  const byPhone = await contactForPhone(pool, destination);
  return byPhone?.name || spokenNumber(destination);
}

router.post("/provider/:callId/status", urlencoded({ extended: false }), twilioWebhookValidation, safeHandler(async (req, res) => {
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
  // BF_SERVER_v821_DIALER - the bridge's call record (if it was recorded) ends with the bridge.
  if (next === "ended" || next === "failed") {
    const { closeCallRecord, bridgeRecordName } = await import("../voice/recordedDial.js");
    await closeCallRecord(pool, bridgeRecordName(req.params.callId));
  }
  return res.status(204).send();
}));

export default router;
