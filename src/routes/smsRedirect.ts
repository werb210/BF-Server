// BF_SERVER_SMS_REDIRECT_v1 - PUBLIC. Tracked-link redirect (marks click + logs
// timeline, then 302s to the destination) and the Twilio message status callback.
import { Router } from "express";
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = Router();
router.use(express.urlencoded({ extended: false }));

router.post("/status", async (req: any, res: any) => {
  try {
    const sid = String(req.body?.MessageSid || "");
    const status = String(req.body?.MessageStatus || "");
    if (sid) await pool.query(`UPDATE sms_campaign_sends SET delivery_status = $2 WHERE message_sid = $1`, [sid, status]);
  } catch { /* ignore */ }
  res.status(204).end();
});

router.get("/:token", async (req: any, res: any) => {
  const fallbackUrl = "https://boreal.financial";
  try {
    const payload = jwt.verify(String(req.params.token), String(process.env.JWT_SECRET)) as { sid?: string; u?: string };
    const url = payload?.u && /^https?:\/\//i.test(payload.u) ? payload.u : fallbackUrl;
    if (payload?.sid) {
      await pool.query(`UPDATE sms_campaign_sends SET clicked_at = COALESCE(clicked_at, now()) WHERE id = $1`, [payload.sid]);
      const r = await pool.query<{ contact_id: string }>(`SELECT contact_id FROM sms_campaign_sends WHERE id = $1`, [payload.sid]);
      const cid = r.rows[0]?.contact_id;
      if (cid) await pool.query(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1,$2,$3)`, [cid, "sms_link_clicked", JSON.stringify({ url })]);
    }
    res.redirect(302, url);
  } catch {
    res.redirect(302, fallbackUrl);
  }
});

export default router;
