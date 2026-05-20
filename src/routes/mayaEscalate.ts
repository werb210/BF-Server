// BF_SERVER_BLOCK_v220_LAUNCH_FIXES_v1 + HOTFIX_DEPS_v1
// Maya escalate endpoint. Two kinds:
//   - kind=talk_to_human  → creates a messenger conversation; visible in
//                            BF-portal Messages tab.
//   - kind=report_issue   → writes a row in `issues` (with screenshot data
//                            URL if provided) so it shows in BF-portal
//                            Communications → Issues tab.
//
// No external service deps. Screenshot bytes are stored as a base64 data
// URL in issues.screenshot_url — the portal img tag renders data URLs
// natively. Azure blob upload can be retro-fitted later by swapping the
// data URL for a blob URL.
import { Router, Request, Response } from "express";
import { pool } from "../db";

const router = Router();

router.post("/maya/escalate", async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const kind = String(b.kind ?? "");
  const contact = b.contact ?? {};
  const conversationId = b.conversation_id ? String(b.conversation_id) : null;

  if (kind !== "talk_to_human" && kind !== "report_issue") {
    return res.status(400).json({ error: "invalid_kind" });
  }

  try {
    if (kind === "talk_to_human") {
      const message = String(b.message ?? "").trim();
      if (!message) return res.status(400).json({ error: "missing_message" });

      const phone = (typeof contact.phone === "string" ? contact.phone.trim() : "") || null;
      const email = (typeof contact.email === "string" ? contact.email.trim() : "") || null;
      const contactName: string = phone || email || "Anonymous visitor";

      const conv = await pool.query<{ id: string }>(
        `INSERT INTO communications_conversations
           (contact_name, contact_phone, channel, last_message_preview, last_message_at, unread, silo)
         VALUES ($1, $2, 'messenger', $3, NOW(), 1, 'BF')
         RETURNING id`,
        [contactName, phone, message.slice(0, 200)]
      );
      const convId: string = conv.rows[0].id;

      await pool.query(
        `INSERT INTO communications_messages
           (conversation_id, channel, direction, body, created_at)
         VALUES ($1, 'messenger', 'inbound', $2, NOW())`,
        [convId, message]
      );

      return res.status(201).json({ ok: true, conversation_id: convId });
    }

    // kind === "report_issue"
    const description = String(b.description ?? "").trim();
    if (!description) return res.status(400).json({ error: "missing_description" });

    // Data URLs render fine in <img src=...>. If the payload is big the
    // request will be rejected upstream by Express' body limit — that's
    // a reasonable cap. Future: swap to blob URL once the blob helper
    // is in place.
    let screenshotUrl: string | null = null;
    const dataUrl: unknown = b.screenshot_data_url;
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/")) {
      // Cap at ~2.5MB of base64 to protect the row size
      if (dataUrl.length <= 2_500_000) {
        screenshotUrl = dataUrl;
      }
    }

    const issue = await pool.query<{ id: string }>(
      `INSERT INTO issues
         (source, kind, description, conversation_id, contact_email, contact_phone,
          page_url, screenshot_url, silo)
       VALUES ('maya_escalate', 'report_issue', $1, $2, $3, $4, $5, $6, 'BF')
       RETURNING id`,
      [
        description,
        conversationId,
        (typeof contact.email === "string" ? contact.email : null) || null,
        (typeof contact.phone === "string" ? contact.phone : null) || null,
        (typeof b.page_url === "string" ? b.page_url : null) || null,
        screenshotUrl,
      ]
    );

    return res.status(201).json({ ok: true, issue_id: issue.rows[0].id });
  } catch (err: unknown) {
    const message: string = err instanceof Error ? err.message : String(err);
    console.error("[maya escalate] failed", message);
    return res.status(500).json({ error: "internal" });
  }
});

export default router;
