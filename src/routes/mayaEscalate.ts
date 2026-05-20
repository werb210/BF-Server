import { Router, Request, Response } from "express";
import { pool } from "../db.js";
import { uploadBufferToBlob } from "../lib/azureBlob.js";
import { logger } from "../platform/logger.js";
import { notifyStaffSMS } from "../services/staffNotifyService.js";

const router = Router();
router.post("/maya/escalate", async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const kind = String(b.kind ?? "");
  const contact = b.contact ?? {};
  const conversationId = b.conversation_id ? String(b.conversation_id) : null;
  if (kind !== "talk_to_human" && kind !== "report_issue") return res.status(400).json({ error: "invalid_kind" });
  try {
    if (kind === "talk_to_human") {
      const message = String(b.message ?? "").trim();
      if (!message) return res.status(400).json({ error: "missing_message" });
      const phone = String(contact.phone ?? "").trim() || null;
      const email = String(contact.email ?? "").trim() || null;
      const contactName = phone || email || "Anonymous visitor";
      const conv = await pool.query<{id:string}>(`INSERT INTO communications_conversations
        (contact_name, contact_phone, channel, last_message_preview, last_message_at, unread, silo)
        VALUES ($1, $2, 'messenger', $3, NOW(), 1, 'BF') RETURNING id`, [contactName, phone, message.slice(0, 200)]);
      const convId = conv.rows[0].id;
      await pool.query(`INSERT INTO communications_messages
        (conversation_id, channel, direction, body, created_at)
        VALUES ($1, 'messenger', 'inbound', $2, NOW())`, [convId, message]);
      void notifyStaffSMS(`Maya escalation: ${contactName} needs a human. Open BF-Portal → Communications → Messages.`).catch(() => {});
      return res.status(201).json({ ok: true, conversation_id: convId });
    }
    const description = String(b.description ?? "").trim();
    if (!description) return res.status(400).json({ error: "missing_description" });
    let screenshotUrl: string | null = null;
    let blobName: string | null = null;
    const dataUrl: string | undefined = b.screenshot_data_url;
    if (dataUrl && dataUrl.startsWith("data:image/png;base64,")) {
      const buf = Buffer.from(dataUrl.split(",")[1], "base64");
      const r = await uploadBufferToBlob({ buffer: buf, contentType: "image/png", pathPrefix: "maya-issues", filename: `issue-${Date.now()}.png` }).catch((err) => {
        logger.warn({ err: String(err?.message ?? err) }, "[maya escalate] screenshot upload failed");
        return null;
      });
      if (r) { screenshotUrl = r.url; blobName = r.blobName; }
    }
    const issue = await pool.query<{id:string}>(`INSERT INTO issues
      (source, kind, description, conversation_id, contact_email, contact_phone,
       page_url, screenshot_url, screenshot_blob_name, silo)
      VALUES ('maya_escalate', 'report_issue', $1, $2, $3, $4, $5, $6, $7, 'BF') RETURNING id`,
      [description, conversationId, contact.email || null, contact.phone || null, b.page_url || null, screenshotUrl, blobName]);
    void notifyStaffSMS(`New issue reported via Maya: ${description.slice(0, 80)}…`).catch(() => {});
    return res.status(201).json({ ok: true, issue_id: issue.rows[0].id });
  } catch (err) {
    logger.error({ err: String((err as Error)?.message ?? err) }, "[maya escalate] failed");
    return res.status(500).json({ error: "internal" });
  }
});
export default router;
