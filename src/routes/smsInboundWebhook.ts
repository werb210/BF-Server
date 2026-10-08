import { Router } from "express";
import { pool } from "../db.js";
import { createContact } from "../services/contacts.js";
import { persistTwilioMediaToBlob } from "../services/mmsMedia.js"; // BF_SERVER_MMS_BLOB_PERSIST_v1
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js"; // BF_SERVER_SILENT_QUERIES_v678

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

// BF_SERVER_SMS_KEYWORDS_v780 - the replies registered with Twilio for RCS and toll-free verification (Oct 2026).
const SMS_HELP = "Boreal Financial: For help call 1-866-631-8939 or email info@boreal.financial. Msg frequency varies. Standard message & data rates may apply. Reply STOP to opt out.";
const SMS_AIDE = "Boreal Financial : Pour de l'aide, appelez le 1-866-631-8939 ou écrivez à info@boreal.financial. La fréquence des messages varie. Des frais standard de messagerie et de données peuvent s'appliquer. Répondez ARRET pour vous désabonner.";
export function smsKeywordReply(kw: string): { kind: "out" | "in" | "help"; text: string } | null {
  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT"].includes(kw)) return { kind: "out", text: "Boreal Financial: You've been unsubscribed and won't receive any more messages. Reply START to resubscribe." };
  if (kw === "ARRET" || kw === "ARRT") return { kind: "out", text: "Boreal Financial : Vous êtes désabonné et ne recevrez plus de messages. Répondez START pour vous réabonner." };
  if (["START", "UNSTOP", "SUBSCRIBE", "OPTIN", "YES"].includes(kw)) return { kind: "in", text: "Boreal Financial: You're subscribed to texts about your financing application. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out." };
  if (kw === "HELP") return { kind: "help", text: SMS_HELP };
  if (kw === "AIDE") return { kind: "help", text: SMS_AIDE };
  if (kw === "INFO") return { kind: "help", text: SMS_HELP + " / " + SMS_AIDE };
  return null;
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
  // BF_SERVER_SMS_KEYWORDS_v780 - adds French ARRET, HELP/AIDE/INFO replies, and the exact wording registered with
  // Twilio (RCS and toll-free). "YES" was a resubscribe word, so a client answering a staff question with "Yes" got
  // an automatic reply and their message never reached staff; START-family words now only resubscribe someone who
  // is actually opted out, and otherwise flow through as a normal message.
  {
    const kw = body.trim().toUpperCase().replace(/[^A-Z]/g, "");
    const digits = from.replace(/[^0-9]/g, "");
    const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
    const reply = smsKeywordReply(kw);
    let act: "out" | "in" | "help" | null = reply ? reply.kind : null;
    if (act === "in") {
      // Only treat it as "resubscribe" when this number is currently opted out.
      const cur = last10 ? await pool.query<{ out: boolean }>(
        `SELECT bool_or(COALESCE(sms_opt_out, false)) AS out FROM contacts
          WHERE phone IS NOT NULL AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1`, [last10],
      ).catch((err: unknown) => { console.warn("[sms-inbound] opt-out lookup failed", err instanceof Error ? err.message : String(err)); return null; }) : null;
      if (!cur?.rows[0]?.out) act = null;
    }
    if (act && reply) {
      if (act !== "help") {
        try {
          if (last10) {
            // BF_SERVER_SMS_STOP_ALL_SILOS_v1 - a person saying STOP means stop, from every silo.
            await pool.query(
              `UPDATE contacts SET sms_opt_out = $2, updated_at = now()
                WHERE phone IS NOT NULL
                  AND length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 10
                  AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1`,
              [last10, act === "out"],
            );
          }
          console.log("[sms-inbound] opt_" + act, { from, silo: "ALL", keyword: kw });
        } catch (err: unknown) {
          console.warn("[sms-inbound] opt-out update failed", err instanceof Error ? err.message : String(err));
        }
      } else {
        console.log("[sms-inbound] help_reply", { from, keyword: kw });
      }
      return res.type("text/xml").send(`<Response><Message>${reply.text}</Message></Response>`);
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
            .catch((swallowedErr: unknown) => { logWarnSwallowed(swallowedErr, "routes/smsInboundWebhook.ts:170");});
        }
      })();
    }

    if (contactId) {
      // BF_SERVER_BLOCK_v619 - automation trigger.
      void import("../modules/automation/automationEngine.js").then((m) => m.emitAutomationEvent({ trigger: "message.inbound", silo: "BF", contactId, data: { channel: "sms" } })).catch((err: any) => console.warn("[automation] emit failed", err?.message ?? String(err)));
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
