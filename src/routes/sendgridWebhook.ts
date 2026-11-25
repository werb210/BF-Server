// BF_SERVER_SENDGRID_WEBHOOK_v1 - PUBLIC SendGrid Event Webhook receiver.
// Writes delivered/open/click/bounce/spam/unsubscribe to the contact timeline and
// flips marketing_opt_out on bounce/spam/unsubscribe (CASL suppression). Verifies
// the ECDSA signature against SENDGRID_WEBHOOK_PUBLIC_KEY (rejects when unset). Raw body required.
import { Router } from "express";
import express from "express";
import crypto from "crypto";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js"; // BF_SERVER_v789_SAFE_HANDLERS
import { parseFlowJobId } from "../flows/flowEngine.js"; // BF_SERVER_CRM_FLOWS_v1

const router = Router();
router.use(express.raw({ type: "*/*", limit: "2mb" }));

// BF_SERVER_EMAIL_HARDENING_v1 - only PERMANENT signals suppress. "dropped"
// (already on SendGrid suppression list) and "blocked"-type soft bounces no
// longer flip marketing_opt_out; previously every greylist/mailbox-full event
// permanently shrank the audience blast after blast.
const SUPPRESS = new Set(["spamreport", "unsubscribe", "group_unsubscribe"]);
// BF_SERVER_v786_WORKFLOW_GRAPH - SendGrid event -> automation trigger.
export const SENDGRID_TRIGGERS: Record<string, string> = {
  open: "email.opened", click: "email.clicked", bounce: "email.bounced",
  unsubscribe: "email.unsubscribed", group_unsubscribe: "email.unsubscribed",
};
// BF_SERVER_BI_SENDGRID_FORWARD_v1 - Boreal Risk Management (BI-Server) mail shares this SendGrid account and its one
// Event Webhook points here, so BI's opens, clicks and bounces never reached BI-Server: its email flows showed 0 opened
// and 0 clicked, never moved anyone on, and never made a call task. BI events carry bi_mkt=1 (or a BI flow job id).
// The batch is passed on to BI-Server byte for byte with SendGrid's signature headers (BI verifies the same key), and
// BF skips those events itself, the same as Keystone's.
export function isBiEvent(ev: any): boolean {
  return ev?.bi_mkt === "1" || /^flow:[0-9a-f-]{36}:/i.test(String(ev?.job_id ?? ""));
}
export async function forwardToBi(raw: Buffer, sig: string, ts: string, fetchImpl: typeof fetch = fetch): Promise<number | null> {
  const base = String(process.env.BI_SERVER_URL || "").replace(/\/+$/, "");
  if (!base) {
    console.error("[sendgrid-webhook] BI events in batch but BI_SERVER_URL is unset - not forwarded");
    return null;
  }
  try {
    const r = await fetchImpl(`${base}/api/v1/bi/webhooks/sendgrid`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Twilio-Email-Event-Webhook-Signature": sig,
        "X-Twilio-Email-Event-Webhook-Timestamp": ts,
        "X-Boreal-Forwarded-By": "bf-server",
        // BF_SERVER_BI_SENDGRID_FORWARD_AUTH_v1 - BI-Server's SendGrid key is not this webhook's key (every forward got
        // 403), so the batch is also signed with the secret both servers share, after SendGrid's signature passed here.
        ...(process.env.JWT_SECRET
          ? { "X-Boreal-Forward-Signature": crypto.createHmac("sha256", process.env.JWT_SECRET).update(`${ts}.${raw.toString("utf8")}`).digest("hex") }
          : {}),
      },
      body: raw.toString("utf8"), // the same bytes SendGrid signed (the signature covers the UTF-8 text)
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) console.error("[sendgrid-webhook] BI forward answered", r.status);
    return r.status;
  } catch (err: any) {
    console.error("[sendgrid-webhook] BI forward failed", err?.message ?? String(err));
    return null;
  }
}

/** Which brand an email event belongs to: a CRM flow's own business, else Boreal Financial. */
async function eventBrand(ev: any): Promise<string> {
  const ref = parseFlowJobId(ev?.job_id);
  if (!ref) return "BF";
  const r = await pool.query<{ silo: string }>(`SELECT silo FROM crm_flows WHERE id = $1::uuid`, [ref.flowId]);
  return String(r.rows[0]?.silo ?? "BF").toUpperCase();
}

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
    // BF_SERVER_v784_WEBHOOK_SIGNATURES - fail closed. Accepting unsigned posts let anyone
    // forge unsubscribe/spamreport events (flipping marketing_opt_out) and timeline rows.
    console.error("[sendgrid-webhook] SENDGRID_WEBHOOK_PUBLIC_KEY unset - rejecting");
    return false;
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

