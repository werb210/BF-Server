// BF_SERVER_VISITOR_JOURNEY_v1 - public collector. The website and client wizard POST
// anonymous journey beacons here (no auth: visitors have no token). Writes/updates a
// visitor_sessions row and appends visitor_events. Never throws to the caller: a
// tracking failure must never break the page. Payload is size-capped and whitelisted.
import { Router } from "express";
import express from "express";
import { pool } from "../db.js";

const router = Router();
router.use(express.json({ limit: "32kb" }));

const s = (v: unknown, max = 512): string | null => {
  if (typeof v !== "string" || !v) return null;
  return v.slice(0, max);
};

// POST /api/track/journey
// { sessionId, attribution?: {...}, events: [{ type, path, title, step, dwellMs, meta }] }
router.post("/journey", async (req: any, res: any) => {
  try {
    const b = req.body ?? {};
    const sessionId = s(b.sessionId, 100);
    if (!sessionId) return res.json({ ok: true, skipped: "no_session" });

    const a = (b.attribution ?? {}) as Record<string, unknown>;
    await pool.query(
      `INSERT INTO visitor_sessions (session_id, landing_page, referrer, gclid, gbraid, wbraid, utm_source, utm_medium, utm_campaign, utm_term, utm_content, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (session_id) DO UPDATE SET
         last_seen_at = now(),
         gclid        = COALESCE(visitor_sessions.gclid, EXCLUDED.gclid),
         utm_source   = COALESCE(visitor_sessions.utm_source, EXCLUDED.utm_source),
         utm_campaign = COALESCE(visitor_sessions.utm_campaign, EXCLUDED.utm_campaign)`,
      [
        sessionId, s(a.landing_page), s(a.referrer), s(a.gclid, 200), s(a.gbraid, 200), s(a.wbraid, 200),
        s(a.utm_source), s(a.utm_medium), s(a.utm_campaign), s(a.utm_term), s(a.utm_content),
        s(req.headers?.["user-agent"], 300),
      ],
    );

    const events = Array.isArray(b.events) ? b.events.slice(0, 50) : [];
    for (const e of events) {
      const type = s(e?.type, 60);
      if (!type) continue;
      const dwell = Number.isFinite(Number(e?.dwellMs)) ? Math.min(Math.max(Number(e.dwellMs), 0), 86_400_000) : null;
      await pool.query(
        `INSERT INTO visitor_events (session_id, event_type, path, title, step, dwell_ms, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [sessionId, type, s(e?.path), s(e?.title, 200), s(e?.step, 80), dwell, e?.meta ? JSON.stringify(e.meta).slice(0, 2000) : null],
      );
    }
    return res.json({ ok: true, events: events.length });
  } catch {
    // Tracking must never surface an error to the visitor's browser.
    return res.json({ ok: true, skipped: "error" });
  }
});

export default router;
