import { Router } from "express";

import applicationRoutes from "./applications.routes.js";
import documentRoutes from "./documents.js";
import userRoutes from "./users.js";

const router = Router();

router.use("/applications", applicationRoutes);
router.use("/documents", documentRoutes);
router.use("/users", userRoutes);

router.get("/health", async (_req, res) => {
  let mayaStatus: "healthy" | "degraded" = "degraded";
  const mayaUrl = process.env.MAYA_URL;
  if (mayaUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      const resp = await fetch(`${mayaUrl}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (resp.ok) {
        const body = await resp.json().catch(() => ({}));
        mayaStatus = body?.status === "ok" ? "healthy" : "degraded";
      }
    } catch {
      mayaStatus = "degraded";
    }
  }
  res.status(200).json({ status: "ok", maya: mayaStatus, data: {} });
});

export default router;
