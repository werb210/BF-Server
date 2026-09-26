// BF_SERVER_BLOCK_v830_VOICEMAILS_LIST
// GET /api/crm/voicemails — recent voicemails for the active silo, newest first,
// joined to contacts for a caller name. Powers the central Voicemail inbox.
import express from "express";
import { pool } from "../../db.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { respondOk } from "../../utils/respondOk.js";
import { resolveSiloFromRequest } from "../../middleware/silo.js";

const router = express.Router();

router.get("/", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  // BF_SERVER_VOICEMAIL_PER_STAFF_v1 - voicemails are private to the staff member
  // the call was for. Each user sees only their own (Todd sees Todd's, etc.).
  const userId = req.user?.userId ?? req.user?.id ?? null;
  const r = await pool.query(
    // BF_SERVER_VOICEMAIL_DURATION_v3
    `SELECT v.id, v.recording_url, v.call_sid, v.created_at,
            v.contact_id,
            COALESCE(v.duration, v.duration_seconds) AS duration_seconds,
            COALESCE(v.transcript, v.transcription)  AS transcript,
            v.from_number,
            -- BF_SERVER_BLOCK_v542 - calls from the client app arrive as
            -- "client:client-<applicationId>" (clientVoice.ts), website "Call us"
            -- as "client:client-anon-<x>", staff rings as "client:<userId>".
            -- Name them instead of showing the raw Twilio identity.
            COALESCE(c.name, capp.name, capp.business, cu.name,
                     CASE WHEN v.from_number ILIKE 'client:client-anon-%' THEN 'Website visitor (Call us button)' END) AS contact_name,
            COALESCE(c.phone, capp.phone, CASE WHEN v.from_number ILIKE 'client:%' THEN NULL ELSE v.from_number END) AS contact_phone,
            COALESCE(v.contact_id, capp.contact_id) AS resolved_contact_id
       FROM voicemails v
       LEFT JOIN contacts c ON c.id = v.contact_id
       LEFT JOIN LATERAL (
         SELECT CASE WHEN COALESCE(TRIM(ac.name), '') = '' OR ac.name ILIKE '%(application started)%' OR ac.name ILIKE 'unknown'
                     THEN NULLIF(TRIM(COALESCE(ac.first_name, '') || ' ' || COALESCE(ac.last_name, '')), '')
                     ELSE TRIM(ac.name) END AS name,
                ac.phone, ac.id AS contact_id,
                COALESCE(NULLIF(TRIM(ap.name), ''), NULLIF(TRIM(ap.business_legal_name), '')) AS business
           FROM applications ap
           LEFT JOIN contacts ac ON ac.id = ap.contact_id
          WHERE v.from_number ~* '^client:client-[0-9a-f-]{36}$'
            AND ap.id::text = substring(v.from_number from 15)
          LIMIT 1
       ) capp ON true
       LEFT JOIN LATERAL (
         SELECT NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS name
           FROM users u
          WHERE v.from_number ~* '^client:[0-9a-f-]{36}$'
            AND u.id::text = substring(v.from_number from 8)
          LIMIT 1
       ) cu ON true
      WHERE (c.silo = $1 OR c.silo IS NULL)
        AND (v.staff_user_id = $2 OR v.staff_user_id IS NULL)
      ORDER BY v.created_at DESC
      LIMIT 200`,
    [silo, userId],
  ).catch(() => ({ rows: [] as any[] }));
  respondOk(res, r.rows ?? []);
}));

// BF_SERVER_VOICEMAIL_AUDIO_PROXY_v1 — stream the Twilio recording with Basic
// auth so the portal <audio> can play it. Raw Twilio recording URLs require
// auth the browser can't supply; the portal fetches this via apiBlob (staff JWT).
router.get("/:id/audio", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id || "");
  const r = await pool.query<{ recording_url: string }>(
    `SELECT recording_url FROM voicemails WHERE id = $1 LIMIT 1`,
    [id],
  ).catch(() => ({ rows: [] as any[] }));
  const url = r.rows[0]?.recording_url;
  if (!url) return res.status(404).end();
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) return res.status(503).end();
  const mp3 = url.endsWith(".mp3") ? url : `${url}.mp3`;
  const auth = Buffer.from(`${sid}:${tok}`).toString("base64");
  const tw = await fetch(mp3, { headers: { Authorization: `Basic ${auth}` } });
  if (!tw.ok) return res.status(502).end();
  const buf = Buffer.from(await tw.arrayBuffer());
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Length", String(buf.length));
  res.setHeader("Cache-Control", "private, max-age=3600");
  return res.send(buf);
}));

export default router;
