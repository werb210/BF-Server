import express from "express";
import { safeHandler } from "../middleware/safeHandler.js";

const router = express.Router();

async function proxyToAgent(path: string, body: unknown, res: express.Response) {
  const mayaUrl = process.env.MAYA_URL;
  if (!mayaUrl) {
    res.status(503).json({ error: "maya_unavailable", message: "Agent service not configured." });
    return;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const upstream = await fetch(`${mayaUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
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
    await proxyToAgent("/api/maya/chat", req.body, res);
  })
);

router.post(
  "/message",
  safeHandler(async (req: any, res: any) => {
    await proxyToAgent("/api/maya/message", req.body, res);
  })
);

export default router;
