// BF_SERVER_v831_DIALER_POLISH - Idempotency-Key for changes the iPhone dialler resends.
//
// The dialler keeps a call outcome, task, call log or text saved with no signal and sends it again later - from the app,
// or from iOS in the background. A send whose reply was lost (the request reached us, the answer never got back) was
// sent again, so the task, CRM note or text was made twice. Each saved change now carries its own Idempotency-Key:
//   - first time: the route runs; a 2xx answer is kept for that staff member and key.
//   - again: the kept answer is returned and the route does not run.
//   - while the first is still running: 409 request_in_progress (the dialler tries again later).
//   - a 4xx/5xx answer is not kept, so a later resend runs the route again.
// Requests without the header are untouched. The middleware goes after the route's auth (it keys on the staff member).
import type { NextFunction, Request, Response } from "express";
import { pool } from "../db.js";
import { safeHandler } from "./safeHandler.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

const KEY_RE = /^[A-Za-z0-9_-]{8,100}$/;
/** A first attempt that never finished (the server restarted mid-request) stops blocking resends after this. */
export const STALE_PENDING_SECONDS = 120;

export function replayKey(scope: string, deps: { db?: Q } = {}) {
  return safeHandler(async function replayKeyMiddleware(req: Request & { user?: any }, res: Response, next: NextFunction) {
    const raw = req.header("idempotency-key");
    if (raw === undefined || raw === null || String(raw).trim() === "") return next();
    const key = String(raw).trim();
    if (!KEY_RE.test(key)) {
      return res.status(400).json({ error: "invalid_idempotency_key", message: "The Idempotency-Key header is not valid." });
    }
    const userId = String(req.user?.userId ?? req.user?.id ?? req.user?.sub ?? "");
    if (!userId) return next();
    const db = deps.db ?? pool;
    try {
      let claimed = await db.query(
        `INSERT INTO dialer_request_keys (user_id, key, scope) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, key) DO NOTHING RETURNING key`,
        [userId, key, scope],
      );
      if (!claimed.rows.length) {
        const prior = await db.query(
          `SELECT scope, status_code, body, (created_at < now() - ($3 || ' seconds')::interval) AS stale
             FROM dialer_request_keys WHERE user_id = $1 AND key = $2`,
          [userId, key, String(STALE_PENDING_SECONDS)],
        );
        const row = prior.rows[0];
        if (row && row.status_code != null) {
          res.setHeader("Idempotent-Replay", "true");
          return res.status(Number(row.status_code)).json(row.body ?? {});
        }
        if (row && !row.stale) {
          return res.status(409).json({ error: "request_in_progress", message: "This change is already being saved." });
        }
        // Gone (it failed and was released) or stuck: take it over.
        await db.query(`DELETE FROM dialer_request_keys WHERE user_id = $1 AND key = $2 AND status_code IS NULL`, [userId, key]);
        claimed = await db.query(
          `INSERT INTO dialer_request_keys (user_id, key, scope) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, key) DO NOTHING RETURNING key`,
          [userId, key, scope],
        );
        if (!claimed.rows.length) {
          return res.status(409).json({ error: "request_in_progress", message: "This change is already being saved." });
        }
      }
    } catch (err: any) {
      // The key store is a safety net: when it is unavailable the change still goes through.
      console.warn("[replay-key] lookup failed; running without it", { scope, message: err?.message });
      return next();
    }

    let body: unknown = null;
    const json = res.json.bind(res);
    res.json = ((payload: unknown) => {
      body = payload;
      return json(payload);
    }) as Response["json"];
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      const status = res.statusCode;
      const done = status >= 200 && status < 300 && res.writableFinished
        ? db.query(
            `UPDATE dialer_request_keys SET status_code = $3, body = $4::jsonb WHERE user_id = $1 AND key = $2`,
            [userId, key, status, JSON.stringify(body ?? {})],
          )
        : db.query(`DELETE FROM dialer_request_keys WHERE user_id = $1 AND key = $2 AND status_code IS NULL`, [userId, key]);
      void done.catch((err: any) => console.warn("[replay-key] could not record the result", { scope, status, message: err?.message }));
      if (Math.random() < 0.01) {
        void db.query(`DELETE FROM dialer_request_keys WHERE created_at < now() - interval '30 days'`)
          .catch((err: any) => console.warn("[replay-key] purge failed", { message: err?.message }));
      }
    };
    res.on("finish", settle);
    res.on("close", settle);
    return next();
  });
}
