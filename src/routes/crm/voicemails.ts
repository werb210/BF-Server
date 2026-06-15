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
  const r = await pool.query(
    `SELECT v.id, v.recording_url, v.call_sid, v.created_at,
            v.contact_id,
            c.name  AS contact_name,
            c.phone AS contact_phone
       FROM voicemails v
       LEFT JOIN contacts c ON c.id = v.contact_id
      WHERE (c.silo = $1 OR c.silo IS NULL)
      ORDER BY v.created_at DESC
      LIMIT 200`,
    [silo],
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
