import express from "express";
import { ROLES } from "../auth/roles.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";

const router = express.Router();

export async function proxyMayaToAgent(
  agentPath: "/api/maya/message" | "/api/maya/chat",
  body: unknown,
  res: express.Response
) {
  const mayaUrl = process.env.MAYA_URL || process.env.MAYA_SERVICE_URL;
  if (!mayaUrl) {
    res.status(503).json({ error: "maya_unavailable", message: "Agent service not configured." });
    return;
  }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const upstream = await fetch(`${mayaUrl}${agentPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
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
    await proxyMayaToAgent("/api/maya/chat", req.body, res);
  })
);

router.post(
  "/message",
  safeHandler(async (req: any, res: any) => {
    await proxyMayaToAgent("/api/maya/message", req.body, res);
  })
);

const adminOnly = [requireAuth, requireAuthorization({ roles: [ROLES.ADMIN] })];

router.get(
  "/overview",
  ...adminOnly,
  safeHandler(async (_req, res) => {
    res.json({
      data: {
        implemented: false,
        totalConversations: 0,
        escalations: 0,
        avgResponseSeconds: 0,
        modelVersion: process.env.OPENAI_MODEL || "gpt-4o-mini",
      },
    });
  })
);

router.get(
  "/metrics",
  ...adminOnly,
  safeHandler(async (_req, res) => {
    res.json({
      data: {
        implemented: false,
        messages24h: 0,
        escalations24h: 0,
        p50LatencyMs: null,
        p95LatencyMs: null,
      },
    });
  })
);

router.post(
  "/roi-simulate",
  ...adminOnly,
  safeHandler(async (req, res) => {
    const budget = Number((req.body as { budget?: unknown })?.budget) || 0;
    res.json({
      data: {
        implemented: false,
        budget,
        projectedDeals: 0,
        projectedRevenue: 0,
        note: "ROI simulation not yet wired to live data.",
      },
    });
  })
);

router.post(
  "/model-rollback",
  ...adminOnly,
  safeHandler(async (_req, res) => {
    res.status(501).json({
      error: "not_implemented",
      message: "Model rollback is not yet implemented.",
    });
  })
);

export default router;
