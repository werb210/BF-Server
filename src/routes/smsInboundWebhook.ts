import { Router } from "express";
import { pool } from "../db.js";
import twilio from "twilio";
const router = Router();
router.post("/webhooks/twilio/sms-inbound", async (req: any, res) => {
  const from = String(req.body?.From ?? "");
  const to = String(req.body?.To ?? "");
  const body = String(req.body?.Body ?? "").trim();
  const messageSid = String(req.body?.MessageSid ?? "");
  void to; void twilio;
  if (!from || !body) return res.type("text/xml").send("<Response/>");
  try {
    const conv = await pool.query<{id:string}>(`SELECT id FROM communications_conversations WHERE contact_phone = $1 AND channel = 'sms' ORDER BY created_at DESC LIMIT 1`, [from]);
    let convId: string;
    if (conv.rowCount === 0) {
      const ins = await pool.query<{id:string}>(`INSERT INTO communications_conversations
        (contact_phone, contact_name, channel, last_message_preview, last_message_at, unread, silo)
        VALUES ($1, $1, 'sms', $2, NOW(), 1, 'BF') RETURNING id`, [from, body.slice(0, 200)]);
      convId = ins.rows[0].id;
    } else {
      convId = conv.rows[0].id;
      await pool.query(`UPDATE communications_conversations SET last_message_preview = $2,last_message_at = NOW(),unread = unread + 1,updated_at = NOW() WHERE id = $1`, [convId, body.slice(0, 200)]);
    }
    await pool.query(`INSERT INTO communications_messages
      (conversation_id, channel, direction, body, twilio_message_sid, created_at)
      VALUES ($1, 'sms', 'inbound', $2, $3, NOW())
      ON CONFLICT (twilio_message_sid) DO NOTHING`, [convId, body, messageSid || null]);
    return res.type("text/xml").send("<Response/>");
  } catch {
    return res.type("text/xml").send("<Response/>");
  }
});
export default router;