router.post("/", safeHandler(async (req: any, res: any) => {
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
  let suppressed = 0; // addresses added to (or seen again on) the suppression list in this call
  // BF_SERVER_SENDGRID_RESOLVE_v332 - retain a capped diagnostic sample for
  // events that cannot be associated with a contact.
  const unresolvedEmails = new Set<string>();
  const seenTypes = new Set<string>();
  const biEvents = (Array.isArray(events) ? events : []).filter(isBiEvent).length;
  if (biEvents > 0) await forwardToBi(raw, sig, ts);
  for (const ev of Array.isArray(events) ? events : []) {
    try {
      // BF_SERVER_v865_KS_MARKETING - Keystone marketing email (KS-Ops) shares this SendGrid account. Its events carry
      // ks_mkt / ks_mkt_send_id and are handled by KS-Ops; matching them here by email could opt out, or log activity
      // on, a Boreal contact who happens to share the address.
      const otherSender = Boolean(ev?.ks_mkt_send_id || ev?.ks_mkt === "1" || ev?.ks_mkt_test === "1" || isBiEvent(ev)); // BF_SERVER_BI_SENDGRID_FORWARD_v1
      if (otherSender) {
        // BF_SERVER_UNIVERSAL_SUPPRESSION_v1 - a spam report or hard bounce from Keystone or Boreal Risk Management mail is
        // still remembered here, so no business emails that address again. Nothing else is touched.
        const otherEmail = String(ev?.email || "").trim().toLowerCase();
        // BF_SERVER_BRAND_UNSUBSCRIBES_v1 - unsubscribing from one brand does not stop the others (Todd's rule), so only a
        // hard bounce or a spam complaint from another brand's mail goes on the shared list; their unsubscribes do not.
        const otherEvent = String(ev?.event || "");
        if (otherEmail && ev?.ks_mkt_test !== "1" && otherEvent !== "unsubscribe" && otherEvent !== "group_unsubscribe" && isSuppressEvent(otherEvent, ev)) {
          await pool.query(
            `INSERT INTO email_suppressions (email, reason, source) VALUES ($1, $2, $3)
             ON CONFLICT (email) DO UPDATE SET last_seen_at = now(), events = email_suppressions.events + 1`,
            [otherEmail, String(ev?.event || ""), isBiEvent(ev) ? "sendgrid_brm" : "sendgrid_ks"],
          );
          await pool.query(
            `UPDATE contacts SET marketing_opt_out = true, updated_at = now()
              WHERE marketing_opt_out = false AND (lower(trim(coalesce(email, ''))) = $1 OR lower(trim(coalesce(secondary_email, ''))) = $1)`,
            [otherEmail],
          );
          suppressed += 1;
        }
        continue;
      }
      const email = String(ev?.email || "").toLowerCase();
      const event = String(ev?.event || "");
      if (event) seenTypes.add(event);
      const contactId = ev?.contact_id ? String(ev.contact_id) : null;
      let cid = contactId;
      if (!cid && email) {
        const r = await pool.query<{ id: string }>(
          `SELECT id FROM contacts
            WHERE lower(trim(coalesce(email, ''))) = $1
               OR lower(trim(coalesce(secondary_email, ''))) = $1
            ORDER BY (lower(trim(coalesce(email, ''))) = $1) DESC, created_at
            LIMIT 1`,
          [email],
        );
        cid = r.rows[0]?.id ?? null;
      }
      // BF_SERVER_v945_EMAIL_SUPPRESSIONS - an unsubscribe, spam report or hard bounce is remembered by address, whether
      // or not a contact matched, and every contact with that address is opted out (not only the one matched below).
      if (email && isSuppressEvent(event, ev)) {
        // BF_SERVER_BRAND_UNSUBSCRIBES_v1 - an unsubscribe stops only the brand whose email it came from (a Keystone flow
        // email stops Keystone, anything else Boreal Financial); a bounce or spam complaint stops every brand.
        const brand = event === "unsubscribe" || event === "group_unsubscribe" ? await eventBrand(ev) : null;
        await pool.query(
          `INSERT INTO email_suppressions (email, reason, source, brands) VALUES ($1, $2, 'sendgrid', $3::text[])
           ON CONFLICT (email) DO UPDATE SET last_seen_at = now(), events = email_suppressions.events + 1,
             reason = CASE WHEN EXCLUDED.brands IS NULL THEN EXCLUDED.reason ELSE email_suppressions.reason END,
             brands = CASE WHEN email_suppressions.brands IS NULL OR EXCLUDED.brands IS NULL THEN NULL
                           ELSE ARRAY(SELECT DISTINCT unnest(email_suppressions.brands || EXCLUDED.brands)) END`,
          [email, event, brand ? [brand] : null],
        );
        await pool.query(
          `UPDATE contacts SET marketing_opt_out = true, updated_at = now()
            WHERE marketing_opt_out = false
              AND ($2::text IS NULL OR coalesce(silo, 'BF') = $2)
              AND (lower(trim(coalesce(email, ''))) = $1 OR lower(trim(coalesce(secondary_email, ''))) = $1)`,
          [email, brand],
        );
        suppressed += 1;
      }
      if (!cid) {
        if (email) unresolvedEmails.add(email);
        continue;
      }
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
      // BF_SERVER_v786_WORKFLOW_GRAPH - email.opened / clicked / bounced / unsubscribed automation triggers.
      const automationType = SENDGRID_TRIGGERS[event];
      if (automationType) void import("../modules/automation/automationEngine.js").then((m) => m.emitAutomationEvent(automationType, { contactId: String(cid), data: { email, url: clickedUrl } })).catch((err: any) => console.warn("[automation] emit failed", err?.message ?? String(err)));
      // BF_SERVER_CRM_FLOWS_v1 - opens and clicks on email-flow emails move the person along their flow.
      const flowRef = parseFlowJobId(ev?.job_id);
      if (flowRef && (event === "open" || event === "click")) {
        await pool.query(
          `INSERT INTO crm_flow_events (flow_id, contact_id, email_key, event_type, url, created_at)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, to_timestamp($6))`,
          [flowRef.flowId, cid, flowRef.key, event, clickedUrl, Number(ev?.timestamp) || Date.now() / 1000],
        ).catch((err: any) => { console.warn("sendgrid_flow_event_failed", { message: err?.message }); });
      }
      // BF_SERVER_BLOCK_v790 - attribute sequence email opens/clicks.
      const seqSendId = ev?.seq_send_id ? String(ev.seq_send_id) : null;
      if (seqSendId && event === "open") await pool.query(`UPDATE sequence_sends SET opened_at = COALESCE(opened_at, now()) WHERE id = $1`, [seqSendId]).catch((err: any) => { console.warn("sendgrid_seq_open_failed", { seqSendId, message: err?.message }); });
      else if (seqSendId && event === "click") await pool.query(`UPDATE sequence_sends SET clicked_at = COALESCE(clicked_at, now()) WHERE id = $1`, [seqSendId]).catch((err: any) => { console.warn("sendgrid_seq_click_failed", { seqSendId, message: err?.message }); });
      // BF_SERVER_TEMPLATE_ANALYTICS_v1 - attribute per-template email opens/clicks via the tse_id custom arg.
      const tseId = ev?.tse_id ? String(ev.tse_id) : null;
      if (tseId && event === "open") await pool.query(`UPDATE template_send_events SET opened_at = COALESCE(opened_at, now()) WHERE id = $1`, [tseId]).catch((err: any) => { console.warn("sendgrid_tse_open_failed", { tseId, message: err?.message }); });
      else if (tseId && event === "click") await pool.query(`UPDATE template_send_events SET clicked_at = COALESCE(clicked_at, now()) WHERE id = $1`, [tseId]).catch((err: any) => { console.warn("sendgrid_tse_click_failed", { tseId, message: err?.message }); });
      // BF_SERVER_v874_MARKETING_TOOLS - the campaign ledger (campaign report, A/B test winner) via the cs_id custom arg.
      const csId = ev?.cs_id ? String(ev.cs_id) : null;
      const csColumn = event === "open" ? "opened_at" : event === "click" ? "clicked_at" : event === "unsubscribe" || event === "group_unsubscribe" || event === "spamreport" ? "unsubscribed_at" : null;
      if (csId && csColumn && /^[0-9a-f-]{36}$/i.test(csId)) {
        await pool.query(
          `UPDATE campaign_sends SET ${csColumn} = COALESCE(${csColumn}, now())${csColumn === "clicked_at" ? ", opened_at = COALESCE(opened_at, now())" : ""} WHERE id = $1`,
          [csId],
        ).catch((err: any) => { console.warn("sendgrid_campaign_send_update_failed", { csId, event, message: err?.message }); });
      }
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
    contactsUnresolved: unresolvedEmails.size,
    forwardedToBi: biEvents,
    suppressed,
    unresolvedSample: Array.from(unresolvedEmails).slice(0, 5).join(",") || "none",
    types: Array.from(seenTypes).join(",") || "none",
  });
  res.status(200).json({ ok: true });
}));

export default router;
