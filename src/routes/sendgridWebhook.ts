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

// BF_SERVER_SENDGRID_WEBHOOK_VISIBILITY_v20 - this endpoint had no logging of
// any kind, and BF-Server mounts no HTTP request logger, so a rejected webhook
// produced literally nothing in the log stream. SendGrid's "Test Integration"
// button was therefore unverifiable from our side: pass and fail looked
// identical. Nothing secret is logged - not the key, not the signature.
function verify(rawBody: Buffer, signature: string, timestamp: string): boolean {
  const key = process.env.SENDGRID_WEBHOOK_PUBLIC_KEY;
  if (!key) {
    console.warn("[sendgrid-webhook] SENDGRID_WEBHOOK_PUBLIC_KEY is not set - accepting unsigned posts");
    return true; // not configured -> accept (configure to enforce)
  }
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
  if (!verify(raw, sig, ts)) {
    // BF_SERVER_SENDGRID_WEBHOOK_VISIBILITY_v20 - say WHY, in terms that
    // separate the three real causes: a wrong key, a missing header, or a body
    // that never reached us as raw bytes.
    console.error("[sendgrid-webhook] REJECTED 403 signature verification failed", {
      keyConfigured: Boolean(process.env.SENDGRID_WEBHOOK_PUBLIC_KEY),
      keyLength: String(process.env.SENDGRID_WEBHOOK_PUBLIC_KEY ?? "").length,
      signatureHeaderPresent: sig.length > 0,
      timestampHeaderPresent: ts.length > 0,
      rawBodyBytes: raw.length,
      rawBodyFromVerifyHook: Buffer.isBuffer((req as any).rawBody),
    });
    res.status(403).json({ ok: false });
    return;
  }
  let events: any[] = [];
  try { events = JSON.parse(raw.toString("utf8")); } catch { res.status(200).json({ ok: true }); return; }
  // BF_SERVER_SENDGRID_WEBHOOK_VISIBILITY_v20
  let resolved = 0;
  const seenTypes = new Set<string>();
  for (const ev of Array.isArray(events) ? events : []) {
    try {
      const email = String(ev?.email || "").toLowerCase();
      const event = String(ev?.event || "");
      if (event) seenTypes.add(event);
      const contactId = ev?.contact_id ? String(ev.contact_id) : null;
      let cid = contactId;
      if (!cid && email) {
        const r = await pool.query<{ id: string }>(`SELECT id FROM contacts WHERE lower(email) = $1 ORDER BY created_at LIMIT 1`, [email]);
        cid = r.rows[0]?.id ?? null;
      }
      if (!cid) continue;
      resolved += 1;
      // BF_SERVER_EMAIL_LINK_CLICKS_v19 - carry the clicked URL. The timeline
      // query already renders payload->>'url' as the row body for email_click,
      // so it stayed blank purely because nothing ever wrote it.
      const clickedUrl = typeof ev?.url === "string" && ev.url ? String(ev.url) : null;
      await pool.query(
        `INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1, $2, $3)`,
        [cid, "email_" + (event || "event"), JSON.stringify({
          sg_event_id: ev?.sg_event_id ?? null, email, event, ts: ev?.timestamp ?? null,
          url: clickedUrl, url_offset: ev?.url_offset ?? null,
        })],
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
      // BF_SERVER_EMAIL_LINK_CLICKS_v19 - per-URL ledger. template_id and silo are
      // looked up from the send ledger when the tse_id custom arg is present; a
      // click with no template still records, it just cannot be rolled up by template.
      if (event === "click" && clickedUrl) {
        try {
          let templateId: string | null = null;
          let silo = "BF";
          if (tseId) {
            const t = await pool.query<{ template_id: string; silo: string }>(
              `SELECT template_id, silo FROM template_send_events WHERE id = $1`, [tseId]);
            templateId = t.rows[0]?.template_id ?? null;
            silo = t.rows[0]?.silo ?? "BF";
          }
          await pool.query(
            `INSERT INTO email_link_clicks (contact_id, template_id, tse_id, silo, url) VALUES ($1,$2,$3,$4,$5)`,
            [cid, templateId, tseId, silo, clickedUrl],
          );
        } catch { /* click tracking must never break event ingestion */ }
      }
    } catch { /* skip bad event */ }
  }
  // BF_SERVER_SENDGRID_WEBHOOK_VISIBILITY_v20 - one line per accepted batch, so
  // a successful Test Integration is visible too. `contactsResolved` separates
  // "signature is fine" from "these were synthetic addresses we could not map",
  // which is what SendGrid's test events always are.
  console.log("[sendgrid-webhook] accepted", {
    events: Array.isArray(events) ? events.length : 0,
    contactsResolved: resolved,
    types: Array.from(seenTypes).join(",") || "none",
  });
  res.status(200).json({ ok: true });
});

export default router;
