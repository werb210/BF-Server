import { Router } from "express";
import { pool } from "../db.js";
import { createContact } from "../services/contacts.js";
import { persistTwilioMediaToBlob } from "../services/mmsMedia.js"; // BF_SERVER_MMS_BLOB_PERSIST_v1

const router = Router();

// BF_SERVER_BLOCK_v690_INBOUND_SMS_CONTACT_STAMP_v1 - resolve-or-create a
// contact for the sender and stamp contact_id + type='sms' + from/to + silo on
// the inbound row. Previously these were omitted, so every inbound SMS was born
// orphaned (contact_id NULL, type NULL): it fell into the Messages-tab "null"
// thread and inflated the nav badge with a count no click could clear.
async function resolveInboundSmsContact(from: string): Promise<string | null> {
  const digits = from.replace(/[^0-9]/g, "");
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits;

  try {
    if (last10) {
      // BF_SERVER_INBOUND_SMS_MERGED_CONTACT_v1 - never resolve to an archived /
      // already-merged contact; follow merged_into_id to the live survivor instead.
      // See the long note in src/routes/webhooks.ts for why this mattered.
      const r = await pool.query<{ id: string }>(
        `WITH matched AS (
           SELECT id, status, merged_into_id, created_at, updated_at
             FROM contacts
            WHERE silo = 'BF'
              AND ((phone IS NOT NULL
                    AND length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 10
                    AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1)
                OR (secondary_phone IS NOT NULL
                    AND length(regexp_replace(secondary_phone, '[^0-9]', '', 'g')) >= 10
                    AND right(regexp_replace(secondary_phone, '[^0-9]', '', 'g'), 10) = $1))
         ),
         resolved AS (
           SELECT coalesce(surv.id, m.id)                 AS id,
                  coalesce(surv.status, m.status)         AS status,
                  coalesce(surv.updated_at, m.updated_at) AS updated_at,
                  coalesce(surv.created_at, m.created_at) AS created_at
             FROM matched m
             LEFT JOIN contacts surv
               ON surv.id = m.merged_into_id
              AND coalesce(surv.status, '') <> 'archived'
              AND surv.merged_into_id IS NULL
         )
         SELECT DISTINCT ON (id) id
           FROM resolved
          WHERE coalesce(status, '') <> 'archived'
          ORDER BY id, updated_at DESC NULLS LAST, created_at ASC NULLS LAST
          LIMIT 1`,
        [last10],
      );
      if (r.rows[0]) return r.rows[0].id;
    }

    const created = await createContact(pool, {
      first_name: from || "Unknown",
      last_name: "",
      phone: from || null,
      role: "other",
      is_primary_applicant: false,
      silo: "BF",
    });
    return created.id;
  } catch (err: unknown) {
    console.warn("[sms-inbound] contact resolve failed", err instanceof Error ? err.message : String(err));
    return null;
  }
}

