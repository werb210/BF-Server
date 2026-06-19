// BF_SERVER_BLOCK_v797_EMAIL_OPEN_TRACKING — public (unauthed) tracking pixel.
// Mounted at /api/track (a router with no requireAuth = public, same as webhooks).
// Email clients fetch this 1x1 gif when the recipient opens the message; we stamp
// opened_at on the matching crm_email_log row (first open wins) and return the gif.
// No auth needed: the token is an unguessable uuid and the only side effect is
// recording an open. Never blocks the image response on a DB hiccup.
import { Router } from "express";
import { pool } from "../db.js";

const router = Router();

// 1x1 transparent GIF.
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

router.get("/email/:token.gif", async (req, res) => {
  const token = String(req.params.token ?? "").trim();
  if (token) {
    try {
      // First-open stamp (back-compat) ...
      await pool.query(
        `UPDATE crm_email_log SET opened_at = now() WHERE pixel_token = $1 AND opened_at IS NULL`,
        [token],
      );
      // ... plus one event row per open (#48 Option B): every open, each timestamped.
      await pool.query(
        `INSERT INTO email_open_events (email_log_id, opened_at)
         SELECT id, now() FROM crm_email_log WHERE pixel_token = $1 LIMIT 1`,
        [token],
      );
    } catch {
      /* never block the pixel on a DB error */
    }
  }
  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.end(PIXEL);
});

export default router;
