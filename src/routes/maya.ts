import express from "express";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { addMessage } from "../modules/ai/chat.repo.js";
import { logError } from "../observability/logger.js";
// BF_SERVER_BLOCK_v317_MAYA_ESCALATIONS_AUTH_v1
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";

const router = express.Router();

// BF_SERVER_BLOCK_v638_MULTIFIX_v1 — accept the original req so we can forward
// X-Maya-Audience (staff|client|visitor) + X-Silo to the agent. Without these
// the agent defaulted to "visitor" and the staff Maya widget kept asking for
// name + phone, ignoring that it was talking to a logged-in staff member.
export async function proxyMayaToAgent(
  agentPath: string,
  method: "POST" | "GET",
  body: unknown,
  res: express.Response,
  req?: express.Request
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
    // BF_SERVER_BLOCK_v638_MULTIFIX_v1 — forward audience + silo from caller.
    const fwdHeaders: Record<string, string> = method === "POST" ? { "Content-Type": "application/json" } : {};
    const audience = req?.header("x-maya-audience");
    if (audience) fwdHeaders["X-Maya-Audience"] = String(audience);
    const silo = req?.header("x-silo");
    if (silo) fwdHeaders["X-Silo"] = String(silo);
    const upstream = await fetch(`${mayaUrl}${agentPath}`, {
      method,
      headers: fwdHeaders,
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const data = await upstream.json().catch(() => ({}));

    // MAYA_TRANSCRIPT_PERSIST_v1 — record the website/client Maya turn into
    // chat_sessions/chat_messages so it appears under Communications -> Maya in
    // the portal. Best-effort: any failure here must NEVER break the reply.
    if (agentPath.includes("/api/maya/message") || agentPath.includes("/api/maya/chat")) {
      try {
        const b: any = body ?? {};
        const sessionId: string | null =
          typeof b.sessionId === "string" && b.sessionId
            ? b.sessionId
            : typeof b.session_id === "string" && b.session_id
              ? b.session_id
              : null;
        const userMsg: string | null = typeof b.message === "string" ? b.message.trim() : null;
        const reply: string | null =
          data && typeof (data as any).reply === "string" ? (data as any).reply.trim() : null;
        if (sessionId && userMsg) {
          const chan = audience ? String(audience) : "web";
          await pool.query(
            `insert into chat_sessions (id, source, channel, status)
             values ($1, 'maya', $2, 'ai')
             on conflict (id) do nothing`,
            [sessionId, chan],
          );
          await addMessage({ sessionId, role: "user", message: userMsg });
          if (reply) await addMessage({ sessionId, role: "ai", message: reply });
        }
      } catch (e: any) {
        logError("maya_transcript_persist_failed", { code: "maya_transcript_persist_failed", error: e?.message ?? "unknown" });
      }
    }

    res.status(upstream.status).json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "agent_proxy_error";
    res.status(503).json({ error: "agent_proxy_error", message });
  }
}

router.post(
  "/chat",
  safeHandler(async (req: any, res: any) => {
    await proxyMayaToAgent("/api/maya/chat", "POST", req.body, res, req);
  })
);

router.post(
  "/message",
  safeHandler(async (req: any, res: any) => {
    await proxyMayaToAgent("/api/maya/message", "POST", req.body, res, req);
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
  // BF_SERVER_BLOCK_v317_MAYA_ESCALATIONS_AUTH_v1
  // Pre-fix this had no auth — the doc-comment said "called by the Maya
  // agent service (NOT a proxy)" but there was nothing actually enforcing
  // that. Anyone on the internet could POST escalations with arbitrary
  // session_id / application_id / reason / surface / silo / payload and
  // fill maya_escalations rows. The 60s (session_id, reason) dedup window
  // doesn't help an attacker who rotates session_id per request. The agent
  // already mints a service JWT with role='Staff' via getServiceToken()
  // (see agent-main/src/api/maya.ts) and includes it on every BF-Server
  // call, so this gate doesn't break the agent. Staff JWTs can also reach
  // it; tighter "service-only" role would require an auth-layer refactor
  // out of scope here.
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
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

    // BF_SERVER_BLOCK_53_v1 -- also write the escalation into
    // communications_messages so staff sees "Client requested human
    // help via Maya" in their normal Communications panel without
    // having to query maya_escalations directly.
    if (applicationId) {
      const msgId = randomUUID();
      await pool.query(
        `INSERT INTO communications_messages
           (id, type, direction, status, application_id, contact_id, silo, body, created_at)
         VALUES (
           $1, 'message', 'inbound', 'received', $2,
           (SELECT contact_id FROM applications WHERE id = $2 LIMIT 1),
           COALESCE($3, (SELECT silo FROM applications WHERE id = $2 LIMIT 1), 'BF'),
           $4, now()
         )`,
        [msgId, applicationId, silo, `🆘 Client requested human help via Maya. Reason: ${reason}`]
      ).catch(() => {});
    }

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
