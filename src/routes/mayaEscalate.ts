// BF_SERVER_BLOCK_v220_LAUNCH_FIXES_v1 + HOTFIX_NODENEXT_v1
// Maya escalate endpoint. Two kinds:
//   - kind=talk_to_human  → creates a messenger conversation; visible in
//                            BF-portal Messages tab.
//   - kind=report_issue   → writes a row in `issues`. Screenshot bytes are
//                            stored as a base64 data URL in screenshot_url —
//                            the portal img tag renders data URLs natively.
import { Router, Request, Response } from "express";
import { pool } from "../db.js";

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

      // BF_SERVER_BLOCK_v222_MAYA_ESCALATE_STAFF_NOTIFY_v1
      // Fan out SMS to available staff so a human sees the request on their
      // phone within seconds, not just a DB row in the Inbox tab. Fire-and-
      // forget: the API still returns 201 immediately. Recipients=available
      // ranges over staff_presence WHERE status='available'; if zero, the
      // helper falls back to MAYA_FALLBACK_SMS_NUMBERS env CSV (off-hours).
      void (async () => {
        try {
          const { sendStaffNotification } = await import("../services/notifications/staffSms.js");
          const summary = message.length > 140 ? `${message.slice(0, 137)}…` : message;
          const contactBit = phone
            ? ` (${phone})`
            : email
              ? ` (${email})`
              : "";
          const recipients = await hasAvailableStaff() ? "available" : "fallback";
          await sendStaffNotification({
            recipients,
            body: `Maya talk-to-human${contactBit}: ${summary}`,
          });
        } catch (err: unknown) {
          const m = err instanceof Error ? err.message : String(err);
          console.warn("[maya escalate] staff notify (talk_to_human) failed", m);
        }
      })();

      return res.status(201).json({ ok: true, conversation_id: convId });
    }

    // kind === "report_issue"
    const description = String(b.description ?? "").trim();
    if (!description) return res.status(400).json({ error: "missing_description" });

    // BF_SERVER_BLOCK_v645_INBOX_AND_SCREENSHOT_v1 — accept three field-name
    // aliases so all current callers work without a wire-protocol break:
    //   - bfw FloatingChat (v149+) sends `screenshot`
    //   - bf-client MayaWidget (v320+) sends `screenshot`
    //   - the agent /maya/issue forwards `screenshot_data_url`
    // We also tolerate bare base64 (no data: prefix) by adding one.
    let screenshotUrl: string | null = null;
    const candidate: unknown =
      b.screenshot_data_url ?? b.screenshot ?? b.screenshot_base64 ?? b.screenshotBase64;
    if (typeof candidate === "string" && candidate.length > 0) {
      const normalized = candidate.startsWith("data:image/")
        ? candidate
        : `data:image/png;base64,${candidate}`;
      if (normalized.length <= 2_500_000) {
        screenshotUrl = normalized;
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

    // BF_SERVER_BLOCK_v222_MAYA_ESCALATE_STAFF_NOTIFY_v1
    void (async () => {
      try {
        const { sendStaffNotification } = await import("../services/notifications/staffSms.js");
        const summary = description.length > 140 ? `${description.slice(0, 137)}…` : description;
        const pageBit = typeof b.page_url === "string" && b.page_url
          ? ` on ${b.page_url}`
          : "";
        const recipients = await hasAvailableStaff() ? "available" : "fallback";
        await sendStaffNotification({
          recipients,
          body: `Maya issue report${pageBit}: ${summary}`,
        });
      } catch (err: unknown) {
        const m = err instanceof Error ? err.message : String(err);
        console.warn("[maya escalate] staff notify (report_issue) failed", m);
      }
    })();

    return res.status(201).json({ ok: true, issue_id: issue.rows[0].id });
  } catch (err: unknown) {
    const message: string = err instanceof Error ? err.message : String(err);
    console.error("[maya escalate] failed", message);
    return res.status(500).json({ error: "internal" });
  }
});

// BF_SERVER_BLOCK_v222_MAYA_ESCALATE_STAFF_NOTIFY_v1
// Quick check used to decide between "available" (live staff) and
// "fallback" (env CSV) recipient modes. sendStaffNotification itself
// doesn't auto-fall-back — it sends to zero recipients silently if
// nobody's available — so we make the routing decision here.
async function hasAvailableStaff(): Promise<boolean> {
  try {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM staff_presence
        WHERE status = 'available'
          AND last_heartbeat > now() - interval '5 minutes'
        LIMIT 1`,
    );
    return (rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

export default router;
