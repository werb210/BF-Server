import express from "express";
import { safeHandler } from "../middleware/safeHandler.js";

const router = express.Router();

export async function proxyMayaToAgent(
  agentPath: string,
  method: "POST" | "GET",
  body: unknown,
  res: express.Response
) {
  const mayaUrl = process.env.MAYA_URL || process.env.MAYA_SERVICE_URL;
  if (!mayaUrl) {
    res.status(503).json({
      error: "maya_unavailable",
      message: "Agent service not configured.",
    });
    return;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const upstream = await fetch(`${mayaUrl}${agentPath}`, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : {},
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const data = await upstream.json().catch(() => ({}));
    res.status(upstream.status).json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "agent_proxy_error";
    res.status(503).json({ error: "agent_proxy_error", message });
  }
}

router.post(
  "/chat",
  safeHandler(async (req: any, res: any) => {
    await proxyMayaToAgent("/api/maya/chat", "POST", req.body, res);
  })
);

router.post(
  "/message",
  safeHandler(async (req: any, res: any) => {
    await proxyMayaToAgent("/api/maya/message", "POST", req.body, res);
  })
);

router.post(
  "/escalate",
  safeHandler(async (req: any, res: any) => {
    await proxyMayaToAgent("/maya/escalate", "POST", req.body, res);
  })
);

/**
 * POST /api/maya/escalations
 * Persistence sink called by the Maya agent service (NOT a proxy).
 * Records that Maya escalated a session to a human. Idempotent over a
 * 60s window keyed on (session_id, reason) to absorb the agent's
 * occasional double-fire without creating duplicate rows.
 */
router.post(
  "/escalations",
  safeHandler(async (req: any, res: any) => {
    const { randomUUID } = await import("node:crypto");
    const body = req.body ?? {};
    const reason = typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 200)
      : "user_requested_human";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.slice(0, 200) : null;
    const applicationId = typeof body.applicationId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.applicationId)
      ? body.applicationId
      : null;
    const surface = typeof body.surface === "string" ? body.surface.slice(0, 50) : null;
    const silo = typeof body.silo === "string" ? body.silo.slice(0, 10) : null;
    const payload = body && typeof body === "object" ? body : {};

    const { pool } = await import("../db.js");

    // Dedupe: if the same (session_id, reason) was logged in the last 60s, return that row.
    if (sessionId) {
      const dupe = await pool.query<{ id: string }>(
        `SELECT id FROM maya_escalations
         WHERE session_id = $1 AND reason = $2
           AND created_at > now() - interval '60 seconds'
         ORDER BY created_at DESC LIMIT 1`,
        [sessionId, reason]
      );
      if (dupe.rows[0]?.id) {
        return res.status(200).json({
          status: "ok",
          data: { id: dupe.rows[0].id, deduped: true },
        });
      }
    }

    const id = randomUUID();
    await pool.query(
      `INSERT INTO maya_escalations
         (id, session_id, application_id, reason, surface, silo, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [id, sessionId, applicationId, reason, surface, silo, JSON.stringify(payload)]
    );

    res.status(201).json({ status: "ok", data: { id, deduped: false } });
  })
);

router.get(
  "/health",
  safeHandler(async (_req: any, res: any) => {
    const mayaUrl = process.env.MAYA_URL || process.env.MAYA_SERVICE_URL;
    const result: any = {
      env: {
        MAYA_URL: !!mayaUrl,
        JWT_SECRET: !!process.env.JWT_SECRET,
      },
    };
    if (!mayaUrl) {
      return res.status(503).json({ ok: false, reason: "MAYA_URL not set", ...result });
    }
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(`${mayaUrl}/health`, { method: "GET", signal: ctrl.signal });
      const body = await r.text();
      return res.status(r.ok ? 200 : 502).json({
        ok: r.ok, agent_status: r.status, agent_body: body.slice(0, 500), ...result,
      });
    } catch (e: any) {
      return res.status(502).json({ ok: false, reason: "agent_unreachable", error: e?.message, ...result });
    }
  })
);

export default router;
