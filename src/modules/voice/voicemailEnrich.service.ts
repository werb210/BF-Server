// BF_SERVER_BLOCK_v720_VOICEMAIL_FULL_v1
import OpenAI from "openai";
import { pool } from "../../db.js";
import { config } from "../../config/index.js";
import { findCallLogByTwilioSid } from "../calls/calls.repo.js";
import { createContact } from "../../services/contacts.js";
import { logCrmEvent } from "../crm/crmTimeline.service.js";
import { sendSms } from "../notifications/sms.service.js";
import { AzureBlobBackend } from "../../lib/storage/azureBlob.js";

const VM_CONTAINER = process.env.VOICEMAIL_BLOB_CONTAINER || "voicemails";
let blob: AzureBlobBackend | null = null;

function blobBackend(): AzureBlobBackend | null {
  if (blob) return blob;
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) return null;
  blob = new AzureBlobBackend(VM_CONTAINER, conn);
  return blob;
}

async function downloadRecording(recordingUrl: string): Promise<Buffer | null> {
  try {
    const url = recordingUrl.endsWith(".mp3") ? recordingUrl : `${recordingUrl}.mp3`;
    const sid = config.twilio.accountSid;
    const tok = config.twilio.authToken;
    const headers: Record<string, string> = {};
    if (sid && tok) {
      headers.Authorization = `Basic ${Buffer.from(`${sid}:${tok}`).toString("base64")}`;
    }
    const r = await fetch(url, { headers });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

async function transcribe(buffer: Buffer): Promise<string> {
  try {
    if (!config.openai.apiKey) return "";
    const client = new OpenAI({ apiKey: config.openai.apiKey });
    const file = await OpenAI.toFile(buffer, "voicemail.mp3");
    const res = await client.audio.transcriptions.create({ file, model: "whisper-1" });
    const text = (res as { text?: string })?.text;
    return typeof text === "string" ? text.trim() : "";
  } catch {
    return "";
  }
}

async function resolveContactByPhone(from: string, silo: string): Promise<string | null> {
  const digits = (from || "").replace(/[^0-9]/g, "");
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
  try {
    if (last10) {
      const r = await pool.query<{ id: string }>(
        `SELECT id FROM contacts
           WHERE silo = $2 AND phone IS NOT NULL
             AND length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 10
             AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1
           ORDER BY created_at ASC LIMIT 1`,
        [last10, silo],
      );
      if (r.rows[0]) return r.rows[0].id;
    }
    const created = await createContact(pool, {
      first_name: from || "Unknown",
      last_name: "",
      phone: from || null,
      role: "other",
      is_primary_applicant: false,
      silo,
    });
    return created.id;
  } catch {
    return null;
  }
}

export async function enrichAndDistributeVoicemail(params: {
  callSid: string;
  recordingSid: string;
  recordingUrl: string;
  durationSeconds?: number | null;
  clientId?: string | null;
}): Promise<void> {
  const { callSid, recordingSid, recordingUrl } = params;
  const initialClientId = params.clientId ?? null;
  const callLog = await findCallLogByTwilioSid(callSid).catch(() => null);
  const silo = callLog?.silo || "BF";
  const fromNumber = callLog?.from_number || callLog?.phone_number || "";
  const applicationId = callLog?.application_id ?? null;
  const durationSeconds = params.durationSeconds ?? callLog?.recording_duration_seconds ?? null;

  let mediaUrl = recordingUrl;
  const buf = await downloadRecording(recordingUrl);
  if (buf) {
    const backend = blobBackend();
    if (backend) {
      try {
        const put = await backend.put({
          buffer: buf,
          filename: `vm-${recordingSid}.mp3`,
          contentType: "audio/mpeg",
          pathPrefix: callSid,
        });
        mediaUrl = put.url;
      } catch {
        // Keep the Twilio recording URL when durable blob storage is unavailable.
      }
    }
  }
  const transcript = buf ? await transcribe(buf) : "";

  let contactId: string | null = callLog?.crm_contact_id ?? initialClientId;
  if (!contactId) contactId = await resolveContactByPhone(fromNumber, silo);

  const preview = transcript ? transcript.slice(0, 200) : "📞 New voicemail";

  let convId: string | null = null;
  try {
    const conv = await pool.query<{ id: string }>(
      `SELECT id FROM communications_conversations
        WHERE contact_phone = $1 AND channel IN ('voice','sms')
        ORDER BY created_at DESC LIMIT 1`,
      [fromNumber],
    );
    if (conv.rowCount === 0) {
      const ins = await pool.query<{ id: string }>(
        `INSERT INTO communications_conversations
           (contact_id, contact_phone, contact_name, channel, last_message_preview, last_message_at, unread, silo)
         VALUES ($1, $2, $2, 'voice', $3, NOW(), 1, $4) RETURNING id`,
        [contactId, fromNumber, preview, silo],
      );
      convId = ins.rows[0].id;
    } else {
      convId = conv.rows[0].id;
      await pool.query(
        `UPDATE communications_conversations
            SET last_message_preview = $2, last_message_at = NOW(), unread = unread + 1, updated_at = NOW()
          WHERE id = $1`,
        [convId, preview],
      );
    }
  } catch {
    // Voicemail enrichment is best effort; do not fail the Twilio callback.
  }

  let messageId: string | null = null;
  try {
    const m = await pool.query<{ id: string }>(
      `INSERT INTO communications_messages
        (id, conversation_id, contact_id, channel, type, direction, body, from_number, silo, media_url, media_duration_seconds, application_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'voice', 'voicemail', 'inbound', $3, $4, $5, $6, $7, $8, NOW()) RETURNING id`,
      [convId, contactId, transcript || "📞 Voicemail", fromNumber, silo, mediaUrl, durationSeconds, applicationId],
    );
    messageId = m.rows[0]?.id ?? null;
  } catch {
    // Voicemail enrichment is best effort; do not fail the Twilio callback.
  }

  try {
    await pool.query(
      `INSERT INTO voicemails
        (id, client_id, call_sid, recording_sid, recording_url, blob_url, transcript, duration_seconds, contact_id, application_id, silo, from_number, conversation_id, message_id, staff_user_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())`,
      [initialClientId ?? contactId, callSid, recordingSid, recordingUrl, mediaUrl, transcript || null, durationSeconds, contactId, applicationId, silo, fromNumber, convId, messageId, callLog?.staff_user_id ?? null],
    );
  } catch {
    // Voicemail enrichment is best effort; do not fail the Twilio callback.
  }

  if (contactId) {
    await logCrmEvent({
      contactId,
      applicationId,
      eventType: "call_received",
      payload: { voicemail: true, recording_url: mediaUrl, duration_seconds: durationSeconds, transcript, call_sid: callSid },
    }).catch(() => {});
  }

  try {
    let notify = process.env.VOICEMAIL_NOTIFY_NUMBER || "";
    if (callLog?.staff_user_id) {
      const u = await pool.query<{ phone: string | null }>(
        `SELECT COALESCE(phone, phone_number) AS phone FROM users WHERE id = $1`,
        [callLog.staff_user_id],
      );
      if (u.rows[0]?.phone) notify = u.rows[0].phone;
    }
    if (notify) {
      const who = fromNumber || "an unknown caller";
      const tail = transcript ? `: "${transcript.slice(0, 140)}"` : "";
      await sendSms({ to: notify, message: `New Boreal voicemail from ${who}${tail}` });
    }
  } catch {
    // Voicemail enrichment is best effort; do not fail the Twilio callback.
  }
}
