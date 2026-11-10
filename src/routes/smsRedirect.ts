// BF_SERVER_SMS_REDIRECT_v1 - PUBLIC. Tracked-link redirect (marks click + logs
// timeline, then 302s to the destination) and the Twilio message status callback.
import { Router } from "express";
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { twilioWebhookValidation } from "../middleware/twilioWebhookValidation.js"; // BF_SERVER_BLOCK_v464_SMS_DELIVERY
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { safeHandler } from "../middleware/safeHandler.js"; // BF_SERVER_v789_SAFE_HANDLERS // BF_SERVER_SILENT_QUERIES_v678

const router = Router();
router.use(express.urlencoded({ extended: false }));

// BF_SERVER_BLOCK_v464_SMS_DELIVERY - this was public and unsigned; anyone could post
// a status. It now checks Twilio's signature like every other Twilio webhook, and
// records the delivery result (and error code) for every tracked text.
router.post("/status", twilioWebhookValidation, safeHandler(async (req: any, res: any) => {
  try {
    const sid = String(req.body?.MessageSid || "");
    const status = String(req.body?.MessageStatus || "");
    if (sid) {
      await pool.query(`UPDATE sms_campaign_sends SET delivery_status = $2 WHERE message_sid = $1`, [sid, status]);
      await pool.query(`UPDATE sequence_sends SET delivery_status = $2 WHERE message_sid = $1`, [sid, status]).catch((swallowedErr: unknown) => { logWarnSwallowed(swallowedErr, "routes/smsRedirect.ts:21");});
      const errorCode = req.body?.ErrorCode ? String(req.body.ErrorCode) : null;
      await pool.query(
        `UPDATE sms_deliveries SET status = $2, error_code = COALESCE($3, error_code), updated_at = now() WHERE message_sid = $1`,
        [sid, status, errorCode],
      ).catch((err: any) => { console.warn("[sms] delivery status update failed", { sid, message: err?.message ?? String(err) }); return { rows: [] }; });
    }
  } catch { /* ignore */ }
  res.status(204).end();
}));

// BF_SERVER_v936_CLIENT_OFFER_CLEANUP - the client's term sheet, from a 15-minute link (PDF as is, Word as a page).
router.get("/ts/:token", async (req: any, res: any) => {
  try {
    const { offerIdFromViewToken, termSheetForViewing } = await import("../brokerTools/termSheetView.js");
    const offerId = offerIdFromViewToken(String(req.params.token ?? ""));
    if (!offerId) return res.status(410).type("text/plain").send("This link has expired. Open the term sheet again from the app.");
    const v = await termSheetForViewing(offerId);
    if (!v.ok) return res.status(v.status).type("text/plain").send("The term sheet could not be opened. Please message your advisor.");
    res.setHeader("Content-Type", v.contentType);
    res.setHeader("Content-Disposition", `inline; filename="${v.filename}"`);
    res.setHeader("Cache-Control", "private, no-store");
    return res.end(v.body);
  } catch (err) {
    console.warn("[term-sheet] view failed", { message: (err as Error)?.message });
    return res.status(500).type("text/plain").send("The term sheet could not be opened. Please message your advisor.");
  }
});

router.get("/:token", async (req: any, res: any) => {
  const fallbackUrl = "https://www.boreal.financial"; // BF_SERVER_WWW_FALLBACK_v749
  try {
    const payload = jwt.verify(String(req.params.token), String(process.env.JWT_SECRET), { algorithms: ["HS256"] }) as { sid?: string; u?: string };
    const url = payload?.u && /^https?:\/\//i.test(payload.u) ? payload.u : fallbackUrl;
    if (payload?.sid) {
      await pool.query(`UPDATE sms_campaign_sends SET clicked_at = COALESCE(clicked_at, now()) WHERE id = $1`, [payload.sid]);
      // BF_SERVER_BLOCK_v786_SEQ_CLICKS - sequence sends are tracked separately.
      await pool.query(`UPDATE sequence_sends SET clicked_at = COALESCE(clicked_at, now()) WHERE id = $1`, [payload.sid]).catch((swallowedErr: unknown) => { logWarnSwallowed(swallowedErr, "routes/smsRedirect.ts:40");});
      const r = await pool.query<{ contact_id: string }>(`SELECT contact_id FROM sms_campaign_sends WHERE id = $1 UNION ALL SELECT contact_id FROM sequence_sends WHERE id = $1 LIMIT 1`, [payload.sid]);
      const cid = r.rows[0]?.contact_id;
      if (cid) await pool.query(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1,$2,$3)`, [cid, "sms_link_clicked", JSON.stringify({ url })]);
      // BF_SERVER_v786_WORKFLOW_GRAPH - automation trigger.
      if (cid) void import("../modules/automation/automationEngine.js").then((m) => m.emitAutomationEvent("link.clicked", { contactId: String(cid), data: { url } })).catch((err: any) => console.warn("[automation] emit failed", err?.message ?? String(err)));
    }
    res.redirect(302, url);
  } catch {
    res.redirect(302, fallbackUrl);
  }
});

export default router;
