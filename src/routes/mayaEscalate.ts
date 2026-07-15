// BF_SERVER_BLOCK_v220_LAUNCH_FIXES_v1 + HOTFIX_NODENEXT_v1
// Maya escalate endpoint. Two kinds:
//   - kind=talk_to_human  → creates a messenger conversation; visible in
//                            BF-portal Messages tab.
//   - kind=report_issue   → writes a row in `issues`. Screenshot bytes are
//                            stored as a base64 data URL in screenshot_url —
//                            the portal img tag renders data URLs natively.
import { Router, Request, Response } from "express";
import { pool } from "../db.js";
import { createContact } from "../services/contacts.js";

const router = Router();

// BF_SERVER_BLOCK_v686_MAYA_CRM_UNIFY_v1
// Every Talk-to-a-Human / Report-an-Issue interaction must attach to a CRM
// contact and land in the CRM timeline (compliance). Match an existing BF
// contact by phone or email; otherwise create a minimal one (anonymous
// visitors included). The contact_id is then stamped on the conversation and
// every message so the staff Messages tab (keyed by contact_id+silo) shows the
// thread and the CRM timeline (which UNIONs communications_messages WHERE
// contact_id AND silo) logs it automatically.
async function resolveContactId(opts: {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  silo: string;
}): Promise<string | null> {
  const phone = (opts.phone ?? "").trim() || null;
  const email = (opts.email ?? "").trim() || null;
  // BF_SERVER_BLOCK_v687_CONTACT_MATCH_NORMALIZE_v1 — match on the last 10
  // digits of the phone so "5878881837", "+15878881837" and "(587) 888-1837"
  // all resolve to the SAME existing contact instead of spawning duplicates.
  // This was the v686 identity-fragmentation bug (one person => 3 contacts).
  const phoneDigits = phone ? phone.replace(/[^0-9]/g, "") : "";
  const phoneLast10 = phoneDigits.length >= 10 ? phoneDigits.slice(-10) : phoneDigits;
  try {
    if (phoneLast10) {
      const r = await pool.query<{ id: string }>(
        `SELECT id FROM contacts
          WHERE silo = $2
            AND phone IS NOT NULL
            AND length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 10
            AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1
          ORDER BY created_at ASC LIMIT 1`,
        [phoneLast10, opts.silo],
      );
      if (r.rows[0]) return r.rows[0].id;
    }
    if (email) {
      const r = await pool.query<{ id: string }>(
        `SELECT id FROM contacts WHERE lower(email) = lower($1) AND silo = $2 ORDER BY created_at ASC LIMIT 1`,
        [email, opts.silo],
      );
      if (r.rows[0]) return r.rows[0].id;
    }
    const rawName = (opts.name ?? "").trim();
    const parts = rawName ? rawName.split(/\s+/) : [];
    const first_name = parts[0] || phone || email || "Website";
    const last_name = parts.slice(1).join(" ") || (rawName ? "" : "Visitor");
    const created = await createContact(pool, {
      first_name,
      last_name,
      email,
      phone,
      role: "other",
      is_primary_applicant: false,
      silo: opts.silo,
    });
    return created.id;
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    console.warn("[maya escalate] resolveContactId failed", m);
    return null;
  }
}