router.post("/webhooks/twilio/sms-inbound", async (req: any, res) => {
  const from = String(req.body?.From ?? "");
  const to = String(req.body?.To ?? "");
  const rawBody = String(req.body?.Body ?? "").trim();
  const messageSid = String(req.body?.MessageSid ?? "");

  // BF_SERVER - capture inbound MMS. Twilio posts NumMedia + MediaUrl0..N.
  // The handler previously read only Body and dropped any message without it,
  // so client screenshots (caption-less MMS) vanished entirely.
  const numMedia = Number.parseInt(String(req.body?.NumMedia ?? "0"), 10) || 0;
  const mediaUrl = numMedia > 0 ? (String(req.body?.MediaUrl0 ?? "").trim() || null) : null;
  const body = rawBody || (mediaUrl ? "[media]" : "");

  // Drop only truly empty messages: no sender, or no text AND no media.
  if (!from || (!body && !mediaUrl)) return res.type("text/xml").send("<Response/>");

  // BF_SERVER_SMS_STOP_HANDLER_v1 - CASL opt-out/opt-in. Honor STOP-family and START-family
  // keywords, scoped to this inbound number's silo (BF). Runs before normal logging. If Twilio
  // Advanced Opt-Out is enabled it intercepts STOP upstream (this never fires, no double reply);
  // if not, this sets our DB flag and confirms. Our sends already suppress on sms_opt_out.
  {
    const kw = body.trim().toUpperCase().replace(/[^A-Z]/g, "");
    const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT"]);
    const START_WORDS = new Set(["START", "YES", "UNSTOP", "SUBSCRIBE", "OPTIN"]);
    if (STOP_WORDS.has(kw) || START_WORDS.has(kw)) {
      const optOut = STOP_WORDS.has(kw);
      const digits = from.replace(/[^0-9]/g, "");
      const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
      try {
        if (last10) {
          // BF_SERVER_SMS_STOP_ALL_SILOS_v1 - this was scoped to silo = 'BF', so a BI
          // contact who texted STOP was never opted out and kept receiving messages.
          // A person saying STOP means stop, from every silo.
          await pool.query(
            `UPDATE contacts SET sms_opt_out = $2, updated_at = now()
              WHERE phone IS NOT NULL
                AND length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 10
                AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1`,
            [last10, optOut],
          );
        }
        console.log("[sms-inbound] opt_" + (optOut ? "out" : "in"), { from, silo: "ALL" });
      } catch (err: unknown) {
        console.warn("[sms-inbound] opt-out update failed", err instanceof Error ? err.message : String(err));
      }
      const reply = optOut
        ? "You have been unsubscribed from Boreal Financial messages. Reply START to resubscribe."
        : "You are resubscribed to Boreal Financial messages. Reply STOP to opt out.";
      return res.type("text/xml").send(`<Response><Message>${reply}</Message></Response>`);
    }
  }

  try {
    const conv = await pool.query<{ id: string }>(
      `SELECT id
         FROM communications_conversations
        WHERE contact_phone = $1 AND channel = 'sms'
        ORDER BY created_at DESC
        LIMIT 1`,
      [from],
    );

    let convId: string;
    if (conv.rowCount === 0) {
      const ins = await pool.query<{ id: string }>(
        `INSERT INTO communications_conversations
          (contact_phone, contact_name, channel, last_message_preview, last_message_at, unread, silo)
         VALUES ($1, $1, 'sms', $2, NOW(), 1, 'BF')
         RETURNING id`,
        [from, body.slice(0, 200)],
      );
      convId = ins.rows[0].id;
    } else {
      convId = conv.rows[0].id;
      await pool.query(
        `UPDATE communications_conversations
            SET last_message_preview = $2,
                last_message_at = NOW(),
                unread = unread + 1,
                updated_at = NOW()
          WHERE id = $1`,
        [convId, body.slice(0, 200)],
      );
    }

    const contactId = await resolveInboundSmsContact(from);
    await pool.query(
      `INSERT INTO communications_messages
        (conversation_id, contact_id, channel, type, direction, body, media_url, from_number, to_number, silo, twilio_message_sid, created_at)
       VALUES ($1, $2, 'sms', 'sms', 'inbound', $3, $4, $5, $6, 'BF', $7, NOW())
       ON CONFLICT (twilio_message_sid) DO NOTHING`,
      [convId, contactId, body, mediaUrl, from, to || null, messageSid || null],
    );

    // BF_SERVER_MMS_BLOB_PERSIST_v1 - copy the MMS to public blob off the hot
    // path so it renders without Twilio creds at view time and survives purge.
    if (mediaUrl && messageSid) {
      void (async () => {
        const persisted = await persistTwilioMediaToBlob(mediaUrl);
        if (persisted) {
          await pool
            .query("UPDATE communications_messages SET media_url = $2 WHERE twilio_message_sid = $1", [messageSid, persisted.url])
            .catch(() => {});
        }
      })();
    }

    return res.type("text/xml").send("<Response/>");
  } catch (err) {
    // #11 - an inbound message that fails to persist must not vanish silently.
    // Log the real reason (still ACK Twilio 200 so it does not retry-storm).
    // eslint-disable-next-line no-console
    console.error("sms_inbound_persist_failed", err);
    return res.type("text/xml").send("<Response/>");
  }
});

export default router;
