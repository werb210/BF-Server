// BF_SERVER_SENDGRID_WEBHOOK_v1 - PUBLIC SendGrid Event Webhook receiver.
// Writes delivered/open/click/bounce/spam/unsubscribe to the contact timeline and
// flips marketing_opt_out on bounce/spam/unsubscribe (CASL suppression). Verifies
// the ECDSA signature when SENDGRID_WEBHOOK_PUBLIC_KEY is set. Raw body required.
import { Router } from "express";
import express from "express";
import crypto from "crypto";
import { pool } from "../db.js";

const router = Router();
router.use(express.raw({ type: "*/*", limit: "2mb" }));

// BF_SERVER_EMAIL_HARDENING_v1 - only PERMANENT signals suppress. "dropped"
// (already on SendGrid suppression list) and "blocked"-type soft bounces no
// longer flip marketing_opt_out; previously every greylist/mailbox-full event
// permanently shrank the audience blast after blast.
const SUPPRESS = new Set(["spamreport", "unsubscribe", "group_unsubscribe"]);
function isSuppressEvent(event: string, ev: any): boolean {
  if (SUPPRESS.has(event)) return true;
  if (event === "bounce" && String(ev?.type ?? "bounce") === "bounce") return true; // hard bounce only
  return false;
}

function verify(rawBody: Buffer, signature: string, timestamp: string): boolean {
  const key = process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
  if (!key) return true; // not configured -> accept (configure to enforce)
  try {
    const pubPem = `-----BEGIN PUBLIC KEY-----\n${key}\n-----END PUBLIC KEY-----\n`;
    const v = crypto.createVerify("sha256");
    v.update(timestamp + rawBody.toString("utf8"));
    v.end();
    return v.verify(pubPem, signature, "base64");
  } catch {
    return false;
  }
}

router.post("/", async (req: any, res: any) => {
  // BF_SERVER_EMAIL_HARDENING_v1 - prefer the true raw bytes captured by the
  // global json parser (req.rawBody); the router-level raw parser never runs
  // because the stream is already consumed upstream.
  const raw: Buffer = Buffer.isBuffer((req as any).rawBody) ? (req as any).rawBody : Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? []));
  const sig = String(req.header("X-Twilio-Email-Event-Webhook-Signature") || "");
  const ts = String(req.header("X-Twilio-Email-Event-Webhook-Timestamp") || "");
  if (!verify(raw, sig, ts)) { res.status(403).json({ ok: false }); return; }
  let events: any[] = [];
  try { events = JSON.parse(raw.toString("utf8")); } catch { res.status(200).json({ ok: true }); return; }
  for (const ev of Array.isArray(events) ? events : []) {
    try {
      const email = String(ev?.email || "").toLowerCase();
      const event = String(ev?.event || "");
      const contactId = ev?.contact_id ? String(ev.contact_id) : null;
      let cid = contactId;
      if (!cid && email) {
        const r = await pool.query<{ id: string }>(`SELECT id FROM contacts WHERE lower(email) = $1 ORDER BY created_at LIMIT 1`, [email]);
        cid = r.rows[0]?.id ?? null;
      }
      if (!cid) continue;
      await pool.query(
        `INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1, $2, $3)`,
        [cid, "email_" + (event || "event"), JSON.stringify({ sg_event_id: ev?.sg_event_id ?? null, email, event, ts: ev?.timestamp ?? null })],
      );
      if (isSuppressEvent(event, ev)) {
        await pool.query(`UPDATE contacts SET marketing_opt_out = true, updated_at = now() WHERE id = $1`, [cid]);
      }
      // BF_SERVER_BLOCK_v790 - attribute sequence email opens/clicks.
      const seqSendId = ev?.seq_send_id ? String(ev.seq_send_id) : null;
      if (seqSendId && event === "open") await pool.query(`UPDATE sequence_sends SET opened_at = COALESCE(opened_at, now()) WHERE id = $1`, [seqSendId]).catch(() => {});
      else if (seqSendId && event === "click") await pool.query(`UPDATE sequence_sends SET clicked_at = COALESCE(clicked_at, now()) WHERE id = $1`, [seqSendId]).catch(() => {});
      // BF_SERVER_TEMPLATE_ANALYTICS_v1 - attribute per-template email opens/clicks via the tse_id custom arg.
      const tseId = ev?.tse_id ? String(ev.tse_id) : null;
      if (tseId && event === "open") await pool.query(`UPDATE template_send_events SET opened_at = COALESCE(opened_at, now()) WHERE id = $1`, [tseId]).catch(() => {});
      else if (tseId && event === "click") await pool.query(`UPDATE template_send_events SET clicked_at = COALESCE(clicked_at, now()) WHERE id = $1`, [tseId]).catch(() => {});
    } catch { /* skip bad event */ }
  }
  res.status(200).json({ ok: true });
});

export default router;