router.post("/maya/escalate", async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const kind = String(b.kind ?? "");
  const contact = b.contact ?? {};
  const conversationId = b.conversation_id ? String(b.conversation_id) : null;
  // BF_SERVER_BLOCK_v763_MAYA_COMMS_SEPARATION — resolve the real silo from the
  // payload instead of hardcoding 'BF', so BI escalations file under BI.
  const silo = (typeof b.silo === "string" && b.silo.trim() ? b.silo.trim() : "BF").toUpperCase();

  if (kind !== "talk_to_human" && kind !== "report_issue") {
    return res.status(400).json({ error: "invalid_kind" });
  }

  try {
    if (kind === "talk_to_human") {
      const message = String(b.message ?? "").trim();
      if (!message) return res.status(400).json({ error: "missing_message" });

      const phone = (typeof contact.phone === "string" ? contact.phone.trim() : "") || null;
      const email = (typeof contact.email === "string" ? contact.email.trim() : "") || null;
      const nameIn = typeof contact.name === "string" ? contact.name.trim() : null;
      // BF_SERVER_BLOCK_v_MAYA_ESCALATE_IDENTITY_GATE_v1 - never mint an anonymous
      // "Website Visitor" lead. A talk-to-human handoff MUST carry a name AND a
      // reachable channel (phone or email). Otherwise return need_identity so the
      // caller (widget) collects it first. This also neutralizes the OpenAI-outage
      // failover, which hits this same endpoint with an empty contact.
      if (!nameIn || !(email || phone)) {
        return res.status(422).json({ ok: false, need_identity: true, missing: { name: !nameIn, channel: !(email || phone) } });
      }
      const contactName: string = nameIn || phone || email || "Anonymous visitor";

      // BF_SERVER_BLOCK_v763_MAYA_COMMS_SEPARATION — the Messages thread shows
      // the HUMAN handoff, not the Maya transcript. The transcript stays in the
      // Maya tab (chat_sessions); the body here is a clean marker, and the
      // visitor's own follow-ups arrive via the conversation poll endpoint.
      const displayBody = `${contactName} requested to talk to a human.`;

      // BF_SERVER_BLOCK_v686_MAYA_CRM_UNIFY_v1 — attach to a CRM contact first.
      const contactId = await resolveContactId({ name: nameIn, email, phone, silo });

      // Reuse the contact's existing open messenger thread instead of spawning a
      // brand-new conversation on every click (the v686 fragmentation bug).
      let convId: string | null = null;
      if (contactId) {
        const existing = await pool.query<{ id: string }>(
          `SELECT id FROM communications_conversations
            WHERE contact_id = $1 AND silo = $2 AND channel = 'messenger'
            ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
          [contactId, silo]
        );
        convId = existing.rows[0]?.id ?? null;
      }
      if (convId) {
        await pool.query(
          `UPDATE communications_conversations
              SET last_message_preview = $2, last_message_at = NOW(), unread = unread + 1
            WHERE id = $1`,
          [convId, displayBody.slice(0, 200)]
        );
      } else {
        const conv = await pool.query<{ id: string }>(
          `INSERT INTO communications_conversations
             (contact_id, contact_name, contact_phone, channel, last_message_preview, last_message_at, unread, silo)
           VALUES ($1, $2, $3, 'messenger', $4, NOW(), 1, $5)
           RETURNING id`,
          [contactId, contactName, phone, displayBody.slice(0, 200), silo]
        );
        convId = conv.rows[0].id;
      }

      await pool.query(
        `INSERT INTO communications_messages
           (id, conversation_id, contact_id, channel, type, direction, body, silo, from_number, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'messenger', 'message', 'inbound', $3, $5, $4, NOW())`,
        [convId, contactId, displayBody, phone, silo]
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

    // BF_SERVER_BLOCK_v686_MAYA_CRM_UNIFY_v1 — issues still attach to a CRM
    // contact, but BF_SERVER_BLOCK_v763_MAYA_COMMS_SEPARATION keeps the issue
    // report itself out of communications_messages so it does not render as a
    // duplicate staff Messages-tab entry.
    const issuePhone = (typeof contact.phone === "string" ? contact.phone.trim() : "") || null;
    const issueEmail = (typeof contact.email === "string" ? contact.email.trim() : "") || null;
    const issueName = typeof contact.name === "string" ? contact.name.trim() : null;
    const issueContactId = await resolveContactId({ name: issueName, email: issueEmail, phone: issuePhone, silo });
    const issueConvName = issueName || issuePhone || issueEmail || "Issue report";
    const issuePreview = `[Issue] ${description}`.slice(0, 200);
    const issueConv = await pool.query<{ id: string }>(
      `INSERT INTO communications_conversations
         (contact_id, contact_name, contact_phone, channel, last_message_preview, last_message_at, unread, silo)
       VALUES ($1, $2, $3, 'messenger', $4, NOW(), 1, $5)
       RETURNING id`,
      [issueContactId, issueConvName, issuePhone, issuePreview, silo]
    );
    const issueConvId = issueConv.rows[0].id;
    // BF_SERVER_BLOCK_v763_MAYA_COMMS_SEPARATION — issues live ONLY in the
    // Issues tab. Do NOT double-post a messenger row into the Messages tab.

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
         (source, kind, description, conversation_id, contact_id, contact_email, contact_phone,
          page_url, screenshot_url, silo)
       VALUES ('maya_escalate', 'report_issue', $1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        description,
        issueConvId,
        issueContactId,
        issueEmail,
        issuePhone,
        (typeof b.page_url === "string" ? b.page_url : null) || null,
        screenshotUrl,
        silo,
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
